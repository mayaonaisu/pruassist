// Domain-term correction for the transcript.
//
// Both halves of the call are transcribed by the browser's Web Speech API, which has never heard of
// PRUShield and renders it "pru shield", "peru shield", or "true shield". Chrome ignores
// SpeechGrammarList, so the recogniser itself cannot be taught the vocabulary — the fix has to be a
// pass over the text after it arrives. This runs on every final and interim line before it is shown
// or routed, so a corrected term flows through display, the guider's concept gate, retrieval, and
// the detectors alike.
//
// Deterministic on purpose: a mis-heard brand name is a spelling problem, not a judgement call, and
// a model call per line would add latency and a failure path to the live loop for no gain. Add new
// products' aliases here when you add their clauses (see docs/kb-authoring.md).

// Each canonical form maps to the surface strings that should become it: spacing/hyphen variants
// and the recogniser's common mishears. Keep aliases distinctive — a generic word ("panel",
// "premium", "rider") would corrupt ordinary speech, so only branded or compound terms belong here.
// Longer aliases are applied first (built below), so "pru active protect" resolves before the bare
// "pru active" rule can touch it.
const CANONICAL: Record<string, string[]> = {
  // Product + rider variants. These are listed before the bare product names, but ordering here does
  // not matter — RULES sorts every alias longest-first, so "pru shield premier" always resolves
  // before "pru shield".
  "PRUActive Retirement II": ["pru active retirement 2", "pru active retirement two", "pru active retirement ii", "pruactive retirement 2", "pruactive retirement two"],
  "PRUExtra Premier Care": ["pru extra premier care", "pruextra premier care"],
  "PRUExtra Preferred Care": ["pru extra preferred care", "pruextra preferred care"],
  "PRUExtra Plus Care": ["pru extra plus care", "pruextra plus care"],
  "PRUPanel Connect": ["pru panel connect", "prupanel connect", "pool panel connect", "prue panel connect", "pruconnect", "pru connect"],
  "PRUShield Premier": ["pru shield premier", "prushield premier", "peru shield premier"],
  "PRUShield Standard": ["pru shield standard", "prushield standard", "peru shield standard"],
  "PRUShield Plus": ["pru shield plus", "prushield plus", "peru shield plus"],
  "PRUActive Retirement": ["pru active retirement", "prue active retirement", "pruactive retirement"],
  "PRUActive Protect": ["pru active protect", "prue active protect", "pruactive protect", "pro active protect"],
  "PRUPersonal Accident": ["pru personal accident", "prue personal accident", "prupersonal accident"],
  "PRUActive Term": ["pru active term", "prue active term", "pruactive term"],
  "MediShield Life": ["medishield life", "medi shield life", "medi-shield life"],
  "PRUActive": ["pru active", "prue active", "pruactive", "pro active"],
  "PRUShield": ["pru shield", "prue shield", "peru shield", "true shield", "crew shield", "prew shield", "pru she'll", "pru-shield", "prushield"],
  "PRUExtra": ["pru extra", "prue extra", "per extra", "pru x-tra", "pru xtra", "pru-extra", "pruextra"],
  "MediShield": ["medishield", "medi shield", "medi-shield"],
  "MediSave": ["medisave", "medi save", "medi-save", "medisafe"],
  "co-insurance": ["co insurance", "coinsurance"],
  "pro-ration": ["proration", "pro ration"],
  "pro-rated": ["prorated", "pro rated"],
  "stop-loss": ["stop loss", "stoploss"],
  "deductible": ["deductable"],
  "Prudential": ["prudential"],
};

// The canonical Prudential terms, for a speech engine that accepts vocabulary hints (Deepgram
// keyterm boosting). Same source of truth as the correction map, so the two never drift apart.
export const CANONICAL_TERMS: string[] = Object.keys(CANONICAL);

// One global, case-insensitive regex per alias, with word boundaries only where the alias actually
// ends in a word character — mirrors termRegex in agent/utterance.ts so "co-insurance" and the like
// still match. Sorted longest-alias-first so the most specific correction wins.
const RULES: { re: RegExp; to: string }[] = Object.entries(CANONICAL)
  .flatMap(([canonical, aliases]) => aliases.map((alias) => ({ alias, to: canonical })))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ alias, to }) => {
    const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const left = /^\w/.test(alias) ? "\\b" : "";
    const right = /\w$/.test(alias) ? "\\b" : "";
    return { re: new RegExp(`${left}${esc}${right}`, "gi"), to };
  });

/**
 * Rewrite mis-heard domain terms to their canonical spelling. Case-insensitive on input, canonical
 * casing on output; leaves everything it does not recognise untouched. Idempotent: the canonical
 * forms differ from their aliases (by spacing or hyphenation), so a second pass is a no-op.
 */
export function fixTerms(text: string): string {
  if (!text) return text;
  return RULES.reduce((s, { re, to }) => s.replace(re, to), text);
}
