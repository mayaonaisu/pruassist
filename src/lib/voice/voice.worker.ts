// The speaker-verification worker: it owns the ONNX engine so onnxruntime-web's WASM never touches the
// main thread. Two jobs:
//  - Scoring: buffer the live PCM tap and, every HOP_SEC of new audio once WINDOW_SEC is available,
//    embed the last WINDOW_SEC and post its cosine similarity to the rep's profile as a [t0, t1] score.
//  - Enrolment: accumulate mic audio, then on "enroll-finish" embed every 3.0 s window (1.5 s hop),
//    average and normalise them into one profile embedding.
//
// Loaded with `new Worker(new URL("./voice.worker.ts", import.meta.url), { type: "module" })` — the same
// Turbopack-validated pattern the pdf.js worker uses.

import { createEngine, type VoiceEngine } from "./engine";
import { SAMPLE_RATE } from "./features";
import { RingBuffer, WINDOW_SAMPLES, cosine, meanEmbedding } from "./window";

type InMessage =
  | { type: "init"; modelUrl: string }
  | { type: "profile"; embedding: Float32Array | null }
  | { type: "pcm"; frame: Float32Array; epoch: number; tSec: number }
  | { type: "enroll-chunk"; pcm: Float32Array }
  | { type: "enroll-finish" }
  | { type: "enroll-reset" };

// Window has the Window.postMessage(message, targetOrigin) signature under the dom lib; cast to the
// worker shape so postMessage(message, transfer) type-checks without pulling in the webworker lib.
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

const WINDOW_SEC = 3.0;
const HOP_SEC = 1.0;
// Below this RMS a window is essentially silence; scoring it would pull the similarity mean toward 0
// and misattribute quiet gaps. Placeholder — the /rep/voice meter is the tuning tool.
const RMS_FLOOR = 0.01;
const RING_CAPACITY = Math.round(SAMPLE_RATE * (WINDOW_SEC + 2)); // a little headroom over one window

let engine: VoiceEngine | null = null;
let profile: Float32Array | null = null;

// Scoring state.
let ring: RingBuffer | null = null;
let ringEpoch = -1;
let lastScoredSec = -Infinity;
let scoring = false; // in-flight embed guard — skip a hop rather than queue

// Enrolment state.
let enrollFrames: Float32Array[] = [];

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length || 1));
}

function onPcm(frame: Float32Array, epoch: number): void {
  const prof = profile;
  if (!engine || !prof) return; // nothing to score against yet
  if (!ring || epoch !== ringEpoch) {
    ring = new RingBuffer(RING_CAPACITY);
    ringEpoch = epoch;
    lastScoredSec = -Infinity;
  }
  ring.append(frame);

  const endSec = ring.length / SAMPLE_RATE;
  if (endSec < WINDOW_SEC) return;
  if (endSec - lastScoredSec < HOP_SEC) return;
  if (scoring) return; // an embed is still running — skip this hop, never queue

  const endSample = ring.length;
  const startSample = endSample - WINDOW_SAMPLES;
  const win = ring.slice(startSample, endSample);
  lastScoredSec = endSec;
  if (rms(win) < RMS_FLOOR) return; // silence — post nothing so the mean isn't dragged toward 0

  scoring = true;
  const t0 = startSample / SAMPLE_RATE;
  const t1 = endSample / SAMPLE_RATE;
  engine
    .embed(win)
    .then((emb) => ctx.postMessage({ type: "score", epoch, t0, t1, score: cosine(emb, prof) }))
    .catch((err) => ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }))
    .finally(() => {
      scoring = false;
    });
}

async function finishEnroll(): Promise<void> {
  if (!engine) {
    ctx.postMessage({ type: "error", message: "Voice engine is not ready." });
    return;
  }
  const total = enrollFrames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const f of enrollFrames) {
    all.set(f, o);
    o += f.length;
  }
  enrollFrames = [];

  const hop = Math.round(1.5 * SAMPLE_RATE);
  const embs: Float32Array[] = [];
  for (let start = 0; start + WINDOW_SAMPLES <= all.length; start += hop) {
    const w = all.subarray(start, start + WINDOW_SAMPLES);
    if (rms(w) < RMS_FLOOR) continue;
    embs.push(await engine.embed(new Float32Array(w)));
  }
  // Shorter than one window (or all silent but present): embed the whole thing padded, rather than fail.
  if (embs.length === 0 && all.length > 0) embs.push(await engine.embed(all));

  const mean = meanEmbedding(embs);
  if (mean.length === 0) {
    ctx.postMessage({ type: "error", message: "No usable audio was captured — try again." });
    return;
  }
  ctx.postMessage({ type: "embedding", embedding: mean }, [mean.buffer]);
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as InMessage;
  (async () => {
    try {
      switch (msg.type) {
        case "init":
          engine = await createEngine(msg.modelUrl);
          ctx.postMessage({ type: "ready" });
          break;
        case "profile":
          profile = msg.embedding ? new Float32Array(msg.embedding) : null;
          break;
        case "pcm":
          onPcm(msg.frame, msg.epoch);
          break;
        case "enroll-chunk":
          enrollFrames.push(new Float32Array(msg.pcm));
          break;
        case "enroll-finish":
          await finishEnroll();
          break;
        case "enroll-reset":
          enrollFrames = [];
          break;
      }
    } catch (err) {
      ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
