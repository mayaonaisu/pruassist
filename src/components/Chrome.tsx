"use client";

const STEPS = ["Intro", "Consent", "Live Session", "Summary"];

export default function Chrome({ step }: { step: number }) {
  return (
    <>
      <header className="pru-header">
        <div className="pru-logo">
          <div className="mark">P</div>
          <div>
            <div className="name">PRUAssist</div>
            <div className="sub">Advisor Co-Pilot</div>
          </div>
        </div>
        <div className="pru-steps">
          {STEPS.map((s, i) => (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {i > 0 && <span style={{ width: 28, height: 1, background: "var(--line)", display: "inline-block" }} />}
              <div className={`pru-step ${i === step ? "active" : i < step ? "done" : ""}`}>
                <span className="num">{i + 1}</span>
                {s}
              </div>
            </div>
          ))}
        </div>
        <div className="pru-tag">
          <span className="dot" />
          Internal · Representative-Only
        </div>
      </header>
      <div className="pru-banner">
        <b>The Financial Representative remains in control.</b> PRUAssist provides private guidance only — it never
        speaks to the customer.
      </div>
    </>
  );
}
