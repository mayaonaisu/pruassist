import type { LineSource, Role } from "./diarize";

export type VoiceLogEntry = {
  at: number; epoch: number; idx: number; text: string;
  sec: number | null; mean: number | null; custMean: number | null; gap: number | null;
  role: Role; source: LineSource; provisional: boolean; ms: number;
};

// Resolve failures and slow optional signals as null so they can never wedge transcript processing.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export function pushLog<T>(ring: readonly T[], entry: T, cap = 200): T[] {
  return [...ring, entry].slice(-cap);
}
