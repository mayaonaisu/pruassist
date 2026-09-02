import { clausesFor, conceptById, conceptsForArea } from "./concepts";
import { clauseById, KNOWLEDGE } from "./knowledge";
import { locateSource } from "./documents";
import type { Alert, ConceptState, RecordRow } from "./agent/types";
import type { Readiness } from "./agent/readiness";

// The customer-facing whiteboard's state, kept pure so it can be unit-tested and so the projection
// that decides what the customer sees is provably narrow.
//
// GROUNDING CONSTRAINT (see the brief §2 and CONTEXT.md): the board may only ever show a concept's
// `label` and `canonical`, a clause's `text`, and the rendered PDF page (with document name and page
// numbers). It must NEVER show a suggested line, an explainer, alert copy, a teach-back, a
// misconception, a `terms`/`qualifiers` list, a customer quote, or a ledger state. The card types
// below deliberately have no field for any of those, and `conceptCard` copies only the safe ones —
// a leak test in scripts/checks.mts proves the projection stays narrow.

// What the board is currently showing.
export type BoardFocus =
  | { kind: "idle" }
  | { kind: "concept"; conceptId: string }
  | { kind: "source"; source: string; clauseId?: string; snippet?: string };

// The slice of the agent view the auto-follow logic diffs between polls. A structural subset of
// AgentView, so a real view can be passed straight in.
export type AgentSlice = { alert: Alert | null; record: RecordRow[]; readiness: Readiness | null };

// A fingerprint of the last poll, so the board follows genuine changes rather than flapping on every
// identical poll.
export type BoardSnapshot = { alertAt: number; rows: Record<string, { state: ConceptState; at: number }> };

export type BoardState = { focus: BoardFocus; pinned: boolean; snap: BoardSnapshot | null };

export type BoardEvent =
  | { type: "agent"; agent: AgentSlice } // a fresh poll — follow it unless pinned
  | { type: "pick"; focus: BoardFocus } // the rep tapped a chip or a citation → pin it
  | { type: "follow" } // "Follow conversation" — unpin and re-derive from scratch
  | { type: "reset" }; // leaving sharing mode

// The customer-safe card for a concept. No misconceptions, teach-back, terms or qualifiers — by type.
export type ConceptCard = {
  id: string;
  label: string;
  canonical: string;
  excerpts: { clauseId: string; text: string; doc: string; pages: number[] }[];
  pages: { file: string; page: number }[];
  highlights: string[];
};

// The customer-safe card for a raw source string (a tapped citation), which may resolve to a brochure
// page, a web page (linked out), or a custom clause (excerpt only).
export type SourceCard = {
  doc: string;
  kind: "pdf" | "web" | "unknown";
  file?: string;
  url?: string;
  pages: number[];
  excerpts: { clauseId?: string; text: string }[];
  highlights: string[];
};

// The S$ figures worth highlighting on the page. Deliberately the whole-dollar policy figures
// (S$1,500, S$3,500, S$ 6,000) — three or more digits — not counts or years.
export function figuresIn(texts: string[]): string[] {
  const out = new Set<string>();
  // The class [\d,] also swallows a trailing sentence comma ("…S$3,500, the…"); trim it so the
  // figure is clean. PdfPage compares digits only, so this is cosmetic there but matters on the card.
  for (const t of texts) for (const m of t.matchAll(/S\$\s?\d[\d,]{2,}/g)) out.add(m[0].replace(/,+$/, ""));
  return [...out];
}

