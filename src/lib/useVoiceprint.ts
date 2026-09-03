"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_MODEL_URL } from "./voice/model-info";
import { pushSample, scoreBetween as ringScoreBetween, recentVerdict, type ScoreSample } from "./voice-ring";
import { DEFAULT_ATTRIBUTE_OPTS, type Role, type VoiceEvidence } from "./diarize";
import type { PcmTap } from "./useDiarizedSpeech";

// The live-session side of the voiceprint: owns the worker that scores the PCM tap against the rep's
// profile, and exposes the results to attribution. Everything the console needs is stable (onPcm is a
// useCallback over refs, so passing it to useDiarizedSpeech never restarts capture), and the raw scores
// live in a ref-held ring that scoreBetween/liveVerdict read without re-rendering.

export type VoiceprintStatus = "off" | "loading" | "ready" | "error";

type WorkerOut =
  | { type: "ready" }
  | { type: "score"; epoch: number; t0: number; t1: number; score: number }
  | { type: "embedding"; embedding: Float32Array }
  | { type: "error"; message: string };

export type Voiceprint = {
  status: VoiceprintStatus;
  onPcm: PcmTap;
  scoreBetween: (epoch: number, start: number, end: number) => VoiceEvidence | null;
  liveVerdict: () => Role | null;
  warm: () => void;
};

export function useVoiceprint({ enabled, profile }: { enabled: boolean; profile: Float32Array | null }): Voiceprint {
  // Only the worker's async outcome is tracked in state (setState lives in its message handler, never
  // synchronously in the effect); "off" is derived from `active`. Since the console loads the profile
  // once, the lifecycle is simply loading → ready.
  const [outcome, setOutcome] = useState<"loading" | "ready" | "error">("loading");
  const workerRef = useRef<Worker | null>(null);
  const ringRef = useRef<ScoreSample[]>([]);
  const lastEpochRef = useRef(0);
  const lastTSecRef = useRef(0);

  const active = enabled && !!profile;
  const status: VoiceprintStatus = !active ? "off" : outcome;

  useEffect(() => {
    if (!active || !profile) return; // status derives to "off"
    ringRef.current = [];
    // The voiceprint is an OPTIONAL enhancement: any failure here must degrade to "error" (→ text cues
    // + toggle), never throw out of the effect (which would unmount the console and blank the transcript).
    // Defer error-state updates out of the synchronous effect body (queueMicrotask) — the async worker
    // handlers below may call setOutcome directly.
    const fail = () => queueMicrotask(() => setOutcome("error"));
    let worker: Worker;
    try {
      worker = new Worker(new URL("./voice/voice.worker.ts", import.meta.url), { type: "module" });
    } catch {
      fail();
      return;
    }
    workerRef.current = worker;
    worker.onerror = () => setOutcome("error");
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      try {
        const msg = e.data;
        if (msg.type === "ready") {
          const copy = profile.slice(); // transfer a copy; the prop's buffer stays intact
          worker.postMessage({ type: "profile", embedding: copy }, [copy.buffer]);
          setOutcome("ready");
        } else if (msg.type === "score") {
          ringRef.current = pushSample(ringRef.current, { epoch: msg.epoch, t0: msg.t0, t1: msg.t1, score: msg.score });
        } else if (msg.type === "error") {
          setOutcome("error");
        }
      } catch {
        setOutcome("error");
      }
    };
    try {
      worker.postMessage({ type: "init", modelUrl: VOICE_MODEL_URL });
    } catch {
      fail();
    }
    return () => {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      workerRef.current = null;
      ringRef.current = [];
    };
  }, [active, profile]);

  // Stable over refs so it never restarts the diarized socket's capture effect. Forwards the frame to
  // the worker (transferring its buffer — the tap always hands us a fresh copy).
  const onPcm = useCallback<PcmTap>((frame, streamTimeSec, epoch) => {
    lastEpochRef.current = epoch;
    lastTSecRef.current = streamTimeSec;
    const worker = workerRef.current;
    if (!worker) return;
    try {
      worker.postMessage({ type: "pcm", frame, epoch, tSec: streamTimeSec }, [frame.buffer]);
    } catch {
      /* posting to the worker must never break the capture tap */
    }
  }, []);

  const scoreBetween = useCallback(
    (epoch: number, start: number, end: number) => ringScoreBetween(ringRef.current, epoch, start, end),
    [],
  );

  const liveVerdict = useCallback(
    () => recentVerdict(ringRef.current, lastEpochRef.current, lastTSecRef.current, DEFAULT_ATTRIBUTE_OPTS.voiceHi, DEFAULT_ATTRIBUTE_OPTS.voiceLo),
    [],
  );

  const warm = useCallback(() => {
    fetch(VOICE_MODEL_URL, { cache: "force-cache" }).catch(() => {});
  }, []);

  return { status, onPcm, scoreBetween, liveVerdict, warm };
}
