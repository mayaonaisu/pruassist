// Windowing, similarity and a sample ring for the voice engine. Pure and dependency-free so it can be
// unit-tested; the numbers come from the reference inference path (src/core/inference.ts): the model
// takes exactly 3.0 s at 16 kHz = 48 240 samples = 300 frames (win 400, hop 160).

export const WINDOW_SAMPLES = 48240;

/** Zero-pad or truncate to exactly WINDOW_SAMPLES, the fixed input length the model expects. */
export function fitWindow(pcm: Float32Array): Float32Array {
  if (pcm.length === WINDOW_SAMPLES) return pcm.slice();
  const out = new Float32Array(WINDOW_SAMPLES);
  out.set(pcm.length > WINDOW_SAMPLES ? pcm.subarray(0, WINDOW_SAMPLES) : pcm);
  return out;
}

/**
 * Tile short utterances instead of zero-padding: features.ts normalises each mel bin across time, and
 * filling most frames with silence otherwise weakens short-utterance speaker verification.
 */
export function tileWindow(pcm: Float32Array): Float32Array {
  if (pcm.length >= WINDOW_SAMPLES) return pcm.slice(0, WINDOW_SAMPLES);
  const out = new Float32Array(WINDOW_SAMPLES);
  if (pcm.length === 0) return out;
  for (let offset = 0; offset < out.length; offset += pcm.length) {
    out.set(pcm.subarray(0, Math.min(pcm.length, out.length - offset)), offset);
  }
  return out;
}

/** Cosine similarity in [-1, 1]. Robust to un-normalised inputs; 0 if either vector is all-zero. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.max(-1, Math.min(1, c));
}

/** Average a list of embeddings and L2-normalise the result (an empty list yields an empty vector). */
export function meanEmbedding(list: Float32Array[]): Float32Array {
  if (list.length === 0) return new Float32Array(0);
  const dim = list[0].length;
  const acc = new Float32Array(dim);
  for (const v of list) for (let i = 0; i < dim; i++) acc[i] += v[i];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    acc[i] /= list.length;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) acc[i] /= norm;
  return acc;
}

/**
 * A fixed-capacity circular buffer of 16 kHz samples with ABSOLUTE indexing: `append` advances a
 * running total, and `slice(fromSample, toSample)` returns that absolute range (samples no longer
 * retained, or not yet written, come back as zeros). The worker uses it to pull the last 3.0 s ending
 * at the newest audio without copying the whole session.
 */
export class RingBuffer {
  private buf: Float32Array;
  private written = 0; // total samples ever appended (absolute index of the next write)

  constructor(private capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** Absolute number of samples appended so far. */
  get length(): number {
    return this.written;
  }

  append(frame: Float32Array): void {
    for (let i = 0; i < frame.length; i++) this.buf[(this.written + i) % this.capacity] = frame[i];
    this.written += frame.length;
  }

  slice(fromSample: number, toSample: number): Float32Array {
    const from = Math.max(0, Math.floor(fromSample));
    const to = Math.max(from, Math.floor(toSample));
    const out = new Float32Array(to - from);
    const oldest = Math.max(0, this.written - this.capacity);
    for (let abs = from; abs < to; abs++) {
      if (abs >= oldest && abs < this.written) out[abs - from] = this.buf[abs % this.capacity];
    }
    return out;
  }
}
