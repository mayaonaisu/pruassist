"use client";

import { useState } from "react";
import type { SummaryData } from "@/lib/console-types";
import type { ConceptState, RecordRow } from "@/lib/agent/types";
import { buildComplianceRecord, renderComplianceHtml } from "@/lib/agent/record";

// What each state means on the record. The wording is deliberately about what was observed, never
// about the customer: "agreed, never demonstrated" is a fact; "did not understand" is a verdict.
const STATE_LABEL: Record<ConceptState, string> = {
  unseen: "NEVER RAISED",
  raised: "EXPLAINED",
  asserted: "ASSERTED ONLY",
  demonstrated: "DEMONSTRATED",
  misunderstood: "MISUNDERSTOOD",
};

const hhmm = (at?: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

// The page citations, without the document name repeated on every row.
const pages = (citations: string[]) =>
  [...new Set(citations.flatMap((c) => c.split(" · ").slice(1)))].join(", ");

export default function SummaryStep({
  summary,
  productArea,
  onNewSession,
}: {
  summary: SummaryData;
  productArea: string;
  onNewSession: () => void;
}) {
  const [notes, setNotes] = useState("");
  const s = summary.stats;

  const startNew = () => {
    // These notes exist only here and feed only the export, so leaving loses them for good.
    if (notes.trim() && !window.confirm("Your typed notes haven’t been exported and will be lost. Start a new session anyway?")) return;
    onNewSession();
  };

  // The Understanding Record as a standalone, print-ready compliance document — the suitability
  // trail. Opens in a new tab (Save as PDF from there); falls back to a download if a popup is
  // blocked. Built from the same record the page already shows.
  const exportRecord = () => {
    const record = buildComplianceRecord(summary.record, {
      productArea,
      signedBy: summary.signedBy,
      customerName: summary.customerName,
      durationMin: summary.durationMin,
    });
    const html = renderComplianceHtml(record, { generatedAt: new Date().toLocaleString() });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const win = window.open(url, "_blank");
    if (!win) {
      const a = document.createElement("a");
      a.href = url;
      a.download = "pruassist-understanding-record.html";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const exportBrief = () => {
    const block = (title: string, items: string[]) =>
      [title, ...(items.length ? items.map((i) => `  - ${i}`) : ["  - (none captured)"]), ""].join("\n");
    const recordBlock = summary.record.length
      ? [
          "Understanding Record — what the customer demonstrated, in their own words:",
          ...summary.record.map((r) =>
            [
              `  ${r.label.padEnd(22)} ${STATE_LABEL[r.state].padEnd(15)}`,
              hhmm(r.at).padEnd(6),
              r.quote ? `"${r.quote}"` : "",
              `[${pages(r.citations)}]`,
              r.risk ? `-- ${r.risk}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          ),
          "",
          `Signed: ${summary.signedBy}${summary.customerName ? ` · Customer: ${summary.customerName}` : ""}`,
          "This record states what was observed in the conversation. It is not an assessment of the",
          "customer's understanding, and PRUAssist made no recommendation.",
          "",
        ].join("\n")
      : "";
    const text = [
      "PRUAssist — Advisor Session Brief",
      `${productArea} · ${summary.durationMin} min`,
      "",
      recordBlock,
      block("Key customer concerns:", summary.concerns),
      block("Talking points:", summary.talkingPoints),
      block("Follow-up items:", summary.followUps),
      "Notes:",
      "  " + (summary.notes || "(none)"),
      notes ? "\nRepresentative added notes:\n  " + notes : "",
      "",
      `Pointers surfaced: ${s.surfaced} · used: ${s.used} · confusion flags: ${s.flags} · documents referenced: ${s.docs}`,
      "",
      "PRUAssist did not make any product recommendations. All talking points were suggestions for the Financial Representative, who remains fully responsible for the advice given.",
    ].join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pruassist-advisor-brief.txt";
    // pls dont touch firefox needs the anchor in the document, and revoking in the same tick aborts the download.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="pru-container" style={{ maxWidth: 1080 }}>
      <div className="brief-head">
        <div>
          <h1 className="doc-title">Advisor brief</h1>
          <div className="doc-sub" style={{ marginBottom: 0 }}>{productArea}</div>
        </div>
        <div className="meta">
          {summary.durationMin} MIN
          <br />
          SESSION ENDED
        </div>
      </div>

      {/* Numbers sit in a sentence, the form the rep repeats to a supervisor. */}
      <p className="stat-sentence">
        Over <b>{summary.durationMin}</b> minutes PRUAssist flagged <b>{s.flags}</b>{" "}
        {s.flags === 1 ? "moment" : "moments"} of confusion and surfaced <b>{s.surfaced}</b>{" "}
        {s.surfaced === 1 ? "pointer" : "pointers"}. You used <b>{s.used}</b>, drawing on <b>{s.docs}</b>{" "}
        {s.docs === 1 ? "document" : "documents"}.
      </p>

      <UnderstandingRecord rows={summary.record} signedBy={summary.signedBy} customerName={summary.customerName} />

      <Section title="What the customer raised" items={summary.concerns} />
      <Section title="Lines suggested to you" items={summary.talkingPoints} said />
      <Section title="Still open" items={summary.followUps} />

      <div className="sec">
        <div className="sec-h">Notes</div>
        <p className="pru-muted" style={{ fontSize: 13.5, lineHeight: 1.65, marginBottom: 14 }}>
          {summary.notes || "No automated notes captured."}
        </p>
        <label htmlFor="rep-notes" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
          Your notes
        </label>
        <textarea
          id="rep-notes"
          name="notes"
          className="pru-input"
          rows={4}
          placeholder="Add anything you want in the exported brief…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ resize: "vertical" }}
        />
      </div>

      <p className="notice" style={{ marginTop: 8 }}>
        PRUAssist did not make any product recommendations. All talking points were suggestions for the Financial
        Representative, who remains fully responsible for the advice given.
      </p>

      <div className="actions-row">
        <button className="pru-btn pru-btn-primary" onClick={exportRecord}>
          Export understanding record
        </button>
        <button className="pru-btn" onClick={exportBrief}>
          Export text brief
        </button>
        <button className="pru-btn" onClick={startNew}>
          Start new session
        </button>
        <span className="hint">The transcript is discarded when you leave this page</span>
      </div>
    </div>
  );
}

/* The artifact. Per concept: the state, the customer's own timestamped words as evidence, the
   brochure pages, and what is still open. This is the part that decides a mis-selling dispute two
   years from now, so it quotes rather than concludes. */
function UnderstandingRecord({
  rows,
  signedBy,
  customerName,
}: {
  rows: RecordRow[];
  signedBy: string;
  customerName: string;
}) {
  if (!rows.length) {
    return (
      <div className="sec">
        <div className="sec-h">Understanding record</div>
        <p className="pru-muted" style={{ fontSize: 13 }}>
          No comprehension evidence was captured for this session. This happens when the shared
          session store was unreachable, or when the conversation covered no tracked concept.
        </p>
      </div>
    );
  }

  const open = rows.filter((r) => r.risk).length;

  return (
    <div className="sec">
      <div className="sec-h">Understanding record</div>
      <p className="pru-muted" style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 12 }}>
        What the customer <b>showed</b>, not what they agreed to. Quotes are their own words, timed
        from the transcript. {open ? `${open} ${open === 1 ? "item is" : "items are"} still open.` : "Nothing is left open."}
      </p>

      <div className="ur">
        {rows.map((r) => (
          <div key={r.conceptId} className={`ur-row ur-${r.state}`}>
            <div className="ur-label">{r.label}</div>
            <div className="ur-state">{STATE_LABEL[r.state]}</div>
            <div className="ur-at">{hhmm(r.at)}</div>
            <div className="ur-quote">{r.quote ? `“${r.quote}”` : <span className="pru-muted">—</span>}</div>
            <div className="ur-cite">{pages(r.citations)}</div>
            <div className="ur-risk">{r.risk ? `⚠ ${r.risk}` : ""}</div>
          </div>
        ))}
      </div>

      <div className="ur-sign">
        <span>
          Signed <b>{signedBy}</b>
          {customerName ? (
            <>
              {" · "}Customer <b>{customerName}</b>
            </>
          ) : null}
        </span>
        <span className="pru-muted">
          States what was observed in the conversation, not an assessment of the customer.
        </span>
      </div>
    </div>
  );
}

function Section({ title, items, said }: { title: string; items: string[]; said?: boolean }) {
  return (
    <div className="sec">
      <div className="sec-h">{title}</div>
      {items.length === 0 ? (
        <p className="pru-muted" style={{ fontSize: 13 }}>
          Nothing captured for this session.
        </p>
      ) : (
        items.map((it, i) => (
          <div key={i} className="qa">
            {/* Suggested lines are set in the spoken voice; everything else is UI text. */}
            <div className={said ? "q" : "a"}>{said ? `“${it}”` : it}</div>
          </div>
        ))
      )}
    </div>
  );
}
