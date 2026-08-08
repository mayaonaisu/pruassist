"use client";

import { useEffect, useRef } from "react";

export type SpeechResult = { final: string; interim: string };

// Live speech-to-text using the browser's built-in Web Speech API (Chrome/Edge).
// Transcribes the LOCAL microphone only — each participant transcribes themselves.
// `onResult` is held in a ref so updating it does not restart recognition.
export function useBrowserSpeech(
  enabled: boolean,
  onResult: (r: SpeechResult) => void,
) {
  const cbRef = useRef(onResult);
  cbRef.current = onResult;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;

    if (!SR) {
      console.warn("Web Speech API not available — use Chrome or Edge for live transcription.");
      return;
    }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      cbRef.current({ final, interim });
    };

    let stopped = false;
    // The API auto-stops on silence; restart to keep it continuous.
    rec.onend = () => {
      if (!stopped) {
        try {
          rec.start();
        } catch {
          /* already started */
        }
      }
    };

    try {
      rec.start();
    } catch {
      /* ignore */
    }

    return () => {
      stopped = true;
      try {
        rec.onend = null;
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);
}

// Minimal typings for the (non-standard) Web Speech API.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
