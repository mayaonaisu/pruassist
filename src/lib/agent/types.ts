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
  evidence: Evidence[];
  reAsks: number;
};

// What the rep is shown mid-call. One at a time, highest risk first — a second alert competing
// for attention during a live conversation is worse than no alert.
export type AlertKind = "false-assent" | "misunderstood" | "divergence" | "re-ask";

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
