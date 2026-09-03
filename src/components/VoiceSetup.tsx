"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { startMicPcm16k, type MicPcm } from "@/lib/mic-pcm";
import { unlockAudio } from "@/lib/audio-context";
import { encodeProfile } from "@/lib/voice/profile-codec";
import { VOICE_MODEL, VOICE_MODEL_URL } from "@/lib/voice/model-info";
import { useVoiceProfile } from "@/lib/useVoiceProfile";
import { separationWarning, thresholdFor } from "@/lib/voice/calibration";

// One-time voice enrolment for the rep, so in-person sessions know who is speaking without the rep
// having to speak first. Everything runs on THIS device: the mic audio goes to an on-device model in a
// worker and only a 192-number voiceprint (never audio) is stored. The page owns the worker and the mic;
// the worker does the embedding.

type Status = "idle" | "loading" | "recording" | "computing" | "saving" | "saved" | "testing" | "error";

const TARGET_SECONDS = 40;

// A ~40 s read: the consent disclosure sentence (doubles as rehearsal) plus varied product sentences so
// the voiceprint sees a range of the rep's speech.
const SCRIPT = [
  "Before we begin, I'd like to let you know this session is recorded so the assistant can help me serve you better, and you can stop it at any time.",
  "PRUShield is a hospital plan, and the deductible is the amount you pay each policy year before it starts to pay.",
  "The co-insurance is the share of the bill you pay after the deductible, and a rider can bring that share right down.",
  "PRUExtra riders sit on top of PRUShield to cover more of your ward and treatment costs.",
  "Staying on the panel of approved doctors keeps your out-of-pocket costs lower and the claim simpler.",
  "In your case, I'd recommend we compare two plans side by side so the trade-offs are clear before you decide.",
];

type WorkerIn =
  | { type: "init"; modelUrl: string }
  | { type: "profile"; embedding: Float32Array | null }
  | { type: "pcm"; frame: Float32Array; epoch: number; tSec: number }
  | { type: "enroll-chunk"; pcm: Float32Array }
  | { type: "enroll-finish"; mode?: "other" }
  | { type: "enroll-reset" };

type WorkerOut =
  | { type: "ready" }
  | { type: "score"; epoch: number; t0: number; t1: number; score: number }
  | { type: "embedding"; embedding: Float32Array; selfMean: number }
  | { type: "other-mean"; otherMean: number }
  | { type: "error"; message: string };

