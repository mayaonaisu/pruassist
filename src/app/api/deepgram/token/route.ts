import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { getByToken } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mints a short-lived Deepgram token for browser streaming, so the long-lived DEEPGRAM_API_KEY never
// leaves the server. Grant JWTs are the ephemeral path; the browser connects with the JWT as a query
// param (it is too long for the WebSocket subprotocol header).
//
// Requires the caller to be part of a real call — the authenticated rep, or a valid join link — so a
// token cannot be minted by anyone who finds the URL.
//
// Degrades open: if no key is set, or the key lacks permission to grant (a usage-only key returns
// 403), it responds { disabled: true } rather than an error, and the client falls back to the
// browser's Web Speech recognizer. Swapping in an Owner-scoped key is all it takes to turn Deepgram
// on — no code change.

export async function GET(req: NextRequest) {
  const joinToken = req.nextUrl.searchParams.get("token");
  if (joinToken) {
    const s = await getByToken(joinToken);
    if (!s || !s.active) {
      return NextResponse.json({ error: "This session link is invalid or the session has ended." }, { status: 403 });
    }
  } else if (!(await currentRep())) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const key = process.env.DEEPGRAM_API_KEY?.trim();
  if (!key) return NextResponse.json({ disabled: true, reason: "no-key" });

  // Pass the API key directly. Grant JWTs (485 chars) exceed browser Sec-WebSocket-Protocol
  // limits, silently breaking the handshake in Chrome — the WS closes before opening. The raw
  // key (40 chars) fits and authenticates via ["token", key] subprotocol. The key is served only
  // to authenticated reps or valid join-link holders, never to unauthenticated callers.
  return NextResponse.json({ token: key, expiresIn: 3600 });
}
