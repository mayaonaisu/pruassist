"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type SpeechResult = { final: string; interim: string };
export type SpeechStatus = "idle" | "listening" | "unsupported" | "denied" | "error";

// Errors the API will keep raising however many times we restart, so retrying just burns CPU.
const FATAL = new Set(["not-allowed", "service-not-allowed", "language-not-supported", "bad-grammar"]);

const subscribeNever = () => () => {};
const isSupported = () =>
  typeof window !== "undefined" &&
  !!((window as WindowWithSpeech).SpeechRecognition || (window as WindowWithSpeech).webkitSpeechRecognition);

// Live speech-to-text on the LOCAL microphone via the browser's Web Speech API.
export function useBrowserSpeech(
  enabled: boolean,
  onResult: (r: SpeechResult) => void,
): SpeechStatus {
  const cbRef = useRef(onResult);
  useEffect(() => {
    cbRef.current = onResult;
  });

  const supported = useSyncExternalStore(subscribeNever, isSupported, () => false);
  const [status, setStatus] = useState<SpeechStatus>("idle");

  useEffect(() => {
    if (!enabled || !supported) return;

    const SR = ((window as WindowWithSpeech).SpeechRecognition ||
      (window as WindowWithSpeech).webkitSpeechRecognition)!;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    rec.onstart = () => {
      attempt = 0;
      setStatus("listening");
    };

    rec.onresult = (e: SpeechRecognitionEventLike) => {
      attempt = 0;
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      cbRef.current({ final, interim });
    };

    rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
      if (!FATAL.has(e.error)) return;
      stopped = true;
      setStatus(e.error === "not-allowed" || e.error === "service-not-allowed" ? "denied" : "error");
    };

    // The API auto-stops on silence and after ~a minute of speech; restart immediately so words
    // after a pause are not clipped. Zero delay on a healthy restart (attempt resets on every
    // onstart/onresult); back off only on repeated no-progress restarts.
    rec.onend = () => {
      if (stopped) return;
      const delay = attempt === 0 ? 0 : Math.min(100 * 2 ** attempt, 2000);
      attempt++;
      if (delay === 0) {
        try { rec.start(); } catch { /* already started */ }
      } else {
        timer = setTimeout(() => {
          try { rec.start(); } catch { /* already started */ }
        }, delay);
      }
    };

    try {
      rec.start();
    } catch {
      /* ignore */
    }

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        rec.onend = null;
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [enabled, supported]);

  if (!supported) return "unsupported";
  return enabled ? status : "idle";
}

// Minimal typings for the (non-standard) Web Speech API.
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onstart: (() => void) | null;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
type WindowWithSpeech = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};
