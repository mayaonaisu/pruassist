import type { Role, VoiceEvidence } from "./diarize";

// A short rolling buffer of voiceprint similarity scores, each covering a [t0, t1] window of audio on a
// given stream epoch. The worker posts these as it embeds 3 s windows; attribution reads them back to
// score a run's window (scoreBetween) and to tint interims live (recentVerdict). Pure and tested — the
// worker and the hook stay thin. Times are Deepgram's per-connection clock, so scores are keyed by
// epoch and never mixed across a reconnect.

export type ScoreSample = { epoch: number; t0: number; t1: number; score: number };

/**
 * Append a sample, dropping anything from an older epoch (a reconnect restarted the clock) and anything
 * more than `keepSec` behind the newest sample of this epoch. Keeps the ring bounded and epoch-clean.
 */
export function pushSample(ring: ScoreSample[], s: ScoreSample, keepSec = 120): ScoreSample[] {
  const kept = ring.filter((r) => r.epoch === s.epoch && s.t1 - r.t1 <= keepSec);
  return [...kept, s];
}

/**
 * Overlap-weighted mean similarity over the samples (in this epoch) intersecting [start, end], with `n`
 * the number of overlapping samples. null when nothing overlaps — the caller then leans on text cues.
 * Weighting by overlap keeps a run that only clips the edge of a window from being dominated by it.
 */
export function scoreBetween(ring: ScoreSample[], epoch: number, start: number, end: number): VoiceEvidence | null {
  let weighted = 0;
  let weight = 0;
  let n = 0;
  for (const s of ring) {
    if (s.epoch !== epoch) continue;
    const lo = Math.max(start, s.t0);
    const hi = Math.min(end, s.t1);
    const overlap = hi - lo;
    if (overlap <= 0) continue;
    weighted += s.score * overlap;
    weight += overlap;
    n += 1;
  }
  if (n === 0 || weight <= 0) return null;
  return { mean: weighted / weight, n };
}

// The verdict on the single most recent window of this epoch, for tinting the live interim line. null
// when there is no recent window (the latest ended more than `staleSec` before now) or it sits between
// the thresholds.
export function recentVerdict(
  ring: ScoreSample[],
  epoch: number,
  nowSec: number,
  hi: number,
  lo: number,
  staleSec = 4,
): Role | null {
  let latest: ScoreSample | null = null;
  for (const s of ring) {
    if (s.epoch !== epoch) continue;
    if (!latest || s.t1 > latest.t1) latest = s;
  }
  if (!latest || nowSec - latest.t1 > staleSec) return null;
  if (latest.score >= hi) return "rep";
  if (latest.score <= lo) return "customer";
  return null;
}
