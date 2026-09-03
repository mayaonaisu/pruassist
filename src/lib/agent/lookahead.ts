import { Type } from "@google/genai";
import { citationsFor, conceptsForArea, type Concept } from "../concepts";
import { clauseById, type Clause } from "../knowledge";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "./gemini";
import { haveKey } from "../genai";
import { clauseBlock, HOUSE_RULES, POINTER_FIELDS, POSTURE } from "./prompts";
import { activeDecision } from "./readiness";
import { runToolLoop } from "./tools";
import { verifyGrounding } from "./verify";
import { retrieve, type Hit } from "../retrieval";
import type { AgentState, Lookahead, Pointers } from "./types";

// Speculative execution for a conversation.
//
// The commodity version of this predicts a generic next question. This one is aimed at *this*
// customer's specific unresolved concepts: the ledger says which ideas they agreed to without
// showing, which they got wrong, and which have not come up at all. The answer is generated and
// grounding-checked in the background, so when the question actually arrives the live path serves
// it from cache — verified, and with no model call on the rep's critical path.

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    question: { type: Type.STRING },
    concern: { type: Type.STRING },
    firstStep: { type: Type.STRING },
    suggestedLine: { type: Type.STRING },
    explainer: { type: Type.STRING },
    comparison: { type: Type.STRING },
    followUp: { type: Type.STRING },
  },
  required: ["question", "concern", "firstStep", "suggestedLine", "explainer", "comparison", "followUp"],
};

/** Risk order: wrong beats agreed-but-unshown beats material-and-never-raised. */
export function rankByRisk(state: AgentState): Concept[] {
  // A concept standing between the representative and a recommendation is worth preparing for
  // ahead of an equally unresolved one that decides nothing. Deliberately smaller than the gap
  // between two risk bands — even counting a re-ask — so it breaks ties without ever letting a
  // never-raised concept overtake a false assent.
  const decision = activeDecision(state);
  const deciding = new Set(decision?.differentiators ?? []);

  const scored = conceptsForArea(state.productArea).map((c) => {
    const e = state.concepts[c.id];
    let risk = 0;
    if (e?.state === "misunderstood") risk = 4;
    else if (e?.state === "asserted" && !e.demonstratedAt) risk = 3;
    else if (!e || e.state === "unseen") risk = c.material ? 2 : 0;
    else if (e.state === "raised") risk = 1;
    // Coming back to a topic is evidence it is unresolved, whatever state it reached.
    if (e?.reAsks) risk += 0.5;
    if (risk > 0 && deciding.has(c.id)) risk += 0.25;
    // A settled concept is not worth preparing for.
    if (e?.state === "demonstrated") risk = 0;
    return { c, risk };
  });
  return scored
    .filter((x) => x.risk > 0)
    .sort((a, b) => b.risk - a.risk)
    .map((x) => x.c);
}

// A concept's own anchor clauses, as retrieval-shaped hits. Guaranteed to exist (import-time
// integrity throws otherwise) and exactly on topic — the reliable fallback when the tool loop
// returns without searching.
export function anchorClauses(concept: Concept): Hit[] {
  return concept.clauseIds
    .map(clauseById)
    .filter((c): c is Clause => Boolean(c))
    .map((c) => ({ ...c, score: 1 }));
}

/**
 * Prepares the answer to the likeliest next question about the riskiest open concept. Returns
 * null when there is nothing worth preparing, when generation fails, or when the answer does not
 * survive grounding verification — a cache entry that is not grounded is worse than a cache miss,
 * because it would be served instantly and with a citation.
 */
