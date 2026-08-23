import { looksComparative } from "../../decisions";
import { activeDecision } from "../readiness";
import { isBareAssent, isQuestion } from "../utterance";
import type { ModeDecision, OrchestratorInput } from "./types";

// The deterministic router: the fallback tier beneath the LLM brain, and the offline test oracle.
//
// It reliably handles the three modes a rule can be trusted on — an ack, a comparison, a question.
// guider / clarification / topic_drift turn on intent and off-scope-ness that a rule judges poorly
// with a single authored product area, so the deterministic tier leaves those to the LLM brain and
// falls back to keep_listening rather than risk a wrong interjection when the model is unavailable.
export function decideMode(input: OrchestratorInput): ModeDecision {
  const text = input.clarifyContext ? `${input.clarifyContext}\n${input.asked}` : input.asked;

  // An ack with no content behind it: do not interrupt the rep.
  if (isBareAssent(text)) return { mode: "keep_listening", why: "bare assent" };

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
