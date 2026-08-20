import { citationsFor, conceptById, conceptsForArea, type Concept } from "../concepts";
import { DEFAULT_TTL, getStore } from "../store";
import type { Detection } from "./signals";
import {
  emptyState,
  type AgentState,
  type Alert,
  type ConceptEntry,
  type ConceptState,
  type Evidence,
  type RecordRow,
  type RepAct,
  type SignalKind,
} from "./types";

// The Concept Ledger. Every material concept moves through a state machine with an evidentiary
// standard, and the record at the end quotes the evidence rather than asserting a verdict.
//
// `misunderstood` means "said something matching a known misconception" — not "does not
// understand". The distinction is the difference between evidence and a judgement about a person.

export const stateKey = (roomId: string) => `sess:agent:${roomId}`;
export const actsKey = (roomId: string) => `sess:agent:${roomId}:acts`;

const EVIDENCE_PER_CONCEPT = 8;

// asserted never overwrites demonstrated; demonstrated and misunderstood outrank everything and
// tie with each other, so within a pass the later turn wins.
const RANK: Record<ConceptState, number> = {
  unseen: 0,
  raised: 1,
  asserted: 2,
  demonstrated: 3,
  misunderstood: 3,
};

function entry(id: string): ConceptEntry {
  return { id, state: "unseen", evidence: [], reAsks: 0 };
}

function stamp(e: ConceptEntry, state: ConceptState, at: number) {
  if (state === "raised") e.raisedAt ??= at;
  if (state === "asserted") e.assertedAt = at;
  if (state === "demonstrated") e.demonstratedAt = at;
  if (state === "misunderstood") e.misunderstoodAt = at;
}

/* ---------- folding a pass into the ledger ---------- */

export function applyDetections(state: AgentState, detections: Detection[]): AgentState {
  const next: AgentState = { ...state, concepts: { ...state.concepts } };

  for (const d of [...detections].sort((a, b) => a.turnIndex - b.turnIndex)) {
    const e: ConceptEntry = { ...(next.concepts[d.conceptId] ?? entry(d.conceptId)) };
    e.evidence = [...e.evidence];

    const ev: Evidence = {
      at: d.at,
      role: d.argues === "raised" ? "rep" : "customer",
      quote: d.quote,
      signal: d.kind,
      detail: d.detail,
      score: Number(d.score.toFixed(3)),
    };
    // The same turn can be re-scored on a later pass; don't stack duplicate evidence.
    if (!e.evidence.some((x) => x.at === ev.at && x.signal === ev.signal && x.quote === ev.quote)) {
      e.evidence.push(ev);
      if (e.evidence.length > EVIDENCE_PER_CONCEPT) e.evidence = e.evidence.slice(-EVIDENCE_PER_CONCEPT);
      if (d.kind === "re-ask") e.reAsks += 1;
    }

    if (d.argues && RANK[d.argues] >= RANK[e.state]) {
      // A concept the customer engages with before the rep names it is still raised.
      if (d.argues !== "raised") e.raisedAt ??= d.at;
      e.state = d.argues;
      stamp(e, d.argues, d.at);
    }

    next.concepts[d.conceptId] = e;
  }

  return next;
}

export function applyActs(state: AgentState, acts: RepAct[]): AgentState {
  if (!acts.length) return state;
  const next: AgentState = { ...state, concepts: { ...state.concepts }, dismissed: [...state.dismissed] };
  for (const a of acts) {
    if (a.type === "dismiss") {
      if (!next.dismissed.includes(a.conceptId)) next.dismissed.push(a.conceptId);
      continue;
    }
    const e = { ...(next.concepts[a.conceptId] ?? entry(a.conceptId)) };
    e.teachBackAskedAt = a.at;
    next.concepts[a.conceptId] = e;
  }
  return next;
}

/* ---------- what the rep sees, one thing at a time ---------- */

// Highest risk first. A second alert competing for attention mid-conversation is worse than none.
const PRIORITY: Record<Alert["kind"], number> = {
  misunderstood: 4,
  divergence: 3,
  "false-assent": 2,
  "re-ask": 1,
};

function headline(kind: Alert["kind"], c: Concept): string {
  switch (kind) {
    case "misunderstood":
      return "That is not what the policy says.";
    case "divergence":
      return "They dropped the part that changes the answer.";
    case "false-assent":
      return "They agreed, but they have not shown it.";
    case "re-ask":
      return `They have asked about ${c.label.toLowerCase()} before.`;
  }
}

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// The evidence, in the order the rep needs it: what was observed, then what corroborates it.
// Assembled rather than concatenated — raw detector notes read as machine output, and the rep
// has about two seconds to take this in mid-conversation.
function describe(kind: Alert["kind"], e: ConceptEntry, last: Evidence): string {
  const parts: string[] = [];
  if (kind === "false-assent") {
    parts.push(`Asserted ${hhmm(e.assertedAt ?? last.at)}, never demonstrated.`);
    const pause = [...e.evidence].reverse().find((x) => x.signal === "latency");
    if (pause?.detail) parts.push(pause.detail);
    if (e.reAsks > 0) {
      const back = [...e.evidence].reverse().find((x) => x.signal === "re-ask");
      if (back?.detail) parts.push(back.detail);
    }
  } else if (last.detail) {
    parts.push(last.detail);
  }
  if (kind !== "false-assent" && e.reAsks > 1) parts.push(`Raised ${e.reAsks} times.`);
  return parts.join(" ");
}

