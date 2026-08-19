import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { getByToken } from "@/lib/sessions";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Consent log. Shares the Store with the session registry so the customer's consent (recorded on
// their device) is visible to the rep's console, which may be served by a different instance.
type ConsentRecord = { room: string; name: string; consentedAt: string };

const consentKey = (roomId: string) => `consent:${roomId}`;

// Customer posts consent with their link token; rep reads it by roomId.
export async function POST(req: NextRequest) {
  const { token, room, name } = await req.json().catch(() => ({}));

  let roomId: string | null = typeof room === "string" ? room : null;
  if (token) {
    const s = await getByToken(token);
    if (!s) return NextResponse.json({ error: "Invalid session link." }, { status: 404 });
    roomId = s.roomId;
  }
  if (!roomId) return NextResponse.json({ error: "Missing room or token." }, { status: 400 });

  const record: ConsentRecord = { room: roomId, name: name || "Customer", consentedAt: new Date().toISOString() };
  await getStore().set(consentKey(roomId), record);
  return NextResponse.json({ ok: true, ...record });
}

// Only the rep reads the consent log — it carries the customer's name and timestamp.
export async function GET(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const room = req.nextUrl.searchParams.get("room");
  if (!room) return NextResponse.json({ error: "Missing 'room'." }, { status: 400 });
  return NextResponse.json({ consent: await getStore().get<ConsentRecord>(consentKey(room)) });
}
