"use client";

import { useCallback, useRef, useState } from "react";
import { useLineStore, speechStatusFrom, type LocalSpeech } from "./useTranscript";
import { useDiarizedSpeech, type DiarizedResult, type PcmTap } from "./useDiarizedSpeech";
import { useBrowserSpeech, type SpeechResult, type SpeechStatus } from "./useBrowserSpeech";
import { deepgramEnabled, type DeepgramStatus } from "./useDeepgramSpeech";
import { looksLikeQuestion } from "./transcript";
import {
  splitRuns,
  attributeFinal,
  emptySpeakerMap,
  interimRole,
  noteProvisional,
  relabelPlan,
  type Role,
  type SpeakerMap,
  type ProvisionalBook,
} from "./diarize";
import { textCue } from "./speaker-cues";
import { useVoiceprint, type VoiceprintStatus } from "./useVoiceprint";

// In-person mode's speech source: one shared iPad mic, diarized by Deepgram, attributed to the rep or
// the customer and emitted as a LocalSpeech-compatible surface — so useTranscript(undefined, this),
// usePointers, useComprehension and the send rules all work UNCHANGED. The only in-person delta lives
// here, in the capture layer.
//
// Attribution is EVIDENCE-based: each diarized run is scored against the rep's on-device voiceprint and
// weighed with text cues, so the rep no longer has to speak first. The manual override ("who's
// speaking") always wins, and when the voice engine is unavailable (no profile, model not loaded) it
// degrades to text cues + the rep-first default — and, with Deepgram down entirely, to Web Speech driven
// purely by the toggle. A firm voice rebinding relabels the recent provisional lines it corrects.

export type InPersonSpeech = LocalSpeech & {
  engine: "deepgram" | "browser"; // browser = the manual-toggle degradation path
  activeRole: Role; // who interims/finals are currently attributed to
  override: Role | null; // manual "who's speaking"; null = auto (evidence decides)
  setOverride: (r: Role | null) => void;
  micPaused: boolean;
  status: DeepgramStatus | SpeechStatus;
  voiceStatus: VoiceprintStatus; // whether the rep's voiceprint is loaded and scoring
  swapSpeaker: (id: string) => void; // per-line correction
};

