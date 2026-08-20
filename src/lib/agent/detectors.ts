import type { Concept } from "../concepts";
import { cosine, embedForSimilarity, lexicalSimilarity } from "../retrieval";
import {
  approximateGapMs,
  conceptsMentioned,
  dominant,
  isBareAssent,
  isQuestion,
  mentions,
  normaliseQuote,
  termRegex,
} from "./utterance";
import type { Detection, SignalKind, Turn } from "./types";

// The comprehension detectors, and the machinery they use to decide.
//
// Each detector takes a prepared `TurnContext` and returns detections. None of them reads another
// detector's output or depends on running in a particular order — the one piece of shared control
// flow, "a bare assent claims the turn", is a fact on the context rather than a `continue`.

/* ---------- thresholds ---------- */

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

// Above this gap before a bare assent, the pause is worth reporting as corroboration. Never
// decisive: see approximateGapMs for why the number is soft.
const PAUSE_MS = 2000;

// How far back a restatement can reach for the rep turn it is echoing.
const DIVERGENCE_WINDOW = 6;

// How long a concept the rep raised stays "in play" for scoring an answer that never names it.
const IN_PLAY_WINDOW = 4;

/* ---------- reading an utterance against a concept ---------- */

type Side = "canonical" | "wrong";
type Reading = { side: Side; confident: boolean; best: number; margin: number; worst: string };

// Two independent readings of the same utterance. Embeddings understand paraphrase but are
// famously weak on polarity: "I pay the first chunk myself" and "the insurer pays the first part
// and I pay the rest" are opposites that share almost all their vocabulary, and cosine ranks the
// wrong one first. Word overlap gets that case right. Neither is trusted alone.
export type Scorer = {
  vector: ((a: string, b: string) => number) | null;
  lexical: (a: string, b: string) => number;
  degraded: boolean;
};

export async function buildScorer(texts: string[]): Promise<Scorer> {
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

/* ---------- what a detector is given ---------- */

export type TurnContext = {
  // Where we are. The whole window is here because divergence and re-ask both need to look back
  // at turns that are already scored.
  turns: Turn[];
  index: number;
  turn: Turn;
  prev?: Turn;

  pool: Concept[];
  scorer: Scorer;
  // Rep turn index → the concepts that turn put on the table.
  raisedBy: Map<number, Concept[]>;

  // Facts about this turn, computed once so no detector re-derives them.
  question: boolean;
  // Note this is the compound condition: assent *to something the rep just said*. An "okay"
  // following another customer turn is not a bare assent and does not suppress anything.
  bareAssent: boolean;
  named: Set<Concept>; // concepts this turn's own words mention
  inPlay: Set<Concept>; // named, plus anything the rep raised in the last few turns
  answering: Concept[]; // what the preceding rep turn was mainly about
  gapMs: number; // approximate silence before this turn
};

export function buildContext(
  turns: Turn[],
  index: number,
  pool: Concept[],
  scorer: Scorer,
  raisedBy: Map<number, Concept[]>,
): TurnContext {
  const turn = turns[index];
  const prev = turns[index - 1];
  const named = new Set(conceptsMentioned(turn.text, pool));

  const inPlay = new Set(named);
  for (let j = index - 1; j >= Math.max(0, index - IN_PLAY_WINDOW); j--) {
    for (const c of raisedBy.get(j) ?? []) inPlay.add(c);
  }

  return {
    turns,
    index,
    turn,
    prev,
    pool,
    scorer,
    raisedBy,
    question: isQuestion(turn.text),
    bareAssent: isBareAssent(turn.text) && prev?.role === "rep",
    named,
    inPlay,
    answering: prev?.role === "rep" ? dominant(prev.text, raisedBy.get(index - 1) ?? []) : [],
    gapMs: prev ? approximateGapMs(prev, turn) : 0,
  };
}

// Every detection is about the turn in hand, so only the fields that vary are written out — the
// rest, `role` included, come from the turn the detector was given.
function detection(
  ctx: TurnContext,
  fields: { conceptId: string; kind: SignalKind; argues: Detection["argues"]; detail: string; score: number },
): Detection {
  return {
    ...fields,
    role: ctx.turn.role,
    turnIndex: ctx.index,
    at: ctx.turn.at,
    quote: normaliseQuote(ctx.turn.text),
  };
}

/* ---------- the detectors ---------- */

/** The rep put a concept on the table. The only rep-side signal. */
export function detectRaised(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "rep") return [];
  return [...ctx.named].map((c) =>
    detection(ctx, {
      conceptId: c.id,
      kind: "uptake",
      argues: "raised",
      detail: `You introduced ${c.label.toLowerCase()}.`,
      score: 1,
    }),
  );
}

/** Signal 2 — agreement with nothing behind it. Counts only against what the rep just raised. */
export function detectAssent(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "customer" || !ctx.bareAssent) return [];
  return ctx.answering.map((c) =>
    detection(ctx, {
      conceptId: c.id,
      kind: "assent",
      argues: "asserted",
      detail: "Agreed without using the idea in their own words.",
      score: 1,
    }),
  );
}