export async function prepareLookahead(state: AgentState, recent: string): Promise<Lookahead | null> {
  if (!haveKey()) return null;

  const target = rankByRisk(state)[0];
  if (!target) return null;

  // Already prepared for this concept and nothing has changed — do not spend the calls again.
  if (state.lookahead?.conceptId === target.id && state.lookahead.rev === state.rev) return state.lookahead;

  // Phase 1: tools on, free-form. The model decides what to look up.
  //
  // Bounded to 2 steps at low thinking. On Vercel the deep pass runs inside `after()` under a 60s
  // function limit, and the full 3-step MEDIUM-thinking loop routinely blew past it and was killed —
  // so the prepared answer never landed. Two steps (read the ledger, search once) is what this gather
  // actually needs, and the retrieval fallback below guarantees a grounded answer even if the leaner
  // loop searches less, so the latency cut costs reliability nothing.
  const gathered = await runToolLoop(
    `${POSTURE} You are preparing, in the background, for the question this customer is most likely ` +
      `to ask next. ${HOUSE_RULES} Read the ledger to see what they have agreed to without ` +
      `demonstrating and what they got wrong. You MUST call search_policy at least once — never ` +
      `write the brief without searching first — for the clauses that would answer their next ` +
      `question. When you have what you need, write a short evidence brief: the single question you ` +
      `expect, and the clause facts that answer it. Do not write the reply itself.`,
    `The representative is discussing ${state.productArea}. The concept most at risk right now is ` +
      `"${target.label}". Recent conversation:\n${recent || "(nothing yet)"}\n\n` +
      `Work out the one question this customer is most likely to ask next about it, and gather the ` +
      `clauses that answer it.`,
    { state, productArea: state.productArea },
    { maxSteps: 2, think: "off" },
  );
  if (!gathered) return null;

  // The tool loop occasionally returns without calling search_policy, gathering no clauses. Rather
  // than skip preparing entirely, retrieve the target concept's clauses directly — the same breadth
  // search_policy would have produced — so a grounded answer is still prepared. This is what makes
  // the lookahead reliable instead of intermittently empty.
  let clauses: Hit[] = gathered.run.cited;
  if (!clauses.length) clauses = await retrieve(`${target.label} ${target.terms.join(" ")}`, 4, state.productArea);
  // Last resort if retrieval itself returns nothing (e.g. embeddings unavailable): the concept's
  // own anchor clauses, which always exist.
  if (!clauses.length) clauses = anchorClauses(target);
  if (!clauses.length) return null;

  // Phase 2: tools off, structured output, over a FRESH contents built from plain text. Structured
  // output cannot be combined with tools, and on the 2.5 series it also fails when contents merely
  // contains function-call history — so nothing from phase 1 is carried over except its prose.
  let pointers: Pointers & { question: string };
  const res = await callWithRetry("lookahead", (ai) =>
    ai.models.generateContent({
      model: MODEL,
      contents:
        `POLICY CLAUSES:\n${clauseBlock(clauses)}\n\n` +
        `EVIDENCE BRIEF:\n${gathered.text || "(none — work from the clauses)"}\n\n` +
        `RECENT CONVERSATION:\n${recent || "(nothing yet)"}`,
      config: {
        systemInstruction:
          `You are PRUAssist, a PRIVATE co-pilot for a Prudential financial representative. ${POSTURE} ` +
          `${HOUSE_RULES} Write the pointers the representative will need when the expected question ` +
          `arrives. "question" is that expected question in the customer's own likely words. ` +
          `Respond ONLY with JSON of this shape, plus "question":\n${POINTER_FIELDS}`,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        // Formatting only — phase 1 already did the reasoning.
        thinkingConfig: thinking("off"),
        temperature: 0.3,
        maxOutputTokens: JSON_BUDGET * 2,
      },
    }),
  );
  if (!res) return null;

  try {
    const p = JSON.parse((res.text ?? "{}").trim()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    pointers = {
      question: str(p.question),
      concern: str(p.concern),
      firstStep: str(p.firstStep),
      suggestedLine: str(p.suggestedLine),
      explainer: str(p.explainer),
      comparison: str(p.comparison),
      followUp: str(p.followUp),
    };
  } catch (e) {
    console.error(`[lookahead] unparseable synthesis: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  if (!pointers.question || !pointers.suggestedLine) return null;

  // Verified before it is cached, not after it is served. failClosed: an unverifiable answer is
  // not cached, because the whole point of the cache is that it skips the live checks.
  const check = await verifyGrounding(
    [pointers.suggestedLine, pointers.explainer, pointers.comparison].filter(Boolean).join("\n"),
    clauses,
    { failClosed: true },
  );
  if (!check.grounded) {
    // Two different reasons, and they mean different things: a claim the clauses do not support,
    // or a verification that could not run. Both drop the answer; only one is the model's fault.
    console.warn(
      `[lookahead] dropped answer for ${target.id}: ${check.unsupported.length ? check.unsupported.join(" | ") : check.note || "not verified"}`,
    );
    return null;
  }

  const { question, ...rest } = pointers;
  return {
    conceptId: target.id,
    label: target.label,
    question,
    pointers: rest,
    sources: clauses.map((h) => ({ id: h.id, source: h.source, snippet: h.text.slice(0, 150) })),
    citations: citationsFor(target),
    // Records how the evidence was gathered — the tools the loop called, or a marker that it
    // returned without searching and the clauses came from the retrieval fallback.
    toolCalls: gathered.run.transcript.length ? gathered.run.transcript : [`fallback: retrieved ${target.id} clauses`],
    verified: true,
    preparedAt: Date.now(),
    rev: state.rev,
  };
}
