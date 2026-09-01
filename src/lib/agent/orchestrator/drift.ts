import { DEFAULT_TTL, getStore } from "../../store";
import { classify } from "./brain";
import { decideMode } from "./modes";
import type { Mode, OrchestratorInput } from "./types";

// Topic-drift escalation: warn once, then pause.
//
// The first drift-routed turn shows the warning banner (handleTopicDrift). If the conversation
// drifts again on the very next substantive turn, PRUAssist stops offering lines rather than keep
// guessing off-scope — the failure mode this product exists to prevent. It resumes on its own the
// moment the talk returns to the policy.
//
// While paused, resume is judged agentically: the same brain that routes normally still reads each
// turn (a cheap OpenRouter call, no Gemini), and a substantive verdict lifts the pause. When the
// brain is unconfigured or down, the deterministic tier stands in — a question resumes, a bare
// off-topic statement does not. So the pause is never a dead end regardless of the brain's health.
//
// State lives in its own key, not the ledger: the deep pass owns the ledger key under a rev guard,
// and a second writer there would race it. The assist route is the only writer of this key, and the
// client is single-flight per room, so a plain read-modify-write is safe.

// Pause once a substantive turn has drifted this many times in a row. The first drift warns; the
// second pauses.
export const DRIFT_PAUSE_AFTER = 2;

// Result modes that mean the turn was in scope, so any drift streak is over. Keyed off the mode the
// handler actually returned — a guider that stayed quiet returns keep_listening and correctly does
// not reset, while a comparison that fell back to policy_guidance does.
export const RESETS_DRIFT: ReadonlySet<Mode> = new Set<Mode>([
  "policy_guidance",
  "comparison",
  "guider",
  "clarification",
]);

export type DriftState = { count: number; pausedAt: number | null };

const ZERO: DriftState = { count: 0, pausedAt: null };

export const driftKey = (roomId: string) => `sess:drift:${roomId}`;

// Every drift helper fails open to the zero state: a store hiccup degrades to today's warn-every-
// time behaviour, never a thrown error on the live path.
export async function loadDrift(roomId: string): Promise<DriftState> {
  try {
    return (await getStore().get<DriftState>(driftKey(roomId))) ?? ZERO;
  } catch {
    return ZERO;
  }
}

export async function recordDrift(roomId: string, prior: DriftState): Promise<DriftState> {
  const count = prior.count + 1;
  const next: DriftState = { count, pausedAt: count >= DRIFT_PAUSE_AFTER ? (prior.pausedAt ?? Date.now()) : null };
  try {
    await getStore().set(driftKey(roomId), next, DEFAULT_TTL);
  } catch {
    /* fail open — the streak just won't advance this turn */
  }
  return next;
}

export async function clearDrift(roomId: string): Promise<void> {
  try {
    await getStore().del(driftKey(roomId));
  } catch {
    /* fail open */
  }
}

// The line the console shows while paused.
export function pausedMessage(scope: string): string {
  return (
    `Paused — the conversation has moved away from ${scope}, so PRUAssist has stopped suggesting ` +
    `lines to avoid guessing off-topic. It resumes automatically when the discussion returns to the policy.`
  );
}

export type PausedVerdict = { resume: Mode } | { paused: true };

// While paused, decide whether this turn lifts the pause. Spends one brain call (no Gemini); the
// deterministic tier stands in when the brain is unavailable. Does not itself mutate drift state —
// the route clears on resume so the pipeline's own verdict governs the streak.
export async function judgePausedTurn(input: OrchestratorInput): Promise<PausedVerdict> {
  const verdict = (await classify(input)) ?? decideMode(input);
  return RESETS_DRIFT.has(verdict.mode) ? { resume: verdict.mode } : { paused: true };
}
