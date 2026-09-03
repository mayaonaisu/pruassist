// In-person mode's attribution core. No React, no I/O — so the rule that decides whether a diarized
// word belongs to the rep or the customer can be checked without a browser or a live Deepgram socket.
//
// Deepgram streaming diarization is anonymous: it tells us THAT two voices differ (a per-word integer
// `speaker` index), never WHICH one is the advisor, gives no per-word confidence, and does not promise
// the indices stay stable across a session. So the mapping index → role is built here from EVIDENCE:
// per-run similarity to the rep's enrolled voiceprint (the primary signal), text cues as a fallback,
// and an always-wins manual override. With no evidence at all it degrades to the old "rep speaks first"
// default — but now provisionally and self-correcting, not as a hard assumption. A manual override
// always wins, and on a single-run final it rebinds the index so a mid-session relabel is recoverable.

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
// `start`/`end` are the run's word times on Deepgram's per-connection clock — the same clock the PCM
// tap stamps, so the voiceprint scorer can find the audio that produced this run.
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

/* ---------- evidence-based binding ---------- */

// Similarity to the rep's voiceprint over a run's audio window: the cumulative mean and how many
// scored windows fed it. (mean is cosine similarity in [-1, 1]; n weights it when folded into stats.)
export type VoiceEvidence = { mean: number; n: number };

// Text-cue votes for one run (see speaker-cues.ts). Summed across an index's runs before deciding.
export type TextCue = { repVotes: number; customerVotes: number };

// What the caller can supply per run. Either half may be absent (engine off, run too short, no cues).
export type SpeakerEvidence = { voice?: VoiceEvidence | null; text?: TextCue | null };

// Accumulated evidence for one speaker index across the runs seen so far.
export type SpeakerStats = { voiceSum: number; voiceN: number; textRep: number; textCust: number; runs: number };

// The learned binding index → role. `firm` marks a binding made by voice or the manual override, which
// text and the no-evidence default may never overwrite; a provisional binding (text/default) may. `stats`
// carries the accumulated evidence. `calibrated` = a firm rep anchor exists.
export type SpeakerMap = {
  assigned: Record<number, Role>;
  firm: Record<number, boolean>;
  stats: Record<number, SpeakerStats>;
  calibrated: boolean;
};

export function emptySpeakerMap(): SpeakerMap {
  return { assigned: {}, firm: {}, stats: {}, calibrated: false };
}

// Thresholds. voiceHi/Lo bracket the cosine similarity that counts as rep/customer; voiceMinN is how
// many scored windows a verdict needs; flipMinN is the (larger) count needed to overturn a FIRM binding
// (hysteresis, so one contrary window cannot flap it); textMargin is the vote gap a text verdict needs.
// The 0.5 / 0.3 similarity guidance is the reference package's — the /rep/voice "test your voice" meter
// is the tool for tuning them to a room.
export type AttributeOpts = { voiceHi: number; voiceLo: number; voiceMinN: number; flipMinN: number; textMargin: number };
export const DEFAULT_ATTRIBUTE_OPTS: AttributeOpts = { voiceHi: 0.5, voiceLo: 0.3, voiceMinN: 2, flipMinN: 4, textMargin: 2 };

// The gap the in-person "Voice match" slider keeps between the rep threshold and the customer
// threshold — the dead zone that stops one borderline window from flip-flapping the binding.
export const VOICE_DEADZONE = 0.2;

// Build AttributeOpts from a single tunable rep-match threshold (the slider's value): similarity ≥ T is
// the rep, ≤ T − deadzone is the customer, in between defers to text cues. T is clamped to [-1, 1].
export function optsForThreshold(voiceHi: number, base: AttributeOpts = DEFAULT_ATTRIBUTE_OPTS): AttributeOpts {
  const hi = Math.max(-1, Math.min(1, voiceHi));
  return { ...base, voiceHi: hi, voiceLo: Math.max(-1, hi - VOICE_DEADZONE) };
}

// An index whose assignment changed from an existing (already-bound) value — the signal to relabel any
// lines already emitted under the old role.
export type Rebind = { speakerIndex: number; from: Role; to: Role };

