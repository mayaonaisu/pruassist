import type { Turn } from "./agent/types";
import { fixTerms } from "./terms";

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

// The rep can correct a mis-heard line in place. The corrected text is normalised the same way a
// freshly-heard one is (fixTerms), so the invariant "every stored line is canonicalised" still
// holds. Blanking a line is ignored rather than treated as a delete, and an unknown id is a no-op.
export function applyLineEdit(lines: Line[], id: string, text: string): Line[] {
  const next = fixTerms(text.trim());
  if (!next) return lines; // blanking a line is ignored, not a delete
  return lines.map((l) => (l.id === id ? { ...l, text: next } : l));
}

// Collapse a suggested line's citations for display: one row per document, its pages merged and
// de-duplicated in first-seen order — the sidebar was repeating the full brochure name on every row.
export function groupCitations(sources: string[]): { doc: string; pages: string }[] {
  const order: string[] = [];
  const byDoc = new Map<string, string[]>();
  for (const src of sources) {
    const [doc, ...rest] = src.split(" · ");
    if (!byDoc.has(doc)) {
      byDoc.set(doc, []);
      order.push(doc);
    }
    const pages = byDoc.get(doc)!;
    for (const p of rest.join(" · ").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!pages.includes(p)) pages.push(p);
    }
  }
  return order.map((doc) => ({ doc, pages: byDoc.get(doc)!.join(", ") }));
}

// The window, not just the new lines: re-ask and divergence both need what came before.
const SEND_WINDOW = 60;

export type Send = {
  /** The window to send, or empty when the server has already seen everything. */
  turns: Turn[];
  /** The cursor to advance to, once the send succeeds. */
  newest: number;
  fresh: boolean;
};

/**
 * What the console should send on this cycle. Every poll is a round trip whether or not there is
 * anything new, because the reply carries the ledger back — but re-sending an unchanged window
 * would make the server re-score turns it has already folded in.
 *
 * `final` forces a send regardless: the record is the deliverable, and the last exchange has to
 * reach the deep pass even if the poll before it already carried the same window.
 *
 * Pulled out of the hook so the rule can be checked without a browser. What remains inside the
 * hook is the ref that holds the cursor and the effect that ticks — plumbing, not a decision.
 */
export function windowToSend(lines: Line[], repName: string, sentUpTo: number, final = false): Send {
  const window = lines.slice(-SEND_WINDOW);
  const newest = newestAt(window);
  const fresh = final || newest > sentUpTo;
  return { turns: fresh ? toTurns(window, repName) : [], newest, fresh };
}
