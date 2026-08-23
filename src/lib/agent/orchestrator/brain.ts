import { activeDecision } from "../readiness";
import type { Mode, ModeDecision, OrchestratorInput } from "./types";

// Tier 1 of the router: an LLM brain reached over the OpenAI-compatible chat API (default: NVIDIA
// Nemotron 3.5 Lightning via OpenRouter). It decides the mode. Returns null — so the caller falls
// back to the deterministic decideMode — whenever the brain is not configured, is unreachable,
// times out, returns non-JSON, names a mode we do not know, or reports low confidence.
//
// Provider-agnostic on purpose: it speaks the plain OpenAI /chat/completions contract, so the same
// code works for OpenRouter, Ollama's /v1 shim, LM Studio, vLLM, or a hosted model — env only.

const MODES: Mode[] = ["keep_listening", "policy_guidance", "comparison", "guider", "topic_drift", "clarification"];

const TIMEOUT_MS = 4000;
const MIN_CONFIDENCE = 0.4;

const SYSTEM =
  "You are the ROUTER for PRUAssist, a private co-pilot for a Prudential insurance representative " +
  "on a live call. Read the customer's latest turn in context and classify it into EXACTLY ONE mode. " +
  "Modes:\n" +
  "- keep_listening: an acknowledgement or nothing that needs a response ('okay thanks').\n" +
  "- policy_guidance: a question about the policy that needs facts ('why do I need PRUExtra?').\n" +
  "- comparison: weighing options against each other ('Premier or Plus?', 'what's the difference?').\n" +
  "- guider: a remark or opinion, not a question, where a proactive nudge helps ('I already have company insurance').\n" +
  "- topic_drift: outside the stated discussion scope ('can I invest with this?').\n" +
  "- clarification: too vague to answer without more context ('why is this more expensive?').\n" +
  'Respond with ONLY JSON: {"mode": "<one of the modes>", "confidence": <0..1>}.';

function userMessage(input: OrchestratorInput): string {
  const decision = activeDecision(input.state);
  const inPlay = decision ? `A "${decision.question}" comparison is currently in play.` : "No comparison is in play yet.";
  const clarify = input.clarifyContext ? `\nRep-supplied context: ${input.clarifyContext}` : "";
  return (
    `Discussion scope: ${input.scope}. ${inPlay}\n` +
    `Recent transcript:\n${input.transcript}\n\n` +
    `Classify the customer's latest turn: "${input.asked}"${clarify}`
  );
}

export async function classify(input: OrchestratorInput): Promise<ModeDecision | null> {
  const base = process.env.ORCHESTRATOR_BASE_URL?.trim();
  const key = process.env.ORCHESTRATOR_API_KEY?.trim();
  const model = process.env.ORCHESTRATOR_MODEL?.trim();
  if (!base || !key || !model) return null; // no brain configured → deterministic fallback

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 60,
        // Nemotron (and other reasoning models) otherwise burn the whole budget on chain-of-thought
        // and never emit the JSON. Routing is a one-shot classification; turn reasoning off so the
        // answer lands fast and clean. Harmless for non-reasoning models (OpenRouter ignores it).
        reasoning: { enabled: false },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMessage(input) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;

    const parsed = JSON.parse(content) as { mode?: unknown; confidence?: unknown };
    const mode = parsed.mode;
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 1;
    if (typeof mode !== "string" || !MODES.includes(mode as Mode)) return null;
    if (confidence < MIN_CONFIDENCE) return null; // unsure → let the deterministic tier decide
    return { mode: mode as Mode, why: `brain (${confidence.toFixed(2)})` };
  } catch {
    // Any failure — network, timeout, bad JSON — is a fallback, never an error to the rep.
    return null;
  }
}
