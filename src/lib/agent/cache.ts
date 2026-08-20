import { cosine, embedForSimilarity, lexicalSimilarity } from "../retrieval";
import type { Lookahead, Turn } from "./types";

// Deciding whether the question that just arrived is the one the background pass prepared for.
//
// Two gates, cheapest first. The lexical gate is free and rejects almost everything, so the
// embedding call — which is the only cost a miss can incur — happens only on a plausible hit.
// Serving a prepared answer to the wrong question would be worse than any latency saved, so the
// vector confirmation is deliberately strict.
const GATE = { lexical: 0.28, vector: 0.86 };

// How long a prepared answer stays servable. The conversation moves on, and an answer prepared
// six minutes ago is about a different moment even if the words still match.
const MAX_AGE_MS = 6 * 60 * 1000;

export type CacheCheck = { hit: boolean; score: number; question: string };

/** The customer's most recent line — what a prepared answer would have to match. */
export function lastCustomerLine(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "customer") return turns[i].text;
  }
  return "";
}

export async function matchesLookahead(look: Lookahead | null, asked: string): Promise<CacheCheck> {
  const miss = { hit: false, score: 0, question: look?.question ?? "" };
  if (!look || !look.verified || !asked.trim()) return miss;
  if (Date.now() - look.preparedAt > MAX_AGE_MS) return miss;

  const lex = lexicalSimilarity(asked, look.question);
  if (lex < GATE.lexical) return { ...miss, score: lex };

  const [a, b] = await embedForSimilarity([asked, look.question]);
  // No vectors means no confirmation, and an unconfirmed hit is not worth the risk of answering
  // the wrong question instantly.
  if (!a || !b) return { ...miss, score: lex };

  const score = cosine(a, b);
  return { hit: score >= GATE.vector, score, question: look.question };
}
