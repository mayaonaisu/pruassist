/**
 * Voiceprint pipeline check — proves the VENDORED mel pipeline (src/lib/voice/features.ts) matches the
 * model's training-time features, the risk the whole feature hinges on (any drift silently ruins
 * similarity). No download, no browser: it synthesises three clips with the built-in Windows TTS — two
 * from one voice, one from another — embeds each through the real ONNX model with onnxruntime-web, and
 * checks that the same-speaker pair scores higher than the different-speaker pair.
 *
 *   npm run voice:check
 *
 * Windows-only (System.Speech for TTS) and needs onnxruntime-web (a dependency) + the committed model at
 * public/models/next-tdnn-c128.onnx. Skips (exit 0) where it cannot run, like the other *:check scripts.
 * Reference guidance is same > 0.5 / different < 0.3; the hard invariant asserted here is same > different.
 */
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResampler } from "../src/lib/pcm.ts";
import { melSpectrogram } from "../src/lib/voice/features.ts";
import { fitWindow, cosine } from "../src/lib/voice/window.ts";

const MODEL = "public/models/next-tdnn-c128.onnx";

if (process.platform !== "win32") {
  console.log("voice:check uses Windows System.Speech for TTS; skipping on this platform.");
  process.exit(0);
}
if (!existsSync(MODEL)) {
  console.error(`Model not found at ${MODEL}. Commit it (see CLAUDE.md) before running voice:check.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "voicecheck-"));

function synth(text: string, voice: string, wav: string): void {
  const ps =
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `try { $s.SelectVoice('${voice}') } catch {}; $s.Rate = -1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${text}'); $s.Dispose()`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
}

// Minimal PCM-WAV reader (mono, 16-bit), same as diarize-check.
function wavToFloat32(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let off = 12;
  let sampleRate = 0, channels = 1, bits = 16, dataStart = 0, dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataSize = size;
    }
    off = body + size + (size & 1);
  }
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);
  const frames = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768;
  return { samples, sampleRate };
}

function clipTo16k(text: string, voice: string, name: string): Float32Array {
  const wav = join(dir, `${name}.wav`);
  synth(text, voice, wav);
  const { samples, sampleRate } = wavToFloat32(readFileSync(wav));
  return createResampler(sampleRate, 16000).push(samples);
}

async function main() {
  const ortNS = await import("onnxruntime-web");
  const ort = (ortNS as unknown as { default?: typeof ortNS }).default ?? ortNS;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;

  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];

  async function embed(pcm16k: Float32Array): Promise<Float32Array> {
    const { data, frames } = melSpectrogram(fitWindow(pcm16k));
    const t = new ort.Tensor("float32", data, [1, 80, frames]);
    const r = await session.run({ [inName]: t });
    const out = r[outName];
    const raw = out.data as Float32Array;
    let emb: Float32Array;
    if (out.dims.length === 3) {
      const hidden = out.dims[1] as number;
      const time = out.dims[2] as number;
      emb = new Float32Array(hidden);
      for (let h = 0; h < hidden; h++) {
        let s = 0;
        for (let k = 0; k < time; k++) s += raw[h * time + k];
        emb[h] = s / time;
      }
    } else {
      emb = new Float32Array(raw);
    }
    let n = 0;
    for (const v of emb) n += v * v;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < emb.length; i++) emb[i] /= n;
    return emb;
  }

  console.log("Synthesising three clips and embedding them through the ONNX model…\n");
  const david1 = "Thanks for coming in today. I want to walk you through how the PRUShield deductible works before we compare the plans in detail.";
  const david2 = "The co-insurance is the share of the bill you pay after the deductible, and the rider can bring that share right down.";
  const zira1 = "So does that mean I have to pay the first part of every hospital bill myself before the insurance starts to help me?";

  const embA = await embed(clipTo16k(david1, "Microsoft David Desktop", "a"));
  const embB = await embed(clipTo16k(david2, "Microsoft David Desktop", "b"));
  const embC = await embed(clipTo16k(zira1, "Microsoft Zira Desktop", "c"));

  const same = cosine(embA, embB);
  const diff = cosine(embA, embC);
  console.log(`  same-speaker    (David / David): ${same.toFixed(3)}`);
  console.log(`  different-speaker (David / Zira): ${diff.toFixed(3)}`);
  console.log(`  reference guidance: same > 0.5, different < 0.3`);

  if (!(same > diff)) {
    console.error("\nFAIL: same-speaker similarity is not greater than different-speaker — the mel pipeline is likely wrong.");
    process.exit(1);
  }
  console.log("\nPASS: same-speaker similarity exceeds different-speaker.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
