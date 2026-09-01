import { runTool, type ToolContext } from "./tools";
import type { Hit } from "../retrieval";

// A generation path over OpenAI's Chat Completions API — a paid, un-throttled alternative to the
// Gemini free tier. Now the primary for the BACKGROUND work off the Groq live path (the post-session
// summary, teach-back grading, the lookahead tool loop + synthesis, and grounding verification). Same
// OpenAI wire format the Groq path uses, so callers shape the result identically. Self-disabling: with
// no OPENAI_API_KEY, `openaiEnabled()` is false and every caller falls back to Gemini unchanged — so
// this can never regress a deploy that has not set the key.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// gpt-4o by default: measurably more careful than gpt-4o-mini on this corpus — it declines to invent
// figures in a suggested line ("reduces out-of-pocket costs significantly" vs mini's fabricated
// "to S$0.00") and its grades are at least as good (replay:all 8/8 on both). These are background /
// fallback calls off the rep's critical path (live generation is Groq), so the extra latency and cost
// over mini buy real quality. Overridable with OPENAI_MODEL — set it to gpt-4o-mini to cut cost.
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";

export const openaiEnabled = (): boolean => !!process.env.OPENAI_API_KEY?.trim();

type ToolCall = { id: string; function: { name: string; arguments: string } };
type Msg = { role: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; name?: string };

// One call to OpenAI chat. Returns the assistant message, or null on any failure (missing key, HTTP
// error, timeout) so the caller can fall back to Gemini rather than surface an error.
async function openaiChat(messages: Msg[], opts: { tools?: unknown[]; json?: boolean; maxTokens?: number } = {}): Promise<Msg | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: opts.maxTokens ?? 1400,
        ...(opts.tools ? { tools: opts.tools, tool_choice: "auto" } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (res.ok) return (await res.json())?.choices?.[0]?.message ?? null;
    console.error(`[openai] ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return null;
  } catch (e) {
    console.error(`[openai] ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// Structured JSON synthesis: a system instruction plus user content in, the raw JSON string out (or
// null on any failure, so the caller falls back to Gemini). response_format pins JSON, exactly as the
// Gemini callers pin responseMimeType: "application/json".
export async function openaiJson(system: string, user: string, maxTokens = 1400): Promise<string | null> {
  const msg = await openaiChat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: true, maxTokens },
  );
  return msg?.content ?? null;
}

// OpenAI-shaped mirror of the Gemini DECLARATIONS in tools.ts — same three tools, same intent.
// Identical to the Groq schema (Groq is OpenAI-compatible), kept independently so the two provider
// modules do not depend on each other.
const OPENAI_TOOLS = [
  { type: "function", function: { name: "search_policy", description: "Search the Prudential brochure corpus for clauses relevant to a question. The only source of policy facts.", parameters: { type: "object", properties: { query: { type: "string", description: "What to look for, phrased as the customer would ask it." }, productArea: { type: "string", description: "Optional advisory area to scope the search to." } }, required: ["query"] } } },
  { type: "function", function: { name: "read_ledger", description: "Read what this customer has demonstrated, merely agreed to, or got wrong so far, with the evidence quotes.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "compare_options", description: "Fetch the clauses describing the options in a decision the customer is weighing ('which one should I take', 'what's the difference').", parameters: { type: "object", properties: { focus: { type: "string" }, decisionId: { type: "string" } }, required: ["focus"] } } },
];

// Phase 1 tool loop over OpenAI: the model chooses what to look up, executing the same tools the
// Gemini/Groq loops use. Returns the cited clauses, the final free-form brief (if any), and the tool
// call transcript — a superset of what groqGatherClauses returns, so it is a drop-in for both the live
// handlers (which read .cited) and the lookahead (which also uses .text and .transcript). Bounded by
// maxSteps so a background loop cannot run away.
export async function openaiGatherClauses(
  instruction: string,
  task: string,
  ctx: ToolContext,
  maxSteps = 2,
): Promise<{ cited: Hit[]; text: string; transcript: string[] }> {
  const messages: Msg[] = [
    { role: "system", content: instruction },
    { role: "user", content: task },
  ];
  const cited: Hit[] = [];
  const transcript: string[] = [];
  let text = "";
  for (let step = 0; step < maxSteps; step++) {
    const msg = await openaiChat(messages, { tools: OPENAI_TOOLS });
    if (!msg) break;
    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      text = (msg.content ?? "").trim();
      break;
    }
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
      transcript.push(`${c.function.name}(${c.function.arguments || "{}"})`);
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: JSON.stringify(result) });
    }
  }
  return { cited, text, transcript };
}
export type { Msg as OpenAiMsg };
