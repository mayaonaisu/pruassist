import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