function emptyStats(): SpeakerStats {
  return { voiceSum: 0, voiceN: 0, textRep: 0, textCust: 0, runs: 0 };
}

/**
 * Attribute one diarized final. Pure: takes the current map, returns the emitted lines and the next
 * map (the input is not mutated). Per run, after folding that run's evidence into stats[idx], the role
 * is decided in this order:
 *
 *   1. Override set → that role for display; a single-run final also rebinds the index (firm) so a
 *      mid-session relabel is recoverable. A multi-run override forces display roles but rebinds nothing
 *      (we cannot know which of several indices the tap meant).
 *   2. Voice (once voiceN ≥ voiceMinN): the cumulative mean ≥ voiceHi → rep, ≤ voiceLo → customer. It
 *      binds an unbound or provisional index firmly and immediately; it overturns a FIRM binding only
 *      with hysteresis (voiceN ≥ flipMinN and the mean decisively opposite).
 *   3. Text (no voice verdict): vote margin ≥ textMargin binds an unbound or provisional index
 *      provisionally, never a firm one.
 *   4. Already assigned → keep.
 *   5. No evidence, never seen → "customer" if some index is already rep, else "rep" (rep-first), marked
 *      provisional. With zero evidence the one failure the product cannot ship is a rep explanation
 *      booked as customer comprehension, so rep-first stays the default — but provisional and one ⇄ away.
 *
 * Binding an index to rep demotes any OTHER provisionally-rep index to customer (there is exactly one
 * rep), which is how the earlier default guess self-corrects once real rep evidence arrives. `rebound`
 * lists every index whose assignment changed from an existing value.
 */
export function attributeFinal(
  map: SpeakerMap,
  runs: SpeakerRun[],
  override: Role | null,
  evidence?: (run: SpeakerRun) => SpeakerEvidence,
  opts: AttributeOpts = DEFAULT_ATTRIBUTE_OPTS,
): {
  lines: { role: Role; text: string; speakerIndex: number; provisional: boolean }[];
  map: SpeakerMap;
  lastRole: Role | null;
  rebound: Rebind[];
} {
  const assigned: Record<number, Role> = { ...map.assigned };
  const firm: Record<number, boolean> = { ...map.firm };
  const stats: Record<number, SpeakerStats> = {};
  for (const k of Object.keys(map.stats)) stats[Number(k)] = { ...map.stats[Number(k)] };

  const rebound: Rebind[] = [];
  const lines: { role: Role; text: string; speakerIndex: number; provisional: boolean }[] = [];

  const someRep = (): boolean => {
    for (const k of Object.keys(assigned)) if (assigned[Number(k)] === "rep") return true;
    return false;
  };

  // Write a binding, recording a rebind when it changed an existing value, and keep the one-rep
  // invariant by demoting any other PROVISIONAL rep to customer.
  const bind = (idx: number, role: Role, firmVal: boolean) => {
    const prior = assigned[idx];
    if (prior !== undefined && prior !== role) rebound.push({ speakerIndex: idx, from: prior, to: role });
    assigned[idx] = role;
    firm[idx] = firmVal;
    if (role === "rep") {
      for (const k of Object.keys(assigned)) {
        const j = Number(k);
        if (j !== idx && assigned[j] === "rep" && !firm[j]) {
          rebound.push({ speakerIndex: j, from: "rep", to: "customer" });
          assigned[j] = "customer";
        }
      }
    }
  };

  for (const run of runs) {
    const idx = run.speakerIndex;
    const s = stats[idx] ?? (stats[idx] = emptyStats());
    s.runs += 1;
    const ev = evidence?.(run);
    if (ev?.voice && ev.voice.n > 0) {
      s.voiceSum += ev.voice.mean * ev.voice.n;
      s.voiceN += ev.voice.n;
    }
    if (ev?.text) {
      s.textRep += ev.text.repVotes;
      s.textCust += ev.text.customerVotes;
    }

    if (override !== null) {
      // Display forced. A single-run rebind is applied after the loop (today's semantics).
      lines.push({ role: override, text: run.text, speakerIndex: idx, provisional: false });
      continue;
    }

    const prior = assigned[idx];
    const priorFirm = firm[idx] ?? false;

    let voiceRole: Role | null = null;
    if (s.voiceN >= opts.voiceMinN) {
      const m = s.voiceSum / s.voiceN;
      if (m >= opts.voiceHi) voiceRole = "rep";
      else if (m <= opts.voiceLo) voiceRole = "customer";
    }
    let textRole: Role | null = null;
    const d = s.textRep - s.textCust;
    if (Math.abs(d) >= opts.textMargin) textRole = d > 0 ? "rep" : "customer";

    let role: Role;
    if (voiceRole) {
      if (prior === undefined || !priorFirm) {
        bind(idx, voiceRole, true);
        role = voiceRole;
      } else if (voiceRole !== prior && s.voiceN >= opts.flipMinN) {
        bind(idx, voiceRole, true); // sustained contrary run clears hysteresis and flips a firm binding
        role = voiceRole;
      } else {
        role = prior; // one contrary window cannot flap a firm binding
      }
    } else if (textRole) {
      if (prior === undefined || !priorFirm) {
        bind(idx, textRole, false); // provisional — text can start or move a guess, never firm one
        role = textRole;
      } else {
        role = prior; // text never overrides a firm (voice / override) binding
      }
    } else if (prior !== undefined) {
      role = prior;
    } else {
      role = someRep() ? "customer" : "rep";
      bind(idx, role, false); // rep-first default, but provisional and self-correcting
    }

    lines.push({ role, text: run.text, speakerIndex: idx, provisional: !(firm[idx] ?? false) });
  }

  if (override !== null && runs.length === 1) {
    bind(runs[0].speakerIndex, override, true); // single-run relabel recovery
  }

  let calibrated = map.calibrated;
  if (!calibrated) {
    for (const k of Object.keys(assigned)) {
      const j = Number(k);
      if (assigned[j] === "rep" && firm[j]) {
        calibrated = true;
        break;
      }
    }
  }

  const lastRole = lines.length ? lines[lines.length - 1].role : null;
  return { lines, map: { assigned, firm, stats, calibrated }, lastRole, rebound };
}

