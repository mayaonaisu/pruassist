import { NextRequest, NextResponse } from "next/server";
import { currentRep } from "@/lib/auth";
import { addLinkSource, addTextSource, listSources, removeSource, type CustomSource } from "@/lib/custom-kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fetching and extracting a linked page can run past Vercel's default 10s on a large page.
export const maxDuration = 30;

// The rep-managed knowledge base: sources a representative adds so the team can keep the assistant
// current. Rep-only, shared across the team. The full clause text stays server-side; the client sees
// a summary (label, area, how many clauses) — enough to manage, not to re-download the corpus.
function view(s: CustomSource) {
  return { id: s.id, kind: s.kind, label: s.label, area: s.area, url: s.url ?? null, addedAt: s.addedAt, clauses: s.clauses.length };
}

const isHttpUrl = (u: unknown): u is string => {
  if (typeof u !== "string") return false;
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
};

export async function GET() {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  return NextResponse.json({ sources: (await listSources()).map(view) });
}

export async function POST(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { kind, area, label, url, text } = body ?? {};
  if (typeof area !== "string" || !area.trim()) {
    return NextResponse.json({ error: "Pick a product area." }, { status: 400 });
  }

  try {
    let source: CustomSource;
    if (kind === "link") {
      if (!isHttpUrl(url)) return NextResponse.json({ error: "Enter a valid http(s) link." }, { status: 400 });
      source = await addLinkSource({ url, area, label: typeof label === "string" ? label : undefined });
    } else if (kind === "text") {
      if (typeof text !== "string" || !text.trim()) return NextResponse.json({ error: "Paste some text to add." }, { status: 400 });
      if (typeof label !== "string" || !label.trim()) return NextResponse.json({ error: "Give the note a short label." }, { status: 400 });
      source = await addTextSource({ label, area, text });
    } else {
      return NextResponse.json({ error: "Unknown source kind." }, { status: 400 });
    }
    return NextResponse.json({ source: view(source) });
  } catch (e) {
    // A bad link or an empty extraction is the rep's to fix, not a server fault.
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not add that source." }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await currentRep())) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  await removeSource(id);
  return NextResponse.json({ ok: true });
}
