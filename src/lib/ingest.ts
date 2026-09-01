import type { Clause } from "./knowledge";

// Turning source material into retrievable clauses: extracting readable text from a web page,
// packing lines into clause-sized chunks, and shaping those chunks into cited clauses. Shared by the
// offline scraper (scripts/ingest-web.mts) and the runtime "add knowledge" API, so both produce
// clauses the same shape as the brochure and website ones.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", middot: "·", trade: "™",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

// Readable content lines from an HTML page: drop scripts/chrome, prefer <main>, block tags become
// line breaks, and nav/label noise (short lines, common button text) is filtered out.
export function htmlToLines(html: string, minLine = 40): string[] {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ");
  h = h.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? h.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? h;
  const text = decodeEntities(
    h.replace(/<(?:\/?)(?:p|div|section|article|li|ul|ol|h[1-6]|br|tr|td)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "),
  );
  const junk = /^(menu|search|log ?in|login|register|contact us|share this|cookie|©|copyright|back to top|read more|find out more|learn more|get a quote|buy now|home|products|about us)\b/i;
  const out: string[] = [];
  let prev = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < minLine || junk.test(line) || line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out;
}

// Plain-text (a rep's pasted note) to lines — no nav filtering, so short facts survive.
export function textToLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

// Pack lines into clause-sized chunks: accumulate to `target`, start a new chunk before crossing
// `max`, and keep a trailing chunk only if it clears `minLine`.
export function chunkLines(lines: string[], opts: { target?: number; max?: number; minLine?: number } = {}): string[] {
  const target = opts.target ?? 700;
  const max = opts.max ?? 1000;
  const minLine = opts.minLine ?? 40;
  const chunks: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${l}` : l;
    if (cur.length >= target) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur.length >= minLine) chunks.push(cur);
  return chunks;
}

export function slugify(s: string): string {
  return (s.split("/").filter(Boolean).pop() ?? "src").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "src";
}

// Shape chunks into cited clauses. A link source cites "<doc> · <url>"; a pasted note cites the
// label alone. Ids are `<prefix>-<n>` so they never collide with the brochure/website clause ids.
export function toClauses(chunks: string[], o: { doc: string; url?: string; idPrefix: string }): Clause[] {
  const source = o.url ? `${o.doc} · ${o.url}` : o.doc;
  return chunks.map((text, i) => ({ id: `${o.idPrefix}-${i + 1}`, source, text }));
}
