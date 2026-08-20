import { GoogleGenAI } from "@google/genai";

// A pool of Gemini API keys, rotated when one runs out of quota.
//
// The free tier allows twenty generateContent calls per model per day and ten per minute, which a
// single advisory session can exhaust. A second key from a second project doubles that, and the
// rotation is worth having precisely at the moment it matters — mid-demo, when there is no time to
// change an environment variable and redeploy.
//
// Keys are read from GEMINI_API_KEY plus GEMINI_API_KEY_2 … _5. They must all serve the same
// model: a key issued to a new project cannot reach gemini-2.5-flash, which is why MODEL defaults
// to a model every key can use.

const MAX_KEYS = 5;

type Pooled = { client: GoogleGenAI; coolUntil: number };

let pool: Pooled[] | null = null;
let current = 0;

function build(): Pooled[] {
  const raw = [process.env.GEMINI_API_KEY, ...Array.from({ length: MAX_KEYS - 1 }, (_, i) => process.env[`GEMINI_API_KEY_${i + 2}`])];
  const keys = [...new Set(raw.map((k) => k?.trim()).filter((k): k is string => Boolean(k)))];
  return keys.map((apiKey) => ({ client: new GoogleGenAI({ apiKey }), coolUntil: 0 }));
}

function ensure(): Pooled[] {
  if (!pool) pool = build();
  return pool;
}

/** How many keys are configured. One means rotation is a no-op. */
export function keyCount(): number {
  return ensure().length;
}

/**
 * A client for the current key, preferring one that is not cooling off. When every key is cooling
 * it returns the current one anyway — a call that might fail beats going silent, and the caller
 * already knows how to degrade.
 */
export function getAi(): GoogleGenAI | null {
  const p = ensure();
  if (!p.length) return null;
  const now = Date.now();
  if (p[current].coolUntil <= now) return p[current].client;
  const free = p.findIndex((k) => k.coolUntil <= now);
  if (free !== -1) current = free;
  return p[current].client;
}

/**
 * Report that the current key is rate limited, and move to another if one is available.
 * Returns true when a different key is ready now, so the caller can retry immediately instead of
 * waiting out the cooldown.
 */
export function rotateAfterRateLimit(coolMs: number): boolean {
  const p = ensure();
  if (!p.length) return false;
  p[current].coolUntil = Date.now() + coolMs;
  const now = Date.now();
  const free = p.findIndex((k) => k.coolUntil <= now);
  if (free === -1) return false;
  current = free;
  return true;
}

/** Whether at least one key is configured. */
export function haveKey(): boolean {
  return ensure().length > 0;
}

// The two ways the free tier says no. 429 is quota, 503 is the model being busy.
export const TRANSIENT_STATUS = [503, 429];

// A 429 usually carries the wait it wants; anything else gets a short default. Used both to decide
// how long to cool a key and how long to wait when every key is cooling.
const DEFAULT_COOLDOWN_MS = 1_200;

export function cooldownFor(e: unknown): number {
  const message = e instanceof Error ? e.message : String(e);
  const advertised = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return advertised ? Math.ceil(Number(advertised[1]) * 1000) : DEFAULT_COOLDOWN_MS;
}

export function statusOf(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

// Only for the replay harness, which deletes the key env vars before importing.
export function resetPool(): void {
  pool = null;
  current = 0;
}