export default function VoiceSetup({ username, repName }: { username: string; repName: string }) {
  const { profile, selfMean, otherMean, updatedAt, reload } = useVoiceProfile();

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [seconds, setSeconds] = useState(0);
  const [testScore, setTestScore] = useState<number | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationSeconds, setCalibrationSeconds] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const micRef = useRef<MicPcm | null>(null);
  const secondsRef = useRef(0);
  const recordingRef = useRef(false);
  const testClockRef = useRef(0);
  // The active profile embedding for the "test your voice" meter: the saved one, refreshed from the
  // freshly-computed embedding right after enrolment.
  const embeddingRef = useRef<Float32Array | null>(null);
  const readyResolveRef = useRef<(() => void) | null>(null);
  const onEmbeddingRef = useRef<((e: Float32Array) => void) | null>(null);
  const embeddingSelfMeanRef = useRef<number | null>(null);
  const onOtherMeanRef = useRef<((mean: number) => void) | null>(null);

  const hasProfile = profile != null; // null = none, undefined = still loading

  useEffect(() => {
    if (profile) embeddingRef.current = profile;
  }, [profile]);

  const stopMic = useCallback(() => {
    try {
      micRef.current?.stop();
    } catch {
      /* ignore */
    }
    micRef.current = null;
  }, []);

  // Create the worker once and wire its replies. Resolves when the model reports ready.
  const ensureWorker = useCallback(async (): Promise<Worker> => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("../lib/voice/voice.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === "ready") {
        readyResolveRef.current?.();
        readyResolveRef.current = null;
      } else if (msg.type === "score") {
        setTestScore(msg.score);
      } else if (msg.type === "embedding") {
        embeddingSelfMeanRef.current = msg.selfMean;
        onEmbeddingRef.current?.(msg.embedding);
      } else if (msg.type === "other-mean") {
        onOtherMeanRef.current?.(msg.otherMean);
      } else if (msg.type === "error") {
        setError(msg.message);
        setStatus("error");
        stopMic();
      }
    };
    const post = (m: WorkerIn) => worker.postMessage(m);
    const ready = new Promise<void>((resolve) => {
      readyResolveRef.current = resolve;
    });
    post({ type: "init", modelUrl: VOICE_MODEL_URL });
    workerRef.current = worker;
    await ready;
    return worker;
  }, [stopMic]);

  useEffect(() => {
    return () => {
      stopMic();
      try {
        workerRef.current?.terminate();
      } catch {
        /* ignore */
      }
      workerRef.current = null;
    };
  }, [stopMic]);

  // Defined before startEnroll so the auto-stop can call it; guarded by a ref, not `status`, so its
  // identity stays stable (no callback churn, no manual-memoization lint).
  const stopEnroll = useCallback(() => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    stopMic();
    const worker = workerRef.current;
    if (!worker) {
      setStatus("error");
      setError("The voice engine stopped unexpectedly.");
      return;
    }
    setStatus("computing");
    onEmbeddingRef.current = async (embedding: Float32Array) => {
      onEmbeddingRef.current = null;
      try {
        setStatus("saving");
        const res = await fetch("/api/voice", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: encodeProfile(embedding), model: VOICE_MODEL, selfMean: embeddingSelfMeanRef.current }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Could not save your voice profile.");
        }
        embeddingRef.current = embedding;
        setStatus("saved");
        reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save your voice profile.");
        setStatus("error");
      }
    };
    worker.postMessage({ type: "enroll-finish" } as WorkerIn);
  }, [stopMic, reload]);

  const startEnroll = useCallback(async () => {
    setError("");
    setTestScore(null);
    unlockAudio(); // resume the shared AudioContext inside this user gesture (Safari)
    setStatus("loading");
    try {
      const worker = await ensureWorker();
      worker.postMessage({ type: "enroll-reset" } as WorkerIn);
      secondsRef.current = 0;
      setSeconds(0);
      recordingRef.current = true;
      setStatus("recording");
      micRef.current = await startMicPcm16k((frame) => {
        worker.postMessage({ type: "enroll-chunk", pcm: frame } as WorkerIn, [frame.buffer]);
        secondsRef.current += frame.length / 16000;
        setSeconds(secondsRef.current);
        if (secondsRef.current >= TARGET_SECONDS) stopEnroll();
      });
    } catch (e) {
      recordingRef.current = false;
      setError(micError(e));
      setStatus("error");
    }
  }, [ensureWorker, stopEnroll]);

  const startTest = useCallback(async () => {
    const emb = embeddingRef.current;
    if (!emb) return;
    setError("");
    setTestScore(null);
    unlockAudio();
    try {
      const worker = await ensureWorker();
      const copy = emb.slice(); // transfer a copy so embeddingRef's buffer isn't neutered
      worker.postMessage({ type: "profile", embedding: copy } as WorkerIn, [copy.buffer]);
      testClockRef.current = 0;
      setStatus("testing");
      micRef.current = await startMicPcm16k((frame) => {
        worker.postMessage({ type: "pcm", frame, epoch: 0, tSec: testClockRef.current } as WorkerIn, [frame.buffer]);
        testClockRef.current += frame.length / 16000;
      });
    } catch (e) {
      setError(micError(e));
      setStatus("error");
    }
  }, [ensureWorker]);

  const stopTest = useCallback(() => {
    stopMic();
    setStatus("saved");
  }, [stopMic]);

  const stopCalibration = useCallback(() => {
    if (!calibrating) return;
    stopMic();
    setCalibrating(false);
    setStatus("computing");
    const worker = workerRef.current;
    if (!worker) {
      setError("The voice engine stopped unexpectedly.");
      setStatus("error");
      return;
    }
    onOtherMeanRef.current = async (mean) => {
      onOtherMeanRef.current = null;
      try {
        setStatus("saving");
        const res = await fetch("/api/voice", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ otherMean: mean }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save calibration.");
        setStatus("saved");
        reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save calibration.");
        setStatus("error");
      }
    };
    worker.postMessage({ type: "enroll-finish", mode: "other" } as WorkerIn);
  }, [calibrating, reload, stopMic]);

  const startCalibration = useCallback(async () => {
    const emb = embeddingRef.current;
    if (!emb) return;
    setError("");
    unlockAudio();
    try {
      const worker = await ensureWorker();
      const copy = emb.slice();
      worker.postMessage({ type: "profile", embedding: copy } as WorkerIn, [copy.buffer]);
      worker.postMessage({ type: "enroll-reset" } as WorkerIn);
      setCalibrationSeconds(0);
      setCalibrating(true);
      setStatus("recording");
      let elapsed = 0;
      micRef.current = await startMicPcm16k((frame) => {
        worker.postMessage({ type: "enroll-chunk", pcm: frame } as WorkerIn, [frame.buffer]);
        elapsed += frame.length / 16000;
        setCalibrationSeconds(elapsed);
        if (elapsed >= 12) {
          stopMic();
          setCalibrating(false);
          setStatus("computing");
          onOtherMeanRef.current = async (mean) => {
            onOtherMeanRef.current = null;
            try {
              const res = await fetch("/api/voice", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ otherMean: mean }) });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save calibration.");
              setStatus("saved");
              reload();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save calibration.");
              setStatus("error");
            }
          };
          worker.postMessage({ type: "enroll-finish", mode: "other" } as WorkerIn);
        }
      });
    } catch (e) {
      setCalibrating(false);
      setError(micError(e));
      setStatus("error");
    }
  }, [ensureWorker, reload, stopMic]);

  const del = useCallback(async () => {
    stopMic();
    try {
      await fetch("/api/voice", { method: "DELETE" });
    } catch {
      /* ignore */
    }
    embeddingRef.current = null;
    setTestScore(null);
    setStatus("idle");
    reload();
  }, [stopMic, reload]);

  const recording = status === "recording" && !calibrating;
  const busy = status === "loading" || status === "computing" || status === "saving";
  const progress = Math.min(100, (seconds / TARGET_SECONDS) * 100);

  return (
    <div className="pru-container" style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 className="doc-title">Set up your voice</h1>
          <div className="doc-sub" style={{ marginBottom: 0 }}>
            So in-person sessions know who’s speaking — about 40 seconds
          </div>
        </div>
        <Link href="/rep" className="pru-btn pru-btn-sm" style={{ marginLeft: "auto" }}>
          ← Back to console
        </Link>
      </div>

      <div className="notice" style={{ marginBottom: 18 }}>
        Runs on this device — your audio never leaves the iPad. Only a 192-number voiceprint is stored, so
        the assistant can tell your voice from the customer’s. No audio is kept.
      </div>

      {error && (
        <div className="notice bad" role="alert" style={{ marginBottom: 18 }}>
          {error}
        </div>
      )}

      <div className="sec">
        <div className="sec-h">Read this aloud</div>
        <div className="voice-script">
          {SCRIPT.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>

      {(recording || busy) && (
        <div style={{ margin: "16px 0" }}>
          <div className="voice-progress" aria-hidden>
            <div className="voice-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="pru-muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            {recording
              ? `Recording — ${Math.floor(seconds)} s of ${TARGET_SECONDS} s`
              : status === "loading"
                ? "Loading the voice model…"
                : status === "computing"
                  ? "Building your voiceprint…"
                  : "Saving…"}
          </div>
        </div>
      )}

      <div className="actions-row" style={{ marginTop: 18 }}>
        {!recording ? (
          <button className="pru-btn pru-btn-primary" onClick={startEnroll} disabled={busy || calibrating || status === "testing"}>
            {hasProfile ? "Re-record my voice" : "Start recording"}
          </button>
        ) : (
          <button className="pru-btn pru-btn-primary" onClick={stopEnroll}>
            Stop &amp; save
          </button>
        )}
        {status === "saved" && <span className="hint">Saved. You can test it below.</span>}
      </div>
      {hasProfile && selfMean != null && <p className="pru-muted voice-self-mean">Your voice reads {selfMean.toFixed(2)} against your own voiceprint</p>}

      {hasProfile && (
        <div className="sec voice-calibration" style={{ marginTop: 26 }}>
          <div className="sec-h">Calibrate with a second voice</div>
          <p className="pru-muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
            Have another person read these two lines into the same mic (about 10 s). Only a similarity number is saved — never their audio or voice.
          </p>
          <div className="voice-script">{SCRIPT.slice(0, 2).map((line, i) => <p key={i}>{line}</p>)}</div>
          <div className="actions-row" style={{ marginTop: 12 }}>
            {!calibrating ? <button className="pru-btn" onClick={startCalibration} disabled={busy || recording || status === "testing"}>Start</button>
              : <button className="pru-btn" onClick={stopCalibration}>Stop</button>}
            {calibrating && <span className="hint">Recording — {Math.floor(calibrationSeconds)} s of 12 s</span>}
          </div>
          {selfMean != null && otherMean != null && (
            <div className="voice-calibration-result">
              Your voice {selfMean.toFixed(2)} · another voice {otherMean.toFixed(2)} · gap {(selfMean - otherMean).toFixed(2)} → recommended Voice match {thresholdFor({ selfMean, otherMean }).toFixed(2)}
            </div>
          )}
          {separationWarning(selfMean, otherMean) && <div className="notice bad">{separationWarning(selfMean, otherMean)}</div>}
        </div>
      )}

      {hasProfile && (
        <div className="sec" style={{ marginTop: 26 }}>
          <div className="sec-h">Test your voice</div>
          <p className="pru-muted" style={{ fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
            Speak, and watch the match to your saved voiceprint. Your own voice should read high; another
            person’s should read low. This is the tuning tool for the thresholds.
          </p>
          <VoiceMeter score={testScore} active={status === "testing"} />
          <div className="actions-row" style={{ marginTop: 12 }}>
            {status !== "testing" ? (
              <button className="pru-btn" onClick={startTest} disabled={busy || recording}>
                Start test
              </button>
            ) : (
              <button className="pru-btn" onClick={stopTest}>
                Stop test
              </button>
            )}
          </div>
        </div>
      )}

      {hasProfile && (
        <div className="sec" style={{ marginTop: 26 }}>
          <div className="sec-h">This device’s voiceprint</div>
          <p className="pru-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Whose voice: <b>{repName}</b> ({username})
            {updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ""}
          </p>
          <button className="pru-btn" onClick={del} disabled={recording || status === "testing"}>
            Delete voiceprint
          </button>
        </div>
      )}
    </div>
  );
}

function VoiceMeter({ score, active }: { score: number | null; active: boolean }) {
  // Cosine is [-1, 1]; map to a 0-100% bar. Colour by the reference guidance (rep ≥ 0.5, other ≤ 0.3).
  const pct = score == null ? 0 : Math.round(((score + 1) / 2) * 100);
  const tone = score == null ? "idle" : score >= 0.5 ? "hi" : score <= 0.3 ? "lo" : "mid";
  return (
    <div>
      <div className={`voice-meter voice-meter-${tone}`} aria-hidden>
        <div className="voice-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="pru-muted" style={{ fontSize: 12.5, marginTop: 6, fontFamily: "var(--font-mono)" }}>
        {active ? (score == null ? "Listening…" : `similarity ${score.toFixed(2)}`) : "Not running"}
      </div>
    </div>
  );
}

function micError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m === "denied") return "Microphone access is blocked. Allow the microphone for this site, then try again.";
  if (m === "unsupported") return "This browser can’t capture audio for enrolment.";
  return m || "Something went wrong starting the microphone.";
}
