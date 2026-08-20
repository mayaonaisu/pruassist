"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      // Parse only after res.ok, or a proxy's HTML error page surfaces as a JSON syntax error.
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
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <span className="pru-logo" style={{ fontSize: 20 }}>
            PRU<i>Assist</i>
          </span>
        </div>

        <form onSubmit={onSubmit} className="pru-card" style={{ padding: 26 }}>
          <div className="pru-eyebrow">Internal · licensed representatives</div>
          <h1 className="doc-title" style={{ fontSize: 21, margin: "10px 0 4px" }}>Sign in</h1>
          <p className="doc-sub" style={{ marginBottom: 20 }}>
            PRUAssist is private to the representative — it never speaks to the customer.
          </p>

          <label htmlFor="username" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>Username</label>
          <input id="username" name="username" className="pru-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />

          <label htmlFor="password" className="pru-eyebrow" style={{ display: "block", margin: "14px 0 7px" }}>Password</label>
          <input id="password" name="password" className="pru-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />

          {error && <p role="alert" style={{ color: "var(--pru)", fontSize: 13, marginTop: 13, fontWeight: 600 }}>{error}</p>}

          <button className="pru-btn pru-btn-primary" disabled={loading} style={{ width: "100%", marginTop: 18, padding: "11px" }}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="pru-muted" style={{ fontSize: 12, textAlign: "center", marginTop: 16 }}>
          Customers join only via the private link you send them.
        </p>
      </div>
    </main>
  );
}
