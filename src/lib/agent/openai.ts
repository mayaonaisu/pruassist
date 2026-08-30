// A generation path over OpenAI's Chat Completions API — a paid, un-throttled alternative to the
// Gemini free tier for the BACKGROUND work (the post-session summary today; the lookahead synthesis
// and grading are the next candidates). Same OpenAI wire format the Groq path uses, so callers shape
// the result identically. Self-disabling: with no OPENAI_API_KEY, `openaiEnabled()` is false and every
// caller falls back to Gemini unchanged — so this can never regress a deploy that has not set the key.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
// gpt-4o-mini: fast and cheap, and off the rep's critical path (this is background work), so latency
// matters less than not hitting Gemini's free-tier daily cap. Overridable.
const OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

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