export function chooseAlert(state: AgentState): Alert | null {
  let best: { alert: Alert; rank: number; at: number } | null = null;

  for (const e of Object.values(state.concepts)) {
    if (state.dismissed.includes(e.id)) continue;
    const c = conceptById(e.id);
    if (!c) continue;

    // The alert speaks about the customer, so it must hang off something the customer said.
    const spoken = e.evidence.filter((x) => x.role === "customer");
    const latest = spoken[spoken.length - 1];
    if (!latest) continue;
    // One turn can trip several detectors. Lead with the one that names what was actually wrong,
    // not the one that happened to be pushed last.
    const sameTurn = spoken.filter((x) => x.at === latest.at);
    const last = sameTurn.find((x) => x.signal === "uptake") ?? latest;

    let kind: Alert["kind"] | null = null;
    if (e.state === "misunderstood") {
      kind = last.signal === "divergence" ? "divergence" : "misunderstood";
    } else if (e.state === "asserted" && !e.demonstratedAt) {
      kind = "false-assent";
    } else if (e.reAsks > 1 && e.state !== "demonstrated") {
      kind = "re-ask";
    }
    if (!kind) continue;

    // Once the rep has asked the teach-back, the ball is with the customer, not the alert.
    if (e.teachBackAskedAt && e.teachBackAskedAt >= last.at) continue;

    const alert: Alert = {
      kind,
      conceptId: c.id,
      label: c.label,
      headline: headline(kind, c),
      detail: describe(kind, e, last),
      teachBack: c.teachBack,
      citations: citationsFor(c),
      quote: last.quote,
      at: last.at,
    };
    const rank = PRIORITY[kind];
    if (!best || rank > best.rank || (rank === best.rank && last.at > best.at)) {
      best = { alert, rank, at: last.at };
    }
  }

  return best?.alert ?? null;
}

export function sameAlert(a: Alert | null, b: Alert | null): boolean {
  if (!a || !b) return a === b;
  return a.conceptId === b.conceptId && a.kind === b.kind && a.at === b.at;
}

/* ---------- the Understanding Record ---------- */

const RISK: Record<ConceptState, string> = {
  unseen: "Not covered in this session",
  raised: "Explained, but nothing came back",
  asserted: "Agreed, never demonstrated",
  demonstrated: "",
  misunderstood: "Correct this next time",
};

// One row per material concept, in the order the ledger declares them, so two sessions on the
// same product produce comparable records.
export function buildRecord(state: AgentState): RecordRow[] {
  return conceptsForArea(state.productArea).map((c) => {
    const e = state.concepts[c.id];
    const st: ConceptState = e?.state ?? "unseen";
    // Quote the words that put the concept in its current state — not merely the last thing the
    // customer said about it, which is often a later question rather than the evidence itself.
    const spoken = [...(e?.evidence ?? [])].reverse().filter((x) => x.role === "customer");
    const causing: Record<ConceptState, SignalKind[]> = {
      unseen: [],
      raised: [],
      asserted: ["assent"],
      demonstrated: ["uptake"],
      misunderstood: ["uptake", "divergence"],
    };
    // `raised` and `unseen` have no customer evidence by definition. Quoting a later question
    // there would read as though the customer had shown something, which is the opposite.
    const own = causing[st].length ? spoken.find((x) => causing[st].includes(x.signal)) : undefined;
    const risk = st === "unseen" && !c.material ? "" : RISK[st];
    return {
      conceptId: c.id,
      label: c.label,
      state: st,
      at: own?.at ?? e?.raisedAt,
      quote: own?.quote ?? "",
      citations: citationsFor(c),
      risk,
    };
  });
}

/* ---------- persistence ---------- */

export async function loadState(roomId: string, productArea: string): Promise<AgentState> {
  const stored = await getStore().get<AgentState>(stateKey(roomId));
  if (!stored) return emptyState(roomId, productArea);
  // A stale record from a previous product area would render rows that were never in scope.
  return stored.productArea === productArea ? stored : { ...stored, productArea };
}

// The deep pass is the only writer of this key, and it is debounced per room, so a plain write
// is safe. `expectedRev` is a cheap guard against two passes overlapping: it is best-effort
// rather than a compare-and-swap, and a dropped write is recovered on the next pass because the
// cursor only advances on a successful one.
export async function saveState(next: AgentState, expectedRev: number): Promise<boolean> {
  const store = getStore();
  const current = await store.get<AgentState>(stateKey(next.roomId));
  if (current && current.rev !== expectedRev) return false;
  await store.set(stateKey(next.roomId), next, DEFAULT_TTL);
  return true;
}

export async function pushAct(roomId: string, act: RepAct): Promise<void> {
  await getStore().append<RepAct>(actsKey(roomId), act, DEFAULT_TTL);
}

export async function drainActs(roomId: string): Promise<RepAct[]> {
  return getStore().drain<RepAct>(actsKey(roomId));
}

// Called when the rep ends the session: the comprehension evidence expires with everything else.
export async function clearAgentState(roomId: string): Promise<void> {
  const store = getStore();
  await store.del(stateKey(roomId));
  await store.del(actsKey(roomId));
}
