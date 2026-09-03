// Log-mel feature extraction for the NeXt-TDNN speaker-embedding model.
//
// Vendored — the constants and every formula are copied VERBATIM from the reference port so the
// features match the ones the model was trained on. Any drift (window, FFT size, mel range, natural
// vs base-10 log, per-bin mean normalisation) silently ruins similarity, so this file is the single
// place those numbers live, with the reference file each came from named beside it.
//
// Reference: @jaehyun-ko/speaker-verification 5.0.0 — src/audio/preprocessor.ts and src/audio/utils.ts
// (github.com/jaehyun-ko/node-speaker-verification), Apache-2.0. Model: NeXt-TDNN (Heo et al., ICASSP
// 2024) exported to ONNX by jaehyun-ko (huggingface.co/jaehyun-ko/next-tdnn-onnx), Apache-2.0.
// No vendor key, no runtime download — the model and this code ship with the app.

export const SAMPLE_RATE = 16000;
export const N_FFT = 512;
export const N_MELS = 80;
export const WIN_LENGTH = 400; // 25 ms
export const HOP_LENGTH = 160; // 10 ms
const PRE_EMPHASIS = 0.97;
const F_MIN = 20;
const F_MAX = 7600;
const LOG_FLOOR = 1e-6;

/* ---------- radix-2 FFT (src/audio/utils.ts) ---------- */

class FFT {
  private size: number;
  private cosTable: Float32Array;
  private sinTable: Float32Array;
  private reverseTable: Uint32Array;

  constructor(size: number) {
    this.size = size;
    const log2Size = Math.log2(size);
    if (log2Size !== Math.floor(log2Size)) throw new Error("FFT size must be a power of 2");

    this.cosTable = new Float32Array(size / 2);
    this.sinTable = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      const angle = (2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    this.reverseTable = new Uint32Array(size);
    const shift = 32 - log2Size;
    for (let i = 0; i < size; i++) this.reverseTable[i] = this.reverseBits(i) >>> shift;
  }

  private reverseBits(x: number): number {
    x = ((x & 0x55555555) << 1) | ((x & 0xaaaaaaaa) >>> 1);
    x = ((x & 0x33333333) << 2) | ((x & 0xcccccccc) >>> 2);
    x = ((x & 0x0f0f0f0f) << 4) | ((x & 0xf0f0f0f0) >>> 4);
    x = ((x & 0x00ff00ff) << 8) | ((x & 0xff00ff00) >>> 8);
    x = ((x & 0x0000ffff) << 16) | ((x & 0xffff0000) >>> 16);
    return x;
  }

  forward(real: Float32Array, imag: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reverseTable[i];
      if (j > i) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const tableStep = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfSize; j++, k += tableStep) {
          const l = j + halfSize;
          const cos = this.cosTable[k];
          const sin = this.sinTable[k];
          const tReal = real[l] * cos - imag[l] * sin;
          const tImag = real[l] * sin + imag[l] * cos;
          real[l] = real[j] - tReal;
          imag[l] = imag[j] - tImag;
          real[j] += tReal;
          imag[j] += tImag;
        }
      }
    }
  }
}

/* ---------- mel filterbank (src/audio/preprocessor.ts) ---------- */

const hzToMel = (hz: number): number => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel: number): number => 700 * (Math.pow(10, mel / 2595) - 1);

const FFT_BINS = Math.floor(N_FFT / 2) + 1; // 257

function buildFilterBank(): { filters: Float32Array[]; centersHz: Float32Array } {
  const melMin = hzToMel(F_MIN);
  const melMax = hzToMel(F_MAX);
  const melPoints = new Float32Array(N_MELS + 2);
  for (let i = 0; i < N_MELS + 2; i++) melPoints[i] = melMin + ((melMax - melMin) * i) / (N_MELS + 1);
  const hzPoints = melPoints.map((mel) => melToHz(mel));
  const binPoints = hzPoints.map((hz) => Math.floor(((N_FFT + 1) * hz) / SAMPLE_RATE));

  const filters: Float32Array[] = [];
  for (let i = 0; i < N_MELS; i++) {
    const filter = new Float32Array(FFT_BINS);
    const startBin = binPoints[i];
    const centerBin = binPoints[i + 1];
    const endBin = binPoints[i + 2];
    for (let j = startBin; j < centerBin; j++) filter[j] = (j - startBin) / (centerBin - startBin);
    for (let j = centerBin; j < endBin; j++) filter[j] = (endBin - j) / (endBin - centerBin);
    filters.push(filter);
  }
  // Each mel bin's centre frequency (the middle mel point), for tests and diagnostics.
  const centersHz = new Float32Array(N_MELS);
  for (let i = 0; i < N_MELS; i++) centersHz[i] = hzPoints[i + 1];
  return { filters, centersHz };
}

