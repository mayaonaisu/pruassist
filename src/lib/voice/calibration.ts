export const MIN_SEPARATION = 0.2;

export function thresholdFor({ selfMean, otherMean }: { selfMean: number | null; otherMean: number | null }): number {
  const raw = selfMean != null && otherMean != null ? (selfMean + otherMean) / 2 : selfMean != null ? selfMean - 0.15 : 0.5;
  return Math.round(Math.min(0.95, Math.max(0.05, raw)) * 100) / 100;
}

export function separationWarning(selfMean: number | null, otherMean: number | null): string | null {
  // Decimal calibration values such as 0.7 - 0.5 can land one ulp below 0.2 in binary floats.
  if (selfMean == null || otherMean == null || selfMean - otherMean + 1e-9 >= MIN_SEPARATION) return null;
  const gap = (selfMean - otherMean).toFixed(2);
  return `Your voice and the other voice are only ${gap} apart. Re-record on the iPad at the distance you'll sit from it, then calibrate again.`;
}
