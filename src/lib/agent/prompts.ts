import type { Decision } from "../decisions";
import type { Clause } from "../knowledge";
import type { Hit } from "../retrieval";
import type { Readiness } from "./readiness";

// Shared prompt fragments. The live path and the background path say the same thing about
// grounding, so they live here rather than in two route files that would quietly drift apart.

export const HOUSE_RULES =
  "Use ONLY the POLICY CLAUSES provided. Never invent figures, product names, limits or coverage, " +
  "and never state a number that does not appear in the clauses — a fabricated figure sitting next " +
  "to a real page citation is the exact failure this product exists to prevent. If the clauses do " +
  "not answer something, say so plainly instead of filling the gap.";

export const POSTURE =
  "You support a Prudential financial representative privately during a live call. The customer " +
  "never sees your output. You never make the recommendation and never speak to the customer — the " +
  "representative decides everything.";

// The shape the live console renders. Both the live call and the pre-computed lookahead produce
// it, so a cached answer is indistinguishable from a fresh one to the UI.
export const POINTER_FIELDS =
  '{"concern": string,            // the customer concern/confusion you detect\n' +
  ' "firstStep": string,          // what the rep should do or check first\n' +
  ' "suggestedLine": string,      // one natural line the rep could say to open\n' +
  ' "explainer": string,          // a plain-language explanation grounded in the clauses\n' +
  ' "comparison": string,         // a short comparison pointer if relevant, else ""\n' +
  ' "followUp": string}           // a follow-up question to surface the customer\'s priority';

export function pointerSystemInstruction(productArea?: string): string {
  return (
    `You are PRUAssist, a PRIVATE co-pilot for a Prudential financial representative during a LIVE ` +
    `conversation about ${productArea ?? "Health Protection (PRUShield)"} insurance. ${POSTURE} ` +
    `${HOUSE_RULES} Produce concise private pointers for the representative. Respond ONLY with JSON ` +
    `of this shape:\n${POINTER_FIELDS}`
  );
}

export function clauseBlock(clauses: (Clause | Hit)[]): string {
  return clauses.map((c, i) => `[${i + 1}] (${c.source})\n${c.text}`).join("\n\n");
}

/**
 * The instruction for a comparison, as distinct from an explanation. The difference that matters:
 * a comparison must say what is not yet settled. Recommending on a dimension the customer has
 * never demonstrated is exactly the failure this product exists to catch.
 */
export function comparisonSystemInstruction(
  decision: Decision,
  readiness: Readiness,
  productArea?: string,
): string {
  const unsettled = [...readiness.blocking, ...readiness.open]
    .map((s) => `${s.label} (${s.state})`)
    .join(", ");

  return (
    `You are PRUAssist, a PRIVATE co-pilot for a Prudential financial representative during a LIVE ` +
    `conversation about ${productArea ?? "Health Protection (PRUShield)"} insurance. ${POSTURE} ` +
    `${HOUSE_RULES}\n\n` +
    `The customer is comparing: ${decision.question}\n` +
    `Options: ${decision.options.map((o) => o.label).join(" · ")}\n` +
    (unsettled
      ? `The customer has NOT demonstrated understanding of: ${unsettled}. Name this in "concern" ` +
        `and put the most important one in "firstStep" — the representative should settle it before ` +
        `recommending, and must not be led to recommend on a dimension the customer has not shown ` +
        `they understand.\n`
      : `The customer has demonstrated every concept that decides this comparison.\n`) +
    `Write "comparison" as the actual difference between the options, in plain language and ` +
    `grounded in the clauses. Respond ONLY with JSON of this shape:\n${POINTER_FIELDS}`
  );
}