// Built once — the config is fixed.
const fft = new FFT(N_FFT);
const { filters: MEL_FILTERS, centersHz: MEL_CENTERS } = buildFilterBank();
const HAMMING = new Float32Array(WIN_LENGTH);
for (let i = 0; i < WIN_LENGTH; i++) HAMMING[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WIN_LENGTH - 1));

// Scratch buffers reused across frames within one call (single-threaded worker).
const reBuf = new Float32Array(N_FFT);
const imBuf = new Float32Array(N_FFT);

/** Each mel bin's centre frequency in Hz. */
export const melCentersHz = (): Float32Array => MEL_CENTERS.slice();

/**
 * The 80-bin log-mel vector for ONE frame (≥ WIN_LENGTH samples), BEFORE the across-time mean
 * normalisation. Hamming window → zero-pad to N_FFT → FFT → power spectrum × mel filter → ln(x + 1e-6).
 * Exposed for tests (a stationary tone's energy lands in one bin here, but is cancelled by the
 * per-bin mean subtraction in melSpectrogram).
 */
export function logMelFrame(frame: Float32Array): Float32Array {
  reBuf.fill(0);
  imBuf.fill(0);
  for (let i = 0; i < WIN_LENGTH; i++) reBuf[i] = frame[i] * HAMMING[i];
  fft.forward(reBuf, imBuf);

  const out = new Float32Array(N_MELS);
  for (let m = 0; m < N_MELS; m++) {
    const filter = MEL_FILTERS[m];
    let energy = 0;
    for (let i = 0; i < FFT_BINS; i++) {
      const mag = Math.sqrt(reBuf[i] * reBuf[i] + imBuf[i] * imBuf[i]);
      energy += mag * mag * filter[i]; // power spectrum × triangular filter
    }
    if (isNaN(energy) || energy < 0) energy = 0;
    out[m] = Math.log(energy + LOG_FLOOR); // natural log, matching torch.log(x + 1e-6)
  }
  return out;
}

/**
 * Log-mel spectrogram for a PCM window, laid out row-major as [N_MELS, frames] — exactly the
 * [1, 80, frames] tensor the ONNX model takes. Applies pre-emphasis, then per-bin mean subtraction
 * across time (torch: x - mean(x, dim=-1)).
 */
export function melSpectrogram(pcm16k: Float32Array): { data: Float32Array; frames: number } {
  // Pre-emphasis (src/audio/preprocessor.ts).
  const emph = new Float32Array(pcm16k.length);
  emph[0] = pcm16k[0] ?? 0;
  for (let i = 1; i < pcm16k.length; i++) emph[i] = pcm16k[i] - PRE_EMPHASIS * pcm16k[i - 1];

  const frames = Math.max(0, Math.floor((emph.length - WIN_LENGTH) / HOP_LENGTH) + 1);
  const data = new Float32Array(N_MELS * frames);

  for (let f = 0; f < frames; f++) {
    const frame = emph.subarray(f * HOP_LENGTH, f * HOP_LENGTH + WIN_LENGTH);
    const mel = logMelFrame(frame);
    for (let m = 0; m < N_MELS; m++) data[m * frames + f] = mel[m];
  }

  // Per-bin mean normalisation across time.
  for (let m = 0; m < N_MELS; m++) {
    let sum = 0;
    for (let f = 0; f < frames; f++) sum += data[m * frames + f];
    const mean = frames ? sum / frames : 0;
    for (let f = 0; f < frames; f++) data[m * frames + f] -= mean;
  }

  return { data, frames };
}
