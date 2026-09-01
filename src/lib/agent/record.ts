import type { ConceptState, RecordRow } from "./types";

// The Understanding Record as a compliance artifact — the "suitability trail" a mis-selling dispute
// would turn on. It states what the customer demonstrated (in their own words) and whether it was
// safe to recommend, quoting rather than concluding. Pure: state in, record out, no store/model, so
// it is testable and produces the same document on the server, the client, or the replay harness.

const STATE_LABEL: Record<ConceptState, string> = {
  unseen: "Never raised",
  raised: "Explained",
  asserted: "Asserted only",
  demonstrated: "Demonstrated",
  misunderstood: "Misunderstood",
};

export type ComplianceMeta = { productArea: string; signedBy: string; customerName: string; durationMin: number };

export type ComplianceRow = {
  conceptId: string;
  label: string;
  state: ConceptState;
  stateLabel: string;
  quote: string;
  pages: string; // brochure pages, document name stripped
  at?: number;
  risk: string; // "" when settled
};

export type ComplianceVerdict = {
  settled: number; // concepts demonstrated
  open: number; // concepts still open (anything with a standing risk)
  contradicting: number; // concepts the customer got wrong
  clear: boolean; // safe to recommend — nothing open
  line: string; // the plain-language verdict
};

export type ComplianceRecord = {
  meta: ComplianceMeta;
  verdict: ComplianceVerdict;
  rows: ComplianceRow[];
  disclaimer: string;
};

// Pages only, document name dropped, deduped — "p.12, p.18" not the doc repeated on every row.
const pagesOf = (citations: string[]) => [...new Set(citations.flatMap((c) => c.split(" · ").slice(1)))].join(", ");

const DISCLAIMER =
  "This record states what was observed in the conversation, in the customer's own words. It is not " +
  "an assessment of the customer's understanding, and PRUAssist made no recommendation. The Financial " +
  "Representative remains fully responsible for the advice given.";

export function buildComplianceRecord(rows: RecordRow[], meta: ComplianceMeta): ComplianceRecord {
  const settled = rows.filter((r) => r.state === "demonstrated").length;
  const contradicting = rows.filter((r) => r.state === "misunderstood").length;
  const open = rows.filter((r) => r.risk !== "").length;
  const clear = rows.length > 0 && open === 0;

  const line = clear
    ? "Ready to recommend — every tracked concept was demonstrated in the customer's own words."
    : rows.length === 0
      ? "No tracked concept was covered in this session."
      : `Not ready to recommend — ${open} concept${open === 1 ? "" : "s"} still open` +
        (contradicting ? `, ${contradicting} contradicting the policy` : "") +
        `. Settle ${open === 1 ? "it" : "these"} before advising.`;

  return {
    meta,
    verdict: { settled, open, contradicting, clear, line },
    rows: rows.map((r) => ({
      conceptId: r.conceptId,
      label: r.label,
      state: r.state,
      stateLabel: STATE_LABEL[r.state],
      quote: r.quote,
      pages: pagesOf(r.citations),
      at: r.at,
      risk: r.risk,
    })),
    disclaimer: DISCLAIMER,
  };
}

/* ---------- rendering (a thin template over the record above) ---------- */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const hhmm = (at?: number) =>
  at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";

