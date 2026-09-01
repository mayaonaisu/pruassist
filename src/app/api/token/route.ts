import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { currentRep } from "@/lib/auth";
import { getByToken, getByRoom } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// LiveKit tokens go only to the authenticated rep or a valid join link, keeping the room private.
export async function GET(req: NextRequest) {
  const username = req.nextUrl.searchParams.get("username");
  const joinToken = req.nextUrl.searchParams.get("token");
  const room = req.nextUrl.searchParams.get("room");
  if (!username) return NextResponse.json({ error: "Missing 'username'." }, { status: 400 });

  let roomId: string;

  if (joinToken) {
    // Customer path — must present a valid, active session link.
    const s = await getByToken(joinToken);
    if (!s || !s.active) {
      return NextResponse.json({ error: "This session link is invalid or the session has ended." }, { status: 403 });
    }
    roomId = s.roomId;
  } else {
    // Rep path — must be authenticated AND the room must be an active session.
    if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const s = room ? await getByRoom(room) : null;
    if (!s || !s.active) return NextResponse.json({ error: "No active session for this room." }, { status: 403 });
    roomId = s.roomId;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: "Server not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env.local." },
      { status: 500 },
    );
  }

  // Identity must be UNIQUE per participant in a room — two participants with the same identity
  // evict each other, so a rep and customer who happen to share a name would never see each other.
  // Role-prefixing guarantees the rep and the (single) customer never collide, while `name` keeps
  // a clean label for the tiles. canPublishData is granted because the customer's live transcript
  // rides the data channel — without it their words never reach the rep.
  const role = joinToken ? "customer" : "rep";
  const at = new AccessToken(apiKey, apiSecret, { identity: `${role}:${username}`, name: username, ttl: "2h" });
  at.addGrant({ room: roomId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
  const token = await at.toJwt();
  return NextResponse.json({ token, room: roomId });
}
