// Raw-PCM conversion for the in-person capture path. No browser types — the AudioWorklet delivers
// Float32 sample frames, and these pure functions turn them into the little-endian 16-bit mono
// `linear16` Deepgram streaming accepts. Kept out of the worklet (which only copies-and-posts) so the
// resample maths can be unit-tested against a known signal.
//
// Why resample at all: Safari's AudioContext runs at the device rate (typically 48 kHz on iPad),
// Deepgram is told `sample_rate=16000`, and constructing an AudioContext at 16 kHz is unreliable
// across Safari versions — so we take the device stream and downsample deterministically here.

/**
 * A stateful, streaming resampler using fractional-phase linear interpolation. `push` takes one chunk
 * of input samples and returns however many output samples are ready; the read phase and the previous
 * chunk's last sample are carried across calls, so a non-integer ratio (44100 or 22050 → 16000) does
 * not drift or click at chunk boundaries. Equal in/out rates are a passthrough copy.
 */
export function createResampler(
  inputRate: number,
  outputRate = 16000,
): { push(chunk: Float32Array): Float32Array } {
  const ratio = inputRate / outputRate;
  let pos = 0; // next fractional read index, relative to the start of the current chunk
  let prevLast = 0; // last sample of the previous chunk — the left neighbour when pos lands in [-1, 0)
  let havePrev = false;

  return {
    push(chunk: Float32Array): Float32Array {
      if (inputRate === outputRate) return chunk.slice();
      const n = chunk.length;
      if (n === 0) return new Float32Array(0);

      const out: number[] = [];
      // Produce while both interpolation neighbours (floor(pos), floor(pos)+1) are within this chunk.
      // floor(pos) === -1 uses prevLast as the left neighbour, bridging the chunk boundary.
      while (Math.floor(pos) + 1 <= n - 1) {
        const i = Math.floor(pos);
        const frac = pos - i;
        const left = i < 0 ? (havePrev ? prevLast : chunk[0]) : chunk[i];
        const right = chunk[i + 1];
        out.push(left + (right - left) * frac);
        pos += ratio;
      }

      pos -= n; // re-base the carried phase onto the next chunk (pos stays ≥ -1 by the break rule)
      prevLast = chunk[n - 1];
      havePrev = true;
      return Float32Array.from(out);
    },
  };
}

// Clamp each sample to [-1, 1] and encode as little-endian signed 16-bit PCM. Negative full-scale maps
// to -32768, positive to 32767 (the asymmetric int16 range).
export function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
