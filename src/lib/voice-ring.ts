import type { Role, VoiceEvidence } from "./diarize";

// A short rolling buffer of voiceprint similarity scores, each covering a [t0, t1] window of audio on a
// given stream epoch. Each sample carries similarity to the REP's voiceprint (`score`) and, once the
// session's customer centroid has been seeded, to the CUSTOMER (`custSim`). Attribution reads these back
// to score a run's window (scoreBetween) and to tint interims live (recentVerdict). Pure and tested.
// Times are Deepgram's per-connection clock, so scores are keyed by epoch and never mixed across a
// reconnect.

export type ScoreSample = { epoch: number; t0: number; t1: number; score: number; custSim: number | null };

/**
 * Append a sample, dropping anything from an older epoch (a reconnect restarted the clock) and anything
 * more than `keepSec` behind the newest sample of this epoch. Keeps the ring bounded and epoch-clean.
 */
export function pushSample(ring: ScoreSample[], s: ScoreSample, keepSec = 120): ScoreSample[] {
  const kept = ring.filter((r) => r.epoch === s.epoch && s.t1 - r.t1 <= keepSec);
  return [...kept, s];
}

/**
 * Overlap-weighted mean similarities over the samples (in this epoch) intersecting [start, end]. `mean`
 * (rep) with `n` overlapping samples; `custMean`/`custN` over the subset that also carries a customer
 * similarity (null when none). null overall when nothing overlaps — the caller then leans on text cues.
 * Weighting by overlap keeps a run that only clips the edge of a window from being dominated by it.
 */
export function scoreBetween(ring: ScoreSample[], epoch: number, start: number, end: number): VoiceEvidence | null {
  let weighted = 0;
  let weight = 0;
  let n = 0;
  let custWeighted = 0;
  let custWeight = 0;
  let custN = 0;
  for (const s of ring) {
    if (s.epoch !== epoch) continue;
    const lo = Math.max(start, s.t0);
    const hi = Math.min(end, s.t1);
    const overlap = hi - lo;
    if (overlap <= 0) continue;
    weighted += s.score * overlap;
    weight += overlap;
    n += 1;
    if (s.custSim != null) {
      custWeighted += s.custSim * overlap;
      custWeight += overlap;
      custN += 1;
    }
  }
  if (n === 0 || weight <= 0) return null;
  return {
    mean: weighted / weight,
    n,
    custMean: custWeight > 0 ? custWeighted / custWeight : null,
    custN,
  };
}

// The verdict on the single most recent window of this epoch, for tinting the live interim line. Uses
// the rep-vs-customer margin when that window carries a customer similarity, else the absolute hi/lo.
// null when there is no recent window (older than `staleSec`) or it sits in the undecided band.
export function recentVerdict(
  ring: ScoreSample[],
  epoch: number,
  nowSec: number,
  hi: number,
  lo: number,
  staleSec = 4,
  margin = 0.05,
): Role | null {
  let latest: ScoreSample | null = null;
  for (const s of ring) {
    if (s.epoch !== epoch) continue;
    if (!latest || s.t1 > latest.t1) latest = s;
  }
  if (!latest || nowSec - latest.t1 > staleSec) return null;
  if (latest.custSim != null) {
    const gap = latest.score - latest.custSim;
    if (gap >= margin) return "rep";
    if (gap <= -margin) return "customer";
    return null;
  }
  if (latest.score >= hi) return "rep";
  if (latest.score <= lo) return "customer";
  return null;
}
