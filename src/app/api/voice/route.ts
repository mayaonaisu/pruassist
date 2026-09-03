import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { saveVoiceProfile, loadVoiceProfile, deleteVoiceProfile, updateVoiceCalibration, validateScalar } from "@/lib/voice-profile";
import { decodeProfile } from "@/lib/voice/profile-codec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The rep's own voiceprint: GET the stored profile, PUT a new one, DELETE it. Rep-only, per-login. The
// stored value is a 192-number voice embedding (not audio), inside the privacy promise — see
// src/lib/voice-profile.ts.

export async function GET() {
  const rep = await currentRep();
  if (!rep) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const rec = await loadVoiceProfile(rep.sub as string);
  return NextResponse.json({ profile: rec?.profile ?? null, model: rec?.model ?? null, selfMean: rec?.selfMean ?? null, otherMean: rec?.otherMean ?? null, updatedAt: rec?.updatedAt ?? null });
}

export async function PUT(req: NextRequest) {
  const rep = await currentRep();
  if (!rep) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { profile, model, selfMean, otherMean } = body ?? {};
  if (typeof profile !== "string" || !profile) return NextResponse.json({ error: "Missing profile." }, { status: 400 });
  if (typeof model !== "string" || !model) return NextResponse.json({ error: "Missing model." }, { status: 400 });
  if (selfMean !== undefined && validateScalar(selfMean) == null) return NextResponse.json({ error: "Invalid selfMean." }, { status: 400 });
  if (otherMean !== undefined && validateScalar(otherMean) == null) return NextResponse.json({ error: "Invalid otherMean." }, { status: 400 });

  // Reject anything that is not a valid 192-dim voiceprint before it reaches the store.
  try {
    decodeProfile(profile);
  } catch {
    return NextResponse.json({ error: "Invalid voice profile." }, { status: 400 });
  }

  try {
    const rec = await saveVoiceProfile(rep.sub as string, profile, model, { selfMean, otherMean });
    return NextResponse.json({ ok: true, updatedAt: rec.updatedAt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save the profile." }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const rep = await currentRep();
  if (!rep) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const otherMean = validateScalar(body?.otherMean);
  if (otherMean == null) return NextResponse.json({ error: "Invalid otherMean." }, { status: 400 });
  try {
    const rec = await updateVoiceCalibration(rep.sub as string, { otherMean });
    return NextResponse.json({ ok: true, updatedAt: rec.updatedAt });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save calibration." }, { status: 400 });
  }
}

export async function DELETE() {
  const rep = await currentRep();
  if (!rep) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  await deleteVoiceProfile(rep.sub as string);
  return NextResponse.json({ ok: true });
}
