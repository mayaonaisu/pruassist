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

const GRANT_TTL_SECONDS = 300;

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

  try {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: GRANT_TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // A usage-only key cannot grant (403). Log once, degrade to Web Speech.
      console.warn(`[deepgram] grant failed (${res.status}) — falling back to Web Speech. The key needs Owner scope.`);
      return NextResponse.json({ disabled: true, reason: `grant-${res.status}` });
    }
    const data = await res.json();
    const token = data?.access_token;
    if (typeof token !== "string") return NextResponse.json({ disabled: true, reason: "no-token" });
    return NextResponse.json({ token, expiresIn: typeof data.expires_in === "number" ? data.expires_in : GRANT_TTL_SECONDS });
  } catch (e) {
    console.warn(`[deepgram] grant error — falling back to Web Speech: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ disabled: true, reason: "error" });
  }
}
