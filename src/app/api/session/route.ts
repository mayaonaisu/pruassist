import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { createSession, getByToken } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The customer sees this name, so prefer the typed signature over the login credential.
function repDisplayName(signature: unknown): string {
  const typed = typeof signature === "string" ? signature.trim() : "";
  if (typed.length > 1) return typed.slice(0, 60);
  return process.env.REP_DISPLAY_NAME?.trim() || "your Prudential representative";
}

// Rep starts a session (auth required). Returns the room + the private join link.
export async function POST(req: NextRequest) {
  const auth = await currentRep();
  if (!auth) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const repName = repDisplayName(body.repName);
  const context = {
    productArea: typeof body.productArea === "string" ? body.productArea : "Health Protection",
    focus: Array.isArray(body.focus) ? body.focus.filter((f: unknown) => typeof f === "string") : [],
  };

  const s = await createSession(repName, context);
  return NextResponse.json({ joinToken: s.joinToken, roomId: s.roomId, joinPath: `/c/${s.joinToken}` });
}

// Customer looks up a session by its link token (returns safe info only).
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token." }, { status: 400 });
  const s = await getByToken(token);
  if (!s) return NextResponse.json({ error: "This session link is not valid." }, { status: 404 });
  return NextResponse.json({ active: s.active, repName: s.repName, productArea: s.context.productArea });
}
