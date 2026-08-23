import type { GoogleGenAI } from "@google/genai";
import { ThinkingLevel, type ThinkingConfig } from "@google/genai";
import { cooldownFor, getAi, isInvalidKeyError, keyCount, rotateAfterRateLimit, statusOf, TRANSIENT_STATUS } from "../genai";

// How the agent talks to Gemini: which model, how hard it should think, and what to do when the
// quota says no. The keys themselves live in ../genai, which both this and retrieval share.

export { getAi };

// The live path and the background path use the same model. Reasoning effort is what differs:
// the tool loop needs thinking, formatting and grading do not.
//
// gemini-3.6-flash rather than the 2.5 series because every key has to be able to reach it —
// 2.5-flash is closed to newly created projects, so a second key added for quota headroom would
// 404 on every call. Overridable, but any override must be a model all the keys can serve.
export const MODEL = process.env.PRUASSIST_MODEL?.trim() || "gemini-3.6-flash";

// Bounds on the background work. The deep pass multiplies calls, so it is capped rather than left
// to run as long as the model likes. Three steps is enough to read the ledger, search once, and
// write the brief; a fourth has never added anything but cost.
export const MAX_TOOL_STEPS = 3;

// Ceiling on background model calls for one advisory session. Comprehension tracking is worth
// paying for; an unbounded background loop on a conversation that never ends is not. When it is
// reached the ledger keeps running on the deterministic detectors, which cost nothing.
export const MAX_BACKGROUND_CALLS = 60;

// Room for a structured answer, with the model's thinking tokens counted against the same budget.
// That is the trap: on the 3.x series MINIMAL thinking is not zero thinking, so a cap sized for the
// JSON alone comes back empty and every caller has to treat a perfectly good call as a failure.
export const JSON_BUDGET = 1600;

// How much the model should think, expressed by intent rather than by number.
//
// The two knobs are not interchangeable across model families: the 2.5 series takes
// `thinkingBudget` in tokens and rejects `thinkingLevel`, while the 3.x series is the other way
// round and returns a bare 400 INVALID_ARGUMENT for `thinkingBudget`. Since PRUASSIST_MODEL exists
// precisely so the model can be swapped under quota pressure, the swap must not break the calls.
//
// "off" is for pure formatting and grading. "dynamic" is for the tool loop, where pinning thinking
// to zero measurably degrades multi-step tool selection.
export function thinking(mode: "off" | "dynamic"): ThinkingConfig {
  const legacyBudget = /^gemini-2\./.test(MODEL);
  if (legacyBudget) return { thinkingBudget: mode === "off" ? 0 : -1 };
  // LOW rather than MINIMAL for "off": some 3.x models (e.g. the gemini-flash-latest alias) reject
  // MINIMAL with a 400, while LOW is accepted across the whole 3.x line and is still barely-thinking.
  return { thinkingLevel: mode === "off" ? ThinkingLevel.LOW : ThinkingLevel.MEDIUM };
}

// Counted per invocation, not globally: the deep pass resets it, does its work, and folds the
// total into the session's budget. Retries count, because the quota counts them.
let calls = 0;
export const callsMade = () => calls;
export const resetCallCount = () => {
  calls = 0;
};

// Waiting longer than this is worse than degrading — the caller has a fallback, and a background
// invocation held open for half a minute is its own problem. Rotating to another key skips it.
const MAX_BACKOFF_MS = 20_000;

/**
 * Runs a Gemini call, surviving the two ways the free tier says no.
 *
 * On a rate limit it first tries another key — instant, and the usual case once a second project
 * is configured. Only when every key is cooling does it fall back to waiting out the delay the API
 * asked for, and only if that delay is short enough to be worth holding the invocation open.
 *
 * The client is passed in rather than captured, so a rotation actually takes effect: a closure
 * over the old client would retry against the key that just ran out.
 *
 * `allowSleep: false` is for the live path, where the rep is waiting and a rotation is the only
 * recovery worth having.
 */
export async function callWithRetry<T>(
  label: string,
  call: (ai: GoogleGenAI) => Promise<T>,
  { allowSleep = true } = {},
): Promise<T | null> {
  let slept = false;
  // One attempt per key, plus one more for the sleep-and-retry path.
  for (let attempt = 0; attempt <= keyCount(); attempt++) {
    const ai = getAi();
    if (!ai) return null;
    try {
      calls += 1;
      return await call(ai);
    } catch (e) {
      const status = statusOf(e);
      const msg = e instanceof Error ? e.message : String(e);
      // A bad key (400 API_KEY_INVALID) is not transient and not the whole pool's fault. One bad key
      // must not kill the call: cool it off hard and try the next one, exactly like a rate limit.
      if (isInvalidKeyError(e) && rotateAfterRateLimit(24 * 60 * 60 * 1000)) {
        console.error(`[${label}] invalid API key — rotating to another key`);
        continue;
      }
      if (status && TRANSIENT_STATUS.includes(status)) {
        const cool = cooldownFor(e);
        // Rotate to a free key for BOTH 429 (quota) and 503 (model busy): the live path can't sleep,
        // so a busy key must be skipped immediately rather than fail the call. Sleeping is the last
        // resort, only when every key is cooling and the caller allows it.
        if (rotateAfterRateLimit(cool)) continue;
        if (allowSleep && !slept && cool <= MAX_BACKOFF_MS) {
          await new Promise((r) => setTimeout(r, cool));
          slept = true;
          continue;
        }
      }
      // The message, not the stack: these are expected operational failures, and a stack trace
      // per blip buries the ones that matter.
      console.error(`[${label}] ${status ?? "error"}: ${msg}`);
      return null;
    }
  }
  console.error(`[${label}] every key is rate limited`);
  return null;
}
