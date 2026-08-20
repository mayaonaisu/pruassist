import type { Concept } from "../concepts";
import { gradeTeachBacks } from "./judge";
import { applyDetections, chooseAlert, sameAlert } from "./ledger";
import { runSignals, type Detection } from "./signals";
import type { AgentState, Turn } from "./types";

// The scoring half of the deep pass: turns in, a folded ledger out. No store, no scheduling, no
// speculative work — everything in here is a pure function of the state and the turns it is given.
//
// It exists so there is exactly one statement of the pipeline. The replay harness used to restate
// it, which meant the fixtures could keep passing while quietly no longer covering what production
// does. The harness now calls this, so it cannot drift from it.
//
// `deepPass` keeps what the harness must not have: the store, the acts queue, the revision counter,
// the call budget and the lookahead.

export type ScoreInput = {
  state: AgentState;
  turns: Turn[];
  pool: Concept[];
  // Background model calls still available this session. Grading needs two; below that only the
  // deterministic detectors run. The caller supplies the number, this module applies the rule —
  // otherwise the harness could enable grading that production had already switched off.
  budget: number;
};

export type ScoreResult = {
  state: AgentState;
  detections: Detection[];
  degraded: boolean;
  changed: boolean;
  // Index of the first turn scored, or -1 when every turn is already behind the cursor.
  scoredFrom: number;
};

// Grading is one model call per outstanding teach-back, and it is worth reserving room for.
const GRADING_BUDGET = 2;

export async function scorePass({ state, turns, pool, budget }: ScoreInput): Promise<ScoreResult> {
  const ordered = [...turns].sort((a, b) => a.at - b.at);
  const scoredFrom = ordered.findIndex((t) => t.at > state.cursorAt);
  if (scoredFrom === -1) {
    return { state, detections: [], degraded: state.degraded, changed: false, scoredFrom };
  }

  const { detections, degraded } = await runSignals(ordered, pool, scoredFrom);

  // Graded last so it lands after the detectors for the same turn: applyDetections sorts by turn
  // index and is stable, so a judgement made against the clause overrides a similarity score.
  const graded = budget >= GRADING_BUDGET ? await gradeTeachBacks(state, ordered) : [];

  const all = [...detections, ...graded];
  const folded = applyDetections(state, all);
  const alert = chooseAlert(folded);

  return {
    state: { ...folded, alert, degraded, cursorAt: ordered[ordered.length - 1].at },
    detections: all,
    degraded,
    changed: all.length > 0 || !sameAlert(alert, state.alert),
    scoredFrom,
  };
}
