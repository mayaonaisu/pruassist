// The shared AudioContext and the pcm-capture worklet registration for the in-person capture path.
//
// One AudioContext per tab, on purpose: Safari suspends any context created outside a user gesture and
// is unreliable about how many can coexist, so the diarized socket (useDiarizedSpeech) and the
// /rep/voice enrolment mic (mic-pcm) must share ONE context and register the worklet ONCE. A second
// context, or re-adding the module, is exactly what stalls capture on iPad Safari. This used to live
// inside useDiarizedSpeech; it moved here so both callers reach the same singleton.
//
// No browser types are touched at import time — every reference is inside a function — so this module
// is safe to import from any client component without a "use client" directive of its own.

let sharedCtx: AudioContext | null = null;
let workletAdded = false;

/** The shared AudioContext, created lazily. null when Web Audio is unavailable (SSR, old browser). */
export function getAudioContext(): AudioContext | null {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedCtx) sharedCtx = new Ctor();
    return sharedCtx;
  } catch {
    return null;
  }
}

/**
 * Call from a user gesture (the "Begin session" or enrolment "Start" tap): create and resume the
 * shared context while the gesture is still active, so Safari does not leave it suspended.
 */
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

/** Register the pcm-capture worklet module on the shared context exactly once. Idempotent. */
export async function ensurePcmWorklet(ctx: AudioContext): Promise<void> {
  if (workletAdded) return;
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  workletAdded = true;
}
