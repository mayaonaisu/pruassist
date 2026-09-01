import { conceptsForArea } from "../../concepts";
import { retrieve, type Hit } from "../../retrieval";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "../gemini";
import { clauseBlock, comparisonSystemInstruction, guidanceSystemInstruction, HOUSE_RULES, pointerSystemInstruction, POSTURE } from "../prompts";
import { groqEnabled, groqGatherClauses, groqGenerateRaw } from "../groq";
import { openaiEnabled, openaiGatherClauses, openaiJson } from "../openai";
import { activeDecision, readinessFor } from "../readiness";
import { runToolLoop } from "../tools";
import { conceptsMentioned } from "../utterance";
import { unsupportedFigures } from "../verify";
import { runGeneration } from "./generation";
import type { OrchestratorInput, OrchestratorResult, Pointers } from "./types";

// The mode handlers. The generating ones (policy / comparison / guider) run the two-phase pattern:
// an agentic tool loop gathers the evidence (the model decides what to search and whether to read
// the ledger), then a structured generation writes the pointers over those clauses and the
// deterministic figure check labels anything ungrounded. The lighter modes return a payload the
// console renders without a model call.

const str = (v: unknown) => (typeof v === "string" ? v : "");
const sourcesOf = (hits: Hit[]) => hits.map((h) => ({ source: h.source, snippet: h.text.slice(0, 150) }));

const NO_CLAUSE_NOTE = "No policy clause covers this yet — keep listening, or ask the customer to be more specific.";
const RATE_LIMIT_NOTE = "The AI service is rate limited right now — try again in a moment.";

const GATHER_INSTRUCTION =
  `${POSTURE} ${HOUSE_RULES} The representative needs to answer the customer's latest turn. You MUST ` +
  `call search_policy at least once — never stop without searching first — for the clauses that ` +
  `answer it, and read the ledger only if it helps you decide what to look up. Gather the clauses, ` +
  `then stop — do not write the reply itself.`;

// The agentic live path is on by default; PRUASSIST_AGENTIC_LIVE=0 turns the tool loop off and the
// live handlers fall back to a single retrieve — a quota safety valve, since the tool loop spends
// several model calls per turn where a plain retrieve spends one.
export const agenticLiveEnabled = (): boolean => process.env.PRUASSIST_AGENTIC_LIVE !== "0";

// Phase 1 of the generating path: let the model choose what to retrieve. Falls back to the plain
// deterministic retrieve the handlers used before — the flag being off, a null loop (no Gemini key),
// or an empty gather must never leave the rep with nothing when a straight lookup would have found one.
export async function gatherClauses(input: OrchestratorInput, hint?: string): Promise<Hit[]> {
  if (!agenticLiveEnabled()) return retrieve(input.transcript, 3, input.scope);
  const task =
    `The representative is discussing ${input.scope}.${hint ? ` ${hint}` : ""} Recent conversation:\n` +
    `${input.transcript}\n\nGather the clauses that answer the customer's latest turn, then stop.`;
  const ctx = { state: input.state, productArea: input.scope };
  // Provider precedence: Groq (fast LPU) → OpenAI → Gemini. All fall back to a plain retrieve so an
  // empty or failed gather never leaves the rep with nothing.
  if (groqEnabled()) {
    const cited = await groqGatherClauses(GATHER_INSTRUCTION, task, ctx, 2);
    return cited.length ? cited : retrieve(input.transcript, 3, input.scope);
  }
  if (openaiEnabled()) {
    const { cited } = await openaiGatherClauses(GATHER_INSTRUCTION, task, ctx, 2);
    return cited.length ? cited : retrieve(input.transcript, 3, input.scope);
  }
  // Live path: rotate keys under a rate limit, never sleep — the rep is waiting inside maxDuration.
  // One step with thinking off keeps the agentic gather (the model still picks the query) fast
  // enough for a live turn; a full loop with dynamic thinking was 13s+ and hit the function budget.
  const gathered = await runToolLoop(GATHER_INSTRUCTION, task, ctx, { allowSleep: false, maxSteps: 1, think: "off" });
  if (gathered && gathered.run.cited.length) return gathered.run.cited;
  return retrieve(input.transcript, 3, input.scope);
}

// Provider-branched raw JSON getter: Groq (fast, OpenAI-compatible) primary, Gemini fallback. Groq's
// free tier caps tokens-per-minute on a single key, so a throttle (429) or error falls through to
// Gemini rather than failing the turn. The caller shapes both identically, so grounding is shared.
async function generateRaw(instruction: string, hits: Hit[], transcript: string): Promise<string | null> {
  if (groqEnabled()) {
    const groq = await groqGenerateRaw(instruction, clauseBlock(hits), transcript);
    if (groq !== null) return groq;
    // Groq unavailable — fall through to OpenAI, then Gemini, rather than drop to a rate-limit note.
  }
  if (openaiEnabled()) {
    const oa = await openaiJson(instruction, `POLICY CLAUSES:\n${clauseBlock(hits)}\n\nRECENT TRANSCRIPT:\n${transcript}`, JSON_BUDGET);
    if (oa !== null) return oa;
  }
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
  return response ? (response.text ?? "") : null;
}

async function generate(
  instruction: string,
  hits: Hit[],
  transcript: string,
): Promise<{ pointers: Pointers; unsupportedFigures: string[] } | null> {
  const raw = await generateRaw(instruction, hits, transcript);
  if (raw === null) return null;

  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse(raw.trim());
  } catch {
    p = { explainer: raw.trim() };
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

export async function handlePolicyGuidance(input: OrchestratorInput, preGathered?: Hit[]): Promise<OrchestratorResult> {
  if (preGathered?.length) {
    // Pre-gathered hits from speculative parallel gather — skip the subgraph's gather step and
    // run a single generate+verify pass. The pre-gather already searched; re-searching for a retry
    // is not worth the latency when the hits were free.
    const gen = await generate(pointerSystemInstruction(input.scope), preGathered, input.transcript);
    if (!gen) return { mode: "policy_guidance", note: RATE_LIMIT_NOTE };
    return { mode: "policy_guidance", pointers: gen.pointers, sources: sourcesOf(preGathered), unsupportedFigures: gen.unsupportedFigures };
  }
  const result = await runGeneration(
    input,
    pointerSystemInstruction(input.scope),
    gatherClauses,
    (instr, hits, transcript) => generate(instr, hits, transcript),
  );
  if (!result.hits.length) return { mode: "policy_guidance", note: NO_CLAUSE_NOTE };
  if (!result.pointers) return { mode: "policy_guidance", note: RATE_LIMIT_NOTE };
  return { mode: "policy_guidance", pointers: result.pointers, sources: sourcesOf(result.hits), unsupportedFigures: result.unsupported };
}

export async function handleComparison(input: OrchestratorInput): Promise<OrchestratorResult> {
  const decision = activeDecision(input.state);
  const hint = decision ? `The customer is weighing: ${decision.question}` : undefined;
  const result = await runGeneration(
    input,
    decision
      ? comparisonSystemInstruction(decision, readinessFor(decision, input.state), input.scope)
      : pointerSystemInstruction(input.scope),
    gatherClauses,
    (instr, hits, transcript) => generate(instr, hits, transcript),
    hint,
  );
  if (!result.hits.length || !decision) return handlePolicyGuidance(input, result.hits);
  if (!result.pointers) return { mode: "comparison", note: RATE_LIMIT_NOTE };
  return {
    mode: "comparison",
    pointers: result.pointers,
    sources: sourcesOf(result.hits),
    unsupportedFigures: result.unsupported,
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
