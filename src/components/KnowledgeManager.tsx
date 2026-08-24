"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Source = {
  id: string;
  kind: "link" | "text";
  label: string;
  area: string;
  url: string | null;
  addedAt: number;
  clauses: number;
};

export default function KnowledgeManager({ areas }: { areas: string[] }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [mode, setMode] = useState<"link" | "text">("link");
  const [area, setArea] = useState(areas[0] ?? "Health Protection");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/knowledge");
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = await res.json();
      setSources(Array.isArray(data.sources) ? data.sources : []);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await load();
    };
    run();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const body = mode === "link" ? { kind: "link", area, url, label } : { kind: "text", area, label, text };
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not add that source.");
      setUrl("");
      setText("");
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that source.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setSources((s) => (s ? s.filter((x) => x.id !== id) : s)); // optimistic
    await fetch(`/api/knowledge?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  };

  const canAdd = !busy && (mode === "link" ? url.trim().length > 0 : label.trim().length > 0 && text.trim().length > 0);

  return (
    <div style={{ minHeight: "100dvh", background: "var(--brochure)" }}>
      <header className="pru-header">
        <span className="pru-logo">
          <img className="pru-mark" src="/prudential-logo.png" alt="Prudential" />
          <i>Assist</i>
        </span>
        <Link href="/rep" className="link" style={{ marginLeft: "auto" }}>
          ← Back to console
        </Link>
      </header>

      <main className="pru-main">
        <div className="pru-container" style={{ maxWidth: 880 }}>
          <h1 className="doc-title">Knowledge base</h1>
          <div className="doc-sub">
            Add your own reference material — a link or a note — so the assistant can cite it when the
            built-in brochure and website content is out of date. Additions are shared with your team,
            enrich answers alongside everything else, and are always cited as <b>(added)</b>.
          </div>

          {/* ---- add a source ---- */}
          <div className="sec">
            <div className="sec-h">Add a source</div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              <button type="button" className={`pru-chip ${mode === "link" ? "on" : ""}`} onClick={() => setMode("link")}>
                {mode === "link" ? "✓ " : ""}Add a link
              </button>
              <button type="button" className={`pru-chip ${mode === "text" ? "on" : ""}`} onClick={() => setMode("text")}>
                {mode === "text" ? "✓ " : ""}Paste text
              </button>
            </div>

            <label className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
              Product area
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {areas.map((a) => (
                <button key={a} type="button" className={`pru-chip ${a === area ? "on" : ""}`} onClick={() => setArea(a)}>
                  {a === area ? "✓ " : ""}
                  {a}
                </button>
              ))}
            </div>

            {mode === "link" ? (
              <>
                <label htmlFor="k-url" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
                  Link
                </label>
                <input
                  id="k-url"
                  className="pru-input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.prudential.com.sg/…"
                  style={{ marginBottom: 12 }}
                />
                <label htmlFor="k-label-l" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
                  Label (optional)
                </label>
                <input
                  id="k-label-l"
                  className="pru-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. PRUShield FAQ"
                />
              </>
            ) : (
              <>
                <label htmlFor="k-label-t" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
                  Label
                </label>
                <input
                  id="k-label-t"
                  className="pru-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Panel providers update, Aug 2026"
                  style={{ marginBottom: 12 }}
                />
                <label htmlFor="k-text" className="pru-eyebrow" style={{ display: "block", marginBottom: 7 }}>
                  Text
                </label>
                <textarea
                  id="k-text"
                  className="pru-input"
                  rows={5}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Paste or type the facts you want the assistant to be able to cite…"
                  style={{ resize: "vertical" }}
                />
              </>
            )}

            {error && (
              <p role="alert" className="notice bad" style={{ marginTop: 14 }}>
                {error}
              </p>
            )}

            <div className="actions-row">
              <button className="pru-btn pru-btn-primary" disabled={!canAdd} onClick={add}>
                {busy ? "Adding…" : mode === "link" ? "Fetch & add" : "Add note"}
              </button>
              <span className="hint">
                {mode === "link" ? "The page is fetched, read, and chunked into citeable clauses." : "Kept as citeable clauses under this label."}
              </span>
            </div>
          </div>

          {/* ---- current sources ---- */}
          <div className="sec">
            <div className="sec-h">Team knowledge{sources ? ` · ${sources.length}` : ""}</div>
            {sources === null ? (
              <p className="pru-muted" style={{ fontSize: 13 }}>
                Loading…
              </p>
            ) : sources.length === 0 ? (
              <p className="pru-muted" style={{ fontSize: 13 }}>
                Nothing added yet. What you add here is cited in live sessions like the brochure.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {sources.map((s) => (
                  <div key={s.id} className="kb-row">
                    <div style={{ minWidth: 0 }}>
                      <div className="kb-label">{s.label}</div>
                      <div className="kb-meta">
                        {s.area} · {s.kind === "link" ? "link" : "note"} · {s.clauses} {s.clauses === 1 ? "clause" : "clauses"}
                      </div>
                      {s.url && (
                        <a href={s.url} target="_blank" rel="noreferrer" className="kb-url">
                          {s.url}
                        </a>
                      )}
                    </div>
                    <button className="pru-btn pru-btn-sm" onClick={() => remove(s.id)} title="Remove this source">
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
