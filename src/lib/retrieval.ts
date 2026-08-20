import { GoogleGenAI } from "@google/genai";
import { KNOWLEDGE, areaOfClause, type Clause } from "./knowledge";

// Embedding failures are logged, never swallowed: silent fallback once faked semantic grounding.
const EMBED_MODEL = "gemini-embedding-001";

export type Hit = Clause & { score: number };

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

// Asymmetric retrieval: corpus and query need different task types, or ranking degrades.
// SEMANTIC_SIMILARITY is the symmetric case — comparing two utterances, not a query to a corpus.
type TaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY";

async function embedBatch(texts: string[], taskType: TaskType): Promise<(number[] | null)[]> {
  const ai = getClient();
  if (!ai) return texts.map(() => null);
  try {
    const res = await ai.models.embedContent({ model: EMBED_MODEL, contents: texts, config: { taskType } });
    return texts.map((_, i) => res.embeddings?.[i]?.values ?? null);
  } catch (e) {
    console.error(`[retrieval] ${taskType} embedding failed (model ${EMBED_MODEL}):`, e);
    return texts.map(() => null);
  }
}

async function embedQuery(text: string): Promise<number[] | null> {
  return (await embedBatch([text], "RETRIEVAL_QUERY"))[0];
}

type Embedded = { clause: Clause; vec: number[] };

// Embed the whole knowledge base once and memoize for the server process.
let kbPromise: Promise<Embedded[] | null> | null = null;
function embedKb() {
  if (!kbPromise) {
    kbPromise = (async () => {
      const vecs = await embedBatch(
        KNOWLEDGE.map((c) => `${c.source}\n${c.text}`),
        "RETRIEVAL_DOCUMENT",
      );
      // One bad clause shouldn't drop the rest back to keyword search.
      const ok = KNOWLEDGE.map((clause, i) => (vecs[i] ? { clause, vec: vecs[i]! } : null)).filter(
        (x): x is Embedded => x !== null,
      );
      if (ok.length < KNOWLEDGE.length) {
        console.error(`[retrieval] embedded ${ok.length}/${KNOWLEDGE.length} clauses`);
      }
      return ok.length ? ok : null;
    })();
  }
  return kbPromise;
}

// Comparing two utterances (not a query to a corpus), memoized because the comprehension
// signals re-score the same canonical statements on every pass of a live conversation.
const simCache = new Map<string, number[] | null>();
const SIM_CACHE_MAX = 600;

export async function embedForSimilarity(texts: string[]): Promise<(number[] | null)[]> {
  const missing = [...new Set(texts.filter((t) => !simCache.has(t)))];
  if (missing.length) {
    const vecs = await embedBatch(missing, "SEMANTIC_SIMILARITY");
    missing.forEach((t, i) => simCache.set(t, vecs[i]));
    // Concept statements are a fixed set; only the customer's utterances grow, so evict oldest.
    while (simCache.size > SIM_CACHE_MAX) simCache.delete(simCache.keys().next().value!);
  }
  return texts.map((t) => simCache.get(t) ?? null);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Common words dominate the overlap and make every question score alike.
const STOPWORDS = new Set(
  ("the and that this with you your for are but not any how have has had was were will would can could should" +
    " what when which who why does did done from they them their there here about into out off over under" +
    " than then some most much many more only just also very get got make made take taken been being" +
    " because while where whom whose our ours yours mine his her its per")
    .split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$ ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Symmetric keyword fallback for utterance-to-utterance comparison, used when embeddings are
// unavailable. Jaccard, not coverage: neither side is a query, so neither side gets to be the
// denominator. Scores land far lower than cosine, so callers keep separate thresholds.
export function lexicalSimilarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

// Keyword fallback. Scores query coverage, not clause brevity, or short clauses always win.
function lexical(query: string, k: number, area?: string): Hit[] {
  const q = new Set(tokenize(query));
  if (!q.size) return [];
  return inArea(KNOWLEDGE, (c) => c, area).map((clause) => {
    const words = new Set(tokenize(`${clause.source} ${clause.text}`));
    let overlap = 0;
    for (const w of q) if (words.has(w)) overlap++;
    return { ...clause, score: overlap / q.size };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Below this a match is incidental. Health questions score 0.67-0.75, off-topic peaks at 0.63.
export const MIN_SCORE = { vector: 0.65, lexical: 0.06 };

// An unknown area narrows to nothing, which would silence the assistant — fall back to the
// whole corpus instead, since a cross-product citation beats no citation at all.
function inArea<T>(items: T[], clauseOf: (x: T) => Clause, area?: string): T[] {
  if (!area) return items;
  const scoped = items.filter((x) => areaOfClause(clauseOf(x)) === area);
  return scoped.length ? scoped : items;
}

// Retrieve the top-k most relevant clauses for a query, optionally scoped to a product area.
export async function retrieve(query: string, k = 3, area?: string): Promise<Hit[]> {
  let kb: Embedded[] | null = null;
  try {
    kb = await embedKb();
  } catch (e) {
    console.error("[retrieval] knowledge base embedding threw:", e);
    kb = null;
  }

  if (kb) {
    const qvec = await embedQuery(query);
    if (qvec) {
      return inArea(kb, (e) => e.clause, area)
        .map(({ clause, vec }) => ({ ...clause, score: cosine(qvec, vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .filter((h) => h.score >= MIN_SCORE.vector);
    }
    // Keep the cached corpus: re-embedding every clause would amplify the throttling.
    return lexical(query, k, area).filter((h) => h.score >= MIN_SCORE.lexical);
  }

  // The corpus itself failed to embed — allow a retry on the next request.
  kbPromise = null;
  return lexical(query, k, area).filter((h) => h.score >= MIN_SCORE.lexical);
}