// A self-contained, print-ready HTML document — the record a compliance officer could file.
// Light-only on purpose: it is a printed artifact, not a themed screen.
export function renderComplianceHtml(record: ComplianceRecord, opts: { generatedAt?: string } = {}): string {
  const v = record.verdict;
  const rowsHtml = record.rows.length
    ? record.rows
        .map(
          (r) => `<tr class="${r.state}">
      <td class="c-label">${esc(r.label)}</td>
      <td><span class="pill ${r.state}">${esc(r.stateLabel)}</span></td>
      <td class="c-quote">${r.quote ? "&ldquo;" + esc(r.quote) + "&rdquo;" : "&mdash;"}</td>
      <td class="c-pages">${esc(r.pages)}</td>
      <td class="c-at">${hhmm(r.at)}</td>
      <td class="c-risk">${r.risk ? esc(r.risk) : ""}</td>
    </tr>`,
        )
        .join("\n")
    : `<tr><td colspan="6" class="empty">No tracked concept was covered in this session.</td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Understanding Record — ${esc(record.meta.customerName || "Advisory session")}</title>
<style>
  :root{--ink:#211C18;--ink-2:#5E574F;--ink-3:#8F867C;--bond:#F4F1ED;--surface:#fff;
    --rule:rgba(33,28,24,.14);--pru:#C8102E;--ochre:#946412;--ochre-bg:#F6E8C9;--green:#436B3C;--green-bg:#EAF0E6;--pru-bg:#FBE9EC}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bond);color:var(--ink);font:15px/1.55 "Hanken Grotesk",system-ui,-apple-system,sans-serif;padding:32px}
  .sheet{max-width:820px;margin:0 auto;background:var(--surface);border:1px solid var(--rule);border-radius:14px;
    box-shadow:0 10px 40px -20px rgba(33,28,24,.3);overflow:hidden}
  .head{padding:26px 30px;border-bottom:1px solid var(--rule);display:flex;align-items:flex-start;gap:16px}
  .brand{font-family:Georgia,"Times New Roman",serif;font-size:21px;font-weight:600;letter-spacing:-.01em}
  .brand i{color:var(--pru);font-style:italic}
  .head .t{margin-left:auto;text-align:right;font-size:12.5px;color:var(--ink-3);line-height:1.5}
  .doc-h{padding:22px 30px 6px}
  .doc-h h1{margin:0;font-family:Georgia,serif;font-weight:500;font-size:25px;letter-spacing:-.01em}
  .doc-h .sub{color:var(--ink-3);font-size:13px;margin-top:4px}
  .meta{display:flex;flex-wrap:wrap;gap:8px 26px;padding:14px 30px 4px;font-size:13px;color:var(--ink-2)}
  .meta b{color:var(--ink);font-weight:600}
  .verdict{margin:16px 30px;padding:15px 18px;border-radius:11px;border:1px solid;display:flex;gap:14px;align-items:flex-start}
  .verdict.clear{background:var(--green-bg);border-color:color-mix(in srgb,var(--green) 40%,transparent)}
  .verdict.hold{background:var(--pru-bg);border-color:color-mix(in srgb,var(--pru) 34%,transparent)}
  .verdict .mk{font-size:20px;line-height:1.2}.verdict.clear .mk{color:var(--green)}.verdict.hold .mk{color:var(--pru)}
  .verdict .vt{font-weight:600;font-size:14.5px}.verdict.clear .vt{color:var(--green)}.verdict.hold .vt{color:var(--pru)}
  .verdict .vc{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;color:var(--ink-2);margin-top:3px}
  table{width:100%;border-collapse:collapse;margin:8px 0 4px;font-size:13.5px}
  th{text-align:left;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-3);font-weight:600;
    padding:6px 30px;border-bottom:1px solid var(--rule)}
  td{padding:12px 30px;border-bottom:1px solid rgba(33,28,24,.06);vertical-align:top}
  .c-label{font-weight:600;white-space:nowrap}
  .c-quote{font-family:Georgia,serif;font-style:italic;color:var(--ink-2)}
  .c-pages,.c-at{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11.5px;color:var(--ink-3);white-space:nowrap}
  .c-risk{color:var(--ochre);font-size:12.5px}
  tr.misunderstood .c-risk{color:var(--pru)}
  .pill{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap}
  .pill.demonstrated{color:var(--green);background:var(--green-bg)}
  .pill.asserted,.pill.raised{color:var(--ochre);background:var(--ochre-bg)}
  .pill.misunderstood{color:var(--pru);background:var(--pru-bg)}
  .pill.unseen{color:var(--ink-3);background:rgba(33,28,24,.05)}
  .empty{color:var(--ink-3);font-style:italic;text-align:center}
  .sign{display:flex;justify-content:space-between;gap:20px;padding:20px 30px;border-top:1px solid var(--rule);font-size:13px;flex-wrap:wrap}
  .sign b{font-weight:600}
  .disc{padding:16px 30px 26px;color:var(--ink-3);font-size:11.5px;line-height:1.55}
  .print{position:fixed;top:20px;right:20px;font:inherit;font-size:13px;font-weight:600;background:var(--ink);color:#fff;
    border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
  @media print{body{background:#fff;padding:0}.sheet{border:0;box-shadow:none;border-radius:0}.print{display:none}}
</style></head><body>
<button class="print" onclick="window.print()">Save as PDF</button>
<div class="sheet">
  <div class="head"><span class="brand">PRU<i>Assist</i></span>
    <div class="t">Understanding Record<br>${esc(opts.generatedAt ?? "")}</div></div>
  <div class="doc-h"><h1>Understanding Record</h1>
    <div class="sub">What the customer demonstrated, in their own words — and whether it was safe to recommend.</div></div>
  <div class="meta">
    <span>Advisory area <b>${esc(record.meta.productArea)}</b></span>
    <span>Representative <b>${esc(record.meta.signedBy || "—")}</b></span>
    <span>Customer <b>${esc(record.meta.customerName || "—")}</b></span>
    <span>Duration <b>${record.meta.durationMin} min</b></span>
  </div>
  <div class="verdict ${v.clear ? "clear" : "hold"}">
    <span class="mk">${v.clear ? "✓" : "△"}</span>
    <div><div class="vt">${esc(v.line)}</div>
      <div class="vc">${v.settled} demonstrated &middot; ${v.open} open &middot; ${v.contradicting} contradicting the policy</div></div>
  </div>
  <table>
    <thead><tr><th>Concept</th><th>State</th><th>Customer's own words</th><th>Pages</th><th>Time</th><th>Still open</th></tr></thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>
  <div class="sign">
    <span>Signed <b>${esc(record.meta.signedBy || "—")}</b>${record.meta.customerName ? " &middot; Customer <b>" + esc(record.meta.customerName) + "</b>" : ""}</span>
    <span style="color:var(--ink-3)">Quotes are the customer's own words, timed from the transcript.</span>
  </div>
  <div class="disc">${esc(record.disclaimer)}</div>
</div>
</body></html>`;
}
