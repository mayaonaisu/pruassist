// In-person mode's attribution core. No React, no I/O — so the rule that decides whether a diarized
// word belongs to the rep or the customer can be checked without a browser or a live Deepgram socket.
//
// Deepgram streaming diarization is anonymous: it tells us THAT two voices differ (a per-word integer
// `speaker` index), never WHICH one is the advisor, gives no per-word confidence, and does not promise
// the indices stay stable across a session. Run-aligned voice evidence carries `sec`; decisive evidence
// outranks index memory and text, and each emitted line records its `LineSource` and gap for diagnostics.
// `engineReady` keeps rep-first confined to the no-engine degradation path, while manual overrides
// always win and can rebind an index when Deepgram changes its assignment.

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

// Voiceprint evidence over a run's audio window. `mean`/`n` are the similarity to the REP's enrolled
// voiceprint (cosine in [-1, 1]) and how many scored windows fed it. `custMean`/`custN` are the same
// against the session's learned CUSTOMER centroid, present only once that centroid has been seeded — so
// attribution can decide by which voice a run is CLOSER to (a margin), which is robust to loudness / mic
// distance / room in a way an absolute threshold is not.
export type VoiceEvidence = { mean: number; n: number; sec?: number; custMean?: number | null; custN?: number };

// Text-cue votes for one run (see speaker-cues.ts). Summed across an index's runs before deciding.
export type TextCue = { repVotes: number; customerVotes: number };

// What the caller can supply per run. Either half may be absent (engine off, run too short, no cues).
export type SpeakerEvidence = { voice?: VoiceEvidence | null; text?: TextCue | null };

// Accumulated evidence for one speaker index across the runs seen so far. custSum/custN accumulate the
// customer-centroid similarity, parallel to voiceSum/voiceN for the rep.
export type SpeakerStats = {
  voiceSum: number; voiceN: number; custSum: number; custN: number; textRep: number; textCust: number; runs: number;
  voiceRecent: number[];
  custRecent: (number | null)[];
  contrary: number;
};

export type LineSource = "override" | "voice-strong" | "voice-index" | "text" | "prior" | "default";

// The learned binding index → role. `firm` marks a binding made by voice or the manual override, which
// text and the no-evidence default may never overwrite; a provisional binding (text/default) may. `stats`
// carries the accumulated evidence. `calibrated` = a firm rep anchor exists.
export type SpeakerMap = {
  assigned: Record<number, Role>;
  firm: Record<number, boolean>;
  stats: Record<number, SpeakerStats>;
  calibrated: boolean;
  lastRole?: Role | null;
};

export function emptySpeakerMap(): SpeakerMap {
  return { assigned: {}, firm: {}, stats: {}, calibrated: false, lastRole: null };
}

