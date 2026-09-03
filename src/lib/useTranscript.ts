"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";
import { useBrowserSpeech, type SpeechResult, type SpeechStatus } from "./useBrowserSpeech";
import { deepgramEnabled, useDeepgramSpeech, type DeepgramStatus } from "./useDeepgramSpeech";
import { applyLineEdit, applySpeakerSwap, looksLikeQuestion, type Line } from "./transcript";
import { fixTerms } from "./terms";

// Deepgram statuses that mean "it isn't working — use Web Speech instead". A mic denial is not one:
// Web Speech would be denied too. Exported for useInPersonSpeech, which maps its diarized-Deepgram
// status onto the same SpeechStatus the shared console surfaces.
export function speechStatusFrom(dg: DeepgramStatus): SpeechStatus {
  switch (dg) {
    case "connecting":
    case "listening":
      return "listening";
    case "denied":
      return "denied";
    default:
      return "idle";
  }
}

// Both halves of the conversation, from two different places: the rep's own microphone via the
// Web Speech API, and the customer's words arriving over LiveKit's data channel after being
// transcribed in their browser.

// Long sessions would otherwise grow the array without bound; nothing reads further back.
const MAX_LINES = 200;

export type Transcript = {
  lines: Line[];
  interim: Record<string, string>;
  speech: SpeechStatus;
  // The freshest lines, for callbacks that must not close over a stale render.
  latest: () => Line[];
  // The rep corrects a mis-heard line in place; the fix flows to the record and downstream readers.
  editLine: (id: string, text: string) => void;
};

// One append-only line store with per-speaker interim slots, plus the in-place corrections the rep can
// make: edit a line's text, or swap who said it. Shared by useLocalSpeech (online — one speaker, the
// rep) and useInPersonSpeech (one shared mic, two speakers) so the MAX_LINES / interim / correction
// semantics live in exactly one place and cannot drift between the two consoles.
export function useLineStore() {
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState<Record<string, string>>({});
  const idRef = useRef(0);

  // Returns the new line's id (or undefined if the text was empty after normalisation), so the
  // in-person attribution layer can later relabel a provisional line by id. The id is computed before
  // setLines so it can be returned synchronously; callers that ignore it are unaffected.
  const addFinal = useCallback((speaker: string, text: string, flag = false): string | undefined => {
    const fixed = fixTerms(text.trim());
    if (!fixed) return undefined;
    const at = Date.now();
    const id = `${at}-${idRef.current++}`;
    setLines((prev) => [...prev.slice(-MAX_LINES), { id, at, speaker, text: fixed, flag }]);
    setInterim((prev) => ({ ...prev, [speaker]: "" }));
    return id;
  }, []);

  const setSpeakerInterim = useCallback((speaker: string, text: string) => {
    setInterim((prev) => ({ ...prev, [speaker]: fixTerms(text) }));
  }, []);

  const clearInterim = useCallback((speaker: string) => {
    setInterim((prev) => (prev[speaker] ? { ...prev, [speaker]: "" } : prev));
  }, []);

  const editLocalLine = useCallback((id: string, text: string) => {
    setLines((prev) => {
      const next = applyLineEdit(prev, id, text);
      return next !== prev ? next : prev;
    });
  }, []);

  const swapLocalSpeaker = useCallback((id: string, repName: string, customerName: string) => {
    setLines((prev) => {
      const next = applySpeakerSwap(prev, id, repName, customerName);
      return next !== prev ? next : prev;
    });
  }, []);

  return { lines, interim, addFinal, setSpeakerInterim, clearInterim, editLocalLine, swapLocalSpeaker };
}

// The local-mic STT hooks (Deepgram / Web Speech) must live ABOVE the LiveKitRoom provider so a
// room reconnect does not kill the WS mid-handshake and restart from scratch. This hook owns only
// the speech-to-text decision; useTranscript below wires it into the shared line store together
// with the remote data-channel listener that does need the room.
export function useLocalSpeech(repName: string, micEnabled: boolean) {
  const store = useLineStore();
  const { addFinal, setSpeakerInterim } = store;

  const onSpeech = useCallback(
    ({ final, interim: itm }: SpeechResult) => {
      if (final) addFinal(repName, final);
      if (itm) setSpeakerInterim(repName, itm);
    },
    [addFinal, setSpeakerInterim, repName],
  );

  const wantDeepgram = deepgramEnabled();
  const dgStatus = useDeepgramSpeech(micEnabled && wantDeepgram, onSpeech);
  const deepgramDown = dgStatus === "unconfigured" || dgStatus === "error";
  const browserStatus = useBrowserSpeech(micEnabled && (!wantDeepgram || deepgramDown), onSpeech);
  const speech: SpeechStatus = wantDeepgram && !deepgramDown ? speechStatusFrom(dgStatus) : browserStatus;

  return {
    localLines: store.lines,
    localInterim: store.interim,
    speech,
    addFinal: store.addFinal,
    setSpeakerInterim: store.setSpeakerInterim,
    // The rep can now correct their OWN mis-heard lines, not only the customer's — the editor was
    // always rendered for them; only this setter was missing (it used to touch remote lines only).
    editLocalLine: store.editLocalLine,
  };
}

export type LocalSpeech = ReturnType<typeof useLocalSpeech>;

export function useTranscript(room: Room | undefined, local: LocalSpeech): Transcript {
  const [remoteLines, setRemoteLines] = useState<Line[]>([]);
  const [remoteInterim, setRemoteInterim] = useState<Record<string, string>>({});
  const idRef = useRef(0);

  const addRemoteFinal = useCallback((speaker: string, text: string, flag = false) => {
    const fixed = fixTerms(text.trim());
    if (!fixed) return;
    const at = Date.now();
    setRemoteLines((prev) => [...prev.slice(-MAX_LINES), { id: `${at}-${idRef.current++}`, at, speaker, text: fixed, flag }]);
    setRemoteInterim((prev) => ({ ...prev, [speaker]: "" }));
  }, []);

  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === "transcript") {
          const speaker = msg.name || msg.role || "Customer";
          if (msg.final) addRemoteFinal(speaker, msg.final, looksLikeQuestion(msg.final));
          else if (msg.interim != null) setRemoteInterim((prev) => ({ ...prev, [speaker]: fixTerms(msg.interim) }));
        }
      } catch {
        /* ignore */
      }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, addRemoteFinal]);

  const lines = useMemo(() => {
    const merged = [...local.localLines, ...remoteLines];
    merged.sort((a, b) => a.at - b.at);
    return merged.slice(-MAX_LINES);
  }, [local.localLines, remoteLines]);

  const interim = useMemo(
    () => ({ ...local.localInterim, ...remoteInterim }),
    [local.localInterim, remoteInterim],
  );

  const linesRef = useRef<Line[]>([]);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  const latest = useCallback(() => linesRef.current, []);

  // A line id belongs to exactly one store (local or remote); applyLineEdit is a no-op for an unknown
  // id, so dispatching to both edits the right one without the caller needing to know which.
  const { editLocalLine } = local;
  const editLine = useCallback(
    (id: string, text: string) => {
      editLocalLine(id, text);
      setRemoteLines((prev) => {
        const next = applyLineEdit(prev, id, text);
        return next !== prev ? next : prev;
      });
    },
    [editLocalLine],
  );

  return { lines, interim, speech: local.speech, latest, editLine };
}
