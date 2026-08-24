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
  // Username match is case-insensitive so the display can follow whatever the rep typed; the
  // password stays exact.
  const typed = typeof username === "string" ? username.trim() : "";
  if (typeof password !== "string" || typed.toLowerCase() !== U.trim().toLowerCase() || password !== P) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const token = await createSessionToken(typed);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8,
    secure: process.env.NODE_ENV === "production",
  });
  return NextResponse.json({ ok: true });
}
