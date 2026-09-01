"use client";

import { useCallback, useRef, useState } from "react";
import { useLineStore, speechStatusFrom, type LocalSpeech } from "./useTranscript";
import { useDiarizedSpeech, type DiarizedResult } from "./useDiarizedSpeech";
import { useBrowserSpeech, type SpeechResult, type SpeechStatus } from "./useBrowserSpeech";
import { deepgramEnabled, type DeepgramStatus } from "./useDeepgramSpeech";
import { looksLikeQuestion } from "./transcript";
import { splitRuns, attributeFinal, emptySpeakerMap, interimRole, type Role, type SpeakerMap } from "./diarize";

// In-person mode's speech source: one shared iPad mic, diarized by Deepgram, attributed to the rep or
// the customer and emitted as a LocalSpeech-compatible surface — so useTranscript(undefined, this),
// usePointers, useComprehension and the send rules all work UNCHANGED. The only in-person delta lives
// here, in the capture layer.
//
// Attribution is diarization-primary with an always-wins manual override (the "who's speaking" toggle
// in the rail). When Deepgram is unavailable, it degrades to Web Speech driven entirely by that toggle
// — no diarization, but the demo never dies.

export type InPersonSpeech = LocalSpeech & {
  engine: "deepgram" | "browser"; // browser = the manual-toggle degradation path
  activeRole: Role; // who interims/finals are currently attributed to
  override: Role | null; // manual "who's speaking"; null = auto (diarizer decides)
  setOverride: (r: Role | null) => void;
  micPaused: boolean;
  status: DeepgramStatus | SpeechStatus;
  swapSpeaker: (id: string) => void; // per-line correction
};

export function useInPersonSpeech(repName: string, customerName: string, enabled: boolean): InPersonSpeech {
  const store = useLineStore();
  const { addFinal, setSpeakerInterim, clearInterim } = store;

  const mapRef = useRef<SpeakerMap>(emptySpeakerMap());
  const lastFinalRoleRef = useRef<Role | null>(null);
  const overrideRef = useRef<Role | null>(null);
  const [override, setOverrideState] = useState<Role | null>(null);
  const [activeRoleState, setActiveRoleState] = useState<Role>("rep");

  const setOverride = useCallback((r: Role | null) => {
    overrideRef.current = r;
    setOverrideState(r);
    if (r) setActiveRoleState(r);
  }, []);

  const nameFor = useCallback((role: Role) => (role === "rep" ? repName : customerName), [repName, customerName]);

  // Emit one final line, attributed. flag mirrors the online rule: only a customer line can warrant a
  // pointer.
  const emit = useCallback(
    (role: Role, text: string) => {
      if (!text) return;
      addFinal(nameFor(role), text, role === "customer" && looksLikeQuestion(text));
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

  // Deepgram: split the final into per-speaker runs and map each to a role; interims are attributed to
  // the current active role (never the unstable per-word index).
  const onDiarized = useCallback(
    (r: DiarizedResult) => {
      if (r.isFinal) {
        const runs = splitRuns(r.words.length ? r.words : undefined);
        if (runs.length === 0) {
          // No diarized words on this final (diarize hiccup / metadata) — attribute the whole line to
          // the active role rather than dropping it.
          const role = interimRole(overrideRef.current, lastFinalRoleRef.current);
          if (r.transcript) {
            emit(role, r.transcript);
            lastFinalRoleRef.current = role;
            setActiveRoleState(overrideRef.current ?? role);
          }
        } else {
          const res = attributeFinal(mapRef.current, runs, overrideRef.current);
          mapRef.current = res.map;
          for (const line of res.lines) emit(line.role, line.text);
          if (res.lastRole) {
            lastFinalRoleRef.current = res.lastRole;
            setActiveRoleState(overrideRef.current ?? res.lastRole);
          }
        }
        clearInterim(repName);
        clearInterim(customerName);
      } else if (r.transcript) {
        showInterim(interimRole(overrideRef.current, lastFinalRoleRef.current), r.transcript);
      }
    },
    [emit, showInterim, clearInterim, repName, customerName],
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

  const wantDeepgram = deepgramEnabled();
  const { status: dgStatus, micPaused } = useDiarizedSpeech(enabled && wantDeepgram, onDiarized);
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
    swapSpeaker,
  };
}