export function useInPersonSpeech(
  repName: string,
  customerName: string,
  enabled: boolean,
  opts?: { profile?: Float32Array | null },
): InPersonSpeech {
  const store = useLineStore();
  const { addFinal, setSpeakerInterim, clearInterim } = store;

  const mapRef = useRef<SpeakerMap>(emptySpeakerMap());
  const lastFinalRoleRef = useRef<Role | null>(null);
  const overrideRef = useRef<Role | null>(null);
  const bookRef = useRef<ProvisionalBook>({});
  const epochRef = useRef(0);
  const [override, setOverrideState] = useState<Role | null>(null);
  const [activeRoleState, setActiveRoleState] = useState<Role>("rep");

  const wantDeepgram = deepgramEnabled();
  const profile = opts?.profile ?? null;
  const voiceprint = useVoiceprint({ enabled: enabled && wantDeepgram, profile });
  const { status: voiceStatus, onPcm: vpOnPcm, scoreBetween: vpScore, liveVerdict: vpVerdict } = voiceprint;

  const setOverride = useCallback((r: Role | null) => {
    overrideRef.current = r;
    setOverrideState(r);
    if (r) setActiveRoleState(r);
  }, []);

  const nameFor = useCallback((role: Role) => (role === "rep" ? repName : customerName), [repName, customerName]);

  // Emit one final line, attributed; returns the new line id (for provisional relabelling). flag mirrors
  // the online rule: only a customer line can warrant a pointer.
  const emit = useCallback(
    (role: Role, text: string): string | undefined => {
      if (!text) return undefined;
      return addFinal(nameFor(role), text, role === "customer" && looksLikeQuestion(text));
    },
    [addFinal, nameFor],
  );

  const showInterim = useCallback(
    (role: Role, text: string) => {
      setSpeakerInterim(nameFor(role), text);
      clearInterim(nameFor(role === "rep" ? "customer" : "rep")); // one live line at a time
    },
    [setSpeakerInterim, clearInterim, nameFor],
  );

  // The tap wrapper records the current stream epoch (so a run's evidence window queries the right
  // connection) and forwards the frame to the voiceprint worker.
  const onPcm = useCallback<PcmTap>(
    (frame, tSec, epoch) => {
      epochRef.current = epoch;
      vpOnPcm(frame, tSec, epoch);
    },
    [vpOnPcm],
  );

  // Deepgram: split the final into per-speaker runs and attribute each with voice + text evidence;
  // interims use the override, the live voice verdict, then the last final's role.
  const onDiarized = useCallback(
    (r: DiarizedResult) => {
      if (r.isFinal) {
        const runs = splitRuns(r.words.length ? r.words : undefined);
        if (runs.length === 0) {
          // No diarized words (diarize hiccup / metadata) — attribute the whole line to the current
          // role rather than dropping it.
          const role = interimRole(overrideRef.current, lastFinalRoleRef.current, vpVerdict());
          if (r.transcript) {
            emit(role, r.transcript);
            lastFinalRoleRef.current = role;
            setActiveRoleState(overrideRef.current ?? role);
          }
        } else {
          const evidence = (run: { speakerIndex: number; text: string; start: number; end: number }) => ({
            voice: vpScore(epochRef.current, run.start, run.end),
            text: textCue(run.text, { repName, customerName }),
          });
          const res = attributeFinal(mapRef.current, runs, overrideRef.current, evidence);
          mapRef.current = res.map;
          const now = Date.now();
          for (const line of res.lines) {
            const id = emit(line.role, line.text);
            // Book a provisional (non-firm, auto) line so a later firm rebind can relabel it.
            if (id && line.provisional && overrideRef.current === null) {
              bookRef.current = noteProvisional(bookRef.current, line.speakerIndex, id, now);
            }
          }
          if (res.rebound.length) {
            const plan = relabelPlan(bookRef.current, res.rebound, now);
            bookRef.current = plan.book;
            for (const id of plan.swapIds) store.swapLocalSpeaker(id, repName, customerName);
          }
          if (res.lastRole) {
            lastFinalRoleRef.current = res.lastRole;
            setActiveRoleState(overrideRef.current ?? res.lastRole);
          }
        }
        clearInterim(repName);
        clearInterim(customerName);
      } else if (r.transcript) {
        showInterim(interimRole(overrideRef.current, lastFinalRoleRef.current, vpVerdict()), r.transcript);
      }
    },
    [emit, showInterim, clearInterim, repName, customerName, store, vpScore, vpVerdict],
  );

  // Web Speech fallback: no diarization, so the manual toggle is the sole source of truth.
  const onBrowser = useCallback(
    ({ final, interim }: SpeechResult) => {
      const role = overrideRef.current ?? lastFinalRoleRef.current ?? "rep";
      if (final) {
        emit(role, final);
        lastFinalRoleRef.current = role;
        setActiveRoleState(role);
        clearInterim(repName);
        clearInterim(customerName);
      }
      if (interim) showInterim(role, interim);
    },
    [emit, showInterim, clearInterim, repName, customerName],
  );

  const { status: dgStatus, micPaused } = useDiarizedSpeech(enabled && wantDeepgram, onDiarized, { onPcm });
  const deepgramDown = dgStatus === "unconfigured" || dgStatus === "error";
  const browserStatus = useBrowserSpeech(enabled && (!wantDeepgram || deepgramDown), onBrowser);

  const engine: "deepgram" | "browser" = wantDeepgram && !deepgramDown ? "deepgram" : "browser";
  const status: DeepgramStatus | SpeechStatus = engine === "deepgram" ? dgStatus : browserStatus;
  const speech: SpeechStatus = engine === "deepgram" ? speechStatusFrom(dgStatus) : browserStatus;

  const swapSpeaker = useCallback((id: string) => store.swapLocalSpeaker(id, repName, customerName), [store, repName, customerName]);

  return {
    // LocalSpeech surface (consumed by useTranscript)
    localLines: store.lines,
    localInterim: store.interim,
    speech,
    addFinal: store.addFinal,
    setSpeakerInterim: store.setSpeakerInterim,
    editLocalLine: store.editLocalLine,
    // in-person extras
    engine,
    activeRole: override ?? activeRoleState,
    override,
    setOverride,
    micPaused: engine === "deepgram" ? micPaused : false,
    status,
    voiceStatus: engine === "deepgram" ? voiceStatus : "off",
    swapSpeaker,
  };
}
