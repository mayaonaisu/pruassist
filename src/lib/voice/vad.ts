// Energy-only VAD, deliberately dumb: its job is to stop silence and the other speaker's tail from
// diluting a short run's embedding.

const SAMPLE_RATE = 16000;

export function voicedFrames(pcm: Float32Array, frameMs = 20, floor = 0.01): Float32Array {
  const frameSamples = Math.max(1, Math.round((SAMPLE_RATE * frameMs) / 1000));
  const frames: Array<{ samples: Float32Array; rms: number }> = [];
  let peak = 0;
  for (let start = 0; start < pcm.length; start += frameSamples) {
    const samples = pcm.subarray(start, Math.min(start + frameSamples, pcm.length));
    let energy = 0;
    for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
    const rms = Math.sqrt(energy / samples.length);
    peak = Math.max(peak, rms);
    frames.push({ samples, rms });
  }
  if (peak === 0) return new Float32Array(0);
  const threshold = Math.max(floor, 0.15 * peak);
  const kept = frames.filter((frame) => frame.rms >= threshold);
  const out = new Float32Array(kept.reduce((sum, frame) => sum + frame.samples.length, 0));
  let offset = 0;
  for (const frame of kept) {
    out.set(frame.samples, offset);
    offset += frame.samples.length;
  }
  return out;
}

export function voicedSeconds(pcm: Float32Array, frameMs = 20, floor = 0.01): number {
  return voicedFrames(pcm, frameMs, floor).length / SAMPLE_RATE;
}
