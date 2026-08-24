import { runTool, type ToolContext } from "./tools";
import type { Hit } from "../retrieval";

// A fast generation path over Groq's OpenAI-compatible endpoint — a spike alternative to Gemini for
// the LIVE handlers. Groq's LPU runs gpt-oss-120b at sub-second latency and its free RPD is generous,
// so the agentic tool loop stops being the rep's bottleneck. Embeddings stay on Gemini (Groq has
// none). Opt-in: set PRUASSIST_GEN=groq with a GROQ_API_KEY; otherwise the Gemini path is unchanged.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";

export const groqEnabled = (): boolean => !!process.env.GROQ_API_KEY?.trim() && process.env.PRUASSIST_GEN === "groq";

type ToolCall = { id: string; function: { name: string; arguments: string } };
type Msg = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string };

// OpenAI-shaped mirror of the Gemini DECLARATIONS in tools.ts — same three tools, same intent.
const GROQ_TOOLS = [
  { type: "function", function: { name: "search_policy", description: "Search the Prudential brochure corpus for clauses relevant to a question. The only source of policy facts.", parameters: { type: "object", properties: { query: { type: "string", description: "What to look for, phrased as the customer would ask it." }, productArea: { type: "string", description: "Optional advisory area to scope the search to." } }, required: ["query"] } } },
  { type: "function", function: { name: "read_ledger", description: "Read what this customer has demonstrated, merely agreed to, or got wrong so far, with the evidence quotes.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "compare_options", description: "Fetch the clauses describing the options in a decision the customer is weighing ('which one should I take', 'what's the difference').", parameters: { type: "object", properties: { focus: { type: "string" }, decisionId: { type: "string" } }, required: ["focus"] } } },
];

async function groqChat(messages: Msg[], opts: { tools?: unknown[]; json?: boolean } = {}): Promise<Msg | null> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 1400,
        ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.error(`[groq] ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = await res.json();
    return data?.choices?.[0]?.message ?? null;
  } catch (e) {
    console.error(`[groq] ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Phase 1: let the model choose what to look up, executing the same tools the Gemini loop uses.
// Bounded by maxSteps (the live path caps it) so the rep never waits on a runaway loop.
export async function groqGatherClauses(instruction: string, task: string, ctx: ToolContext, maxSteps = 2): Promise<Hit[]> {
  const messages: Msg[] = [
    { role: "system", content: instruction },
    { role: "user", content: task },
  ];
  const cited: Hit[] = [];
  for (let step = 0; step < maxSteps; step++) {
    const msg = await groqChat(messages, { tools: GROQ_TOOLS });
    if (!msg) break;
    const calls = msg.tool_calls ?? [];
    if (!calls.length) break;
    messages.push(msg);
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        /* malformed args — run with none */
      }
      const { result, cited: got } = await runTool(c.function.name, args, ctx);
      for (const h of got) if (!cited.some((x) => x.id === h.id)) cited.push(h);
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result) });
    }
  }
  return cited;
}

// Phase 2: structured synthesis over the gathered clauses. Returns the raw JSON string, which the
// caller shapes into Pointers exactly as it does for the Gemini path — so grounding checks are shared.
export async function groqGenerateRaw(instruction: string, clauseBlockText: string, transcript: string): Promise<string | null> {
  const msg = await groqChat(
    [
      { role: "system", content: instruction },
      { role: "user", content: `POLICY CLAUSES:\n${clauseBlockText}\n\nRECENT TRANSCRIPT:\n${transcript}` },
    ],
    { json: true },
  );
  return msg?.content ?? null;
}
