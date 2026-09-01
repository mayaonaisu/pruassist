import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Hit } from "../../retrieval";
import type { OrchestratorInput, Pointers } from "./types";

const MAX_ATTEMPTS = 2;

export function shouldRetry(unsupported: string[], attempt: number): boolean {
  return unsupported.length > 0 && attempt < MAX_ATTEMPTS;
}

// The generation subgraph: gather → generate → evaluate, with a bounded back-edge.
// When the deterministic grounding check finds unsupported figures, it routes back to gather
// with feedback so the model can search for clauses that actually support those figures (or omit
// them). Capped at MAX_ATTEMPTS so a live call never hangs; the worst case is today's behavior
// (figures labeled, returned as-is).

export const GenState = Annotation.Root({
  input: Annotation<OrchestratorInput>,
  instruction: Annotation<string>,
  hint: Annotation<string | undefined>,
  hits: Annotation<Hit[]>({ reducer: (_, b) => b, default: () => [] }),
  pointers: Annotation<Pointers | null>({ reducer: (_, b) => b, default: () => null }),
  unsupported: Annotation<string[]>({ reducer: (_, b) => b, default: () => [] }),
  attempt: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  // The gather and generate functions are injected so the subgraph stays testable without
  // hitting real LLM endpoints.
  gatherFn: Annotation<(input: OrchestratorInput, hint?: string) => Promise<Hit[]>>,
  generateFn: Annotation<(instruction: string, hits: Hit[], transcript: string) => Promise<{ pointers: Pointers; unsupportedFigures: string[] } | null>>,
});

async function gather(s: typeof GenState.State) {
  const feedback = s.unsupported.length
    ? ` The previous answer used figures not found in the clauses: ${s.unsupported.join(", ")}. Search for clauses that support them, or generate an answer that omits them.`
    : "";
  const hits = await s.gatherFn(s.input, (s.hint ?? "") + feedback);
  return { hits, attempt: s.attempt + 1 };
}

async function generate(s: typeof GenState.State) {
  const gen = await s.generateFn(s.instruction, s.hits, s.input.transcript);
  if (!gen) return { pointers: null, unsupported: [] as string[] };
  return { pointers: gen.pointers, unsupported: gen.unsupportedFigures };
}

function evaluate(s: typeof GenState.State): "gather" | "__end__" {
  return shouldRetry(s.unsupported, s.attempt) ? "gather" : "__end__";
}

const compiled = new StateGraph(GenState)
  .addNode("gather", gather)
  .addNode("generate", generate)
  .addEdge(START, "gather")
  .addEdge("gather", "generate")
  .addConditionalEdges("generate", evaluate, { gather: "gather", __end__: END })
  .compile();

export type GenerationResult = {
  pointers: Pointers | null;
  unsupported: string[];
  hits: Hit[];
  attempt: number;
};

export async function runGeneration(
  input: OrchestratorInput,
  instruction: string,
  gatherFn: (input: OrchestratorInput, hint?: string) => Promise<Hit[]>,
  generateFn: (instruction: string, hits: Hit[], transcript: string) => Promise<{ pointers: Pointers; unsupportedFigures: string[] } | null>,
  hint?: string,
): Promise<GenerationResult> {
  const out = await compiled.invoke({
    input,
    instruction,
    hint,
    gatherFn,
    generateFn,
  });
  return {
    pointers: out.pointers,
    unsupported: out.unsupported,
    hits: out.hits,
    attempt: out.attempt,
  };
}
