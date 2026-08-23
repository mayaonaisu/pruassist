import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { isBareAssent } from "../utterance";
import { classify } from "./brain";
import {
  handleClarification,
  handleComparison,
  handleGuider,
  handleKeepListening,
  handlePolicyGuidance,
  handleTopicDrift,
} from "./handlers";
import { decideMode } from "./modes";
import type { Mode, OrchestratorInput, OrchestratorResult } from "./types";

// The orchestrator as a LangGraph StateGraph: one scopeCheck node (the brain) decides the mode,
// conditional edges route to one handler node per mode, each ends. The decision logic and the
// handlers are plain functions the nodes call, so they stay unit-testable and the graph is just
// the wiring.

const S = Annotation.Root({
  input: Annotation<OrchestratorInput>,
  mode: Annotation<Mode>,
  result: Annotation<OrchestratorResult | null>,
});

const HANDLERS: Record<Mode, (i: OrchestratorInput) => OrchestratorResult | Promise<OrchestratorResult>> = {
  keep_listening: handleKeepListening,
  policy_guidance: handlePolicyGuidance,
  comparison: handleComparison,
  guider: handleGuider,
  topic_drift: handleTopicDrift,
  clarification: handleClarification,
};

// scopeCheck = the brain. Wake-gate (never spend a brain call on a bare ack) → LLM tier 1 →
// deterministic tier 2.
async function scopeCheck(state: typeof S.State): Promise<Partial<typeof S.State>> {
  const input = state.input;
  const text = input.clarifyContext ? `${input.clarifyContext}\n${input.asked}` : input.asked;
  if (isBareAssent(text)) return { mode: "keep_listening" };
  const brain = await classify(input);
  return { mode: brain?.mode ?? decideMode(input).mode };
}

function dispatch(mode: Mode) {
  return async (state: typeof S.State): Promise<Partial<typeof S.State>> => ({
    result: await HANDLERS[mode](state.input),
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
