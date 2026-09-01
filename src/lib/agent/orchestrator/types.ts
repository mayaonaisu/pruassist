import type { AgentState } from "../types";

// The conversation modes the orchestrator routes between. The brain (LLM) or the deterministic
// fallback picks exactly one per substantive customer turn; LangGraph dispatches to the matching
// handler.
export type Mode =
  | "keep_listening" // nothing worth surfacing — do not interrupt the rep
  | "policy_guidance" // a policy question: retrieve clauses and answer it
  | "comparison" // weighing options: retrieve the decision's clauses, say what is unsettled
  | "guider" // a proactive advisory nudge; retrieves only when it cites policy facts
  | "topic_drift" // off the selected scope: warn once, then pause (see orchestrator/drift.ts)
  | "clarification"; // too vague to answer: ask the rep for context, then re-route

// The response-level mode the assist route can return, on top of the orchestrator's own modes.
// `drift_paused` is produced by the route (drift.ts), never by a handler or the brain, so it stays
// out of the Mode union that keys the handler map and the brain's allowlist.
export type AssistMode = Mode | "drift_paused";

// Everything the router and the handlers need about the turn being routed. Built by /api/assist
// from the request plus the already-loaded ledger.
export type OrchestratorInput = {
  asked: string; // the latest customer utterance to route
  transcript: string; // recent window, "<speaker>: <text>" lines, for the generation handlers
  state: AgentState; // the folded ledger for this room (source of the active decision)
  scope: string; // the session product area
  clarifyContext?: string; // rep-supplied context on a clarification re-ask
  presetMode?: Mode; // skip the router and dispatch straight to this mode (the drift-resume path
  // already spent a brain call deciding the mode, so the graph must not spend a second one)
};

export type ModeDecision = { mode: Mode; why: string };

// The six pointer fields the console renders — produced by the generating modes.
export type Pointers = {
  concern: string;
  firstStep: string;
  suggestedLine: string;
  explainer: string;
  comparison: string;
  followUp: string;
};

export type Source = { source: string; snippet: string };

// What a node hands back. One shape with optional fields so the route can map it uniformly:
// generating modes fill `pointers`/`sources`/`unsupportedFigures`; the lighter modes fill `note`,
// `drift`, or `clarify`.
export type OrchestratorResult = {
  mode: Mode;
  pointers?: Pointers;
  sources?: Source[];
  unsupportedFigures?: string[];
  comparing?: boolean;
  note?: string; // no clause, or the model was unavailable
  drift?: { message: string };
  clarify?: { question: string; prompt: string };
};
