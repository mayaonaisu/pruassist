import { createResampler } from "./pcm";
import { getAudioContext, ensurePcmWorklet } from "./audio-context";

// Standalone 16 kHz mono float capture for the /rep/voice enrolment page and its live "test your voice"
// meter. It reuses the exact same graph as the diarized socket — getUserMedia → pcm-capture worklet →
// resampler to 16 kHz — but is decoupled from Deepgram: no WebSocket, and it emits raw Float32 frames
// because the speaker-embedding model consumes floats (the Deepgram path is the only one that encodes
// linear16). getUserMedia must run inside a user gesture on Safari, and unlockAudio() must already have
// resumed the shared context.
//
// Throws "denied" (mic permission refused) or "unsupported" (no Web Audio / AudioWorklet) so the
// enrolment page can show the right message; every other detail is the same proven path pcm.ts unit-tests.

export type MicPcm = { stop(): void };

export async function startMicPcm16k(
  onFrame: (frame: Float32Array) => void,
  frameSamples = 1600,
): Promise<MicPcm> {
  const ctx = getAudioContext();
  if (!ctx || !ctx.audioWorklet) throw new Error("unsupported");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new Error("denied");
  }

  try {
    if (ctx.state === "suspended") await ctx.resume();
    await ensurePcmWorklet(ctx);
  } catch {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    throw new Error("unsupported");
  }

  const source = ctx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(ctx, "pcm-capture");
  const sink = ctx.createGain();
  sink.gain.value = 0; // route to destination so the worklet is pulled, but stay silent
  const resampler = createResampler(ctx.sampleRate, 16000);
  let pending = new Float32Array(0);

  worklet.port.onmessage = (e: MessageEvent) => {
    const chunk = resampler.push(new Float32Array(e.data as ArrayBuffer));
    if (chunk.length) {
      const merged = new Float32Array(pending.length + chunk.length);
      merged.set(pending, 0);
      merged.set(chunk, pending.length);
      pending = merged;
    }
    while (pending.length >= frameSamples) {
      onFrame(new Float32Array(pending.subarray(0, frameSamples)));
      pending = pending.slice(frameSamples);
    }
  };

  source.connect(worklet);
  worklet.connect(sink);
  sink.connect(ctx.destination);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { worklet.port.onmessage = null; } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
      try { worklet.disconnect(); } catch { /* ignore */ }
      try { sink.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    },
  };
}
