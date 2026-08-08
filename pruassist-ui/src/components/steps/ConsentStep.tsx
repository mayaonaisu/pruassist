"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/console-types";
import { IconDoc, IconHeart, IconShield } from "../icons";

const FOCUS = [
  "Explain policy differences",
  "Compare coverage options",
  "Clarify customer questions",
  "Address objections",
  "Review claim scenarios",
];
const DOCS = [
  { name: "Base Health Protection Plan", meta: "PRUShield · master policy" },
  { name: "Add-on / Rider Document", meta: "PRUExtra · riders 2026" },
  { name: "Claims and FAQ Document", meta: "Internal reference" },
];

export default function ConsentStep({
  repName,
  onBack,
  onStarted,
}: {
  repName: string;
  onBack: () => void;
  onStarted: (s: SessionInfo) => void;
}) {
  const [agree, setAgree] = useState(false);
  const [signature, setSignature] = useState(repName === "Representative" ? "" : repName);
  const [focus, setFocus] = useState<string[]>(FOCUS.slice(0, 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = agree && signature.trim().length > 1;

  async function start() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productArea: "Health Protection", focus }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the session.");
      onStarted({ ...data, productArea: "Health Protection", focus });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the session.");
      setBusy(false);
    }
  }

  return (
    <div className="pru-container" style={{ maxWidth: 980 }}>
      <button className="pru-btn pru-btn-sm" onClick={onBack} style={{ border: "none", padding: "4px 0", background: "none" }}>← Back</button>
      <span className="pru-eyebrow" style={{ display: "block", marginTop: 6 }}>Step 2 of 4</span>
      <h1 style={{ fontSize: 36, margin: "10px 0 6px" }}>Consent &amp; meeting context</h1>
      <p className="pru-muted" style={{ marginBottom: 20, maxWidth: 640, lineHeight: 1.6 }}>
        Confirm consent and set the meeting context. PRUAssist starts listening only after you start the session, and
        transcribes the customer only once they consent on their private link.
      </p>

      {/* Consent */}
      <div className="pru-card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span className="pru-ico sm red"><IconShield size={16} /></span>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Consent Required</div>
        </div>
        <p className="pru-muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
          PRUAssist provides private guidance to the representative only. It does not speak to the customer.
        </p>
        <div className="pru-grid-2">
          <div className="pru-card" style={{ background: "var(--surface-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="pru-eyebrow">Representative</span>
              <span className="pru-eyebrow" style={{ color: ready ? "var(--green)" : "var(--muted)" }}>{ready ? "Signed" : "Pending"}</span>
            </div>
            <div style={{ fontWeight: 700, margin: "6px 0 10px" }}>Financial Representative Consent</div>
            <label style={{ display: "flex", gap: 8, fontSize: 13.5, cursor: "pointer", marginBottom: 12 }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              I agree to use PRUAssist during this advisory session.
            </label>
            <div className="pru-eyebrow" style={{ marginBottom: 6 }}>Typed signature</div>
            <input className="pru-input" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Type your name" style={{ fontStyle: "italic" }} />
          </div>
          <div className="pru-card" style={{ background: "var(--surface-2)" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="pru-eyebrow">Customer</span>
              <span className="pru-eyebrow" style={{ color: "var(--muted)" }}>Via private link</span>
            </div>
            <div style={{ fontWeight: 700, margin: "6px 0 10px" }}>Customer Consent</div>
            <p className="pru-muted" style={{ fontSize: 13 }}>
              After you start, you’ll get a private link to send the customer. They consent to recording on that link
              before joining — PRUAssist won’t transcribe them until they do.
            </p>
          </div>
        </div>
      </div>

      {/* Meeting context */}
      <div className="pru-card">
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 2 }}>Meeting Context</div>
        <p className="pru-muted" style={{ fontSize: 13.5, marginBottom: 16 }}>Pick the product area and policy documents PRUAssist should reference.</p>
        <div className="pru-grid-2" style={{ alignItems: "start" }}>
          <div>
            <div className="pru-eyebrow" style={{ marginBottom: 8 }}>Product area</div>
            <div className="pru-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="pru-ico sm red"><IconHeart size={16} /></span>
                <div>
                  <div style={{ fontWeight: 700 }}>Health Protection</div>
                  <div className="pru-muted" style={{ fontSize: 12.5 }}>Active scope for this session</div>
                </div>
              </div>
              <span className="pru-muted" style={{ fontSize: 12.5 }}>Fixed for prototype</span>
            </div>
            <div className="pru-eyebrow" style={{ margin: "16px 0 8px" }}>Meeting focus</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {FOCUS.map((f) => {
                const on = focus.includes(f);
                return (
                  <button
                    key={f}
                    className={`pru-chip ${on ? "on" : ""}`}
                    onClick={() => setFocus((prev) => (on ? prev.filter((x) => x !== f) : [...prev, f]))}
                  >
                    {on ? "✓ " : ""}
                    {f}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div className="pru-eyebrow" style={{ marginBottom: 8 }}>Active documents</div>
            {DOCS.map((d) => (
              <div key={d.name} className="pru-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="pru-ico sm ink"><IconDoc size={15} /></span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{d.name}</div>
                    <div className="pru-muted" style={{ fontSize: 12 }}>{d.meta}</div>
                  </div>
                </div>
                <span className="pru-eyebrow green" style={{ background: "var(--sage-tint)", color: "var(--green)", padding: "3px 9px", borderRadius: 999 }}>● Active</span>
              </div>
            ))}
          </div>
        </div>

        {error && <p style={{ color: "var(--pru-red)", fontSize: 13, marginTop: 14 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18 }}>
          <span className="pru-muted" style={{ fontSize: 12.5, maxWidth: 480 }}>
            By starting, PRUAssist begins listening to your microphone. You can pause or end the session at any time.
          </span>
          <button className="pru-btn pru-btn-primary" disabled={!ready || busy} onClick={start}>
            {busy ? "Starting…" : "● Start Recording"}
          </button>
        </div>
      </div>
    </div>
  );
}
