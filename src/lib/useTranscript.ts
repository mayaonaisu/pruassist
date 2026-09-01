"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";
import { useBrowserSpeech, type SpeechResult, type SpeechStatus } from "./useBrowserSpeech";
import { deepgramEnabled, useDeepgramSpeech, type DeepgramStatus } from "./useDeepgramSpeech";
import { applyLineEdit, looksLikeQuestion, type Line } from "./transcript";
import { fixTerms } from "./terms";

// Deepgram statuses that mean "it isn't working — use Web Speech instead". A mic denial is not one:
// Web Speech would be denied too.
function speechStatusFrom(dg: DeepgramStatus): SpeechStatus {
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
  speech: ReturnType<typeof useBrowserSpeech>;
  // The freshest lines, for callbacks that must not close over a stale render.
  latest: () => Line[];
  // The rep corrects a mis-heard line in place; the fix flows to the record and downstream readers.
  editLine: (id: string, text: string) => void;
};

// The local-mic STT hooks (Deepgram / Web Speech) must live ABOVE the LiveKitRoom provider so a
// room reconnect does not kill the WS mid-handshake and restart from scratch. This hook owns only
// the speech-to-text decision; useTranscript below wires it into the shared line store together
// with the remote data-channel listener that does need the room.
export function useLocalSpeech(repName: string, micEnabled: boolean) {
  const [localLines, setLocalLines] = useState<Line[]>([]);
  const [localInterim, setLocalInterim] = useState<Record<string, string>>({});
  const idRef = useRef(0);

  const addFinal = useCallback((speaker: string, text: string, flag = false) => {
    const fixed = fixTerms(text.trim());
    if (!fixed) return;
    const at = Date.now();
    setLocalLines((prev) => [...prev.slice(-MAX_LINES), { id: `${at}-${idRef.current++}`, at, speaker, text: fixed, flag }]);
    setLocalInterim((prev) => ({ ...prev, [speaker]: "" }));
  }, []);

  const setSpeakerInterim = useCallback((speaker: string, text: string) => {
    setLocalInterim((prev) => ({ ...prev, [speaker]: fixTerms(text) }));
  }, []);

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

  return { localLines, localInterim, speech, addFinal, setSpeakerInterim };
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

  const editLine = useCallback((id: string, text: string) => {
    setRemoteLines((prev) => {
      const next = applyLineEdit(prev, id, text);
      return next !== prev ? next : prev;
    });
  }, []);

  return { lines, interim, speech: local.speech, latest, editLine };
}