// Thresholds. voiceHi/Lo bracket the cosine similarity that counts as rep/customer BEFORE a customer
// centroid exists (the absolute fallback); voiceMargin is how much closer to the rep than to the
// customer a run must be ONCE the centroid exists (the robust, relative decision). voiceMinN is how many
// scored windows a verdict needs; flipMinN is the (larger) count needed to overturn a FIRM binding
// (hysteresis); textMargin is the vote gap a text verdict needs. The 0.5 / 0.3 absolute guidance is the
// reference package's; the relative margin is what the "test your voice" / in-console meters help tune.
export type AttributeOpts = {
  voiceHi: number; voiceLo: number; voiceMargin: number; strongMargin: number;
  voiceMinN: number; minVoicedSec: number; recentK: number; flipMinN: number; flipRuns: number;
  textMargin: number; engineReady: boolean;
};
export const DEFAULT_ATTRIBUTE_OPTS: AttributeOpts = {
  voiceHi: 0.5, voiceLo: 0.3, voiceMargin: 0.05, strongMargin: 0.15,
  voiceMinN: 1, minVoicedSec: 0.6, recentK: 6, flipMinN: 4, flipRuns: 2,
  textMargin: 2, engineReady: false,
};

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
  return {
    voiceSum: 0, voiceN: 0, custSum: 0, custN: 0, textRep: 0, textCust: 0, runs: 0,
    voiceRecent: [], custRecent: [], contrary: 0,
  };
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
  lines: { role: Role; text: string; speakerIndex: number; provisional: boolean; source: LineSource; gap: number | null }[];
  map: SpeakerMap;
  lastRole: Role | null;
  rebound: Rebind[];
} {
  const assigned: Record<number, Role> = { ...map.assigned };
  const firm: Record<number, boolean> = { ...map.firm };
  const stats: Record<number, SpeakerStats> = {};
  for (const k of Object.keys(map.stats)) {
    const prior = map.stats[Number(k)];
    stats[Number(k)] = { ...prior, voiceRecent: [...prior.voiceRecent], custRecent: [...prior.custRecent] };
  }

  const rebound: Rebind[] = [];
  const lines: { role: Role; text: string; speakerIndex: number; provisional: boolean; source: LineSource; gap: number | null }[] = [];

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
      if (ev.voice.custMean != null && ev.voice.custN) {
        s.custSum += ev.voice.custMean * ev.voice.custN;
        s.custN += ev.voice.custN;
      }
      s.voiceRecent.push(ev.voice.mean);
      s.custRecent.push(ev.voice.custMean ?? null);
      s.voiceRecent = s.voiceRecent.slice(-opts.recentK);
      s.custRecent = s.custRecent.slice(-opts.recentK);
    }
    if (ev?.text) {
      s.textRep += ev.text.repVotes;
      s.textCust += ev.text.customerVotes;
    }

    if (override !== null) {
      // Display forced. A single-run rebind is applied after the loop (today's semantics).
      const gap = ev?.voice ? (ev.voice.custMean != null ? ev.voice.mean - ev.voice.custMean : ev.voice.mean) : null;
      lines.push({ role: override, text: run.text, speakerIndex: idx, provisional: false, source: "override", gap });
      continue;
    }

    const prior = assigned[idx];
    const priorFirm = firm[idx] ?? false;

    let runRole: Role | null = null;
    let weakRole: Role | null = null;
    const gap = ev?.voice ? (ev.voice.custMean != null ? ev.voice.mean - ev.voice.custMean : ev.voice.mean) : null;
    if (ev?.voice && ev.voice.sec != null && ev.voice.sec >= opts.minVoicedSec) {
      if (ev.voice.custMean != null) {
        const runGap = ev.voice.mean - ev.voice.custMean;
        if (Math.abs(runGap) >= opts.strongMargin) runRole = runGap > 0 ? "rep" : "customer";
        else if (Math.abs(runGap) >= opts.voiceMargin) weakRole = runGap > 0 ? "rep" : "customer";
      } else {
        if (ev.voice.mean >= opts.voiceHi) runRole = "rep";
        else if (ev.voice.mean <= opts.voiceLo) runRole = "customer";
      }
    }

    if (runRole) {
      if (prior === undefined || !priorFirm || prior === runRole) {
        bind(idx, runRole, true);
        s.contrary = 0;
      } else {
        s.contrary += 1;
        if (s.contrary >= opts.flipRuns) {
          bind(idx, runRole, true);
          s.contrary = 0;
        }
      }
      lines.push({ role: runRole, text: run.text, speakerIndex: idx, provisional: false, source: "voice-strong", gap });
      continue;
    }

    let voiceRole: Role | null = null;
    if (s.voiceRecent.length >= opts.voiceMinN) {
      const repMean = s.voiceRecent.reduce((sum, value) => sum + value, 0) / s.voiceRecent.length;
      if (s.custRecent.every((value) => value !== null)) {
        const custMean = (s.custRecent as number[]).reduce((sum, value) => sum + value, 0) / s.custRecent.length;
        const recentGap = repMean - custMean;
        if (recentGap >= opts.voiceMargin) voiceRole = "rep";
        else if (recentGap <= -opts.voiceMargin) voiceRole = "customer";
      } else {
        if (repMean >= opts.voiceHi) voiceRole = "rep";
        else if (repMean <= opts.voiceLo) voiceRole = "customer";
      }
    }
    voiceRole ??= weakRole;
    let textRole: Role | null = null;
    const d = s.textRep - s.textCust;
    if (Math.abs(d) >= opts.textMargin) textRole = d > 0 ? "rep" : "customer";

    let role: Role;
    let source: LineSource;
    let provisional: boolean;
    if (voiceRole) {
      if (prior === undefined || !priorFirm) {
        const firmFromMemory = s.voiceRecent.length >= 2 || (ev?.voice?.sec == null && s.voiceN >= 2);
        bind(idx, voiceRole, firmFromMemory);
        role = voiceRole;
        source = "voice-index";
      } else if (voiceRole !== prior && ev?.voice?.sec == null && s.voiceN >= opts.flipMinN) {
        bind(idx, voiceRole, true); // sustained contrary run clears hysteresis and flips a firm binding
        role = voiceRole;
        source = "voice-index";
      } else {
        role = prior; // one contrary window cannot flap a firm binding
        source = voiceRole === prior ? "voice-index" : "prior";
      }
      provisional = !(firm[idx] ?? false);
    } else if (textRole) {
      if (prior === undefined || !priorFirm) {
        bind(idx, textRole, false); // provisional — text can start or move a guess, never firm one
        role = textRole;
        source = "text";
      } else {
        role = prior; // text never overrides a firm (voice / override) binding
        source = "prior";
      }
      provisional = !(firm[idx] ?? false);
    } else if (prior !== undefined) {
      role = prior;
      source = "prior";
      provisional = !priorFirm;
    } else {
      const lastRoleSoFar = lines.length ? lines[lines.length - 1].role : map.lastRole ?? null;
      // With a voiceprint loaded and no rep-like evidence, a missed rep line is the safer, reversible error.
      role = opts.engineReady ? (lastRoleSoFar ?? "customer") : (someRep() ? "customer" : "rep");
      bind(idx, role, false); // rep-first default, but provisional and self-correcting
      source = "default";
      provisional = true;
    }

    lines.push({ role, text: run.text, speakerIndex: idx, provisional, source, gap });
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

  const lastRole = lines.length ? lines[lines.length - 1].role : map.lastRole ?? null;
  return { lines, map: { assigned, firm, stats, calibrated, lastRole }, lastRole, rebound };
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
