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
      // Parse only after checking res.ok — an HTML error page from a proxy would otherwise throw
      // a JSON syntax error and show the rep a raw parser message.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "Sign in failed. Please try again.");
      }
      router.push("/rep");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed. Please try again.");
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "24px 16px" }}>
      <div className="pru-enter" style={{ width: "min(400px, 100%)" }}>
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

          <label htmlFor="username" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>Username</label>
          <input id="username" name="username" className="pru-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />

          <label htmlFor="password" className="pru-eyebrow" style={{ display: "block", margin: "14px 0 7px" }}>Password</label>
          <input id="password" name="password" className="pru-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />

          {error && <p role="alert" style={{ color: "var(--pru)", fontSize: 13, marginTop: 13, fontWeight: 600 }}>{error}</p>}

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
