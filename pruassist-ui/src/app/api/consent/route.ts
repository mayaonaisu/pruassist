import { NextRequest, NextResponse } from "next/server";
import { getByToken } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Demo-grade in-memory consent log (resets when the dev server restarts).
type ConsentRecord = { room: string; name: string; consentedAt: string };
const consents = new Map<string, ConsentRecord>();

// Customer posts consent with their link token; rep reads it by roomId.
export async function POST(req: NextRequest) {
  const { token, room, name } = await req.json().catch(() => ({}));

  let roomId: string | null = typeof room === "string" ? room : null;
  if (token) {
    const s = getByToken(token);
    if (!s) return NextResponse.json({ error: "Invalid session link." }, { status: 404 });
    roomId = s.roomId;
  }
  if (!roomId) return NextResponse.json({ error: "Missing room or token." }, { status: 400 });

  const record: ConsentRecord = { room: roomId, name: name || "Customer", consentedAt: new Date().toISOString() };
  consents.set(roomId, record);
  return NextResponse.json({ ok: true, ...record });
}

export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room");
  if (!room) return NextResponse.json({ error: "Missing 'room'." }, { status: 400 });
  return NextResponse.json({ consent: consents.get(room) ?? null });
}
