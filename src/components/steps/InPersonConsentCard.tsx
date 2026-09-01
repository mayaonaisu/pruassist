"use client";

import { useState } from "react";
import { IconCheck, IconX } from "@/components/icons";

// The hand-the-iPad consent surface for in-person mode. In an online session the customer sees the
// disclosures on their own device (/c/[token]); in person that page is never visited, so the same
// disclosures — reworded for one shared microphone, no camera — are shown here, and the customer types
// their name and accepts on this device. Records the same consent:<roomId> key via /api/consent.
export default function InPersonConsentCard({
  roomId,
  repName,
  productArea,
  onConsented,
  onDeclined,
}: {
  roomId: string;
  repName: string;
  productArea: string;
  onConsented: (name: string) => void;
  onDeclined: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const clean = name.trim();
  // A customer name equal to the rep's would misattribute every line (toTurns keys on "=== repName"),
  // so it is rejected here.
  const collides = clean.length > 1 && clean.toLowerCase() === repName.trim().toLowerCase();
  const ready = clean.length > 1 && !collides;

  async function agree() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, name: clean }),
      });
      if (!res.ok) throw new Error("Could not record consent. Please try again.");
      onConsented(clean);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record consent.");
      setBusy(false);
    }
  }

  return (
    <div className="pru-container" style={{ maxWidth: 640 }}>
      <div className="pru-eyebrow" style={{ marginBottom: 10 }}>In person · PRUAssist</div>
      <h1 className="doc-title">{repName} would like to record this session</h1>
      <div className="doc-sub">{productArea} · please read and accept on this device</div>

      <div className="cust-card">
        <ul>
          <li>
            <IconCheck size={15} />
            <span>Your voice is recorded from this device’s microphone during this meeting, and heard by {repName} only.</span>
          </li>
          <li>
            <IconCheck size={15} />
            <span>The conversation is transcribed, and the assistant separates who is speaking; {repName} can correct any mistake.</span>
          </li>
          <li>
            <IconCheck size={15} />
            <span>
              Short quotes of what you say about specific policy terms are kept for 24 hours, so
              {" " + repName} has a record of what was explained and what is still unclear.
            </span>
          </li>
          <li>
            <IconX size={15} />
            <span>A private assistant helps them find the right wording — it never speaks to you, and never makes the recommendation.</span>
          </li>
        </ul>
      </div>

      <input
        className="sigline"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Type your name"
        aria-label="Your name"
        style={{ minHeight: 44 }}
      />
      <span className="sigcap">YOUR NAME</span>

      {collides && (
        <p className="notice" style={{ marginTop: 10 }}>
          Please enter the customer’s name, not the representative’s.
        </p>
      )}
      {error && (
        <p role="alert" className="notice bad" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="pru-btn pru-btn-primary" disabled={!ready || busy} onClick={agree} style={{ minHeight: 44 }}>
          {busy ? "Recording consent…" : "I agree — continue"}
        </button>
        <button className="pru-btn" onClick={onDeclined} style={{ minHeight: 44 }}>
          Decline
        </button>
      </div>
      <p className="pru-muted" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
        You can leave at any time. Declining ends the session for both of you.
      </p>
    </div>
  );
}
