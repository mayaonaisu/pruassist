import { conceptsForArea } from "../../concepts";
import { looksComparative } from "../../decisions";
import { activeDecision } from "../readiness";
import { conceptsMentioned, isBareAssent, isQuestion, termRegex } from "../utterance";
import type { ModeDecision, OrchestratorInput } from "./types";

// Words that only belong to another conversation. The universal set is off-scope in any advisory
// area; the per-scope set is off-scope only where it does not belong (investing is drift in a health
// discussion, but the point of a retirement one). Kept deliberately narrow so the check stays
// high-precision — a false drift is worse than a missed one.
const OFF_DOMAIN_UNIVERSAL = [
  "weather", "football", "soccer", "basketball", "rugby", "cricket", "sports",
  "holiday", "vacation", "traffic", "lunch", "dinner", "restaurant", "movie", "weekend", "politics", "election",
];
const OFF_DOMAIN_BY_SCOPE: Record<string, string[]> = {
  "Health Protection": ["invest", "investment", "investing", "stocks", "shares", "crypto", "bitcoin", "forex", "trading"],
};

function matchesOffDomain(text: string, scope: string): boolean {
  const cues = [...OFF_DOMAIN_UNIVERSAL, ...(OFF_DOMAIN_BY_SCOPE[scope] ?? [])];
  return cues.some((t) => termRegex(t).test(text));
}

/**
 * A high-precision, model-free "this is off the discussion scope" signal: the turn names an
 * off-domain cue, names no in-scope concept, and is not asking to compare the options in play.
 * Deliberately conservative — it only fires on clearly-elsewhere talk, so it is safe both as the
 * deterministic tier's own verdict AND as an override when the LLM brain misclassifies a drift.
 */
export function looksOffScope(input: OrchestratorInput): boolean {
  const text = input.clarifyContext ? `${input.clarifyContext}\n${input.asked}` : input.asked;
  if (!matchesOffDomain(text, input.scope)) return false;
  if (conceptsMentioned(text, conceptsForArea(input.scope)).length) return false;
  const decision = activeDecision(input.state);
  if (decision && looksComparative(text, decision)) return false;
  return true;
}

// The deterministic router: the fallback tier beneath the LLM brain, and the offline test oracle.
//
// It reliably handles an ack, a clearly off-scope turn, a comparison, and a question. guider and
// clarification still turn on intent a rule judges poorly, so the deterministic tier leaves those to
// the LLM brain and falls back to keep_listening rather than risk a wrong interjection — but drift
// no longer depends solely on the brain: a high-precision off-domain check catches it here too.
export function decideMode(input: OrchestratorInput): ModeDecision {
  const text = input.clarifyContext ? `${input.clarifyContext}\n${input.asked}` : input.asked;

  // An ack with no content behind it: do not interrupt the rep.
  if (isBareAssent(text)) return { mode: "keep_listening", why: "bare assent" };

  // Clearly off the selected scope: warn, rather than answer a question that was never in scope.
  if (looksOffScope(input)) return { mode: "topic_drift", why: "clearly off the discussion scope" };

  // Weighing the options actually in play, per the ledger.
  const decision = activeDecision(input.state);
  if (decision && looksComparative(text, decision)) {
    return { mode: "comparison", why: `comparative about ${decision.id}` };
  }

  // Any other question: retrieve and answer. Retrieval decides whether a clause covers it.
  if (isQuestion(text)) return { mode: "policy_guidance", why: "a question — retrieve and answer" };

  // A non-question, non-assent statement. The LLM brain may make this a guider; the deterministic
  // tier stays quiet rather than guess.
  return { mode: "keep_listening", why: "no rule-certain action" };
}
