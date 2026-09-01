// In-person mode's attribution core. No React, no I/O — so the rule that decides whether a diarized
// word belongs to the rep or the customer can be checked without a browser or a live Deepgram socket.
//
// Deepgram streaming diarization is anonymous: it tells us THAT two voices differ (a per-word integer
// `speaker` index), never WHICH one is the advisor, gives no per-word confidence, and does not promise
// the indices stay stable across a session. So the mapping index → role is built here, calibrated from
// "the rep speaks first" (they read the consent script), and every unknown index defaults to the
// customer — the safe direction, since a rep line wrongly booked as customer comprehension is the one
// failure the product cannot ship. A manual override always wins, and on a single-run final it rebinds
// the index so a mid-session relabel is recoverable.

export type Role = "rep" | "customer";

// One diarized word as it arrives on the live socket: `channel.alternatives[0].words[]`. `speaker` is
// the per-word integer index; it is absent on non-diarized or metadata frames. `punctuated_word`
// carries smart-formatting (capitalisation, punctuation) and is preferred for display when present.
export type DiarizedWord = {
  word: string;
  punctuated_word?: string;
  speaker?: number;
  start: number;
  end: number;
};

// A maximal run of consecutive words sharing one speaker index, collapsed into one line of text.
export type SpeakerRun = { speakerIndex: number; text: string; start: number; end: number };

// The switch for the docs contradiction (§3.1 of docs/in-person-mode-research.md): the hosted
// streaming reference marks `diarize` deprecated in favour of `diarize_model`, while the self-hosted
// changelog says streaming rejects `diarize_model` with a 400. `diarize=true` is accepted by both, so
// it is the safe default; flip this one constant to `diarize=true&diarize_model=latest` if the empirical
// check (diarize:check) shows the hosted socket wants it.
export const DIARIZE_PARAMS = "diarize=true";

// Group a diarized final's words into consecutive same-speaker runs. Words without a speaker index
// (diarization off, or a metadata frame) are unattributable and skipped; an empty or missing list, or
// a list where nothing carries a speaker, yields no runs — the console must never throw on an
// unexpected frame.
export function splitRuns(words: DiarizedWord[] | undefined): SpeakerRun[] {
  if (!words || words.length === 0) return [];
  const runs: SpeakerRun[] = [];
  for (const w of words) {
    if (typeof w.speaker !== "number") continue;
    const text = (w.punctuated_word ?? w.word ?? "").trim();
    const last = runs[runs.length - 1];
    if (last && last.speakerIndex === w.speaker) {
      last.text = [last.text, text].filter(Boolean).join(" ");
      last.end = w.end;
    } else {
      runs.push({ speakerIndex: w.speaker, text, start: w.start, end: w.end });
    }
  }
  return runs;
}

// The learned binding from speaker index → role, plus whether the rep anchor has been set yet.
export type SpeakerMap = { assigned: Record<number, Role>; calibrated: boolean };

export function emptySpeakerMap(): SpeakerMap {
  return { assigned: {}, calibrated: false };
}

function hasRep(assigned: Record<number, Role>): boolean {
  for (const k in assigned) if (assigned[k] === "rep") return true;
  return false;
}

/**
 * Attribute one diarized final. Pure: takes the current map, returns the emitted lines and the next
 * map (the input is not mutated).
 *
 * - Calibration (override null): the first index ever seen binds to "rep" (the rep speaks first — the
 *   consent script); the next new index binds to "customer"; any later unknown index defaults to
 *   "customer" (matches transcript.ts's "everyone who is not the rep is the customer").
 * - Override (non-null): forces every emitted line's role. On a SINGLE-run final it also rebinds that
 *   run's index to the override, so the rep tapping "customer" mid-session repairs a relabel going
 *   forward. On a MULTI-run final it forces the display roles but leaves the map untouched (we cannot
 *   know which of several indices the tap referred to).
 */
export function attributeFinal(
  map: SpeakerMap,
  runs: SpeakerRun[],
  override: Role | null,
): { lines: { role: Role; text: string }[]; map: SpeakerMap; lastRole: Role | null } {
  const assigned: Record<number, Role> = { ...map.assigned };
  const lines: { role: Role; text: string }[] = [];

  for (const run of runs) {
    let role: Role;
    if (override !== null) {
      role = override;
    } else if (assigned[run.speakerIndex] !== undefined) {
      role = assigned[run.speakerIndex];
    } else {
      role = hasRep(assigned) ? "customer" : "rep";
      assigned[run.speakerIndex] = role;
    }
    lines.push({ role, text: run.text });
  }

  if (override !== null && runs.length === 1) {
    assigned[runs[0].speakerIndex] = override; // single-run relabel recovery
  }

  const calibrated = map.calibrated || hasRep(assigned);
  const lastRole = lines.length ? lines[lines.length - 1].role : null;
  return { lines, map: { assigned, calibrated }, lastRole };
}

// Which role an interim (not-yet-final) line should display under. Interims never consult the per-word
// speaker index — it is least reliable early in an utterance — so: the override if set, else whoever
// the last final was attributed to, else the rep (the calibration phase, before anyone else has
// spoken).
export function interimRole(override: Role | null, lastFinalRole: Role | null): Role {
  return override ?? lastFinalRole ?? "rep";
}
