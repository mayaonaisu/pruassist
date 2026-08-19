"use client";

import { IconArrow, IconLayers, IconLock, IconLogout, IconShield, IconSparkle } from "../icons";
import { KNOWLEDGE } from "@/lib/knowledge";

const CLAUSES = KNOWLEDGE.length;

// Post-login readiness — real status, not a product pitch.
const READY = [
  { icon: <IconLayers size={16} />, label: "Knowledge base", value: `${CLAUSES} policy clauses`, sub: "PRUShield + PRUExtra · brochure-cited" },
  { icon: <IconSparkle size={16} />, label: "Talking points", value: "AI ready", sub: "Grounded · every line sourced" },
  { icon: <IconLock size={16} />, label: "Privacy", value: "Private to you", sub: "Customer consents on their link" },
  { icon: <IconShield size={16} />, label: "Your control", value: "Suggests only", sub: "Use, rephrase, or ignore" },
];

const NEXT = [
  { n: "1", title: "Consent & context", body: "Confirm consent, choose the meeting focus, and send the customer a private link to join." },
  { n: "2", title: "Live session", body: "Speak normally on video. Private talking points appear on your side only, in real time." },
  { n: "3", title: "Summary & follow-ups", body: "Get an automatic recap — concerns raised, points covered, and suggested next steps." },
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
    <div className="pru-container" style={{ maxWidth: 1040 }}>
      {/* launchpad header */}
      <div style={{ padding: "20px 0 4px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span className="pru-eyebrow pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <IconLock size={12} /> Internal tool{name ? ` · signed in as ${name}` : ""}
          </span>
          <button className="pru-btn pru-btn-sm" onClick={logout} title="Sign out of PRUAssist">
            <IconLogout size={15} /> Log out
          </button>
        </div>
        <h1 style={{ fontSize: 46, margin: "18px 0 12px", maxWidth: 640 }}>Ready when you are.</h1>
        <p className="pru-muted" style={{ maxWidth: 560, lineHeight: 1.62, fontSize: 15.5 }}>
          Start an advisory session and PRUAssist works quietly in the background — transcribing with consent, spotting
          confusion, and handing you private, policy-grounded lines. You stay in control of every word.
        </p>
        <div style={{ marginTop: 26 }}>
          <button className="pru-btn pru-btn-primary" onClick={onStart} style={{ padding: "12px 22px" }}>
            Start advisory session <IconArrow size={16} />
          </button>
        </div>
      </div>

      {/* co-pilot readiness — real, reassuring pre-flight */}
      <div className="pru-card" style={{ marginTop: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
          <span className="pru-eyebrow">Co-pilot readiness</span>
          <span className="pru-eyebrow pill green" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: "var(--sage)", display: "inline-block" }} /> All systems ready
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20 }}>
          {READY.map((r) => (
            <div key={r.label}>
              <span className="pru-ico sm sage">{r.icon}</span>
              <div className="pru-eyebrow" style={{ marginTop: 13 }}>{r.label}</div>
              <div style={{ fontWeight: 700, fontSize: 15, margin: "5px 0 3px", letterSpacing: "-0.01em" }}>{r.value}</div>
              <div className="pru-muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>{r.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* what happens after you start — the procedure, not a pitch */}
      <div style={{ marginTop: 24 }}>
        <span className="pru-eyebrow" style={{ marginLeft: 2 }}>What happens after you start</span>
        <div className="pru-grid-3" style={{ marginTop: 12 }}>
          {NEXT.map((s) => (
            <div key={s.n} className="pru-card pru-lift">
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 27, height: 27, borderRadius: 999, background: "var(--pru)", color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)", flexShrink: 0 }}>{s.n}</span>
                <div style={{ fontWeight: 700, fontSize: 15.5, letterSpacing: "-0.01em" }}>{s.title}</div>
              </div>
              <p className="pru-muted" style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 13 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