/* ---------- provisional relabel bookkeeping ---------- */

// Line ids emitted provisionally (no override) per speaker index, with when. A later firm rebind of an
// index relabels these — but only within a recent window, so an old line the rep has moved on from is
// left alone.
export type ProvisionalBook = Record<number, { id: string; at: number }[]>;
export const RELABEL_WINDOW_MS = 60_000;

// Record one provisional line for an index, pruning entries older than the window (relative to `at`).
export function noteProvisional(book: ProvisionalBook, speakerIndex: number, id: string, at: number): ProvisionalBook {
  const next: ProvisionalBook = { ...book };
  const kept = (next[speakerIndex] ?? []).filter((e) => at - e.at <= RELABEL_WINDOW_MS);
  next[speakerIndex] = [...kept, { id, at }];
  return next;
}

// Given the rebinds from one attributeFinal, the line ids to swap now (recent provisional lines on the
// rebound indices) and the book with those consumed and stale entries pruned.
export function relabelPlan(
  book: ProvisionalBook,
  rebound: Rebind[],
  now: number,
): { swapIds: string[]; book: ProvisionalBook } {
  const next: ProvisionalBook = { ...book };
  const swapIds: string[] = [];
  for (const rb of rebound) {
    const entries = (next[rb.speakerIndex] ?? []).filter((e) => now - e.at <= RELABEL_WINDOW_MS);
    for (const e of entries) swapIds.push(e.id);
    delete next[rb.speakerIndex]; // consumed — these lines have been relabeled
  }
  for (const k of Object.keys(next)) {
    const j = Number(k);
    const kept = next[j].filter((e) => now - e.at <= RELABEL_WINDOW_MS);
    if (kept.length) next[j] = kept;
    else delete next[j];
  }
  return { swapIds, book: next };
}

// Which role an interim (not-yet-final) line should display under. Interims never consult the per-word
// speaker index (least reliable early in an utterance): the override if set, else the live voiceprint
// verdict on the most recent scored window, else whoever the last final was, else the rep.
export function interimRole(override: Role | null, lastFinalRole: Role | null, liveVoice?: Role | null): Role {
  return override ?? liveVoice ?? lastFinalRole ?? "rep";
}
