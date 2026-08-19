import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  const U = process.env.REP_USERNAME;
  const P = process.env.REP_PASSWORD;

  if (!U || !P || !process.env.AUTH_SECRET) {
    return NextResponse.json(
      { error: "Auth not configured. Set REP_USERNAME, REP_PASSWORD and AUTH_SECRET in .env.local." },
      { status: 500 },
    );
  }
  if (username !== U || password !== P) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const token = await createSessionToken(username);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
    // The demo runs `next dev` behind a public HTTPS tunnel so the customer can join from a
    // phone, which would otherwise serve a real session cookie over a public URL without Secure.
    secure: process.env.NODE_ENV === "production" || !!process.env.PUBLIC_TUNNEL,
  });
  return NextResponse.json({ ok: true });
}
