import { Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { conceptsForArea } from "../concepts";
import { decisionById } from "../decisions";
import { clauseById } from "../knowledge";
import { retrieve, type Hit } from "../retrieval";
import { callWithRetry, JSON_BUDGET, MAX_TOOL_STEPS, MODEL, thinking } from "./gemini";
import { haveKey } from "../genai";
import type { AgentState } from "./types";

// The tool loop, written by hand on purpose.
//
// @google/genai decides a tool is callable with `'callTool' in tool`, and a Tool built from
// `{ functionDeclarations }` has no such method — automatic function calling is disabled for it
// and the model's function calls come back unexecuted. So the loop below is not a stylistic
// choice; without it nothing runs.
//
// `estimate_premium` is deliberately absent. The corpus describes premiums qualitatively and
// contains no rate tables, so such a tool could only fabricate figures — next to a real page
// citation, which is the exact failure this product exists to prevent.

export const DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "search_policy",
    description:
      "Search the Prudential brochure corpus for clauses relevant to a question. Returns clauses " +
      "with their brochure page citations. This is the only source of policy facts.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "What to look for, phrased as the customer would ask it." },
        productArea: {
          type: Type.STRING,
          description: "Optional advisory area to scope the search to, e.g. 'Health Protection'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_ledger",
    description:
      "Read what this customer has demonstrated, merely agreed to, or got wrong so far in this " +
      "conversation, with the evidence quotes. Use it to work out what they are likely to ask next.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "compare_options",
    description:
      "Fetch the clauses describing the options in a decision the customer is weighing, for " +
      "questions of the form 'which one should I take' or 'what is the difference between'. Pass " +
      "the decisionId when you know it — 'which-tier' or 'add-pruextra'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        focus: { type: Type.STRING, description: "What to compare on, e.g. 'where I can be treated'." },
        decisionId: { type: Type.STRING, description: "Optional decision id: 'which-tier' or 'add-pruextra'." },
      },
      required: ["focus"],
    },
  },
];

export type ToolContext = { state: AgentState; productArea: string };

// Every clause any tool returned, in call order — the evidence block the synthesis phase reads.
export type ToolRun = { cited: Hit[]; steps: number; transcript: string[] };

function ledgerDigest(state: AgentState): string {
  const rows = conceptsForArea(state.productArea).map((c) => {
    const e = state.concepts[c.id];
    if (!e || e.state === "unseen") return `${c.label}: never raised`;
    const quote = [...e.evidence].reverse().find((x) => x.role === "customer")?.quote;
    return `${c.label}: ${e.state}${quote ? ` — customer said "${quote}"` : ""}${e.reAsks ? ` (returned to it ${e.reAsks}x)` : ""}`;
  });
  return rows.join("\n");
}

async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ result: unknown; cited: Hit[] }> {
  switch (name) {
    case "search_policy": {
      const query = typeof args.query === "string" ? args.query : "";
      const area = typeof args.productArea === "string" ? args.productArea : ctx.productArea;
      const hits = await retrieve(query, 4, area);
      return {
        cited: hits,
        result: hits.length
          ? { clauses: hits.map((h) => ({ source: h.source, text: h.text })) }
          : { clauses: [], note: "No clause in the corpus covers this. Do not answer it." },
      };
    }
    case "read_ledger":
      return { cited: [], result: { productArea: ctx.productArea, concepts: ledgerDigest(ctx.state) } };
    case "compare_options": {
      const focus = typeof args.focus === "string" ? args.focus : "";
      const decision = typeof args.decisionId === "string" ? decisionById(args.decisionId) : null;
      // A named decision brings the clauses that describe its own options; otherwise fall back to
      // the general comparison set. The search only adds whatever the rep is comparing on.
      const ids = decision ? [...new Set(decision.options.flatMap((o) => o.clauseIds))] : COMPARISON_CLAUSES;
      const fixed = ids
        .map(clauseById)
        .filter((c) => c !== undefined)
        .map((c) => ({ ...c, score: 1 }) as Hit);
      const extra = await retrieve(focus || "difference between the plans", 2, ctx.productArea);
      const cited = [...fixed, ...extra.filter((e) => !fixed.some((c) => c.id === e.id))];
      return { cited, result: { clauses: cited.map((h) => ({ source: h.source, text: h.text })) } };
    }
    default:
      return { cited: [], result: { error: `Unknown tool ${name}` } };
  }
}

const COMPARISON_CLAUSES = ["plan-tiers", "pruextra-plans", "what-is-pruextra", "limits-of-cover"];

/**
 * Phase 1 of the two-phase pattern: tools on, free-form output, thinking enabled. Structured
 * output cannot be combined with tools, and on the 2.5 series it also fails once `contents`
 * merely contains tool-call history — so this phase produces prose and evidence, and the caller
 * synthesises from a fresh `contents` with no functionCall parts in it.
 */
export async function runToolLoop(
  instruction: string,
  task: string,
  ctx: ToolContext,
  // The live path passes allowSleep:false: the rep is waiting and maxDuration is 30s, so a
  // rate-limited call must rotate keys, never sleep out a 20s backoff. Background callers leave it
  // true — a lookahead held open a little longer is fine.
  { allowSleep = true } = {},
): Promise<{ text: string; run: ToolRun } | null> {
  if (!haveKey()) return null;

  const contents: Content[] = [{ role: "user", parts: [{ text: task }] }];
  const run: ToolRun = { cited: [], steps: 0, transcript: [] };

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const res = await callWithRetry(
      "tools",
      (ai) =>
        ai.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction: instruction,
            tools: [{ functionDeclarations: DECLARATIONS }],
            // -1 leaves the budget dynamic. Pinning it to 0 measurably degrades multi-step tool
            // selection, and choosing what to search for is the whole job of this phase.
            thinkingConfig: thinking("dynamic"),
            temperature: 0.2,
            maxOutputTokens: JSON_BUDGET * 2,
          },
        }),
      { allowSleep },
    );
    // Speculative work: a failure here costs nothing but the speculation, so it never propagates.
    if (!res) return run.cited.length ? { text: "", run } : null;

    const calls = res.functionCalls ?? [];
    if (!calls.length) return { text: (res.text ?? "").trim(), run };

    // Echo the model turn back verbatim. gemini-2.5 attaches a thoughtSignature to the
    // function-call part, and rebuilding the parts by hand drops it and breaks the next turn.
    const modelTurn = res.candidates?.[0]?.content;
    if (!modelTurn) return { text: (res.text ?? "").trim(), run };
    contents.push(modelTurn);

    const responses: Part[] = [];
    for (const call of calls) {
      run.steps += 1;
      const { result, cited } = await runTool(call.name ?? "", call.args ?? {}, ctx);
      run.cited.push(...cited.filter((c) => !run.cited.some((x) => x.id === c.id)));
      run.transcript.push(`${call.name}(${JSON.stringify(call.args ?? {})})`);
      responses.push({
        functionResponse: { id: call.id, name: call.name, response: result as Record<string, unknown> },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  // Out of steps. Whatever evidence was gathered is still usable; the caller synthesises from it.
  return { text: "", run };
}
