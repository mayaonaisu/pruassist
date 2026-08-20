import { conceptsForArea } from "../concepts";
import { callsMade, MAX_BACKGROUND_CALLS, MAX_TOOL_STEPS, resetCallCount } from "./gemini";
import { applyActs, drainActs, loadState, saveState } from "./ledger";
import { prepareLookahead } from "./lookahead";
import { scorePass } from "./score";
import type { AgentState, Turn } from "./types";

// The deep pass. It runs after the response to /api/agent/state has already been sent, so nothing
// in here is on the rep's critical path — the fast path is exactly as quick as it was before.
//
// This module is the I/O around the scoring: the store, the acts queue, the debounce, the revision
// counter, the call budget and the lookahead. The scoring itself is `scorePass`, which the replay
// harness also calls — so the fixtures exercise the pipeline rather than a copy of it.

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

  resetCallCount();
  const budgetLeft = MAX_BACKGROUND_CALLS - state.backgroundCalls;
  const ordered = [...turns].sort((a, b) => a.at - b.at);

  const scored = await scorePass({ state, turns: ordered, pool, budget: budgetLeft });
  if (scored.scoredFrom === -1) return { ran: false, reason: "no-new-turns" };

  // rev exists so the client can poll cheaply — that is this module's concern, not the scorer's.
  let next: AgentState = {
    ...scored.state,
    updatedAt: Date.now(),
    rev: scored.changed ? scored.state.rev + 1 : scored.state.rev,
  };

  // Prepare the likeliest next question only once the ledger has something to reason from, and
  // never more often than the ceiling above.
  let prepared = false;
  const canPrepare = budgetLeft - callsMade() >= MAX_TOOL_STEPS + 2;
  if (lookaheadEnabled() && scored.changed && canPrepare && Date.now() - next.lookaheadTriedAt >= LOOKAHEAD_MIN_MS) {
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
  return {
    ran: true,
    state: next,
    detections: scored.detections.length,
    graded: scored.detections.filter((d) => d.kind === "explain-back").length,
    prepared,
    spent,
  };
}
