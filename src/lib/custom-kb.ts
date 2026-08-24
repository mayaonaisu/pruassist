import type { Clause } from "./knowledge";
import { getStore } from "./store";
import { chunkLines, htmlToLines, textToLines, toClauses } from "./ingest";

// The rep-managed knowledge base: sources a representative adds at runtime (a pasted note or a link)
// so the team can keep the assistant current when the built-in brochure/website content is out of
// date. Shared across all reps and persisted in the same store as sessions, so it survives deploys.
//
// These clauses flow through the SAME retrieval + grounding + citation path as everything else, but
// they are tagged "(added)" and cite their label/URL, and — like the website clauses — they never
// anchor a concept: the suitability spine stays on the authoritative brochure.

const KEY = "kb:custom";
// Effectively permanent: rep knowledge is not session state and must not quietly expire.
const TTL = 60 * 60 * 24 * 3650;

export type CustomSource = {
  id: string;
  kind: "link" | "text";
  label: string;
  url?: string;
  area: string;
  addedAt: number;
  clauses: Clause[];
};

export async function listSources(): Promise<CustomSource[]> {
  return (await getStore().get<CustomSource[]>(KEY)) ?? [];
}

async function save(sources: CustomSource[]): Promise<void> {
  await getStore().set(KEY, sources, TTL);
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function addTextSource(input: { label: string; area: string; text: string }): Promise<CustomSource> {
  const id = newId();
  const label = input.label.trim() || "Added note";
  // A pasted note is not web chrome, so keep short facts (minLine 1) rather than filtering them out.
  const chunks = chunkLines(textToLines(input.text), { minLine: 1 });
  const source: CustomSource = {
    id,
    kind: "text",
    label,
    area: input.area,
    addedAt: Date.now(),
    clauses: toClauses(chunks, { doc: `${label} (added)`, idPrefix: `custom-${id}` }),
  };
  await save([source, ...(await listSources())]);
  return source;
}

export async function addLinkSource(input: { url: string; area: string; label?: string }): Promise<CustomSource> {
  const res = await fetch(input.url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PRUAssist-ingest/1.0)", Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Couldn’t fetch that link (HTTP ${res.status}).`);
  const chunks = chunkLines(htmlToLines(await res.text()), { minLine: 40 });
  if (!chunks.length) throw new Error("No readable content was found at that link.");
  const id = newId();
  const label = input.label?.trim() || new URL(input.url).hostname.replace(/^www\./, "");
  const source: CustomSource = {
    id,
    kind: "link",
    label,
    url: input.url,
    area: input.area,
    addedAt: Date.now(),
    clauses: toClauses(chunks, { doc: `${label} (added)`, url: input.url, idPrefix: `custom-${id}` }),
  };
  await save([source, ...(await listSources())]);
  return source;
}

export async function removeSource(id: string): Promise<void> {
  await save((await listSources()).filter((s) => s.id !== id));
}

// The clauses to merge into retrieval, scoped to a product area the same way the static corpus is.
export async function customClauses(area?: string): Promise<Clause[]> {
  const sources = await listSources();
  const scoped = area ? sources.filter((s) => s.area === area) : sources;
  return scoped.flatMap((s) => s.clauses);
}
