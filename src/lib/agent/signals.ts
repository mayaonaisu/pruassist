import { CONCEPTS, type Concept } from "../concepts";
import { cosine, embedForSimilarity, lexicalSimilarity } from "../retrieval";
import type { SignalKind, Turn } from "./types";

// The comprehension detectors. Every one of them runs on text and timing alone — the Web Speech
// API returns words and timestamps, not tone, so nothing here infers anything from prosody.
//
// A detector never decides a state on its own; it argues for one. The ledger applies precedence.

export type Detection = {
  conceptId: string;
  kind: SignalKind;
  argues: "raised" | "asserted" | "demonstrated" | "misunderstood" | null; // null = evidence only
  turnIndex: number;
  at: number;
  quote: string;
  detail: string;
  score: number;
};

// A false alarm is worse than silence: it trains the rep to ignore the assistant. These floors
// are the equivalent of MIN_SCORE in retrieval — below them the match is incidental.
//
// Measured with scripts/scores.mts, not guessed. gemini-embedding-001 puts almost any two
// insurance sentences around 0.75 cosine (the word "test" scores 0.76 against the deductible
// clause), so in vector mode the margin does the work and the floor only rejects noise. Jaccard
// over content words spans the full range and carries a much lower floor.
const T = {
  vector: { floor: 0.75, margin: 0.02, reAsk: 0.9 },
  lexical: { floor: 0.12, margin: 0.03, reAsk: 0.4 },
};

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
function termRegex(term: string): RegExp {
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

function conceptsMentioned(text: string, pool: Concept[]): Concept[] {
  return pool.filter((c) => mentions(text, c));
}

// A rep turn can brush against four concepts while really being about one. Attributing a single
// "okay" to all four would flood the record, so assent lands on whichever the turn is most about.
function dominant(text: string, hits: Concept[]): Concept[] {
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

/* ---------- similarity, with a keyword fallback ---------- */

type Side = "canonical" | "wrong";
type Reading = { side: Side; confident: boolean; best: number; margin: number; worst: string };

// Two independent readings of the same utterance. Embeddings understand paraphrase but are
// famously weak on polarity: "I pay the first chunk myself" and "the insurer pays the first part
// and I pay the rest" are opposites that share almost all their vocabulary, and cosine ranks the
// wrong one first. Word overlap gets that case right. Neither is trusted alone.
type Scorer = {
  vector: ((a: string, b: string) => number) | null;
  lexical: (a: string, b: string) => number;
  degraded: boolean;
};

async function buildScorer(texts: string[]): Promise<Scorer> {
  const unique = [...new Set(texts)];
  const vecs = await embedForSimilarity(unique);
  const got = vecs.filter(Boolean).length;
  // Decided from the vectors actually returned, not from a separate health check: the embedding
  // endpoint throttles, and a half-empty batch scoring 0 against everything would be worse than
  // an honest fallback.
  if (!got || got < unique.length * 0.8) return { vector: null, lexical: lexicalSimilarity, degraded: true };

  const byText = new Map(unique.map((t, i) => [t, vecs[i]]));
  return {
    degraded: false,
    lexical: lexicalSimilarity,
    vector: (a, b) => {
      const va = byText.get(a);
      const vb = byText.get(b);
      return va && vb ? cosine(va, vb) : lexicalSimilarity(a, b);
    },
  };
}

function read(
  text: string,
  c: Concept,
  score: (a: string, b: string) => number,
  t: { floor: number; margin: number },
): Reading {
  const canonical = score(text, c.canonical);
  let worst = { text: "", score: -1 };
  for (const m of c.misconceptions) {
    const s = score(text, m);
    if (s > worst.score) worst = { text: m, score: s };
  }
  const side: Side = worst.score > canonical ? "wrong" : "canonical";
  const best = Math.max(canonical, worst.score);
  const margin = Math.abs(canonical - worst.score);
  return { side, confident: best >= t.floor && margin >= t.margin, best, margin, worst: worst.text };
}

// Two questions count as the same question when either reading says so. A re-ask never changes a
// state on its own, so a looser rule here costs the rep nothing but a line of context.
function sameQuestion(a: string, b: string, s: Scorer): boolean {
  if (s.lexical(a, b) >= T.lexical.reAsk) return true;
  return s.vector ? s.vector(a, b) >= T.vector.reAsk : false;
}

// `misunderstood` is the state that puts words in the customer's mouth, so it needs both readings
// to agree. `demonstrated` only costs the rep a teach-back they did not need, so one confident
// reading carries it. The asymmetry is deliberate.
function judge(text: string, c: Concept, s: Scorer): { side: Side; score: number; worst: string } | null {
  const lex = read(text, c, s.lexical, T.lexical);
  if (!s.vector) return lex.confident ? { side: lex.side, score: lex.best, worst: lex.worst } : null;

  const vec = read(text, c, s.vector, T.vector);
  if (vec.confident && lex.confident && vec.side === lex.side) {
    return { side: vec.side, score: vec.best, worst: vec.worst };
  }
  const solo = vec.confident ? vec : lex.confident ? lex : null;
  if (solo && solo.side === "canonical") return { side: "canonical", score: solo.best, worst: solo.worst };
  return null;
}

/* ---------- the pass ---------- */

export type SignalResult = { detections: Detection[]; degraded: boolean };

// `from` is the first turn not yet folded into the ledger. Earlier turns are still read, because
// re-ask and divergence both need the turns the customer is echoing.
export async function runSignals(
  turns: Turn[],
  pool: Concept[] = CONCEPTS,
  from = 0,
): Promise<SignalResult> {
  const out: Detection[] = [];
  if (!turns.length || !pool.length) return { detections: out, degraded: false };

  const customerText = turns.filter((t) => t.role === "customer").map((t) => t.text);
  const targets = pool.flatMap((c) => [c.canonical, ...c.misconceptions]);
  const scorer = await buildScorer([...customerText, ...targets]);

  // Which concepts each rep turn put on the table, and with which limits attached.
  const raisedBy = new Map<number, Concept[]>();
  turns.forEach((turn, i) => {
    if (turn.role !== "rep") return;
    const hits = conceptsMentioned(turn.text, pool);
    if (hits.length) raisedBy.set(i, hits);
  });

  for (const [i, hits] of raisedBy) {
    if (i < from) continue;
    for (const c of hits) {
      out.push({
        conceptId: c.id,
        kind: "uptake",
        argues: "raised",
        turnIndex: i,
        at: turns[i].at,
        quote: normaliseQuote(turns[i].text),
        detail: `You introduced ${c.label.toLowerCase()}.`,
        score: 1,
      });
    }
  }

  for (let i = Math.max(0, from); i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role !== "customer") continue;
    const prev = turns[i - 1];
    const question = isQuestion(turn.text);

    // 2 — bare assent. Only counts against what the rep just raised, or the alert would attach
    // itself to whichever concept happened to be open.
    if (isBareAssent(turn.text) && prev?.role === "rep") {
      const gap = approximateGapMs(prev, turn);
      for (const c of dominant(prev.text, raisedBy.get(i - 1) ?? [])) {
        out.push({
          conceptId: c.id,
          kind: "assent",
          argues: "asserted",
          turnIndex: i,
          at: turn.at,
          quote: normaliseQuote(turn.text),
          detail: "Agreed without using the idea in their own words.",
          score: 1,
        });
        if (gap >= 2000) {
          out.push({
            conceptId: c.id,
            kind: "latency",
            argues: null,
            turnIndex: i,
            at: turn.at,
            quote: normaliseQuote(turn.text),
            detail: `About ${(gap / 1000).toFixed(1)}s of silence before agreeing (approximate).`,
            score: 0,
          });
        }
      }
      continue;
    }

    // 1 — term uptake and correctness. A customer explaining an idea back rarely uses the term
    // for it ("so I pay the first chunk myself"), so anything the rep put on the table in the
    // last few turns is scored too — the floor and the margin are what keep that honest.
    const named = new Set(conceptsMentioned(turn.text, pool));
    const inPlay = new Set(named);
    for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
      for (const c of raisedBy.get(j) ?? []) inPlay.add(c);
    }

    for (const c of inPlay) {
      const verdict = judge(turn.text, c, scorer);
      if (!verdict) continue;

      // Everything in an insurance conversation embeds close to everything else, so a concept
      // that is merely in play may only ever earn `demonstrated`. Telling a rep their customer
      // holds a misconception about something the customer never mentioned is the false alarm
      // that would teach them to ignore the assistant.
      if (verdict.side === "wrong" && !named.has(c)) continue;

      if (verdict.side === "wrong") {
        out.push({
          conceptId: c.id,
          kind: "uptake",
          argues: "misunderstood",
          turnIndex: i,
          at: turn.at,
          quote: normaliseQuote(turn.text),
          detail: `Closer to a known misconception than to the clause: "${verdict.worst}"`,
          score: verdict.score,
        });
      } else if (!question) {
        // Asking about an idea is not using it. Only a statement can demonstrate.
        out.push({
          conceptId: c.id,
          kind: "uptake",
          argues: "demonstrated",
          turnIndex: i,
          at: turn.at,
          quote: normaliseQuote(turn.text),
          detail: "Restated the idea correctly in their own words.",
          score: verdict.score,
        });
      }
    }

    // 3 — divergence. The rep's phrasing carried a limit; the restatement dropped it.
    if (!question) {
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        const source = raisedBy.get(j);
        if (!source) continue;
        for (const c of source) {
          if (!mentions(turn.text, c)) continue;
          const said = c.qualifiers.filter((q) => termRegex(q).test(turns[j].text));
          const dropped = said.filter((q) => !termRegex(q).test(turn.text));
          if (said.length && dropped.length === said.length && dropped.length >= 1) {
            out.push({
              conceptId: c.id,
              kind: "divergence",
              argues: "misunderstood",
              turnIndex: i,
              at: turn.at,
              quote: normaliseQuote(turn.text),
              detail: `Dropped the qualifier you used: ${dropped.map((d) => `"${d}"`).join(", ")}.`,
              score: 0.6,
            });
          }
        }
        break; // only the most recent rep turn that raised anything
      }
    }

    // 4 — re-ask. Asking the same thing again means the earlier answer did not land.
    if (question) {
      let repeated = false;
      for (let j = i - 1; j >= 0; j--) {
        const earlier = turns[j];
        if (earlier.role !== "customer" || !isQuestion(earlier.text)) continue;
        if (!sameQuestion(turn.text, earlier.text, scorer)) continue;
        repeated = true;
        // A customer rarely names the concept when re-asking ("what's the most I'd pay?"). If
        // neither question does, the re-ask belongs to whatever the rep answered in between —
        // that is the explanation which failed to land.
        const inQuestions = new Set(
          conceptsMentioned(turn.text, pool).concat(conceptsMentioned(earlier.text, pool)),
        );
        const shared = inQuestions.size
          ? inQuestions
          : new Set(
              Array.from(raisedBy)
                .filter(([k]) => k > j && k < i)
                .flatMap(([k, hits]) => dominant(turns[k].text, hits)),
            );
        for (const c of shared) {
          out.push({
            conceptId: c.id,
            kind: "re-ask",
            argues: null,
            turnIndex: i,
            at: turn.at,
            quote: normaliseQuote(turn.text),
            detail: "Asked this again after it was already answered.",
            score: 1,
          });
        }
        break;
      }

      // Coming back with a question about something the rep already covered. On its own this is
      // just a follow-up; against a concept the customer only ever agreed to, it is the second
      // piece of evidence that the agreement was hollow. It never changes a state by itself.
      if (!repeated) {
        for (const c of conceptsMentioned(turn.text, pool)) {
          const coveredEarlier = [...raisedBy].some(([j, hits]) => j < i && hits.includes(c));
          if (!coveredEarlier) continue;
          out.push({
            conceptId: c.id,
            kind: "re-ask",
            argues: null,
            turnIndex: i,
            at: turn.at,
            quote: normaliseQuote(turn.text),
            detail: "Came back to this with a question after you had explained it.",
            score: 1,
          });
        }
      }
    }
  }

  return { detections: out, degraded: scorer.degraded };
}
