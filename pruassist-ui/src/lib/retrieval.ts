import { GoogleGenAI } from "@google/genai";
import { KNOWLEDGE, type Clause } from "./knowledge";

const EMBED_MODEL = "text-embedding-004";

export type Hit = Clause & { score: number };

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

async function embed(text: string): Promise<number[] | null> {
  const ai = getClient();
  if (!ai) return null;
  try {
    const res = await ai.models.embedContent({ model: EMBED_MODEL, contents: text });
    return res.embeddings?.[0]?.values ?? null;
  } catch {
    return null;
  }
}

// Embed the whole knowledge base once and memoize for the server process.
let kbPromise: Promise<{ clause: Clause; vec: number[] }[] | null> | null = null;
function embedKb() {
  if (!kbPromise) {
    kbPromise = (async () => {
      const results = await Promise.all(
        KNOWLEDGE.map(async (clause) => {
          const vec = await embed(`${clause.source}\n${clause.text}`);
          return vec ? { clause, vec } : null;
        }),
      );
      // If any clause failed to embed, signal a fallback to lexical search.
      return results.every((r) => r !== null) ? (results as { clause: Clause; vec: number[] }[]) : null;
    })();
  }
  return kbPromise;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

// Keyword-overlap fallback used when embeddings are unavailable.
function lexical(query: string, k: number): Hit[] {
  const q = new Set(tokenize(query));
  return KNOWLEDGE.map((clause) => {
    const words = tokenize(`${clause.source} ${clause.text}`);
    let overlap = 0;
    for (const w of words) if (q.has(w)) overlap++;
    return { ...clause, score: overlap / (words.length || 1) };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Retrieve the top-k most relevant clauses for a query.
export async function retrieve(query: string, k = 3): Promise<Hit[]> {
  let kb: { clause: Clause; vec: number[] }[] | null = null;
  try {
    kb = await embedKb();
  } catch {
    kb = null;
  }

  if (kb) {
    const qvec = await embed(query);
    if (qvec) {
      return kb
        .map(({ clause, vec }) => ({ ...clause, score: cosine(qvec, vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }
  }

  // Embeddings unavailable — reset the cache so we can retry later, use lexical now.
  kbPromise = null;
  return lexical(query, k);
}
