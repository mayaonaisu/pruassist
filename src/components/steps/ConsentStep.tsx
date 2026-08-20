"use client";

import { useState } from "react";
import type { SessionInfo } from "@/lib/console-types";
import DocumentsInScope from "../DocumentsInScope";

const FOCUS = [
  "policy differences",
  "coverage options",
  "customer questions",
  "objections",
  "claim scenarios",
];
const PRODUCT_AREA = "Health Protection";

// Reads the selection back as speech, since the sentence above is what the rep will say.
function asPhrase(items: string[]): string {
  if (items.length === 0) return "whatever comes up";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

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
  const [focus, setFocus] = useState<string[]>(FOCUS.slice(0, 2));
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
        body: JSON.stringify({ productArea: PRODUCT_AREA, focus, repName: signature.trim() }),
      });
      // /rep is gated on page load only, so an 8-hour-old console fails here rather than earlier.
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "Could not start the session.");
      }
      onStarted({ ...(await res.json()), productArea: PRODUCT_AREA, focus });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the session.");
      setBusy(false);
    }
  }

  return (
    <div className="pru-container" style={{ maxWidth: 1160 }}>
      <button className="link" onClick={onBack} style={{ marginBottom: 12 }}>
        ← Back
      </button>
      <h1 className="doc-title">Before we start recording</h1>
      <div className="doc-sub">
        Both parties consent on their own device. Nothing is captured until the customer accepts on theirs.
      </div>

      {/* The configuration reads as a sentence the rep would actually say. */}
      <p className="sentence">
        Today&rsquo;s session covers <span className="slot">{PRODUCT_AREA}</span>, focusing on{" "}
        <span className="slot multi">{asPhrase(focus)}</span>.
      </p>

      <div className="sec">
        <div className="sec-h">Meeting focus</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {FOCUS.map((f) => {
            const on = focus.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
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

      <div className="pru-grid-2" style={{ marginBottom: 24 }}>
        <div className="consent">
          <div className="h">
            <span className="t">Representative</span>
            <span className={`chip ${ready ? "ok" : "wait"}`}>{ready ? "SIGNED" : "UNSIGNED"}</span>
          </div>
          <p>
            I confirm the customer has been told this session is recorded and transcribed to assist my advice.
          </p>
          <label style={{ display: "flex", gap: 8, fontSize: 13, cursor: "pointer", marginBottom: 16, color: "var(--ink-2)" }}>
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            I agree to use PRUAssist during this advisory session.
          </label>
          <input
            id="signature"
            name="signature"
            className="sigline"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Type your name"
            aria-label="Typed signature"
          />
          <span className="sigcap">TYPED SIGNATURE</span>
        </div>

        <div className="consent">
          <div className="h">
            <span className="t">Customer</span>
            <span className="chip wait">AWAITING</span>
          </div>
          <p>
            Sent to their device via private link once you start. They accept there — you can&rsquo;t accept on their
            behalf, and they aren&rsquo;t transcribed until they do.
          </p>
          <div className="await">—</div>
          <span className="sigcap">LINK NOT YET SENT</span>
        </div>
      </div>

      <DocumentsInScope title="Documents in scope for this session" />

      {error && (
        <p role="alert" className="notice bad" style={{ marginTop: 16 }}>
          {error}
        </p>
      )}

      <div className="actions-row">
        <button className="pru-btn pru-btn-primary" disabled={!ready || busy} onClick={start}>
          {busy ? "Starting…" : "Start session"}
        </button>
        <span className="hint">
          {ready ? "Recording begins when you start" : "Sign above to enable"}
        </span>
      </div>
    </div>
  );
}
