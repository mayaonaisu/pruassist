import { Type } from "@google/genai";
import type { Clause } from "../knowledge";
import type { Hit } from "../retrieval";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "./gemini";
import { openaiEnabled, openaiJson } from "./openai";
import { haveKey } from "../genai";
import { clauseBlock, HOUSE_RULES } from "./prompts";

// Grounding self-verification, at two speeds.
//
// On the live path there is no time for a second model call, so the check is deterministic and
// aimed at the one failure that matters most: a figure the model made up sitting next to a real
// brochure page number. On the background path a model call is free, so the whole line is checked.

/* ---------- deterministic: do the numbers come from the pages? ---------- */

// "S$3,500" and "3500" are the same figure. Years and small ordinals are not policy figures.
function figures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    // Below 10 is almost always "one of three tiers" or "the first 21 days"-style prose, and
    // years are dates rather than amounts. Neither is a fabricable policy figure.
    if (n < 10) continue;
    if (n >= 1900 && n <= 2100 && !text.includes(`$${m[0]}`)) continue;
    out.push(raw);
  }
  return [...new Set(out)];
}

/** Figures in `line` that appear nowhere in the cited clauses. Empty is the good case. */
export function unsupportedFigures(line: string, clauses: (Clause | Hit)[]): string[] {
  if (!line.trim() || !clauses.length) return [];
  const supported = new Set(clauses.flatMap((c) => figures(c.text)));
  // A percentage of a supported figure is still arithmetic the clauses do not state, so it counts.
  return figures(line).filter((f) => !supported.has(f));
}

/* ---------- model check: is every claim actually in the clauses? ---------- */

export type Grounding = { grounded: boolean; unsupported: string[]; note: string };

const GROUNDING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    grounded: { type: Type.BOOLEAN },
    unsupported: { type: Type.ARRAY, items: { type: Type.STRING } },
    note: { type: Type.STRING },
  },
  required: ["grounded", "unsupported", "note"],
};

/**
 * Checks a generated passage against the clauses it claims to be grounded in. Used on the
 * background path only, where a second call costs the rep nothing. Returns `grounded: true` when
 * verification is unavailable — the caller decides what to do with an unverified line, and
 * silently failing closed would make the assistant mute whenever the API blips.
 */
export async function verifyGrounding(
  passage: string,
  clauses: (Clause | Hit)[],
  { failClosed = false } = {},
): Promise<Grounding> {
  if (!haveKey() || !passage.trim() || !clauses.length) {
    return { grounded: !failClosed, unsupported: [], note: "not verified" };
  }

  const vSystem =
    "You are a grounding checker. Decide whether every factual claim in the PASSAGE is " +
    "supported by the POLICY CLAUSES. " +
    HOUSE_RULES +
    " List each unsupported claim verbatim in `unsupported`. A claim that merely rephrases a " +
    "clause is supported. A hypothetical the representative offers the customer (\"if your " +
    "bill came to S$8,000\") is not a factual claim about the policy and is supported. Set " +
    "`grounded` to false if `unsupported` is non-empty. Keep `note` to one short sentence. " +
    'Respond only with JSON: {"grounded": boolean, "unsupported": string[], "note": string}.';
  const vUser = `POLICY CLAUSES:\n${clauseBlock(clauses)}\n\nPASSAGE TO CHECK:\n${passage}`;

  // OpenAI when configured, Gemini as the fallback — same JSON shape either way.
  let raw: string | null = openaiEnabled() ? await openaiJson(vSystem, vUser, JSON_BUDGET) : null;
  if (raw === null) {
    const res = await callWithRetry("verify", (ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: vUser,
        config: {
          systemInstruction: vSystem,
          responseMimeType: "application/json",
          responseSchema: GROUNDING_SCHEMA,
          // Pure judgement over a short passage; thinking buys nothing and costs latency.
          thinkingConfig: thinking("off"),
          temperature: 0,
          maxOutputTokens: JSON_BUDGET,
        },
      }),
    );
    raw = res?.text ?? null;
  }
  if (raw === null) return { grounded: !failClosed, unsupported: [], note: "verification unavailable" };

  try {
    const p = JSON.parse((raw ?? "{}").trim()) as Partial<Grounding>;
    const unsupported = Array.isArray(p.unsupported) ? p.unsupported.filter((x) => typeof x === "string") : [];
    return {
      grounded: p.grounded !== false && unsupported.length === 0,
      unsupported,
      note: typeof p.note === "string" ? p.note : "",
    };
  } catch {
    console.error(`[verify] unparseable response: ${(raw ?? "").trim().slice(0, 120)}`);
    return { grounded: !failClosed, unsupported: [], note: "unparseable verification" };
  }
}
