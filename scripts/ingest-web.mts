/**
 * Ingest selected prudential.com.sg product pages into the retrievable knowledge base.
 *
 *   npm run ingest:web
 *
 * Fetches each page in PAGES, extracts the readable text, chunks it into clause-sized pieces, and
 * regenerates src/lib/web-knowledge.ts. Those clauses flow through the SAME retrieval + grounding +
 * citation pipeline as the hand-authored brochure clauses (knowledge.ts) — but they carry a "(web)"
 * document and cite the page URL, so a rep always sees a claim came from the website rather than the
 * policy. The comprehension spine (concepts, the suitability figures) stays anchored to the brochure.
 *
 * Add or change pages by editing PAGES below, then re-run. Review the generated file before shipping.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "lib", "web-knowledge.ts");

// The pages to ingest: the URL, the product area retrieval should scope it to (must match an area
// the app uses — e.g. "Health Protection"), and a short document label shown in citations.
const PAGES: { url: string; area: string; doc: string }[] = [
  {
    url: "https://www.prudential.com.sg/products/health-insurance/medical/prushield",
    area: "Health Protection",
    doc: "PRUShield & PRUExtra (prudential.com.sg)",
  },
  {
    url: "https://www.prudential.com.sg/products/health-insurance/critical-illness/pruactive-protect",
    area: "Critical Illness",
    doc: "PRUActive Protect (prudential.com.sg)",
  },
];

// Keep the ingest focused: enough to enrich answers, not the whole page including footers and legal.
const MIN_LINE = 40; // shorter lines are almost always nav / labels / buttons
const CHUNK_TARGET = 700;
const CHUNK_MAX = 1000;
const MAX_CHUNKS_PER_PAGE = 24;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", middot: "·", trade: "™",
};
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
}

function htmlToLines(html: string): string[] {
  // Drop non-content blocks entirely.
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(nav|header|footer|form)[\s\S]*?<\/\1>/gi, " ");
  // Prefer <main> if the page marks it; otherwise the body.
  h = h.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? h.match(/<body[\s\S]*?<\/body>/i)?.[0] ?? h;
  // Block-level tags become line breaks; everything else is stripped.
  const text = decodeEntities(
    h
      .replace(/<(?:\/?)(?:p|div|section|article|li|ul|ol|h[1-6]|br|tr|td)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
  const junk = /^(menu|search|log ?in|login|register|contact us|share this|cookie|©|copyright|back to top|read more|find out more|learn more|get a quote|buy now|home|products|about us)\b/i;
  const out: string[] = [];
  let prev = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < MIN_LINE || junk.test(line) || line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out;
}

function chunk(lines: string[]): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > CHUNK_MAX) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur} ${l}` : l;
    if (cur.length >= CHUNK_TARGET) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur.length >= MIN_LINE) chunks.push(cur);
  return chunks.slice(0, MAX_CHUNKS_PER_PAGE);
}

const slug = (url: string) => (url.split("/").filter(Boolean).pop() ?? "page").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

type Clause = { id: string; source: string; text: string };

async function main() {
  const clauses: Clause[] = [];
  const area: Record<string, string> = {};

  for (const p of PAGES) {
    process.stdout.write(`\n${p.doc}\n  ${p.url}\n`);
    let html: string;
    try {
      const res = await fetch(p.url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; PRUAssist-ingest/1.0)", Accept: "text/html" },
        redirect: "follow",
      });
      if (!res.ok) {
        console.error(`  HTTP ${res.status} — skipped`);
        continue;
      }
      html = await res.text();
    } catch (e) {
      console.error(`  fetch failed — skipped: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const pieces = chunk(htmlToLines(html));
    if (!pieces.length) {
      console.error("  no readable content extracted — skipped");
      continue;
    }
    pieces.forEach((text, i) => {
      clauses.push({ id: `web-${slug(p.url)}-${i + 1}`, source: `${p.doc} · ${p.url}`, text });
    });
    area[p.doc] = p.area;
    console.log(`  ${pieces.length} clauses · area "${p.area}"`);
  }

  const header =
    "// GENERATED by scripts/ingest-web.mts — do not edit by hand. Re-run: npm run ingest:web\n" +
    "//\n" +
    "// Product information ingested from prudential.com.sg, as retrievable clauses. Kept separate from\n" +
    "// the hand-authored brochure clauses so the source is always visible: these carry a \"(web)\" document\n" +
    "// and cite the page URL, and the comprehension spine (concepts, the suitability figures) stays\n" +
    "// anchored to the brochure, never to a marketing page.\n" +
    'import type { Clause } from "./knowledge";\n\n';
  const body =
    `export const WEB_KNOWLEDGE: Clause[] = ${JSON.stringify(clauses, null, 2)};\n\n` +
    "// Web document → product area, so retrieval scopes these the same way brochure clauses are scoped.\n" +
    `export const WEB_DOCUMENT_AREA: Record<string, string> = ${JSON.stringify(area, null, 2)};\n`;

  writeFileSync(OUT, header + body);
  console.log(`\nWrote ${clauses.length} clauses from ${Object.keys(area).length} page(s) to src/lib/web-knowledge.ts`);
}

main();