/** Signal 6 — the pause before agreeing. Corroborating evidence; never changes a state. */
export function detectLatency(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "customer" || !ctx.bareAssent || ctx.gapMs < PAUSE_MS) return [];
  return ctx.answering.map((c) =>
    detection(ctx, {
      conceptId: c.id,
      kind: "latency",
      argues: null,
      detail: `About ${(ctx.gapMs / 1000).toFixed(1)}s of silence before agreeing (approximate).`,
      score: 0,
    }),
  );
}

/**
 * Signal 1 — term uptake and correctness. A customer explaining an idea back rarely uses the term
 * for it ("so I pay the first chunk myself"), so anything the rep put on the table in the last few
 * turns is scored too; the floor and the margin are what keep that honest.
 */
export function detectUptake(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "customer" || ctx.bareAssent) return [];
  const out: Detection[] = [];

  for (const c of ctx.inPlay) {
    const verdict = judge(ctx.turn.text, c, ctx.scorer);
    if (!verdict) continue;

    // Everything in an insurance conversation embeds close to everything else, so a concept that
    // is merely in play may only ever earn `demonstrated`. Telling a rep their customer holds a
    // misconception about something the customer never mentioned is the false alarm that would
    // teach them to ignore the assistant.
    if (verdict.side === "wrong" && !ctx.named.has(c)) continue;

    if (verdict.side === "wrong") {
      out.push(
        detection(ctx, {
          conceptId: c.id,
          kind: "uptake",
          argues: "misunderstood",
          detail: `Closer to a known misconception than to the clause: "${verdict.worst}"`,
          score: verdict.score,
        }),
      );
    } else if (!ctx.question) {
      // Asking about an idea is not using it. Only a statement can demonstrate.
      out.push(
        detection(ctx, {
          conceptId: c.id,
          kind: "uptake",
          argues: "demonstrated",
          detail: "Restated the idea correctly in their own words.",
          score: verdict.score,
        }),
      );
    }
  }

  return out;
}

/** Signal 3 — the rep's phrasing carried a limit; the restatement dropped it. */
export function detectDivergence(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "customer" || ctx.bareAssent || ctx.question) return [];
  const out: Detection[] = [];

  for (let j = ctx.index - 1; j >= Math.max(0, ctx.index - DIVERGENCE_WINDOW); j--) {
    const source = ctx.raisedBy.get(j);
    if (!source) continue;
    for (const c of source) {
      if (!mentions(ctx.turn.text, c)) continue;
      const said = c.qualifiers.filter((q) => termRegex(q).test(ctx.turns[j].text));
      const dropped = said.filter((q) => !termRegex(q).test(ctx.turn.text));
      if (said.length && dropped.length === said.length) {
        out.push(
          detection(ctx, {
            conceptId: c.id,
            kind: "divergence",
            argues: "misunderstood",
            detail: `Dropped the qualifier you used: ${dropped.map((d) => `"${d}"`).join(", ")}.`,
            score: 0.6,
          }),
        );
      }
    }
    break; // only the most recent rep turn that raised anything
  }

  return out;
}

/** Signal 4 — asking the same thing again means the earlier answer did not land. */
export function detectReAsk(ctx: TurnContext): Detection[] {
  if (ctx.turn.role !== "customer" || ctx.bareAssent || !ctx.question) return [];
  const out: Detection[] = [];

  for (let j = ctx.index - 1; j >= 0; j--) {
    const earlier = ctx.turns[j];
    if (earlier.role !== "customer" || !isQuestion(earlier.text)) continue;
    if (!sameQuestion(ctx.turn.text, earlier.text, ctx.scorer)) continue;

    // A customer rarely names the concept when re-asking ("what's the most I'd pay?"). If neither
    // question does, the re-ask belongs to whatever the rep answered in between — that is the
    // explanation which failed to land.
    const inQuestions = new Set(
      conceptsMentioned(ctx.turn.text, ctx.pool).concat(conceptsMentioned(earlier.text, ctx.pool)),
    );
    const shared = inQuestions.size
      ? inQuestions
      : new Set(
          Array.from(ctx.raisedBy)
            .filter(([k]) => k > j && k < ctx.index)
            .flatMap(([k, hits]) => dominant(ctx.turns[k].text, hits)),
        );
    for (const c of shared) {
      out.push(
        detection(ctx, {
          conceptId: c.id,
          kind: "re-ask",
          argues: null,
          detail: "Asked this again after it was already answered.",
          score: 1,
        }),
      );
    }
    return out;
  }

  // Coming back with a question about something the rep already covered. On its own this is just
  // a follow-up; against a concept the customer only ever agreed to, it is the second piece of
  // evidence that the agreement was hollow. It never changes a state by itself.
  for (const c of conceptsMentioned(ctx.turn.text, ctx.pool)) {
    const coveredEarlier = [...ctx.raisedBy].some(([j, hits]) => j < ctx.index && hits.includes(c));
    if (!coveredEarlier) continue;
    out.push(
      detection(ctx, {
        conceptId: c.id,
        kind: "re-ask",
        argues: null,
        detail: "Came back to this with a question after you had explained it.",
        score: 1,
      }),
    );
  }

  return out;
}

// Order matters only for how detections read in the replay harness, which prints them in the
// order they were produced. The ledger sorts by turn index and is stable, so state is unaffected.
export const DETECTORS = [
  detectRaised,
  detectAssent,
  detectLatency,
  detectUptake,
  detectDivergence,
  detectReAsk,
];
