import { Type } from "@google/genai";
import { clausesFor, conceptById, type Concept } from "../concepts";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "./gemini";
import { openaiEnabled, openaiJson } from "./openai";
import { haveKey } from "../genai";
import { clauseBlock, HOUSE_RULES } from "./prompts";
import { normaliseQuote } from "./utterance";
import type { AgentState, Detection, Turn } from "./types";

// Signal 5 — the explain-back grade. The rep asks the teach-back question; whatever the customer
// says next gets graded against the clause, and the grade names *which part* was wrong rather than
// returning a score. "You explained the deductible but not that it is once a year" is actionable;
// "62%" is not.

export type ExplainBack = {
  verdict: "correct" | "partial" | "wrong";
  missing: string; // the part they did not get, in the rep's words. "" when correct.
  got: string; // the part they did get, so the rep can build on it
};

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdict: { type: Type.STRING, enum: ["correct", "partial", "wrong"] },
    missing: { type: Type.STRING },
    got: { type: Type.STRING },
  },
  required: ["verdict", "missing", "got"],
};

/**
 * Grades a customer's answer to a teach-back question against the clauses behind the concept.
 * Returns null when grading is unavailable, so the caller can fall back to the deterministic
 * detectors rather than inventing a verdict.
 */
export async function gradeExplainBack(concept: Concept, answer: string): Promise<ExplainBack | null> {
  if (!haveKey() || answer.trim().split(/\s+/).length < 3) return null;

  const clauses = clausesFor(concept);
  const user =
    `POLICY CLAUSES:\n${clauseBlock(clauses)}\n\n` +
    `WHAT THE POLICY ACTUALLY SAYS, IN PLAIN LANGUAGE:\n${concept.canonical}\n\n` +
    `KNOWN MISCONCEPTIONS:\n${concept.misconceptions.map((m) => `- ${m}`).join("\n")}\n\n` +
    `THE REPRESENTATIVE ASKED:\n${concept.teachBack}\n\n` +
    `THE CUSTOMER ANSWERED:\n${answer}`;
  const system =
    "Grade the customer's answer against what the policy says. " +
    HOUSE_RULES +
    " Grade ONE idea: the one in WHAT THE POLICY ACTUALLY SAYS. Never mark an answer down " +
    "for leaving out something true but belonging to a different part of the policy — the " +
    "representative asked about one thing, and an alert about a second thing would read as " +
    "the customer having failed when they did not. " +
    "`correct` means they captured the substance, even loosely and without the jargon. " +
    "`partial` means part of it is right and a material part is either missing or stated " +
    "wrongly. `wrong` is for an answer with none of the idea left standing: the substance " +
    "itself is contradicted, not one part of it hanging off a half the customer did get. " +
    "An answer that lands half the idea and has the other half backwards is `partial`, " +
    "never `wrong` — the half they landed is real, and grading the whole answer wrong " +
    "sends the representative back to explain it from the start when one thing needs " +
    "correcting. Be generous about wording and strict about substance: a customer " +
    "explaining it in their own words is the point. " +
    "`missing` names the specific part they did not get, addressed to the representative in " +
    "one short sentence, and is empty when the verdict is correct. `got` names what they did " +
    'get, in one short clause. Respond only with JSON: {"verdict","missing","got"}.';

  // OpenAI when configured (off Gemini's free-tier cap), Gemini as the fallback — same JSON shape.
  let text: string | null = openaiEnabled() ? await openaiJson(system, user, JSON_BUDGET) : null;
  if (text === null) {
    const res = await callWithRetry("judge", (ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: user,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: thinking("off"),
          temperature: 0,
          maxOutputTokens: JSON_BUDGET,
        },
      }),
    );
    text = res?.text ?? null;
  }
  text = text?.trim() ?? "";
  if (!text) {
    // Almost always the token cap: thinking counts against it, so a tight budget returns nothing.
    console.error("[judge] empty response — raise JSON_BUDGET if this recurs");
    return null;
  }

  try {
    const p = JSON.parse(text) as Partial<ExplainBack>;
    if (p.verdict !== "correct" && p.verdict !== "partial" && p.verdict !== "wrong") {
      console.error(`[judge] no usable verdict in: ${text.slice(0, 120)}`);
      return null;
    }
    return {
      verdict: p.verdict,
      missing: typeof p.missing === "string" ? p.missing : "",
      got: typeof p.got === "string" ? p.got : "",
    };
  } catch {
    // An unparseable grade is no grade. The deterministic detectors still ran on this turn.
    console.error(`[judge] unparseable grade: ${text.slice(0, 120)}`);
    return null;
  }
}

/* ---------- turning a grade into ledger evidence ---------- */

// A one-word reply is assent, not an explanation. Below this the rep has not actually had their
// question answered yet, so the ledger waits rather than grading a shrug.
const MIN_ANSWER_WORDS = 4;

/**
 * Grades every outstanding teach-back: one where the rep pressed "Asked it" and the customer has
 * since said something substantive that has not been graded yet. Each is graded exactly once.
 *
 * Returns detections rather than mutating the ledger, so grading composes with the deterministic
 * detectors instead of competing with them — and when grading is unavailable it simply returns
 * nothing and the cosine detectors keep working.
 */
export async function gradeTeachBacks(state: AgentState, turns: Turn[]): Promise<Detection[]> {
  const out: Detection[] = [];

  for (const [id, e] of Object.entries(state.concepts)) {
    if (!e.teachBackAskedAt) continue;
    if (e.explainBackGradedAt && e.explainBackGradedAt >= e.teachBackAskedAt) continue;

    const concept = conceptById(id);
    if (!concept) continue;

    const index = turns.findIndex(
      (t) =>
        t.role === "customer" &&
        t.at > e.teachBackAskedAt! &&
        t.text.trim().split(/\s+/).length >= MIN_ANSWER_WORDS,
    );
    if (index === -1) continue;

    const answer = turns[index];
    const grade = await gradeExplainBack(concept, answer.text);
    if (!grade) continue;

    const argues =
      grade.verdict === "correct" ? "demonstrated" : grade.verdict === "wrong" ? "misunderstood" : null;

    out.push({
      conceptId: id,
      kind: "explain-back",
      argues,
      role: answer.role,
      turnIndex: index,
      at: answer.at,
      quote: normaliseQuote(answer.text),
      detail:
        grade.verdict === "correct"
          ? `Answered your teach-back correctly${grade.got ? ` — ${lower(grade.got)}` : ""}.`
          : grade.verdict === "partial"
            ? `Got part of it${grade.got ? ` (${lower(grade.got)})` : ""}, but ${lower(grade.missing)}`
            : `Answered your teach-back incorrectly: ${lower(grade.missing)}`,
      score: 1,
    });
  }

  return out;
}

// The grader writes sentences; they are being spliced into one.
function lower(s: string): string {
  const t = s.trim().replace(/\.$/, "");
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}
