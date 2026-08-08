import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { createSession, getByToken } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rep starts a session (auth required). Returns the room + the private join link.
export async function POST(req: NextRequest) {
  const cookieTok = (await cookies()).get(SESSION_COOKIE)?.value;
  const auth = cookieTok ? await verifySessionToken(cookieTok) : null;
  if (!auth) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const repName = String(auth.name ?? auth.sub ?? "Representative");
  const context = {
    productArea: typeof body.productArea === "string" ? body.productArea : "Health Protection",
    focus: Array.isArray(body.focus) ? body.focus.filter((f: unknown) => typeof f === "string") : [],
  };

  const s = createSession(repName, context);
  return NextResponse.json({ joinToken: s.joinToken, roomId: s.roomId, joinPath: `/c/${s.joinToken}` });
}

// Customer looks up a session by its link token (returns safe info only).
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token." }, { status: 400 });
  const s = getByToken(token);
  if (!s) return NextResponse.json({ error: "This session link is not valid." }, { status: 404 });
  return NextResponse.json({ active: s.active, repName: s.repName, productArea: s.context.productArea });
}
