import { conceptsForArea } from "../concepts";
import { callsMade, MAX_BACKGROUND_CALLS, MAX_TOOL_STEPS, resetCallCount } from "./gemini";
import { gradeTeachBacks } from "./judge";
import { applyActs, applyDetections, chooseAlert, drainActs, loadState, sameAlert, saveState } from "./ledger";
import { prepareLookahead } from "./lookahead";
import { runSignals } from "./signals";
import type { AgentState, Turn } from "./types";

// The deep pass. It runs after the response to /api/agent/state has already been sent, so nothing
// in here is on the rep's critical path — the fast path is exactly as quick as it was before.
//
// Three stages, in order of how much they cost:
//   1. deterministic detectors over the new turns (embeddings, cheap)
//   2. explain-back grading, only for teach-backs the rep actually asked (one model call each)
//   3. lookahead preparation for the riskiest open concept (a tool loop — the expensive one)

// One pass per room per this interval. The deep pass costs embedding calls, and a rapid-fire
// conversation would otherwise fan out one pass per utterance.
const MIN_INTERVAL_MS = 5_000;

// Lookahead is the expensive stage, and the answer it prepares stays useful for a while. This is
// the ceiling on how often it may run per room, independent of how often the ledger changes.
const LOOKAHEAD_MIN_MS = 25_000;

// How much conversation the lookahead sees. It needs the shape of the discussion, not all of it.
const LOOKAHEAD_CONTEXT_TURNS = 8;

// `force` is for the flush when the rep ends the session: the record is the deliverable, so the
// last exchange must be scored even if a pass ran a second ago.
export type DeepInput = { roomId: string; productArea: string; turns: Turn[]; force?: boolean };

export type DeepOutcome =
  | { ran: false; reason: "disabled" | "debounced" | "no-concepts" | "no-new-turns" | "write-lost" }
  | { ran: true; state: AgentState; detections: number; graded: number; prepared: boolean; spent: number };

export function deepEnabled(): boolean {
  return process.env.PRUASSIST_DEEP !== "0";
}

// Lookahead has its own switch: it is the costly stage, and turning it off leaves comprehension
// tracking fully working.
export function lookaheadEnabled(): boolean {
  return deepEnabled() && process.env.PRUASSIST_LOOKAHEAD !== "0";
}

export async function deepPass({ roomId, productArea, turns, force }: DeepInput): Promise<DeepOutcome> {
  if (!deepEnabled()) return { ran: false, reason: "disabled" };

  const pool = conceptsForArea(productArea);
  if (!pool.length) return { ran: false, reason: "no-concepts" };

  const loaded = await loadState(roomId, productArea);
  if (!force && loaded.updatedAt && Date.now() - loaded.updatedAt < MIN_INTERVAL_MS) {
    return { ran: false, reason: "debounced" };
  }

  // Rep actions are folded in before scoring, so a teach-back asked a second ago already
  // suppresses the alert this pass would otherwise re-raise — and is available to the grader.
  const state = applyActs(loaded, await drainActs(roomId));

  const ordered = [...turns].sort((a, b) => a.at - b.at);
  const from = ordered.findIndex((t) => t.at > state.cursorAt);
  if (from === -1) return { ran: false, reason: "no-new-turns" };

  resetCallCount();
  const budgetLeft = MAX_BACKGROUND_CALLS - state.backgroundCalls;

  const { detections, degraded } = await runSignals(ordered, pool, from);

  // Graded last so it lands after the detectors for the same turn: applyDetections sorts by turn
  // index and is stable, so a judgement made against the clause overrides a similarity score.
  const graded = budgetLeft >= 2 ? await gradeTeachBacks(state, ordered) : [];

  const folded = applyDetections(state, [...detections, ...graded]);
  const alert = chooseAlert(folded);
  const changed = detections.length > 0 || graded.length > 0 || !sameAlert(alert, state.alert);

  let next: AgentState = {
    ...folded,
    alert,
    degraded,
    cursorAt: ordered[ordered.length - 1].at,
    updatedAt: Date.now(),
    rev: changed ? folded.rev + 1 : folded.rev,
  };

  // Prepare the likeliest next question only once the ledger has something to reason from, and
  // never more often than the ceiling above.
  let prepared = false;
  const canPrepare = budgetLeft - callsMade() >= MAX_TOOL_STEPS + 2;
  if (lookaheadEnabled() && changed && canPrepare && Date.now() - next.lookaheadTriedAt >= LOOKAHEAD_MIN_MS) {
    const recent = ordered
      .slice(-LOOKAHEAD_CONTEXT_TURNS)
      .map((t) => `${t.role === "rep" ? "Rep" : "Customer"}: ${t.text}`)
      .join("\n");
    try {
      const look = await prepareLookahead(next, recent);
      next = { ...next, lookahead: look ?? next.lookahead, lookaheadTriedAt: Date.now() };
      prepared = look !== null && look !== state.lookahead;
    } catch (e) {
      // Never let speculative work take the ledger down with it.
      console.error(`[agent] lookahead failed for ${roomId}:`, e);
      next = { ...next, lookaheadTriedAt: Date.now() };
    }
  }

  const spent = callsMade();
  next = { ...next, backgroundCalls: next.backgroundCalls + spent };
  if (budgetLeft > 0 && budgetLeft - spent <= 0) {
    console.warn(`[agent] ${roomId} background call budget spent; detectors continue without the model`);
  }

  const written = await saveState(next, loaded.rev);
  if (!written) return { ran: false, reason: "write-lost" };
  return { ran: true, state: next, detections: detections.length, graded: graded.length, prepared, spent };
}
