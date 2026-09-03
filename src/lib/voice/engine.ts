import * as ort from "onnxruntime-web";
import { melSpectrogram, N_MELS } from "./features";
import { fitWindow } from "./window";

// The ONNX speaker-embedding engine. Runs INSIDE the worker (voice.worker.ts) — onnxruntime-web is a
// large WASM dependency and must never enter the main bundle. Single-threaded on purpose: multi-thread
// ORT needs SharedArrayBuffer and therefore COOP/COEP headers, which this app does not serve.
//
// Vendored inference logic from @jaehyun-ko/speaker-verification 5.0.0 (src/core/model.ts), Apache-2.0:
// input tensor [1, 80, frames]; the output is [1, 192] already, or [1, 192, frames] which is mean-pooled
// over time; then L2-normalised so cosine similarity is a dot product.

export type VoiceEngine = {
  embed(pcm16k: Float32Array): Promise<Float32Array>; // 192-d unit vector
  close(): Promise<void>;
};

export async function createEngine(modelUrl: string): Promise<VoiceEngine> {
  ort.env.wasm.wasmPaths = "/ort/"; // served as static assets (see scripts/copy-ort-wasm.mjs)
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  return {
    async embed(pcm16k: Float32Array): Promise<Float32Array> {
      const { data, frames } = melSpectrogram(fitWindow(pcm16k));
      const tensor = new ort.Tensor("float32", data, [1, N_MELS, frames]);
      const results = await session.run({ [inputName]: tensor });
      const output = results[outputName];
      const raw = output.data as Float32Array;

      let emb: Float32Array;
      if (output.dims.length === 3) {
        // [1, hidden, time] → mean-pool over time.
        const hidden = output.dims[1];
        const time = output.dims[2];
        emb = new Float32Array(hidden);
        for (let h = 0; h < hidden; h++) {
          let sum = 0;
          for (let t = 0; t < time; t++) sum += raw[h * time + t];
          emb[h] = sum / time;
        }
      } else {
        // [1, hidden] — already pooled.
        emb = new Float32Array(raw);
      }

      let norm = 0;
      for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < emb.length; i++) emb[i] /= norm;
      return emb;
    },

    async close(): Promise<void> {
      await session.release();
    },
  };
}
