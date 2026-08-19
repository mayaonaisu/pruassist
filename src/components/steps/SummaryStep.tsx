"use client";

import { useState } from "react";
import type { SummaryData } from "@/lib/console-types";

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
    // The typed notes live only in this component and feed only the export, so leaving
    // without them is unrecoverable.
    if (notes.trim() && !window.confirm("Your typed notes haven’t been exported and will be lost. Start a new session anyway?")) return;
    onNewSession();
  };

  const exportBrief = () => {
    const block = (title: string, items: string[]) =>
      [title, ...(items.length ? items.map((i) => `  - ${i}`) : ["  - (none captured)"]), ""].join("\n");
    const text = [
      "PRUAssist — Advisor Session Brief",
      `${productArea} · ${summary.durationMin} min`,
      "",
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
    // The anchor must be in the document for a programmatic click to download in Firefox, and
    // the object URL must outlive the click — revoking in the same tick aborts the download.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="pru-container" style={{ maxWidth: 900 }}>
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

      {/* The numbers sit inside a sentence rather than in metric cards, because this is the
          form the rep repeats to a supervisor. */}
      <p className="stat-sentence">
        Over <b>{summary.durationMin}</b> minutes PRUAssist flagged <b>{s.flags}</b>{" "}
        {s.flags === 1 ? "moment" : "moments"} of confusion and surfaced <b>{s.surfaced}</b>{" "}
        {s.surfaced === 1 ? "pointer" : "pointers"}. You used <b>{s.used}</b>, drawing on <b>{s.docs}</b>{" "}
        {s.docs === 1 ? "document" : "documents"}.
      </p>

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
        <button className="pru-btn pru-btn-primary" onClick={exportBrief}>
          Export brief
        </button>
        <button className="pru-btn" onClick={startNew}>
          Start new session
        </button>
        <span className="hint">The transcript is discarded when you leave this page</span>
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
