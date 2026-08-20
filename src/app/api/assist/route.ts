import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { retrieve } from "@/lib/retrieval";
import { getByRoom } from "@/lib/sessions";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "@/lib/agent/gemini";
import { haveKey } from "@/lib/genai";
import { loadState } from "@/lib/agent/ledger";
import { matchesLookahead } from "@/lib/agent/cache";
import { activeDecision, readinessFor } from "@/lib/agent/readiness";
import { looksComparative } from "@/lib/decisions";
import { clauseBlock, comparisonSystemInstruction, pointerSystemInstruction } from "@/lib/agent/prompts";
import { unsupportedFigures } from "@/lib/agent/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This is the fast path and stays that way. Comprehension tracking lives behind /api/agent/state,
// which schedules its own work after the response is flushed.

export async function POST(req: NextRequest) {
  // Rep-only: this route spends billed Gemini calls.
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  if (!haveKey()) {
    return NextResponse.json({ note: "Add GEMINI_API_KEY to .env.local to enable AI pointers." });
  }

  const body = await req.json().catch(() => ({}));
  const { transcript, roomId, asked } = body ?? {};
  if (!transcript || typeof transcript !== "string") {
    return NextResponse.json({ error: "Missing 'transcript'." }, { status: 400 });
  }

  // roomId is optional on purpose: a tab left open from an earlier session must not start
  // failing mid-demo. Without it there is no product area and no prepared answer.
  const session = typeof roomId === "string" && roomId ? await getByRoom(roomId) : null;
  const productArea = session?.context.productArea;

  // The ledger, loaded once: the cache gate reads it, and so does the comparison instruction.
  const state = session ? await loadState(roomId, session.context.productArea) : null;

  // 0) CACHE — did the background pass already prepare, and verify, the answer to this question?
  if (state) {
    const question = typeof asked === "string" && asked.trim() ? asked : (transcript.split("\n").slice(-1)[0] ?? "");
    const check = await matchesLookahead(state.lookahead, question);
    if (check.hit && state.lookahead) {
      const l = state.lookahead;
      return NextResponse.json({
        ...l.pointers,
        sources: l.sources,
        // Surfaced rather than hidden: an answer written before the question was asked is a claim
        // the rep should be able to see and check, not a silent optimisation.
        cached: true,
        prepared: { conceptId: l.conceptId, label: l.label, question: l.question, at: l.preparedAt, match: Number(check.score.toFixed(3)) },
        verified: l.verified,
        unsupportedFigures: [],
      });
    }
  }

  // 1) RETRIEVE the most relevant Prudential clauses for what was just said.
  const hits = await retrieve(transcript, 3, productArea);
  if (!hits.length) {
    // No clause means no grounded citation, so say nothing rather than invent one.
    return NextResponse.json({ note: "No policy clause covers this yet — keep listening, or ask the customer to be more specific." });
  }

  // A comparison is a different job from an explanation: it has to say what is not yet settled.
  const decision = state ? activeDecision(state) : null;
  const comparing =
    decision && state && typeof asked === "string" && asked.trim() ? looksComparative(asked, decision) : false;
  const instruction =
    comparing && decision && state
      ? comparisonSystemInstruction(decision, readinessFor(decision, state), productArea)
      : pointerSystemInstruction(productArea);

  // 2) GENERATE a structured set of private pointers, grounded in those clauses.
  // allowSleep is off: a rate limit rotates to another key if one is free, but the rep is waiting,
  // so it never blocks on a cooldown — it degrades to a note instead.
  const response = await callWithRetry(
    "assist",
    (ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: `POLICY CLAUSES:\n${clauseBlock(hits)}\n\nRECENT TRANSCRIPT:\n${transcript}`,
        config: {
          systemInstruction: instruction,
          responseMimeType: "application/json",
          thinkingConfig: thinking("off"),
          temperature: 0.3,
          maxOutputTokens: JSON_BUDGET,
        },
      }),
    { allowSleep: false },
  );

  if (!response) {
    return NextResponse.json({ note: "The AI service is rate limited right now — try again in a moment." });
  }

  let p: Record<string, unknown> = {};
  try {
    p = JSON.parse((response.text ?? "").trim());
  } catch {
    p = { explainer: (response.text ?? "").trim() };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const pointers = {
    concern: str(p.concern),
    firstStep: str(p.firstStep),
    suggestedLine: str(p.suggestedLine),
    explainer: str(p.explainer),
    comparison: str(p.comparison),
    followUp: str(p.followUp),
  };

  // 3) VERIFY, deterministically. There is no time for a second model call here, so the check
  // targets the failure that matters most: a figure the model invented, shown next to a real
  // brochure page number. It labels rather than blocks — the rep decides what to say.
  const spoken = [pointers.suggestedLine, pointers.explainer, pointers.comparison].filter(Boolean).join("\n");

  return NextResponse.json({
    ...pointers,
    sources: hits.map((h) => ({ source: h.source, snippet: h.text.slice(0, 150) })),
    cached: false,
    comparing,
    unsupportedFigures: unsupportedFigures(spoken, hits),
  });
}
