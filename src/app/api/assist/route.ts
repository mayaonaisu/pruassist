import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { getByRoom } from "@/lib/sessions";
import { loadState } from "@/lib/agent/ledger";
import { matchesLookahead } from "@/lib/agent/cache";
import { runOrchestrator } from "@/lib/agent/orchestrator/graph";
import {
  clearDrift,
  judgePausedTurn,
  loadDrift,
  pausedMessage,
  recordDrift,
  RESETS_DRIFT,
  type DriftState,
} from "@/lib/agent/orchestrator/drift";
import type { Mode, OrchestratorInput } from "@/lib/agent/orchestrator/types";
import { emptyState } from "@/lib/agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The orchestrator can stack a brain call, a bounded tool loop, and a generation on a cache miss,
// which can exceed Vercel's default 10s function limit. Give the live path real headroom so
// serverless does not 504 a slow-but-valid agentic answer; a cache hit still returns in well under
// a second, and the live tool loop is capped (handlers.ts) to keep the common case far below this.
export const maxDuration = 60;

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
  // mid-demo. Without it there is no product area, no prepared answer, and no drift state.
  const rid = typeof roomId === "string" && roomId ? roomId : null;
  const session = rid ? await getByRoom(rid) : null;
  const productArea = session?.context.productArea;
  const state = session && rid ? await loadState(rid, session.context.productArea) : null;

  const scope = productArea ?? "Health Protection";
  const orchState = state ?? emptyState(rid ?? "anon", scope);
  const orchInput: OrchestratorInput = {
    asked: typeof asked === "string" ? asked : "",
    transcript,
    state: orchState,
    scope,
    clarifyContext: typeof clarifyContext === "string" && clarifyContext.trim() ? clarifyContext : undefined,
  };

  // 0) DRIFT — if the conversation is paused for drifting off scope, judge whether this turn brings
  // it back (one brain call, no Gemini) before spending anything else. Paused means paused: the
  // cache is skipped too. Only a real session gets a drift streak; a stale/anon tab bypasses it.
  const driftRoom = session ? rid : null;
  let presetMode: Mode | undefined;
  let drift: DriftState = { count: 0, pausedAt: null };
  if (driftRoom) {
    drift = await loadDrift(driftRoom);
    if (drift.pausedAt) {
      const verdict = await judgePausedTurn(orchInput);
      if ("resume" in verdict) {
        await clearDrift(driftRoom);
        presetMode = verdict.resume; // skip the graph's router: judgePausedTurn already classified
      } else {
        return NextResponse.json({ mode: "drift_paused", note: pausedMessage(scope) });
      }
    }
  }

  // 1) CACHE — did the background pass already prepare, and verify, the answer to this question?
  if (state) {
    const question = typeof asked === "string" && asked.trim() ? asked : (transcript.split("\n").slice(-1)[0] ?? "");
    const check = await matchesLookahead(state.lookahead, question);
    if (check.hit && state.lookahead) {
      const l = state.lookahead;
      // A served answer is an in-scope turn — end any drift streak.
      if (driftRoom && drift.count > 0) await clearDrift(driftRoom);
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

  // 2) ORCHESTRATE — the brain (or the deterministic fallback) decides the mode; LangGraph routes
  // to the matching handler. The safety spine (readiness) is not here — it rides the state poll.
  const result = await runOrchestrator({ ...orchInput, presetMode });

  // 3) DRIFT bookkeeping — a substantive answer ends the streak; a repeat drift advances it and
  // pauses on the second consecutive one. keep_listening leaves the streak untouched.
  if (driftRoom) {
    if (RESETS_DRIFT.has(result.mode)) {
      if (drift.count > 0) await clearDrift(driftRoom);
    } else if (result.mode === "topic_drift") {
      const next = await recordDrift(driftRoom, drift);
      if (next.pausedAt) return NextResponse.json({ mode: "drift_paused", note: pausedMessage(scope) });
      // else this is the first drift — fall through to the one-time warning below.
    }
  }

  // 4) MAP the mode result onto the response the console renders.
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
