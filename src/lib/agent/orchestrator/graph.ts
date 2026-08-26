import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Hit } from "../../retrieval";
import { isBareAssent } from "../utterance";
import { classify } from "./brain";
import {
  agenticLiveEnabled,
  handleClarification,
  handleComparison,
  handleGuider,
  handleKeepListening,
  handlePolicyGuidance,
  handleTopicDrift,
} from "./handlers";
import { decideMode, looksOffScope } from "./modes";
import type { Mode, OrchestratorInput, OrchestratorResult } from "./types";

// The orchestrator as a LangGraph StateGraph: scopeCheck decides the mode (running the brain and
// a speculative gather in parallel), conditional edges route to the matching handler, each ends.
// The generating handlers (policy_guidance, comparison) contain a bounded evaluator-optimizer
// subgraph (generation.ts) that retries on ungrounded figures.

const GENERATING: Set<Mode> = new Set(["policy_guidance", "comparison", "guider"]);

const S = Annotation.Root({
  input: Annotation<OrchestratorInput>,
  mode: Annotation<Mode>,
  speculativeHits: Annotation<Hit[] | null>,
  result: Annotation<OrchestratorResult | null>,
});

type Handler = (i: OrchestratorInput, preGathered?: Hit[]) => OrchestratorResult | Promise<OrchestratorResult>;
const HANDLERS: Record<Mode, Handler> = {
  keep_listening: handleKeepListening,
  policy_guidance: handlePolicyGuidance,
  comparison: handleComparison,
  guider: handleGuider,
  topic_drift: handleTopicDrift,
  clarification: handleClarification,
};

// scopeCheck runs the brain and a speculative clause gather in parallel. The brain takes 1-4s;
// gathering takes 1-3s. Running them concurrently cuts the serial waterfall. If the brain picks a
// non-generating mode, the speculative hits are discarded — no behavior change, just wasted work.
async function scopeCheck(state: typeof S.State): Promise<Partial<typeof S.State>> {
  const input = state.input;
  if (input.presetMode) return { mode: input.presetMode, speculativeHits: null };
  const text = input.clarifyContext ? `${input.clarifyContext}\n${input.asked}` : input.asked;
  if (isBareAssent(text)) return { mode: "keep_listening", speculativeHits: null };

  // Fire the brain and a speculative gather concurrently. Import gatherClauses lazily to avoid a
  // circular dep (handlers imports generation which is compiled at module level).
  const { gatherClauses } = await import("./handlers");
  const [brain, hits] = await Promise.all([
    classify(input),
    agenticLiveEnabled() ? gatherClauses(input).catch(() => [] as Hit[]) : Promise.resolve([] as Hit[]),
  ]);

  let mode = brain?.mode ?? decideMode(input).mode;
  if (mode !== "topic_drift" && looksOffScope(input)) mode = "topic_drift";

  return {
    mode,
    speculativeHits: GENERATING.has(mode) && hits.length > 0 ? hits : null,
  };
}

function dispatch(mode: Mode) {
  return async (state: typeof S.State): Promise<Partial<typeof S.State>> => ({
    result: await HANDLERS[mode](state.input, state.speculativeHits ?? undefined),
  });
}

const compiled = new StateGraph(S)
  .addNode("scopeCheck", scopeCheck)
  .addNode("keep_listening", dispatch("keep_listening"))
  .addNode("policy_guidance", dispatch("policy_guidance"))
  .addNode("comparison", dispatch("comparison"))
  .addNode("guider", dispatch("guider"))
  .addNode("topic_drift", dispatch("topic_drift"))
  .addNode("clarification", dispatch("clarification"))
  .addEdge(START, "scopeCheck")
  .addConditionalEdges("scopeCheck", (s: typeof S.State) => s.mode, {
    keep_listening: "keep_listening",
    policy_guidance: "policy_guidance",
    comparison: "comparison",
    guider: "guider",
    topic_drift: "topic_drift",
    clarification: "clarification",
  })
  .addEdge("keep_listening", END)
  .addEdge("policy_guidance", END)
  .addEdge("comparison", END)
  .addEdge("guider", END)
  .addEdge("topic_drift", END)
  .addEdge("clarification", END)
  .compile();

/** Run the orchestrator to completion and return the chosen node's result. */
export async function runOrchestrator(input: OrchestratorInput): Promise<OrchestratorResult> {
  const out = await compiled.invoke({ input });
  return out.result ?? { mode: "keep_listening" };
}