// The concept's clause text, laid out as customer-safe excerpts with their brochure page locations.
export function conceptCard(conceptId: string): ConceptCard | null {
  const concept = conceptById(conceptId);
  if (!concept) return null;

  const excerpts = clausesFor(concept).map((c) => {
    const loc = locateSource(c.source);
    return { clauseId: c.id, text: c.text, doc: loc.doc, pages: loc.pages };
  });

  // Page locations to render, in clause order, de-duplicated. The first is the default page (the
  // first page of the concept's first clause).
  const pages: { file: string; page: number }[] = [];
  const seen = new Set<string>();
  for (const c of clausesFor(concept)) {
    const loc = locateSource(c.source);
    if (loc.kind !== "pdf" || !loc.file) continue;
    for (const page of loc.pages) {
      const key = `${loc.file}#${page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push({ file: loc.file, page });
    }
  }

  return {
    id: concept.id,
    label: concept.label,
    canonical: concept.canonical,
    excerpts,
    pages,
    highlights: figuresIn(excerpts.map((e) => e.text)),
  };
}

// Resolve a tapped citation to a customer-safe card. Prefer the exact clause (by id); otherwise the
// clauses on the same document whose pages intersect the citation; otherwise the snippet alone.
export function sourceCard(focus: Extract<BoardFocus, { kind: "source" }>): SourceCard {
  const loc = locateSource(focus.source);
  const base = { doc: loc.doc, kind: loc.kind, file: loc.file, url: loc.url, pages: loc.pages };

  // 1. An explicit clause id is the exact match.
  const byId = focus.clauseId ? clauseById(focus.clauseId) : undefined;
  if (byId) {
    const excerpts = [{ clauseId: byId.id, text: byId.text }];
    return { ...base, excerpts, highlights: figuresIn([byId.text]) };
  }

  // 2. No id (a stale lookahead answer): the clauses on this document whose pages overlap the citation.
  if (loc.pages.length) {
    const excerpts = KNOWLEDGE.filter((c) => {
      if (c.source.split(" · ")[0] !== loc.doc) return false;
      return locateSource(c.source).pages.some((p) => loc.pages.includes(p));
    }).map((c) => ({ clauseId: c.id, text: c.text }));
    if (excerpts.length) return { ...base, excerpts, highlights: figuresIn(excerpts.map((e) => e.text)) };
  }

  // 3. Nothing to anchor to: show the snippet the rep tapped, if any.
  const excerpts = focus.snippet ? [{ text: focus.snippet }] : [];
  return { ...base, excerpts, highlights: figuresIn(excerpts.map((e) => e.text)) };
}

// The concepts the conversation has actually touched, for the board's chip row. `active` marks the
// one the board would auto-follow (the alert's concept, else the one most worth asking) so the UI can
// weight it — never a ledger state, never a colour that would encode "misunderstood" to the customer.
export function conceptsInPlay(agent: AgentSlice, productArea: string): { conceptId: string; label: string; active: boolean }[] {
  const inPlay = new Set((agent.record ?? []).filter((r) => r.state !== "unseen").map((r) => r.conceptId));
  const active = agent.alert?.conceptId ?? agent.readiness?.nextConceptId ?? null;
  return conceptsForArea(productArea)
    .filter((c) => inPlay.has(c.id))
    .map((c) => ({ conceptId: c.id, label: c.label, active: c.id === active }));
}

// The auto-follow rule: what the board should show next, given a fresh poll and the previous poll's
// fingerprint. Returns a null focus when nothing changed (the board keeps its current focus) plus the
// new fingerprint to store. Applied only when the board is not pinned. The rules run in order, first
// match wins, so the board follows one clear signal and never flaps:
//   1. a genuinely new alert (its `at` is past the previous poll's) → the alerted concept;
//   2. else the record row that moved since the previous poll (latest `at`, not `unseen`);
//   3. else, only on the very first snapshot, readiness.nextConceptId if it has been raised;
//   4. else null — keep the current focus.
// Rules 1 and 2 are between-poll deltas, so they need a previous snapshot; the very first snapshot
// (no previous poll to diff) is seeded by rule 3 alone.
export function autoFocus(agent: AgentSlice, prev: BoardSnapshot | null): { focus: BoardFocus | null; snap: BoardSnapshot } {
  const rows: BoardSnapshot["rows"] = {};
  for (const r of agent.record ?? []) rows[r.conceptId] = { state: r.state, at: r.at ?? 0 };
  const snap: BoardSnapshot = { alertAt: agent.alert?.at ?? 0, rows };

  const focus = ((): BoardFocus | null => {
    // 1. a new alert
    if (prev && agent.alert && agent.alert.at > prev.alertAt) {
      return { kind: "concept", conceptId: agent.alert.conceptId };
    }
    // 2. the most-recent record row that moved since the previous poll
    if (prev) {
      const changed = (agent.record ?? []).filter((r) => {
        if (r.state === "unseen") return false;
        const before = prev.rows[r.conceptId];
        return !before || before.state !== r.state || before.at !== (r.at ?? 0);
      });
      if (changed.length) {
        const latest = changed.reduce((a, b) => ((b.at ?? 0) >= (a.at ?? 0) ? b : a));
        return { kind: "concept", conceptId: latest.conceptId };
      }
    }
    // 3. first snapshot only: seed from what is most worth asking about
    if (!prev) {
      const next = agent.readiness?.nextConceptId;
      const standing = next ? agent.readiness?.standing.find((s) => s.conceptId === next) : undefined;
      if (next && standing && standing.state !== "unseen") return { kind: "concept", conceptId: next };
    }
    // 4. nothing to follow
    return null;
  })();

  return { focus, snap };
}

const IDLE: BoardState = { focus: { kind: "idle" }, pinned: false, snap: null };

// The board's starting state, held by InPersonConsole so a citation pick can land before the whiteboard
// mounts.
export const initialBoardState: BoardState = IDLE;

// The board's state transitions. `pick` pins (the rep chose it explicitly); `follow` unpins and
// forgets the fingerprint so the next poll re-derives from scratch; `agent` auto-follows unless
// pinned; `reset` returns to idle when sharing mode is left.
export function reduceBoard(state: BoardState, ev: BoardEvent): BoardState {
  switch (ev.type) {
    case "pick":
      return { focus: ev.focus, pinned: true, snap: state.snap };
    case "follow":
      return { focus: state.focus, pinned: false, snap: null };
    case "reset":
      return { ...IDLE };
    case "agent": {
      if (state.pinned) return state; // a pinned board ignores the poll
      const { focus, snap } = autoFocus(ev.agent, state.snap);
      return { focus: focus ?? state.focus, pinned: false, snap };
    }
  }
}
