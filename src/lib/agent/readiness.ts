import { citationsFor, conceptById } from "../concepts";
import { decisionsForArea, type Decision } from "../decisions";
import type { AgentState, ConceptState } from "./types";

// What the ledger says about a decision the representative is working through.
//
// Pure: a projection of AgentState, no store and no model. That is deliberate — whether a
// recommendation is safe to make is not a judgement anyone should want an LLM to reach.

export type Standing = {
  conceptId: string;
  label: string;
  state: ConceptState;
  role: "prerequisite" | "differentiator";
  citations: string[];
  teachBack: string;
};

export type Readiness = {
  decisionId: string;
  question: string;
  options: { id: string; label: string; gist: string }[];
  standing: Standing[];
  settled: number; // differentiators demonstrated
  total: number; // differentiators in play
  blocking: Standing[]; // misunderstood — correct these first
  open: Standing[]; // anything else not yet demonstrated
  ready: boolean;
  nextQuestion: string | null;
  nextConceptId: string | null;
};

// What to ask about next. A misconception outranks everything, because leaving it uncorrected
// means the rest of the comparison is being weighed against something untrue. Then agreement
// without evidence, then a concept never raised, then one explained with no response.
const URGENCY: Record<ConceptState, number> = {
  misunderstood: 4,
  asserted: 3,
  unseen: 2,
  raised: 1,
  demonstrated: 0,
};

function rank(s: Standing): number {
  // Differentiators break ties: they are where the options actually differ.
  return URGENCY[s.state] * 2 + (s.role === "differentiator" ? 1 : 0);
}

function standingFor(state: AgentState, conceptId: string, role: Standing["role"]): Standing | null {
  const concept = conceptById(conceptId);
  if (!concept) return null;
  return {
    conceptId,
    label: concept.label,
    state: state.concepts[conceptId]?.state ?? "unseen",
    role,
    citations: citationsFor(concept),
    teachBack: concept.teachBack,
  };
}

export function readinessFor(decision: Decision, state: AgentState): Readiness {
  const standing: Standing[] = [
    ...decision.prerequisites.map((id) => standingFor(state, id, "prerequisite")),
    ...decision.differentiators.map((id) => standingFor(state, id, "differentiator")),
  ].filter((s): s is Standing => s !== null);

  const differentiators = standing.filter((s) => s.role === "differentiator");
  const blocking = standing.filter((s) => s.state === "misunderstood");
  const open = standing.filter((s) => s.state !== "demonstrated" && s.state !== "misunderstood");

  // Prerequisites do not gate. Requiring four demonstrations before a comparison becomes usable
  // makes the mechanism unreachable in a real conversation, and a differentiator is where the
  // money differs. Unsettled prerequisites still surface, and can still be the next question.
  const ready = blocking.length === 0 && differentiators.every((s) => s.state === "demonstrated");

  const next = [...blocking, ...open].sort((a, b) => rank(b) - rank(a))[0] ?? null;

  return {
    decisionId: decision.id,
    question: decision.question,
    options: decision.options.map((o) => ({ id: o.id, label: o.label, gist: o.gist })),
    standing,
    settled: differentiators.filter((s) => s.state === "demonstrated").length,
    total: differentiators.length,
    blocking,
    open,
    ready,
    nextQuestion: next?.teachBack ?? null,
    nextConceptId: next?.conceptId ?? null,
  };
}

/**
 * Which decision the conversation is actually about, by how much of its ledger has moved.
 * Deterministic rather than model-chosen: this only decides what to show, and a wrong guess should
 * be cheap and explicable.
 */
export function activeDecision(state: AgentState): Decision | null {
  let best: { decision: Decision; score: number } | null = null;

  for (const decision of decisionsForArea(state.productArea)) {
    const touched = (ids: string[]) => ids.filter((id) => (state.concepts[id]?.state ?? "unseen") !== "unseen").length;
    // Differentiators weigh double: a customer discussing what separates the options is choosing
    // between them, where one discussing the vocabulary may not be there yet.
    const score = touched(decision.differentiators) * 2 + touched(decision.prerequisites);
    if (score > 0 && (!best || score > best.score)) best = { decision, score };
  }

  return best?.decision ?? null;
}
