import type { Concept } from "../concepts";
import type { Turn } from "./types";

// The shape of a single utterance: which concepts it names, whether it is a question, whether it
// is assent with nothing behind it, and how long the silence before it was.
//
// Everything here is text and timing. The Web Speech API returns words and timestamps, not tone,
// so nothing in this module — or anywhere downstream of it — infers anything from how something
// was said.

const QUOTE_MAX = 180;

// Only concept-tied fragments are ever stored, and only this much of one.
export function normaliseQuote(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= QUOTE_MAX ? s : s.slice(0, QUOTE_MAX - 1).trimEnd() + "…";
}

/* ---------- term matching ---------- */

const termCache = new Map<string, RegExp>();

// Word boundaries only where the term actually ends in a word character, so "10%" and "co-pay"
// still match. Without this, "cap" fires on "capacity" and every alert becomes noise.
export function termRegex(term: string): RegExp {
  let re = termCache.get(term);
  if (!re) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const left = /^\w/.test(term) ? "\\b" : "";
    const right = /\w$/.test(term) ? "\\b" : "";
    re = new RegExp(`${left}${esc}${right}`, "i");
    termCache.set(term, re);
  }
  return re;
}

export function mentions(text: string, concept: Concept): boolean {
  return concept.terms.some((t) => termRegex(t).test(text));
}

function termHits(text: string, concept: Concept): number {
  return concept.terms.filter((t) => termRegex(t).test(text)).length;
}

export function conceptsMentioned(text: string, pool: Concept[]): Concept[] {
  return pool.filter((c) => mentions(text, c));
}

// A rep turn can brush against four concepts while really being about one. Attributing a single
// "okay" to all four would flood the record, so assent lands on whichever the turn is most about.
export function dominant(text: string, hits: Concept[]): Concept[] {
  if (hits.length < 2) return hits;
  const counted = hits.map((c) => ({ c, n: termHits(text, c) }));
  const top = Math.max(...counted.map((x) => x.n));
  return counted.filter((x) => x.n === top).map((x) => x.c);
}

/* ---------- utterance shape ---------- */

const ASSENT_PHRASES = [
  "that makes sense",
  "makes sense",
  "sounds good",
  "fair enough",
  "got it",
  "i got it",
  "i see",
  "i understand",
  "understood",
  "no problem",
  "of course",
  "for sure",
  "all right",
  "alright",
  "okay",
  "ok",
  "oh ok",
  "yeah",
  "yea",
  "yes",
  "yep",
  "yup",
  "sure",
  "right",
  "mmhmm",
  "mm hmm",
  "mhm",
  "uh huh",
  "true",
  "correct",
  "clear",
  "noted",
  "thanks",
  "thank you",
];

const FILLER = new Set(["so", "well", "oh", "ah", "um", "uh", "and", "but", "i", "that", "it", "is", "was", "now", "then", "like"]);

// Assent with no content is the signal. "okay, yeah, that makes sense" carries no concept words,
// so it can only ever move a concept to `asserted` — never to `demonstrated`.
export function isBareAssent(text: string): boolean {
  let s = ` ${text.toLowerCase().replace(/[^a-z0-9%$\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (!s.trim()) return false;
  let matched = false;
  for (const p of ASSENT_PHRASES) {
    const re = new RegExp(`\\s${p.replace(/\s+/g, "\\s+")}\\s`, "g");
    if (re.test(s)) {
      matched = true;
      s = s.replace(re, " ");
    }
  }
  if (!matched) return false;
  const left = s.split(" ").filter((w) => w && !FILLER.has(w));
  return left.length <= 1;
}

export function isQuestion(text: string): boolean {
  const s = text.trim().toLowerCase();
  if (s.includes("?")) return true;
  return /^(what|why|how|when|which|who|where|is|are|do|does|did|can|could|should|would|will|if)\b/.test(s);
}

// Rough gap before a reply. Finalisation timestamps are all the browser gives us, so this
// subtracts an estimate of how long the reply itself took to say. Corroborating only — network
// jitter and voice-activity endpointing both distort it, and nothing here changes a state.
const WORDS_PER_SECOND = 2.8;

export function approximateGapMs(prev: Turn, next: Turn): number {
  const spoken = (next.text.trim().split(/\s+/).length / WORDS_PER_SECOND) * 1000;
  return Math.round(next.at - prev.at - spoken);
}
