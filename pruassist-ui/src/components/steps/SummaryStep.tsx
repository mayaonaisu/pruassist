"use client";

import { useEffect, useState } from "react";
import type { SummaryData } from "@/lib/console-types";
import { IconShield } from "../icons";

export default function SummaryStep({ summary, onNewSession }: { summary: SummaryData; onNewSession: () => void }) {
  const [notes, setNotes] = useState("");
  const s = summary.stats;

  const exportBrief = () => {
    const block = (title: string, items: string[]) =>
      [title, ...(items.length ? items.map((i) => `  - ${i}`) : ["  - (none captured)"]), ""].join("\n");
    const text = [
      "PRUAssist — Advisor Session Brief",
      `Health Protection · ${summary.durationMin} min`,
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
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="pru-container" style={{ maxWidth: 1080 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <span className="pru-eyebrow pill green" style={{ background: "var(--sage-tint)", color: "var(--green)" }}>● Session ended</span>
          <h1 style={{ fontSize: 36, margin: "12px 0 4px" }}>Advisor session summary</h1>
          <div className="pru-muted" style={{ fontSize: 13.5 }}>
            Health Protection · {summary.durationMin} min · {s.flags} customer concern{s.flags === 1 ? "" : "s"} flagged
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="pru-btn" onClick={onNewSession}>Start New Session</button>
          <button className="pru-btn pru-btn-primary" onClick={exportBrief}>↓ Export Advisor Brief</button>
        </div>
      </div>

      <div className="pru-grid-2 pru-stagger" style={{ marginTop: 20 }}>
        <ListCard title="Key customer concerns" items={summary.concerns} dot="var(--amber)" />
        <ListCard title="Talking points suggested" items={summary.talkingPoints} dot="var(--pru-red)" />
      </div>
      <div className="pru-grid-2 pru-stagger" style={{ marginTop: 18 }}>
        <ListCard title="Follow-up items" items={summary.followUps} dot="var(--green)" />
        <div className="pru-card">
          <span className="pru-eyebrow pill">Representative notes</span>
          <p className="pru-muted" style={{ fontSize: 13.5, margin: "12px 0", lineHeight: 1.5 }}>{summary.notes || "No automated notes captured."}</p>
          <textarea className="pru-input" rows={4} placeholder="Add additional notes…" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ resize: "vertical" }} />
        </div>
      </div>

      <div className="pru-card pru-stagger" style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
        <Stat label="Pointers surfaced" value={s.surfaced} />
        <Stat label="Pointers used" value={s.used} />
        <Stat label="Confusion flags" value={s.flags} />
        <Stat label="Documents referenced" value={s.docs} />
      </div>

      <div className="pru-card" style={{ marginTop: 18, background: "var(--pru-red-soft)", borderColor: "var(--pru-red-line)", display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <span style={{ color: "var(--pru)", flexShrink: 0 }}><IconShield size={15} /></span>
        <span className="pru-muted" style={{ fontSize: 12.5, maxWidth: 660 }}>
          PRUAssist did not make any product recommendations. All talking points were suggestions for the Financial
          Representative, who remains fully responsible for the advice given.
        </span>
      </div>
    </div>
  );
}

function ListCard({ title, items, dot }: { title: string; items: string[]; dot: string }) {
  return (
    <div className="pru-card">
      <span className="pru-eyebrow pill">{title}</span>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {(items.length ? items : ["No items captured for this session."]).map((it, i) => (
          <div key={i} style={{ display: "flex", gap: 10, fontSize: 13.5, lineHeight: 1.45 }}>
            <span style={{ color: dot, marginTop: 5, fontSize: 9 }}>●</span>
            <span>{it}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="pru-stat">
      <div className="label">{label}</div>
      <div className="value">
        <CountUp value={value} />
      </div>
    </div>
  );
}

function CountUp({ value }: { value: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const dur = 750;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      setN(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n}</>;
}
