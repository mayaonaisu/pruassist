import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { getByRoom } from "@/lib/sessions";
import { loadState } from "@/lib/agent/ledger";
import { matchesLookahead } from "@/lib/agent/cache";
import { runOrchestrator } from "@/lib/agent/orchestrator/graph";
import { emptyState } from "@/lib/agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The orchestrator can stack a brain call, retrieval, and a generation on a cache miss, which can
// exceed Vercel's default 10s function limit. Give the live path headroom so serverless does not
// kill a slow-but-valid answer; a cache hit still returns in well under a second.
export const maxDuration = 30;

// The live path, and the front door of the orchestrator. The cache short-circuit stays first (a
// prepared answer costs no model call); on a miss the LangGraph orchestrator decides the mode and
// routes. Comprehension tracking still lives behind /api/agent/state, untouched.

export async function POST(req: NextRequest) {
  // Rep-only: this route can spend billed model calls.
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { transcript, roomId, asked, clarifyContext } = body ?? {};
  if (!transcript || typeof transcript !== "string") {
    return NextResponse.json({ error: "Missing 'transcript'." }, { status: 400 });
  }

  // roomId is optional on purpose: a tab left open from an earlier session must not start failing
  // mid-demo. Without it there is no product area and no prepared answer.
  const session = typeof roomId === "string" && roomId ? await getByRoom(roomId) : null;
  const productArea = session?.context.productArea;
  const state = session ? await loadState(roomId, session.context.productArea) : null;

  // 0) CACHE — did the background pass already prepare, and verify, the answer to this question?
  if (state) {
    const question = typeof asked === "string" && asked.trim() ? asked : (transcript.split("\n").slice(-1)[0] ?? "");
    const check = await matchesLookahead(state.lookahead, question);
    if (check.hit && state.lookahead) {
      const l = state.lookahead;
      return NextResponse.json({
        mode: "policy_guidance",
        ...l.pointers,
        sources: l.sources,
        // Surfaced rather than hidden: an answer written before the question was asked is a claim
        // the rep should be able to see and check, not a silent optimisation.
        cached: true,
        prepared: { conceptId: l.conceptId, label: l.label, question: l.question, at: l.preparedAt, match: Number(check.score.toFixed(3)) },
        verified: l.verified,
        unsupportedFigures: [],
      });
    }
  }

  // 1) ORCHESTRATE — the brain (or the deterministic fallback) decides the mode; LangGraph routes
  // to the matching handler. The safety spine (readiness) is not here — it rides the state poll.
  const scope = productArea ?? "Health Protection";
  const orchState = state ?? emptyState(typeof roomId === "string" && roomId ? roomId : "anon", scope);
  const result = await runOrchestrator({
    asked: typeof asked === "string" ? asked : "",
    transcript,
    state: orchState,
    scope,
    clarifyContext: typeof clarifyContext === "string" && clarifyContext.trim() ? clarifyContext : undefined,
  });

  // 2) MAP the mode result onto the response the console renders.
  if (result.mode === "keep_listening") {
    return NextResponse.json({ mode: result.mode, note: null });
  }
  if (result.mode === "topic_drift") {
    return NextResponse.json({ mode: result.mode, note: result.drift?.message, drift: result.drift });
  }
  if (result.mode === "clarification") {
    return NextResponse.json({ mode: result.mode, clarify: result.clarify });
  }
  if (result.note && !result.pointers) {
    return NextResponse.json({ mode: result.mode, note: result.note });
  }
  return NextResponse.json({
    mode: result.mode,
    ...(result.pointers ?? {}),
    sources: result.sources ?? [],
    cached: false,
    comparing: result.comparing ?? false,
    unsupportedFigures: result.unsupportedFigures ?? [],
  });
}
