import type { Turn } from "./agent/types";

// The transcript, as pure data. No React, no fetch — so the rules that decide what gets sent to
// the server can be checked without a browser, a LiveKit room and two cameras.

// `at` is when the browser finalised the line, not when the speaker started. Every timing figure
// downstream is therefore an approximation, and is labelled as one.
export type Line = { id: string; at: number; speaker: string; text: string; flag?: boolean };

// Marks a customer line as worth an AI pointer. Deliberately looser than the detectors' notion of
// a question: this only decides whether to spend a suggestion, and a false positive costs a call.
export function looksLikeQuestion(text: string): boolean {
  const s = text.trim().toLowerCase();
  if (s.split(/\s+/).length < 3) return false;
  if (s.includes("?")) return true;
  return /\b(why|what|whats|how|when|which|who|where|do i|can i|could i|should i|is it|are there|difference|cover|covered|exclud|deductible|insurance|rider|add[- ]?on|claim|premium|expensive|cost|afford|worried|confus|not sure|understand|mean|need)\b/.test(s);
}

// Everyone who is not the rep is the customer. The console only ever has the two of them.
export function toTurns(lines: Line[], repName: string): Turn[] {
  return lines.map((l) => ({
    at: l.at,
    role: l.speaker === repName ? ("rep" as const) : ("customer" as const),
    speaker: l.speaker,
    text: l.text,
  }));
}

export function transcriptText(lines: Line[]): string {
  return lines.map((l) => `${l.speaker}: ${l.text}`).join("\n");
}

export function newestAt(lines: Line[]): number {
  return lines.length ? lines[lines.length - 1].at : 0;
}

// The customer's most recent line on its own. The blended transcript would match almost anything,
// so the prepared-answer check needs the question by itself.
export function lastFromCustomer(lines: Line[], repName: string): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].speaker !== repName) return lines[i].text;
  }
  return "";
}
