"use client";

import { useEffect } from "react";
import Link from "next/link";
import { IconArrow, IconLogout } from "../icons";
import DocumentsInScope from "../DocumentsInScope";
import { useVoiceProfile } from "@/lib/useVoiceProfile";
import { VOICE_MODEL_URL } from "@/lib/voice/model-info";

const NEXT = [
  { n: "01", title: "Consent & context", body: "Confirm consent, set the meeting focus, and either send the customer a private link or hand them this device to consent in person." },
  { n: "02", title: "Live session", body: "Speak normally. Private pointers appear on your side only, as the conversation runs." },
  { n: "03", title: "Advisor brief", body: "A written record of what they asked, what you answered, and what is still open." },
];

export default function IntroStep({ repName, onStart }: { repName: string; onStart: () => void }) {
  const name = repName && repName !== "Representative" ? repName : null;
  const { profile } = useVoiceProfile(); // undefined while loading, null if none, else the vector

  // Warm the model cache before an in-person session when a voiceprint already exists — the model is
  // immutable-cached, so this one prefetch means the worker starts instantly at "Begin". (The ORT wasm
  // warms on the worker's first init.)
  useEffect(() => {
    if (profile) fetch(VOICE_MODEL_URL, { cache: "force-cache" }).catch(() => {});
  }, [profile]);

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
          <h1 className="doc-title">{name ? `Welcome back, ${name}!` : "Ready when you are"}</h1>
          <div className="doc-sub" style={{ marginBottom: 0 }}>
            {name ? "Ready when you are" : "Signed in"} · nothing is recorded until both parties consent
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
          {profile && (
            <Link href="/rep/voice" className="pru-muted" style={{ fontSize: 12.5, textDecoration: "none" }} title="Whose voice this device recognises">
              Voice: set up · Re-record
            </Link>
          )}
          <Link href="/knowledge" className="pru-btn pru-btn-sm" title="Add your own reference material">
            Knowledge base
          </Link>
          <button className="pru-btn pru-btn-sm" onClick={logout} title="Sign out of PRUAssist">
            <IconLogout size={14} /> Log out
          </button>
        </div>
      </div>

      {profile === null && (
        <div className="notice" style={{ marginBottom: 18 }}>
          Set up your voice so in-person sessions know who’s speaking (about 40 seconds).{" "}
          <Link href="/rep/voice" style={{ color: "var(--pru)", fontWeight: 500 }}>
            Set up now
          </Link>
        </div>
      )}

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
        <span className="hint">You choose online or in-person on the next screen</span>
      </div>
    </div>
  );
}
