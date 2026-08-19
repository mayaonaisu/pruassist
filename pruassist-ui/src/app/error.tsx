"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)", display: "grid", placeItems: "center", padding: 28 }}>
      <div className="pru-card" style={{ width: "min(480px, 94vw)", textAlign: "center" }}>
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
        <p className="pru-muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
          PRUAssist hit an unexpected error. Your session was not saved. You can try again, or return to the console and
          start a new advisory session.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "center", flexWrap: "wrap" }}>
          <button className="pru-btn pru-btn-primary" onClick={reset}>Try again</button>
          <a className="pru-btn" href="/rep">Back to console</a>
        </div>
      </div>
    </div>
  );
}
