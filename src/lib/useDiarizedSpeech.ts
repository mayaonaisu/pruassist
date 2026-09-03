"use client";

import { useEffect, useRef, useState } from "react";
import { CANONICAL_TERMS } from "./terms";
import { createResampler, floatTo16BitPCM } from "./pcm";
import { DIARIZE_PARAMS, type DiarizedWord } from "./diarize";
import { type DeepgramStatus } from "./useDeepgramSpeech";
import { getAudioContext, ensurePcmWorklet, unlockAudio } from "./audio-context";

// unlockAudio moved to audio-context.ts (shared with the enrolment mic); re-exported here so the
// existing `import { unlockAudio } from "@/lib/useDiarizedSpeech"` call sites keep compiling.
export { unlockAudio };

// A tap on the exact 16 kHz float audio being streamed to Deepgram, for the voiceprint scorer. It gets
// the frame BEFORE Int16 encoding (the model wants floats), the stream time in seconds on Deepgram's
// own clock (frames sent × 0.1 s, reset at every socket.onopen), and an `epoch` that increments on each
// reconnect — so a run's word times (which also restart at reconnect) can be matched to the right audio.
export type PcmTap = (frame: Float32Array, streamTimeSec: number, epoch: number) => void;

// Live diarized speech-to-text for IN-PERSON mode: one shared iPad microphone, two speakers, one
// Deepgram stream that tags every word with a speaker index. A parallel to useDeepgramSpeech, NOT an
// extension of it — the online hook is shipped on two pages and every stage differs here: the audio
// path is AudioWorklet → linear16 PCM (not MediaRecorder/WebM, which Safari mis-encodes as MP4/AAC),
// the URL carries the diarization + encoding params, and the message shape is per-word not a plain
// string. Attribution does NOT live here; this hook is transport only and emits raw diarized results.
//
// The reconnect/deadline/keepalive/token scaffolding is copied verbatim from useDeepgramSpeech —
// ~80 lines of proven behaviour that would only be de-risked, never improved, by sharing.

export type DiarizedResult = { isFinal: boolean; transcript: string; words: DiarizedWord[] };

const KEYTERMS = CANONICAL_TERMS.map((t) => `keyterm=${encodeURIComponent(t)}`).join("&");
// The exact URL the diarize:check harness validated against the live API. linear16 @ 16 kHz mono +
// diarization, on top of the online base params (nova-3, keyterms, endpointing, utterance_end).
const WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&interim_results=true" +
  "&endpointing=400&utterance_end_ms=1200&" + KEYTERMS +
  "&encoding=linear16&sample_rate=16000&channels=1&" + DIARIZE_PARAMS;

