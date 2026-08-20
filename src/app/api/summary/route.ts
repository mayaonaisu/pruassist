import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { currentRep } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "gemini-2.5-flash";

// Summarises the advisory conversation into a post-session brief for the rep.
export async function POST(req: NextRequest) {
  // Rep-only: this route spends billed Gemini calls.
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const apiKey = process.env.GEMINI_API_KEY;
  const { transcript } = await req.json().catch(() => ({}));
  const fallback = {
    concerns: [] as string[],
    talkingPoints: [] as string[],
    followUps: [] as string[],
    notes: "",
  };
  if (!apiKey || !transcript || typeof transcript !== "string") {
    return NextResponse.json(fallback);
  }

  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `ADVISORY SESSION TRANSCRIPT:\n${transcript}`,
      config: {
        systemInstruction:
          "Summarise this Prudential Health Protection advisory session for the financial representative's internal " +
          "records. Be factual and concise. Respond ONLY with JSON: " +
          '{"concerns": string[], "talkingPoints": string[], "followUps": string[], "notes": string} — ' +
          "concerns = the customer's key concerns/questions; talkingPoints = points the rep raised or should raise; " +
          "followUps = concrete follow-up actions; notes = one or two sentences of context.",
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.3,
        maxOutputTokens: 700,
      },
    });
    const text = (response.text ?? "").trim();
    const p = JSON.parse(text);
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return NextResponse.json({
      concerns: arr(p.concerns),
      talkingPoints: arr(p.talkingPoints),
      followUps: arr(p.followUps),
      notes: typeof p.notes === "string" ? p.notes : "",
    });
  } catch {
    return NextResponse.json(fallback);
  }
}
