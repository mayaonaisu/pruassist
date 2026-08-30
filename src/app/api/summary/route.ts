import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { callWithRetry, JSON_BUDGET, MODEL, thinking } from "@/lib/agent/gemini";
import { openaiEnabled, openaiJson } from "@/lib/agent/openai";
import { haveKey } from "@/lib/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A model call to write the brief can run past Vercel's default 10s limit on a long session.
export const maxDuration = 30;

// The one instruction, shared by both providers so the brief is identical whichever writes it.
const SUMMARY_SYSTEM =
  "Summarise this Prudential Health Protection advisory session for the financial representative's internal " +
  "records. Be factual and concise. Respond ONLY with JSON: " +
  '{"concerns": string[], "talkingPoints": string[], "followUps": string[], "notes": string} — ' +
  "concerns = the customer's key concerns/questions; talkingPoints = points the rep raised or should raise; " +
  "followUps = concrete follow-up actions; notes = one or two sentences of context.";

// Summarises the advisory conversation into a post-session brief for the rep.
//
// `generated` tells the UI whether a brief was actually produced. Without it a service failure and a
// genuinely quiet session look identical once the arrays are empty, and the rep reads "couldn't
// reach the model" as "nothing was said". The Understanding Record is unaffected either way — it is
// built from the ledger, not this call.
export async function POST(req: NextRequest) {
  // Rep-only: this route spends billed Gemini calls.
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { transcript } = await req.json().catch(() => ({}));
  const empty = { concerns: [] as string[], talkingPoints: [] as string[], followUps: [] as string[], notes: "" };

  // No words to summarise is not a failure — the brief is honestly empty.
  if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
    return NextResponse.json({ ...empty, generated: true });
  }
  // A transcript we cannot summarise IS a failure the rep must be able to tell apart from silence.
  // Either provider can write it, so the guard clears if EITHER is configured.
  if (!openaiEnabled() && !haveKey()) return NextResponse.json({ ...empty, generated: false });

  // OpenAI first when configured — a paid, un-throttled endpoint keeps the brief off Gemini's
  // free-tier daily cap. On any failure (or with no OpenAI key) it falls through to Gemini, so the
  // brief still generates. Gemini goes through the shared key pool and MODEL, so it survives a
  // rate-limited or newly-added key and uses the model every key can reach.
  let raw: string | null = openaiEnabled() ? await openaiJson(SUMMARY_SYSTEM, `ADVISORY SESSION TRANSCRIPT:\n${transcript}`, JSON_BUDGET) : null;
  if (raw === null && haveKey()) {
    const res = await callWithRetry("summary", (ai) =>
      ai.models.generateContent({
        model: MODEL,
        contents: `ADVISORY SESSION TRANSCRIPT:\n${transcript}`,
        config: {
          systemInstruction: SUMMARY_SYSTEM,
          responseMimeType: "application/json",
          thinkingConfig: thinking("off"),
          temperature: 0.3,
          maxOutputTokens: JSON_BUDGET,
        },
      }),
    );
    raw = res?.text ?? null;
  }

  // Both providers unavailable or errored — a failure, not an empty session.
  if (raw === null) return NextResponse.json({ ...empty, generated: false });

  try {
    const p = JSON.parse(raw.trim());
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return NextResponse.json({
      concerns: arr(p.concerns),
      talkingPoints: arr(p.talkingPoints),
      followUps: arr(p.followUps),
      notes: typeof p.notes === "string" ? p.notes : "",
      generated: true,
    });
  } catch {
    // A non-JSON body is a generation failure, not a quiet session.
    return NextResponse.json({ ...empty, generated: false });
  }
}
