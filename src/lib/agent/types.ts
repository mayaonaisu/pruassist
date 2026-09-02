// Shared shapes for the comprehension record. Kept in one file because the client, the API
// routes and the replay harness all read them, and a drift between them would be silent.

export type Role = "rep" | "customer";

// One finalised transcript line. `at` is when the browser finalised it, not when the speaker
// started — every latency figure derived from it is therefore an approximation.
export type Turn = { at: number; role: Role; speaker: string; text: string };

// asserted and demonstrated are deliberately different states. The gap between them is the
// whole point: "the rep said it and the customer agreed" is not evidence of understanding.
export type ConceptState =
  | "unseen" // never came up
  | "raised" // the rep introduced it
  | "asserted" // the customer signalled assent — not understanding
  | "demonstrated" // the customer used it correctly in their own words
  | "misunderstood"; // the customer used it incorrectly

export type SignalKind = "uptake" | "assent" | "divergence" | "re-ask" | "explain-back" | "latency";

// What one detector observed about one turn. A detector never decides a state on its own; it
// argues for one, and the ledger applies precedence. `argues: null` is evidence only.
//
// This is the currency of the whole signal system — the detectors mint it, the grader mints it,
// the ledger folds it — so it lives here with the other shared shapes rather than inside any one
// of them.
export type Detection = {
  conceptId: string;
  kind: SignalKind;
  argues: "raised" | "asserted" | "demonstrated" | "misunderstood" | null;
  // Whose words these are. Carried from the turn the detector was looking at, never derived —
  // the record quotes the customer, and a rep's sentence attributed to them would be a lie in the
  // one artifact where that matters.
  role: Role;
  turnIndex: number;
  at: number;
  quote: string;
  detail: string;
  score: number;
};

// The customer's own words, normalised and clipped. Never the raw transcript: the record is
// built from concept-tied fragments only, which is what the consent copy promises.
export type Evidence = {
  at: number;
  role: Role;
  quote: string;
  signal: SignalKind;
  detail?: string; // what the detector actually observed, for the rep to judge
  score?: number; // detector confidence, 0..1
};

export type ConceptEntry = {
  id: string;
  state: ConceptState;
  raisedAt?: number;
  assertedAt?: number;
  demonstratedAt?: number;
  misunderstoodAt?: number;
  teachBackAskedAt?: number;
  // The answer to a teach-back is graded once. Without this the same reply would be re-graded on
  // every pass, spending a model call each time to reach the same verdict.
  explainBackGradedAt?: number;
  evidence: Evidence[];
  reAsks: number;
};

// The six fields the live console renders. Produced identically by the live path and by the
// lookahead, so a cached answer is indistinguishable from a fresh one to the UI.
export type Pointers = {
  concern: string;
  firstStep: string;
  suggestedLine: string;
  explainer: string;
  comparison: string;
  followUp: string;
};

// `id` is the clause id (Clause.id), carried so the sharing-mode board can resolve a cited snippet
// back to its full clause and page. Lookahead answers cached in Redis before this field shipped have
// no id on the wire; the client type keeps it optional and falls back to a page-intersection match.
export type Source = { id: string; source: string; snippet: string };

// A pre-computed, grounding-verified answer to the question this customer is most likely to ask
// next. Served instantly on a match, which is a real latency win rather than a gesture.
export type Lookahead = {
  conceptId: string;
  label: string;
  question: string; // the expected question, in the customer's likely words
  pointers: Pointers;
  sources: Source[];
  citations: string[];
  toolCalls: string[]; // what the tool loop actually did, for the console's provenance line
  verified: boolean;
  preparedAt: number;
  rev: number; // the ledger revision it was prepared against
};

// What the rep is shown mid-call. One at a time, highest risk first — a second alert competing
// for attention during a live conversation is worse than no alert.
export type AlertKind = "false-assent" | "misunderstood" | "divergence" | "re-ask" | "explain-back";

export type Alert = {
  kind: AlertKind;
  conceptId: string;
  label: string;
  headline: string;
  detail: string;
  teachBack: string;
  citations: string[];
  quote: string;
  at: number;
};

// Rep actions, appended to their own key so they never race the deep pass's writes.
export type RepAct =
  | { type: "teach-back-asked"; conceptId: string; at: number }
  | { type: "dismiss"; conceptId: string; at: number };

export type AgentState = {
  roomId: string;
  productArea: string;
  rev: number; // bumped on every write so the client can poll cheaply
  updatedAt: number;
  // Timestamp of the last turn folded in, not an index: the client's transcript window slides,
  // and an index would silently re-process or skip turns once it does.
  cursorAt: number;
  concepts: Record<string, ConceptEntry>;
  alert: Alert | null;
  dismissed: string[]; // concept ids the rep has waved off; no alert re-fires for them
  degraded: boolean; // true when embeddings were unavailable and detection ran on keywords
  lookahead: Lookahead | null;
  // When preparation was last attempted, successful or not. Without it a run that keeps returning
  // null (nothing worth preparing, or an answer that failed verification) would retry every pass.
  lookaheadTriedAt: number;
  // Background model calls spent on this session, against MAX_BACKGROUND_CALLS. Grading and
  // lookahead stop when it runs out; the deterministic detectors carry on.
  backgroundCalls: number;
};

export function emptyState(roomId: string, productArea: string): AgentState {
  return {
    roomId,
    productArea,
    rev: 0,
    updatedAt: 0,
    cursorAt: 0,
    concepts: {},
    alert: null,
    dismissed: [],
    degraded: false,
    lookahead: null,
    lookaheadTriedAt: 0,
    backgroundCalls: 0,
  };
}

// One row of the Understanding Record — what the artifact renders and what the rep signs.
export type RecordRow = {
  conceptId: string;
  label: string;
  state: ConceptState;
  at?: number;
  quote: string;
  citations: string[];
  risk: string; // "" when the concept is settled
};
