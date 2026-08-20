import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";

// One client for everything the agent does. Routes used to construct their own per request, which
// is harmless but means no connection reuse and no single place to change the model.

let client: GoogleGenAI | null = null;

export function getAi(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

// The live path and the background path use the same model. Reasoning effort is what differs:
// the tool loop needs thinking, formatting and grading do not.
//
// Overridable because free-tier quota is per project *per model per day* — 20 requests/day on
// gemini-2.5-flash at the time of writing, which a single lookahead can consume a third of. If a
// demo runs into that ceiling, pointing PRUASSIST_MODEL at another model is a config change
// rather than a deploy.
export const MODEL = process.env.PRUASSIST_MODEL?.trim() || "gemini-2.5-flash";

// Bounds on the background work. The deep pass multiplies calls, so it is capped rather than left
// to run as long as the model likes. Three steps is enough to read the ledger, search once, and
// write the brief; a fourth has never added anything but cost.
export const MAX_TOOL_STEPS = 3;

// Ceiling on background model calls for one advisory session. Comprehension tracking is worth
// paying for; an unbounded background loop on a conversation that never ends is not. When it is
// reached the ledger keeps running on the deterministic detectors, which cost nothing.
export const MAX_BACKGROUND_CALLS = 60;

// 503 UNAVAILABLE and 429 are the model saying "not right now". The background pass has time to
// wait, and without this a demand spike silently turns comprehension tracking off. Anything else
// is a real error and is not worth a second call.
const TRANSIENT = [503, 429];

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
  return { thinkingLevel: mode === "off" ? ThinkingLevel.MINIMAL : ThinkingLevel.MEDIUM };
}

// Counted per invocation, not globally: the deep pass resets it, does its work, and folds the
// total into the session's budget. Retries count, because the quota counts them.
let calls = 0;
export const callsMade = () => calls;
export const resetCallCount = () => {
  calls = 0;
};

// A 429 usually carries the wait it wants. Retrying sooner burns another quota unit and fails
// again, so the advertised delay is honoured — up to a ceiling, past which retrying is pointless
// and the caller should degrade rather than hold a background invocation open.
const MAX_BACKOFF_MS = 20_000;
const DEFAULT_BACKOFF_MS = 1_200;

function backoffFor(e: unknown): number | null {
  const message = e instanceof Error ? e.message : String(e);
  const advertised = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (!advertised) return DEFAULT_BACKOFF_MS;
  const ms = Math.ceil(Number(advertised[1]) * 1000);
  return ms > MAX_BACKOFF_MS ? null : ms;
}

export async function callWithRetry<T>(label: string, call: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      calls += 1;
      return await call();
    } catch (e) {
      const status = (e as { status?: number })?.status;
      const backoff = attempt === 0 && status && TRANSIENT.includes(status) ? backoffFor(e) : null;
      if (backoff !== null) {
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      // The message, not the stack: these are expected operational failures, and a stack trace
      // per blip buries the ones that matter.
      console.error(`[${label}] ${status ?? "error"}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  return null;
}
