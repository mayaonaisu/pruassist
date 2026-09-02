// The brochure documents the sharing-mode whiteboard can render, and a locator that turns a clause's
// `source` string into something the board can act on. The clause `source` format is load-bearing
// (see knowledge.ts): "<doc> · p.2, p.12, p.17" for a brochure page citation, "<doc> · https://…"
// for a web-sourced clause. This is a pure module — no fetch, no fs — so it is unit-tested offline.

// A committed brochure PDF the board can render. `doc` matches the DOCUMENT_AREA / clause-source key
// exactly, so a citation string resolves straight to the file. `file` is the public URL the browser
// fetches; the committed asset lives at `public${file}`.
export type DocumentRef = { doc: string; slug: string; kind: "pdf"; file: string; url: string; edition?: string };

// The five brochures, downloaded into public/docs/ at build time. Doc names are identical to the
// DOCUMENT_AREA keys in knowledge.ts so a clause source resolves without a rename table.
export const DOCUMENTS: DocumentRef[] = [
  {
    doc: "PRUShield Product Brochure (Apr 2026)",
    slug: "prushield-apr-2026",
    kind: "pdf",
    file: "/docs/prushield-apr-2026.pdf",
    url: "https://www.prudential.com.sg/-/media/project/prudential/pdf/ebrochures/prushield/prushield-ebrochure-english.pdf",
    edition: "April 2026",
  },
  {
    doc: "PRUActive Protect Brochure",
    slug: "pruactive-protect",
    kind: "pdf",
    file: "/docs/pruactive-protect.pdf",
    url: "https://www.prudential.com.sg/-/media/project/prudential/pdf/ebrochures/pruactive-protect/pruactive-protect-brochure-en.pdf",
  },
  {
    doc: "PRUPersonal Accident Brochure",
    slug: "prupersonal-accident",
    kind: "pdf",
    file: "/docs/prupersonal-accident.pdf",
    url: "https://www.prudential.com.sg/-/media/project/prudential/pdf/ebrochures/prupersonal-accident/prupersonal-accident-ebrochure-english.pdf",
  },
  {
    doc: "PRUActive Term Brochure",
    slug: "pruactive-term",
    kind: "pdf",
    file: "/docs/pruactive-term.pdf",
    url: "https://www.prudential.com.sg/-/media/project/prudential/pdf/ebrochures/pruactive-term/pruactive_term_ebrochure_english.pdf",
  },
  {
    doc: "PRUActive Retirement II Brochure",
    slug: "pruactive-retirement-ii",
    kind: "pdf",
    file: "/docs/pruactive-retirement-ii.pdf",
    url: "https://www.prudential.com.sg/-/media/project/prudential/pdf/ebrochures/pruactive-retirement-ii/pruactive-retirement-ii_ebrochure_eng_ad.pdf",
  },
];

// Where a clause's `source` string points. A brochure page citation is `pdf` with the file to render
// and the pages to open; a prudential.com.sg clause is `web` (the site cannot be iframed — an excerpt
// card links out instead); a custom knowledge-base clause is `unknown` — its pages are still parsed so
// the board can label them, but there is no PDF to render.
export type SourceLocation = { doc: string; kind: "pdf" | "web" | "unknown"; file?: string; url?: string; pages: number[] };

export function documentFor(doc: string): DocumentRef | undefined {
  return DOCUMENTS.find((d) => d.doc === doc);
}

// Unique, ascending page numbers harvested from a `p.N` citation tail — the same regex knowledge.ts
// and groupCitations use, so a string either produces round-trips through this locator.
function pagesIn(text: string): number[] {
  const nums = [...text.matchAll(/p\.(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function locateSource(source: string): SourceLocation {
  const sep = source.indexOf(" · ");
  const doc = (sep >= 0 ? source.slice(0, sep) : source).trim();
  const tail = sep >= 0 ? source.slice(sep + 3).trim() : "";

  // A web-sourced clause cites a URL rather than pages.
  if (tail.startsWith("http")) return { doc, kind: "web", url: tail, pages: [] };

  const pages = pagesIn(tail);
  const ref = documentFor(doc);
  if (ref) return { doc, kind: "pdf", file: ref.file, url: ref.url, pages };
  return { doc, kind: "unknown", pages };
}
