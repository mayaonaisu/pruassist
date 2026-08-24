"use client";

import { useEffect, useRef, useState } from "react";
import { CANONICAL_TERMS } from "./terms";
import type { SpeechResult } from "./useBrowserSpeech";

// Live speech-to-text on the LOCAL microphone via Deepgram streaming, with keyterm boosting so brand
// terms (PRUShield, PRUExtra, PRUPanel Connect…) are recognised at decode time rather than repaired
// afterward. Same shape as useBrowserSpeech so the two are interchangeable, plus richer statuses the
// caller uses to fall back: `unconfigured` (no Owner key / grant refused) and `error` both mean
// "use Web Speech instead".

export type DeepgramStatus = "idle" | "connecting" | "listening" | "denied" | "error" | "unconfigured";

// Opt-in flag (Web Speech stays the default). Inlined by Next at build time. When on but Deepgram is
// unconfigured or errors, the caller still falls back to Web Speech — so turning this on can only
// improve things, never break the demo.
export const deepgramEnabled = (): boolean =>
  process.env.NEXT_PUBLIC_ENABLE_DEEPGRAM === "1" || process.env.NEXT_PUBLIC_ENABLE_DEEPGRAM === "true";

const KEYTERMS = CANONICAL_TERMS.map((t) => `keyterm=${encodeURIComponent(t)}`).join("&");
const WS_BASE =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&interim_results=true&" + KEYTERMS;

const MAX_RECONNECTS = 5;

// Wall-clock bound on *connecting*: if the socket never opens within this window, stop retrying and
// let the caller fall back to Web Speech. This backs up the attempt counter, which a flapping
// `enabled`/`joinToken` dep can reset to 0 on every effect restart — leaving the transcript blank
// indefinitely. The deadline lives in a ref (below) so it keeps counting across those restarts.
//
// It measures time-to-connect, NOT time-to-first-word: an open socket that is simply hearing silence
// is healthy, and must never be torn down for Web Speech. Generous enough to clear a cold serverless
// token route plus the Deepgram handshake.
const CONNECT_DEADLINE_MS = 8000;

export function useDeepgramSpeech(
  enabled: boolean,
  onResult: (r: SpeechResult) => void,
  // Customers authenticate the token route with their join link; the rep is authenticated by cookie.
  joinToken?: string,
): DeepgramStatus {
  const cbRef = useRef(onResult);
  useEffect(() => {
    cbRef.current = onResult;
  });

  const [status, setStatus] = useState<DeepgramStatus>("idle");

  // The fallback deadline persists across effect restarts (unlike the per-run `attempts` and timers),
  // so a reconnect storm or a flapping dep can't keep resetting it and strand the transcript blank.
  // Cleared only once a real transcript proves Deepgram is working; re-armed on the next enable.
  const deadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return; // the hook returns "idle" while disabled without touching state

    let stopped = false;
    let stream: MediaStream | null = null;
    let ws: WebSocket | null = null;
    let recorder: MediaRecorder | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let opened = false;

    // Arm the wall-clock fallback once and keep it running across reconnects: the socket has until
    // this instant to open, whatever the attempt count is doing.
    const deadline = deadlineRef.current ?? (deadlineRef.current = Date.now() + CONNECT_DEADLINE_MS);

    const stopStreamBits = () => {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* ignore */ }
      recorder = null;
      if (ws) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
        try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    };

    async function connect() {
      if (stopped) return;
      setStatus("connecting");

      // 1) Short-lived token from our server (the real key never reaches the browser).
      let token: string;
      try {
        const url = joinToken ? `/api/deepgram/token?token=${encodeURIComponent(joinToken)}` : "/api/deepgram/token";
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data?.disabled || typeof data?.token !== "string") {
          setStatus("unconfigured"); // caller falls back to Web Speech
          return;
        }
        token = data.token;
      } catch {
        setStatus("unconfigured");
        return;
      }
      if (stopped) return;

      // 2) Mic (once). A denial would also deny Web Speech, so it is not a fall-back case.
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          setStatus("denied");
          return;
        }
      }
      if (stopped) return;

      // 3) Connect. The ephemeral token authenticates through the WebSocket subprotocol
      // (`Sec-WebSocket-Protocol: bearer, <token>`). Deepgram's streaming endpoint rejects the token
      // as an `?access_token=` query param — the handshake fails and the socket closes 1006 without
      // ever opening — so query-string auth silently kills the primary STT path.
      const socket = new WebSocket(WS_BASE, ["bearer", token]);
      ws = socket;

      socket.onopen = () => {
        if (stopped) return;
        attempts = 0;
        // Connected: Deepgram is healthy even before the first word. Disarm the fallback clock and
        // clear the ref so the next enable gets a fresh window.
        opened = true;
        deadlineRef.current = null;
        setStatus("listening");
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m));
        const rec = new MediaRecorder(stream!, mime ? { mimeType: mime } : undefined);
        recorder = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(e.data);
        };
        rec.start(250); // small timeslice keeps latency low
        // Deepgram closes an idle socket after ~10s; a KeepAlive guards a quiet stretch.
        keepAlive = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
        }, 8000);
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type !== "Results") return;
          const transcript: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
          if (!transcript) return;
          cbRef.current(msg.is_final ? { final: transcript, interim: "" } : { final: "", interim: transcript });
        } catch {
          /* non-JSON keepalive/metadata — ignore */
        }
      };

      socket.onerror = () => {
        // Let onclose decide whether to retry; an error alone is not terminal.
      };

      socket.onclose = () => {
        if (stopped) return;
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* ignore */ }
        recorder = null;
        if (attempts >= MAX_RECONNECTS) {
          setStatus("error"); // give up → caller falls back to Web Speech
          return;
        }
        attempts++;
        setStatus("connecting");
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** attempts, 4000));
      };
    }

    // If the socket has not opened by the deadline, hand off to Web Speech rather than keep
    // reconnecting. An already-open socket (even a silent one) has cleared `opened` and is left alone.
    const giveUpTimer = setTimeout(() => {
      if (stopped || opened) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      stopStreamBits();
      setStatus("error"); // caller falls back to Web Speech
    }, Math.max(0, deadline - Date.now()));

    connect();

    return () => {
      stopped = true;
      clearTimeout(giveUpTimer);
      if (retryTimer) clearTimeout(retryTimer);
      stopStreamBits();
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      stream = null;
    };
  }, [enabled, joinToken]);

  return enabled ? status : "idle";
}
