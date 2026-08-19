"use client";

import { IconArrow, IconLogout } from "../icons";
import DocumentsInScope from "../DocumentsInScope";

const NEXT = [
  { n: "01", title: "Consent & context", body: "Confirm consent, set the meeting focus, and send the customer a private link." },
  { n: "02", title: "Live session", body: "Speak normally. Private pointers appear on your side only, as the conversation runs." },
  { n: "03", title: "Advisor brief", body: "A written record of what they asked, what you answered, and what is still open." },
];

export default function IntroStep({ repName, onStart }: { repName: string; onStart: () => void }) {
  const name = repName && repName !== "Representative" ? repName : null;

  async function logout() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* navigate away regardless */
    }
    window.location.href = "/"; // hard nav to the landing so no authed state lingers
  }

  return (
    <div className="pru-container" style={{ maxWidth: 1120 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 22 }}>
        <div>
          <h1 className="doc-title">Ready when you are</h1>
          <div className="doc-sub" style={{ marginBottom: 0 }}>
            {name ? `Signed in as ${name}` : "Signed in"} · nothing is recorded until both parties consent
          </div>
        </div>
        <button className="pru-btn pru-btn-sm" onClick={logout} style={{ marginLeft: "auto" }} title="Sign out of PRUAssist">
          <IconLogout size={14} /> Log out
        </button>
      </div>

      <DocumentsInScope title="Documents indexed for this session" />

      <div className="sec" style={{ marginTop: 26 }}>
        <div className="sec-h">What happens after you start</div>
        <div className="pru-grid-3">
          {NEXT.map((s) => (
            <div key={s.n}>
              <div className="pru-eyebrow" style={{ color: "var(--pru)" }}>{s.n}</div>
              <div style={{ fontWeight: 500, fontSize: 14.5, margin: "7px 0 5px" }}>{s.title}</div>
              <p className="pru-muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="actions-row">
        <button className="pru-btn pru-btn-primary" onClick={onStart}>
          Start advisory session <IconArrow size={15} />
        </button>
        <span className="hint">You send the customer a link on the next screen</span>
      </div>
    </div>
  );
}