const MAX_RECONNECTS = 5;
const CONNECT_DEADLINE_MS = 8000;
const FRAME = 1600; // 100 ms of 16 kHz mono → 3200 bytes per WS send

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function useDiarizedSpeech(
  enabled: boolean,
  onResult: (r: DiarizedResult) => void,
  opts?: { onPcm?: PcmTap },
): { status: DeepgramStatus; micPaused: boolean } {
  const cbRef = useRef(onResult);
  useEffect(() => {
    cbRef.current = onResult;
  });

  // Held in a ref so passing a fresh onPcm never restarts the capture effect (whose only dep is
  // `enabled`). Unset ⇒ nothing changes; the tap is a no-op.
  const pcmTapRef = useRef(opts?.onPcm);
  useEffect(() => {
    pcmTapRef.current = opts?.onPcm;
  });

  const [status, setStatus] = useState<DeepgramStatus>("idle");
  const [micPaused, setMicPaused] = useState(false);
  const deadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let ws: WebSocket | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let worklet: AudioWorkletNode | null = null;
    let sink: GainNode | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let opened = false;
    let pending: Float32Array = new Float32Array(0);
    let resampler: { push(chunk: Float32Array): Float32Array } | null = null;
    // Deepgram's word timestamps restart at each socket.onopen, so the voice tap's clock must too:
    // framesSent × 0.1 s is the seconds-of-audio-sent on THIS connection, and epoch bumps per open so
    // evidence from a previous connection is never matched against a new run's times.
    let framesSent = 0;
    let epoch = 0;

    const armGiveUp = () => {
      if (giveUpTimer) clearTimeout(giveUpTimer);
      const deadline = deadlineRef.current ?? (deadlineRef.current = Date.now() + CONNECT_DEADLINE_MS);
      giveUpTimer = setTimeout(() => {
        // Don't give up while hidden — the screen may be locked; we resume on return to foreground.
        if (stopped || opened || document.hidden) return;
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        teardownAudio();
        setStatus("error"); // caller falls back to Web Speech
      }, Math.max(0, deadline - Date.now()));
    };

    const teardownAudio = () => {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      try { if (worklet) worklet.port.onmessage = null; } catch { /* ignore */ }
      try { source?.disconnect(); } catch { /* ignore */ }
      try { worklet?.disconnect(); } catch { /* ignore */ }
      try { sink?.disconnect(); } catch { /* ignore */ }
      source = null; worklet = null; sink = null;
      if (ws) {
        try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch { /* ignore */ }
        try { ws.onclose = null; ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    };

    async function connect() {
      if (stopped) return;
      setStatus("connecting");

      // 1) Short-lived token from our server (the real key never reaches the browser). Rep cookie
      //    path only — in-person mode has no customer join token.
      let token: string;
      try {
        const res = await fetch("/api/deepgram/token");
        const data = await res.json();
        if (!res.ok || data?.disabled || typeof data?.token !== "string") {
          setStatus("unconfigured"); // caller falls back to Web Speech + manual toggle
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
        const track = stream.getAudioTracks()[0];
        if (track) {
          track.onmute = () => setMicPaused(true);
          track.onunmute = () => setMicPaused(false);
        }
      }
      if (stopped) return;

      // 3) Audio graph. Resume the shared context (Safari) and register the worklet once.
      const ctx = getAudioContext();
      if (!ctx || !ctx.audioWorklet) {
        setStatus("unconfigured"); // no Web Audio / AudioWorklet — fall back
        return;
      }
      try {
        if (ctx.state === "suspended") await ctx.resume();
        await ensurePcmWorklet(ctx);
      } catch {
        setStatus("error");
        return;
      }
      if (stopped) return;

      resampler = createResampler(ctx.sampleRate, 16000);
      pending = new Float32Array(0);

      // 4) Connect. The token route returns the API key; it authenticates via the
      //    `Sec-WebSocket-Protocol: token, <key>` subprotocol (grant JWTs are too long for the header).
      const socket = new WebSocket(WS_URL, ["token", token]);
      ws = socket;

      socket.onopen = () => {
        if (stopped) return;
        attempts = 0;
        opened = true;
        deadlineRef.current = null;
        // New connection ⇒ Deepgram's word clock restarts at 0, so the tap clock and epoch do too.
        framesSent = 0;
        epoch++;
        setStatus("listening");

        source = ctx.createMediaStreamSource(stream!);
        worklet = new AudioWorkletNode(ctx, "pcm-capture");
        sink = ctx.createGain();
        sink.gain.value = 0; // route to destination (so the worklet is pulled) but stay silent
        source.connect(worklet);
        worklet.connect(sink);
        sink.connect(ctx.destination);

        worklet.port.onmessage = (e: MessageEvent) => {
          if (!resampler || socket.readyState !== WebSocket.OPEN) return;
          pending = concatF32(pending, resampler.push(new Float32Array(e.data as ArrayBuffer)));
          while (pending.length >= FRAME) {
            const frame = pending.subarray(0, FRAME);
            socket.send(floatTo16BitPCM(frame));
            // Feed the voiceprint scorer the SAME frame (as floats), stamped on Deepgram's clock. A
            // fresh copy because the tap may transfer the buffer to a worker; counting only frames
            // actually sent keeps this clock identical to the word timestamps.
            const tap = pcmTapRef.current;
            if (tap) tap(new Float32Array(frame), framesSent * 0.1, epoch);
            framesSent++;
            pending = pending.slice(FRAME);
          }
        };

        keepAlive = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "KeepAlive" }));
        }, 5000);
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type !== "Results") return;
          const alt = msg.channel?.alternatives?.[0];
          const transcript: string = alt?.transcript ?? "";
          const words: DiarizedWord[] = alt?.words ?? [];
          if (!transcript && words.length === 0) return;
          cbRef.current({ isFinal: !!msg.is_final, transcript, words });
        } catch {
          /* non-JSON keepalive/metadata — ignore */
        }
      };

      socket.onerror = () => {
        // Let onclose decide whether to retry; an error alone is not terminal.
      };

      socket.onclose = () => {
        if (stopped) return;
        opened = false;
        if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
        try { source?.disconnect(); worklet?.disconnect(); sink?.disconnect(); } catch { /* ignore */ }
        source = null; worklet = null; sink = null;
        // A close while hidden (screen locked / tab backgrounded) is expected, not a failure. Wait for
        // the foreground to reconnect instead of burning a reconnect attempt.
        if (document.hidden) {
          setStatus("connecting");
          return;
        }
        if (attempts >= MAX_RECONNECTS) {
          setStatus("error"); // give up → caller falls back to Web Speech + manual toggle
          return;
        }
        attempts++;
        setStatus("connecting");
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** attempts, 4000));
      };
    }

    // Returning to the foreground: capture died while hidden, so start a fresh connect window rather
    // than counting it against the reconnect cap.
    const onVisibility = () => {
      if (document.hidden) {
        setMicPaused(true);
        return;
      }
      setMicPaused(false);
      if (stopped || opened) return;
      attempts = 0;
      deadlineRef.current = Date.now() + CONNECT_DEADLINE_MS;
      armGiveUp();
      connect();
    };

    armGiveUp();
    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      if (retryTimer) clearTimeout(retryTimer);
      teardownAudio();
      try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      stream = null;
    };
  }, [enabled]);

  return { status: enabled ? status : "idle", micPaused };
}
