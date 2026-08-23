import { conceptsForArea } from "../../concepts";
import { retrieve, type Hit } from "../../retrieval";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "../gemini";
import { clauseBlock, comparisonSystemInstruction, guidanceSystemInstruction, pointerSystemInstruction } from "../prompts";
import { activeDecision, readinessFor } from "../readiness";
import { conceptsMentioned } from "../utterance";
import { unsupportedFigures } from "../verify";
import type { OrchestratorInput, OrchestratorResult, Pointers } from "./types";

// The mode handlers. The generating ones (policy / comparison / guider) reuse the exact
// retrieve → generate → verify machinery the assist route used before the orchestrator existed;
// the lighter ones return a payload the console renders without a model call.

const str = (v: unknown) => (typeof v === "string" ? v : "");
const sourcesOf = (hits: Hit[]) => hits.map((h) => ({ source: h.source, snippet: h.text.slice(0, 150) }));

async function generate(
  instruction: string,
  hits: Hit[],
  transcript: string,
): Promise<{ pointers: Pointers; unsupportedFigures: string[] } | null> {
  const response = await callWithRetry(
    "orchestrator",
    (ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: `POLICY CLAUSES:\n${clauseBlock(hits)}\n\nRECENT TRANSCRIPT:\n${transcript}`,
        config: {
          systemInstruction: instruction,
          responseMimeType: "application/json",
          thinkingConfig: thinking("off"),
          temperature: 0.3,
          maxOutputTokens: JSON_BUDGET,
        },
      }),
    { allowSleep: false },
  );
  if (!response) return null;

  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse((response.text ?? "").trim());
  } catch {
    p = { explainer: (response.text ?? "").trim() };
  }
  const pointers: Pointers = {
    concern: str(p.concern),
    firstStep: str(p.firstStep),
    suggestedLine: str(p.suggestedLine),
    explainer: str(p.explainer),
    comparison: str(p.comparison),
    followUp: str(p.followUp),
  };
  // Same deterministic grounding label as the live path: a figure not on the cited pages is flagged.
  const spoken = [pointers.suggestedLine, pointers.explainer, pointers.comparison].filter(Boolean).join("\n");
  return { pointers, unsupportedFigures: unsupportedFigures(spoken, hits) };
}

export async function handlePolicyGuidance(input: OrchestratorInput): Promise<OrchestratorResult> {
  const hits = await retrieve(input.transcript, 3, input.scope);
  if (!hits.length) {
    return { mode: "policy_guidance", note: "No policy clause covers this yet — keep listening, or ask the customer to be more specific." };
  }
  const gen = await generate(pointerSystemInstruction(input.scope), hits, input.transcript);
  if (!gen) return { mode: "policy_guidance", note: "The AI service is rate limited right now — try again in a moment." };
  return { mode: "policy_guidance", pointers: gen.pointers, sources: sourcesOf(hits), unsupportedFigures: gen.unsupportedFigures };
}

export async function handleComparison(input: OrchestratorInput): Promise<OrchestratorResult> {
  const decision = activeDecision(input.state);
  const hits = await retrieve(input.transcript, 3, input.scope);
  // No clauses or no active decision — fall back to a plain grounded answer rather than nothing.
  if (!hits.length || !decision) return handlePolicyGuidance(input);
  const gen = await generate(
    comparisonSystemInstruction(decision, readinessFor(decision, input.state), input.scope),
    hits,
    input.transcript,
  );
  if (!gen) return { mode: "comparison", note: "The AI service is rate limited right now — try again in a moment." };
  return {
    mode: "comparison",
    pointers: gen.pointers,
    sources: sourcesOf(hits),
    unsupportedFigures: gen.unsupportedFigures,
    comparing: true,
  };
}

export async function handleGuider(input: OrchestratorInput): Promise<OrchestratorResult> {
  // A guider only earns a model call when the remark names a concept/product — then its "benefits"
  // can be grounded in the clauses. A bare remark that names nothing gets NO retrieval and NO
  // generation: staying quiet beats spending a Gemini call on an ungrounded nudge.
  const named = conceptsMentioned(input.asked, conceptsForArea(input.scope));
  if (!named.length) return { mode: "keep_listening" };

  const hits = await retrieve(input.asked, 3, input.scope);
  const gen = await generate(guidanceSystemInstruction(input.scope), hits, input.transcript);
  if (!gen) return { mode: "keep_listening" };
  return { mode: "guider", pointers: gen.pointers, sources: sourcesOf(hits), unsupportedFigures: gen.unsupportedFigures };
}

export function handleKeepListening(): OrchestratorResult {
  return { mode: "keep_listening" };
}

export function handleTopicDrift(input: OrchestratorInput): OrchestratorResult {
  return {
    mode: "topic_drift",
    drift: { message: `That sounds outside the ${input.scope} discussion you set — steer back to it, or note it for follow-up.` },
  };
}

export function handleClarification(input: OrchestratorInput): OrchestratorResult {
  return {
    mode: "clarification",
    clarify: { question: input.asked, prompt: "That is a little open-ended — what should PRUAssist assume before it answers?" },
  };
}
