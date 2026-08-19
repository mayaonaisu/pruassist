import { NextRequest, NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { currentRep } from "@/lib/auth";
import { getByToken, getByRoom } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Issues a LiveKit token ONLY to:
//   (a) the authenticated rep, for one of their active session rooms, or
//   (b) a customer presenting a valid session join-token (the private link).
// Anyone without the link or a rep login cannot obtain a token, so the room
// is effectively private to the two intended participants.
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

  const at = new AccessToken(apiKey, apiSecret, { identity: username, ttl: "2h" });
  at.addGrant({ room: roomId, roomJoin: true, canPublish: true, canSubscribe: true });
  const token = await at.toJwt();
  return NextResponse.json({ token, room: roomId });
}
