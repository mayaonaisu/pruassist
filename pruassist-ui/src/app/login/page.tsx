"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconShield } from "@/components/icons";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Login failed.");
      router.push("/rep");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="pru-enter" style={{ width: "min(400px, 94vw)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, justifyContent: "center", marginBottom: 22 }}>
          <div className="pru-logo">
            <div className="mark">P</div>
            <div>
              <div className="name">PRUAssist</div>
              <div className="sub">Advisor Co-Pilot</div>
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="pru-card" style={{ padding: 26 }}>
          <span className="pru-ico red" style={{ marginBottom: 16 }}><IconShield size={20} /></span>
          <span className="pru-eyebrow pill" style={{ display: "inline-block" }}>● Internal · licensed representatives</span>
          <h1 style={{ fontSize: 24, fontWeight: 750, margin: "14px 0 4px" }}>Sign in to your co-pilot</h1>
          <p className="pru-muted" style={{ fontSize: 13.5, marginBottom: 20 }}>
            PRUAssist is private to the representative — it never speaks to the customer.
          </p>

          <label className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>Username</label>
          <input className="pru-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />

          <label className="pru-eyebrow" style={{ display: "block", margin: "14px 0 7px" }}>Password</label>
          <input className="pru-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

          {error && <p style={{ color: "var(--pru)", fontSize: 13, marginTop: 13, fontWeight: 600 }}>{error}</p>}

          <button className="pru-btn pru-btn-primary" disabled={loading} style={{ width: "100%", marginTop: 18, padding: "11px" }}>
            {loading ? "Signing in…" : "Sign in →"}
          </button>
        </form>

        <p className="pru-muted" style={{ fontSize: 12, textAlign: "center", marginTop: 16 }}>
          Customers join only via the private link you send them.
        </p>
      </div>
    </main>
  );
}
