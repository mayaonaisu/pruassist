"use client";

const STEPS = ["Ready", "Consent", "Live", "Brief"];

export default function Chrome({ step }: { step: number }) {
  return (
    <header className="pru-header">
      <span className="pru-logo">
        <img className="pru-mark" src="/prudential-logo.png" alt="Prudential" />
        <i>Assist</i>
      </span>
      <div className="pru-steps">
        {STEPS.map((s, i) => (
          <span key={s} className={`pru-step ${i === step ? "active" : i < step ? "done" : ""}`}>
            {String(i + 1).padStart(2, "0")} {s.toUpperCase()}
          </span>
        ))}
      </div>
      <span className="pru-tag">
        <span className="dot" />
        Private to you
      </span>
    </header>
  );
}
