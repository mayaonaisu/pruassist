"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";
import { useBrowserSpeech } from "./useBrowserSpeech";
import { looksLikeQuestion, type Line } from "./transcript";

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
};

export function useTranscript(room: Room | undefined, repName: string, micEnabled: boolean): Transcript {
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState<Record<string, string>>({});
  const idRef = useRef(0);
  const linesRef = useRef<Line[]>([]);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  const addFinal = useCallback((speaker: string, text: string, flag = false) => {
    if (!text.trim()) return;
    const at = Date.now();
    setLines((prev) => [...prev.slice(-MAX_LINES), { id: `${at}-${idRef.current++}`, at, speaker, text: text.trim(), flag }]);
    setInterim((prev) => ({ ...prev, [speaker]: "" }));
  }, []);

  const setSpeakerInterim = useCallback((speaker: string, text: string) => {
    setInterim((prev) => ({ ...prev, [speaker]: text }));
  }, []);

  // Muting must pause transcription too, or "Mute" keeps feeding the rep's words to the AI.
  const speech = useBrowserSpeech(micEnabled, ({ final, interim: itm }) => {
    if (final) addFinal(repName, final);
    if (itm) setSpeakerInterim(repName, itm);
  });

  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === "transcript") {
          const speaker = msg.name || msg.role || "Customer";
          if (msg.final) addFinal(speaker, msg.final, looksLikeQuestion(msg.final));
          else if (msg.interim != null) setSpeakerInterim(speaker, msg.interim);
        }
      } catch {
        /* ignore */
      }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, addFinal, setSpeakerInterim]);

  const latest = useCallback(() => linesRef.current, []);

  return { lines, interim, speech, latest };
}
