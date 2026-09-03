import { CANONICAL_TERMS } from "./terms";
import { isBareAssent, isQuestion } from "./agent/utterance";
import type { TextCue } from "./diarize";

// Text-only heuristics for who is speaking, the fallback the voice engine falls back TO (no profile, no
// model yet, WASM unsupported). Pure and deterministic — no tone, no timing, only the words — so it can
// be unit-tested and so it never contradicts the privacy stance (nothing is inferred from HOW something
// was said). Each rule casts at most one vote for a side; attributeFinal sums them across an index's
// runs and acts only on a clear margin, so a single ambiguous line stays neutral.

const REP_CHECKINS = [
  /\bdoes that make sense\b/,
  /\bmakes? sense so far\b/,
  /\bany questions?\b/,
  /\bshall we\b/,
  /\blet me (explain|show you|walk you|go through|run you)\b/,
  /\bwould you like me to\b/,
  /\bare you (with me|following|okay with)\b/,
];

const REP_FRAMES = [
  // "the deductible is / co-insurance means / premium covers …" — a product term in a teaching frame.
  /\b(the )?(deductible|co-?insurance|co-?pay|premium|rider|panel|policy year|excess)\b[^.?!]{0,40}\b(is|are|means?|works?|covers?|applies|refers)\b/,
  /\bour (plan|policy|rider|coverage|panel)\b/,
  /\byou(?:'|’)?ll (pay|get|be covered|receive|have|need to)\b/,
  /\bin your case\b/,
  /\bfor (example|instance)\b/,
  /\bwhat (this|that) means is\b/,
  /\bi(?:'|’)?d recommend\b/,
  /\bi recommend\b/,
];

const CUST_UNCERTAINTY = [
  /\bi (?:don(?:'|’)?t|do not) (understand|get|know|follow)\b/,
  /\bso i (pay|have to|get|need|would|only)\b/,
  /\bdo i (have to|need to|get to)\b/,
  /\bwhat if i\b/,
  /\bwhat happens if\b/,
  /\bi(?:'|’)?m (not sure|confused|worried|lost)\b/,
  /\bi am (not sure|confused|worried|lost)\b/,
  /\bhow much (do|will|would) i\b/,
];

function firstName(name?: string): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

function addresses(text: string, name?: string): boolean {
  const first = firstName(name);
  if (first.length < 2) return false;
  return new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

const TERM_RES = CANONICAL_TERMS.map(
  (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i"),
);

/**
 * Vote for who said `text`. Small aggregate rules, one vote each; the caller decides on the margin.
 * `ctx` supplies the two first names so "thanks, Sarah" (rep addressing the customer) and "so, John?"
 * (customer addressing the rep) each nudge the right way.
 */
export function textCue(text: string, ctx: { repName?: string; customerName?: string } = {}): TextCue {
  const t = text.trim();
  if (!t) return { repVotes: 0, customerVotes: 0 };
  const low = t.toLowerCase();
  let repVotes = 0;
  let customerVotes = 0;

  const checkin = REP_CHECKINS.some((re) => re.test(low));
  if (checkin) repVotes += 1;
  if (REP_FRAMES.some((re) => re.test(low))) repVotes += 1;

  // A branded term inside a full, explanatory sentence reads as the rep teaching, not the customer
  // echoing a single word. Guard on length so a bare "PRUShield?" stays a (customer) question.
  const words = low.split(/\s+/).filter(Boolean).length;
  if (words >= 8 && TERM_RES.some((re) => re.test(t))) repVotes += 1;

  if (addresses(t, ctx.customerName)) repVotes += 1;

  // A question counts for the customer only when the rep did not just ask a check-in question. Use the
  // strict isQuestion ("?" or an interrogative opener), NOT looksLikeQuestion — the latter fires on any
  // sentence containing "deductible"/"premium"/… , which would give every rep explanation a spurious
  // customer vote.
  if (!checkin && isQuestion(t)) customerVotes += 1;
  if (CUST_UNCERTAINTY.some((re) => re.test(low))) customerVotes += 1;
  if (addresses(t, ctx.repName)) customerVotes += 1;
  if (isBareAssent(t)) customerVotes += 1;

  return { repVotes, customerVotes };
}
