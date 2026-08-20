import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { currentRep } from "@/lib/auth";
import { retrieve } from "@/lib/retrieval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Fast Gemini model for low-latency live suggestions.
const MODEL = "gemini-2.5-flash";

export async function POST(req: NextRequest) {
  // Rep-only: this route spends billed Gemini calls.
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ note: "Add GEMINI_API_KEY to .env.local to enable AI pointers." });
  }

  const { transcript } = await req.json().catch(() => ({}));
  if (!transcript || typeof transcript !== "string") {
    return NextResponse.json({ error: "Missing 'transcript'." }, { status: 400 });
  }

  // 1) RETRIEVE the most relevant Prudential clauses for what was just said.
  const hits = await retrieve(transcript, 3);
  if (!hits.length) {
    // No clause means no grounded citation, so say nothing rather than invent one.
    return NextResponse.json({ note: "No policy clause covers this yet — keep listening, or ask the customer to be more specific." });
  }
  const context = hits.map((h, i) => `[${i + 1}] (${h.source})\n${h.text}`).join("\n\n");

  // 2) GENERATE a structured set of private pointers, grounded in those clauses.
  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: `POLICY CLAUSES:\n${context}\n\nRECENT TRANSCRIPT:\n${transcript}`,
      config: {
        systemInstruction:
          "You are PRUAssist, a PRIVATE co-pilot for a Prudential financial representative during a LIVE " +
          "conversation about Health Protection (PRUShield) insurance. Use ONLY the POLICY CLAUSES provided — do not " +
          "invent figures, product names or coverage. Produce concise private pointers for the representative. The " +
          "customer never sees these. Respond ONLY with JSON of this shape:\n" +
          '{"concern": string,            // the customer concern/confusion you detect\n' +
          ' "firstStep": string,          // what the rep should do or check first\n' +
          ' "suggestedLine": string,      // one natural line the rep could say to open\n' +
          ' "explainer": string,          // a plain-language explanation grounded in the clauses\n' +
          ' "comparison": string,         // a short comparison pointer if relevant, else ""\n' +
          ' "followUp": string}           // a follow-up question to surface the customer\'s priority',
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.3,
        maxOutputTokens: 800,
      },
    });

    const text = (response.text ?? "").trim();
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(text);
    } catch {
      p = { explainer: text };
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");

    return NextResponse.json({
      concern: str(p.concern),
      firstStep: str(p.firstStep),
      suggestedLine: str(p.suggestedLine),
      explainer: str(p.explainer),
      comparison: str(p.comparison),
      followUp: str(p.followUp),
      sources: hits.map((h) => ({ source: h.source, snippet: h.text.slice(0, 150) })),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "AI request failed.";
    return NextResponse.json({ note: `AI error: ${message}` });
  }
}
