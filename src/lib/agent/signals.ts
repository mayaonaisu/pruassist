import { CONCEPTS, type Concept } from "../concepts";
import { buildContext, buildScorer, DETECTORS } from "./detectors";
import { conceptsMentioned } from "./utterance";
import type { Detection, Turn } from "./types";

// One sweep of the detectors over a transcript window.
//
// Every detector runs against every turn from `from` onwards and decides for itself whether it
// applies. There is no ordering between them and no short-circuit: what used to be a `continue`
// after a bare assent is now a fact on the context that each detector reads for itself.

export type SignalResult = { detections: Detection[]; degraded: boolean };

// `from` is the first turn not yet folded into the ledger. Earlier turns are still read, because
// re-ask and divergence both need the turns the customer is echoing.
export async function runSignals(
  turns: Turn[],
  pool: Concept[] = CONCEPTS,
  from = 0,
): Promise<SignalResult> {
  if (!turns.length || !pool.length) return { detections: [], degraded: false };

  const customerText = turns.filter((t) => t.role === "customer").map((t) => t.text);
  const targets = pool.flatMap((c) => [c.canonical, ...c.misconceptions]);
  const scorer = await buildScorer([...customerText, ...targets]);

  // Built over every turn, not just the new ones: divergence and re-ask look back past the cursor.
  const raisedBy = new Map<number, Concept[]>();
  turns.forEach((turn, i) => {
    if (turn.role !== "rep") return;
    const hits = conceptsMentioned(turn.text, pool);
    if (hits.length) raisedBy.set(i, hits);
  });

  const detections: Detection[] = [];
  for (let i = Math.max(0, from); i < turns.length; i++) {
    const ctx = buildContext(turns, i, pool, scorer, raisedBy);
    for (const detect of DETECTORS) detections.push(...detect(ctx));
  }

  return { detections, degraded: scorer.degraded };
}
