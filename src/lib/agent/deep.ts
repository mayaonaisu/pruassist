import { conceptsForArea } from "../concepts";
import { applyActs, applyDetections, chooseAlert, drainActs, loadState, sameAlert, saveState } from "./ledger";
import { runSignals } from "./signals";
import type { AgentState, Turn } from "./types";

// The deep pass. It runs after the response to /api/assist has already been sent, so nothing in
// here is on the rep's critical path — the fast path is exactly as quick as it was before.

// One pass per room per this interval. The deep pass costs embedding calls, and a rapid-fire
// conversation would otherwise fan out one pass per utterance.
const MIN_INTERVAL_MS = 5_000;

// `force` is for the flush when the rep ends the session: the record is the deliverable, so the
// last exchange must be scored even if a pass ran a second ago.
export type DeepInput = { roomId: string; productArea: string; turns: Turn[]; force?: boolean };

export type DeepOutcome =
  | { ran: false; reason: "disabled" | "debounced" | "no-concepts" | "no-new-turns" | "write-lost" }
  | { ran: true; state: AgentState; detections: number };

export function deepEnabled(): boolean {
  return process.env.PRUASSIST_DEEP !== "0";
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
  // suppresses the alert this pass would otherwise re-raise.
  const state = applyActs(loaded, await drainActs(roomId));

  const ordered = [...turns].sort((a, b) => a.at - b.at);
  const from = ordered.findIndex((t) => t.at > state.cursorAt);
  if (from === -1) return { ran: false, reason: "no-new-turns" };

  const { detections, degraded } = await runSignals(ordered, pool, from);

  const folded = applyDetections(state, detections);
  const alert = chooseAlert(folded);
  const changed = detections.length > 0 || !sameAlert(alert, state.alert);

  const next: AgentState = {
    ...folded,
    alert,
    degraded,
    cursorAt: ordered[ordered.length - 1].at,
    updatedAt: Date.now(),
    rev: changed ? folded.rev + 1 : folded.rev,
  };

  const written = await saveState(next, loaded.rev);
  if (!written) return { ran: false, reason: "write-lost" };
  return { ran: true, state: next, detections: detections.length };
}
