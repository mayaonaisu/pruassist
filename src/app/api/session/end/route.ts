import { NextRequest, NextResponse } from "next/server";
import { RoomServiceClient } from "livekit-server-sdk";
import { currentRep } from "@/lib/auth";
import { endSession } from "@/lib/sessions";
import { clearAgentState } from "@/lib/agent/ledger";
import { clearDrift } from "@/lib/agent/orchestrator/drift";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rep ends a session: the join link stops working and the room is deleted, dropping everyone.
export async function POST(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { roomId } = await req.json().catch(() => ({}));
  if (!roomId) return NextResponse.json({ error: "Missing roomId." }, { status: 400 });
  await endSession(roomId);
  // The comprehension evidence is quoted customer speech. It has done its job once the record is
  // in the rep's hands, so it goes now rather than waiting out its 24-hour TTL.
  await clearAgentState(roomId);
  await clearDrift(roomId);

  // Disconnect the customer (and anyone else) by deleting the LiveKit room.
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const httpUrl = wsUrl?.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
  if (apiKey && apiSecret && httpUrl) {
    try {
      const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
      await svc.deleteRoom(roomId);
    } catch {
      /* room may already be gone — ignore */
    }
  }

  return NextResponse.json({ ok: true });
}
