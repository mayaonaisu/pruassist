import { NextRequest, NextResponse, after } from "next/server";
import { currentRep } from "@/lib/auth";
import { buildRecord, loadState, pushAct } from "@/lib/agent/ledger";
import { deepEnabled, deepPass } from "@/lib/agent/deep";
import { getByRoom } from "@/lib/sessions";
import type { AgentState, RepAct, Role, Turn } from "@/lib/agent/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The deep pass runs after the response is flushed but still inside this invocation.
export const maxDuration = 60;

// The comprehension state for one room. Rep-only and private: that is the whole point of the
// product — the customer never sees any of it, and never knows it exists.

function view(state: AgentState) {
  const l = state.lookahead;
  return {
    rev: state.rev,
    alert: state.alert,
    degraded: state.degraded,
    record: buildRecord(state),
    // What the background pass is holding an answer for. Surfaced while idle so the rep can see
    // the assistant is ahead of the conversation rather than only noticing when it lands.
    prepared: l ? { label: l.label, question: l.question, at: l.preparedAt, toolCalls: l.toolCalls } : null,
  };
}

// No session record means the shared store is unavailable, not that the room is fake. Say so
// rather than returning an empty ledger, which would read as "the customer understood nothing".
const UNAVAILABLE = { unavailable: true, rev: 0, alert: null, degraded: true, record: [], prepared: null };

// Only the shape is trusted; the values are whatever the browser captured.
function parseTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      const role: Role = o.role === "rep" ? "rep" : "customer";
      return {
        at: typeof o.at === "number" ? o.at : 0,
        role,
        speaker: typeof o.speaker === "string" ? o.speaker : role,
        text: typeof o.text === "string" ? o.text : "",
      };
    })
    .filter((t) => t.at > 0 && t.text.trim().length > 0);
}

export async function GET(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const roomId = req.nextUrl.searchParams.get("roomId");
  if (!roomId) return NextResponse.json({ error: "Missing roomId." }, { status: 400 });

  const session = await getByRoom(roomId);
  if (!session) return NextResponse.json(UNAVAILABLE);
  return NextResponse.json(view(await loadState(roomId, session.context.productArea)));
}

// One call does both halves of the two-speed loop: it returns the ledger as it stands right now
// (fast), and schedules the pass over the turns just sent to run after the response is flushed
// (slow). The rep's view is therefore always one cycle behind the deep pass, which is the design
// — nothing the rep waits on is ever blocked on scoring.
export async function POST(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { roomId, act } = body ?? {};
  if (!roomId || typeof roomId !== "string") {
    return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
  }

  const session = await getByRoom(roomId);
  if (!session) return NextResponse.json(UNAVAILABLE);
  const productArea = session.context.productArea;

  // Rep actions are appended to their own key rather than written into the ledger, so they can
  // never race the deep pass — two writers, two keys, no lost updates.
  if (act && typeof act === "object") {
    const { type, conceptId } = act as Record<string, unknown>;
    if (typeof conceptId === "string" && (type === "teach-back-asked" || type === "dismiss")) {
      await pushAct(roomId, { type, conceptId, at: Date.now() } as RepAct);
    }
  }

  const turns = parseTurns(body?.turns);
  if (turns.length && deepEnabled()) {
    after(async () => {
      try {
        const outcome = await deepPass({ roomId, productArea, turns, force: body?.final === true });
        // Both outcomes are logged. A pass that declines to run is not a failure, but silence
        // makes "the ledger never moved" impossible to diagnose from outside.
        console.log(
          outcome.ran
            ? `[agent] ${roomId} rev=${outcome.state.rev} detections=${outcome.detections} graded=${outcome.graded} calls=${outcome.spent}`
            : `[agent] ${roomId} skipped: ${outcome.reason}`,
        );
      } catch (e) {
        // Comprehension tracking must never take the live console down with it. Degrade to the
        // previous behaviour, but log loudly — a swallowed failure here is invisible.
        console.error(`[agent] deep pass failed for ${roomId}:`, e);
      }
    });
  }

  return NextResponse.json(view(await loadState(roomId, productArea)));
}
