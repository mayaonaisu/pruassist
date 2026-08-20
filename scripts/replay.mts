/**
 * Replay harness — the development loop for the Concept Ledger.
 *
 *   npm run replay -- fixtures/false-assent.json
 *   npm run replay -- fixtures/*.json --no-ai
 *
 * Feeds a scripted two-speaker transcript through the real signal detectors and the real ledger
 * with an in-process store: no browser, no video, no second device. It prints every signal that
 * fires, every ledger transition with the evidence quote, and the final Understanding Record.
 *
 * It is also the deterministic fallback for a demo: browser speech recognition on venue wifi is
 * not something to stake a live run on.
 *
 * `--no-ai` forces the keyword fallback, which is what runs when GEMINI_API_KEY is absent or the
 * embedding call fails. Both paths must behave.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const noAi = args.includes("--no-ai");
const files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("usage: npm run replay -- <fixture.json> [more.json] [--no-ai]");
  process.exit(1);
}

// The harness must never touch the shared session store, and --no-ai must be decided before the
// retrieval module memoizes a client. Both mean deleting env vars ahead of the dynamic imports.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
if (noAi) delete process.env.GEMINI_API_KEY;

const { conceptsForArea } = await import("../src/lib/concepts.ts");
const { applyDetections, buildRecord, chooseAlert, sameAlert } = await import("../src/lib/agent/ledger.ts");
const { runSignals } = await import("../src/lib/agent/signals.ts");
const { emptyState } = await import("../src/lib/agent/types.ts");
type Turn = import("../src/lib/agent/types.ts").Turn;
type AgentState = import("../src/lib/agent/types.ts").AgentState;
type Alert = import("../src/lib/agent/types.ts").Alert;

type Fixture = {
  name: string;
  productArea: string;
  expect?: string;
  turns: { t: string; role: "rep" | "customer"; text: string }[];
};

// Fixed base so runs are byte-identical: the ledger stores timestamps and the record prints them.
const BASE = Date.UTC(2026, 7, 20, 6, 30, 0);

const seconds = (t: string) => {
  const [m, s] = t.split(":").map(Number);
  return m * 60 + (s || 0);
};

// Elapsed, not wall clock: the live console shows the time of day, but a fixture is about where
// in the conversation something happened.
const clock = (at: number) => {
  const s = Math.round((at - BASE) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const STATE_COLOUR: Record<string, (s: string) => string> = {
  unseen: C.dim,
  raised: C.dim,
  asserted: C.amber,
  demonstrated: C.green,
  misunderstood: C.red,
};

async function replay(file: string): Promise<boolean> {
  const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  const pool = conceptsForArea(fx.productArea);

  const turns: Turn[] = fx.turns.map((t) => ({
    at: BASE + seconds(t.t) * 1000,
    role: t.role,
    speaker: t.role === "rep" ? "Rep" : "Customer",
    text: t.text,
  }));

  console.log("");
  console.log(C.bold(`${basename(file)}`) + C.dim(` · ${fx.productArea} · ${pool.length} concepts` + (noAi ? " · keyword fallback" : "")));
  console.log(C.dim("─".repeat(78)));

  let state: AgentState = emptyState("replay", fx.productArea);
  let shown: Alert | null = null;
  let alerts = 0;

  // One pass per turn, which is more often than the live debounce allows — deliberately, so the
  // harness proves a transition is stable rather than an artefact of when the pass happened to run.
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const who = turn.role === "rep" ? "REP     " : C.cyan("CUSTOMER");
    console.log(`  ${C.dim(clock(turn.at))}  ${who}  ${turn.text}`);

    const before = new Map(Object.entries(state.concepts).map(([k, v]) => [k, v.state]));
    const { detections } = await runSignals(turns.slice(0, i + 1), pool, i);
    state = applyDetections(state, detections);

    for (const d of detections) {
      // What the ledger applied, not what the detector argued: `asserted → raised` is a
      // transition the rank guard refuses, and printing the argument would hide that.
      const from = before.get(d.conceptId) ?? "unseen";
      const to = state.concepts[d.conceptId]?.state ?? from;
      const arrow = d.argues && to !== from ? ` ${from} → ${to}` : d.argues ? ` (stays ${to})` : "";
      console.log(
        C.dim(`              ↳ ${d.kind.padEnd(11)}`) +
          `${d.conceptId}${C.dim(arrow)}  ${C.dim(d.detail)}` +
          (d.score > 0 && d.score < 1 ? C.dim(`  [${d.score.toFixed(3)}]`) : ""),
      );
    }

    const alert = chooseAlert(state);
    state = { ...state, alert };
    if (alert && !sameAlert(alert, shown)) {
      alerts++;
      console.log("");
      console.log(`         ${C.bold(C.amber("▲ ALERT"))}  ${C.bold(alert.headline)}  ${C.dim(`(${alert.kind})`)}`);
      console.log(`                  ${alert.label} — ${alert.detail}`);
      console.log(`                  ${C.cyan("Ask:")} ${alert.teachBack}`);
      console.log(`                  ${C.dim(alert.citations.join(" · "))}`);
      console.log("");
    }
    shown = alert;
  }

  console.log("");
  console.log(C.bold("  Understanding Record"));
  for (const row of buildRecord(state)) {
    const colour = STATE_COLOUR[row.state] ?? C.dim;
    const when = row.state === "unseen" ? "     " : clock(row.at ?? 0);
    const quote = row.quote ? `"${row.quote.slice(0, 44)}"` : "";
    console.log(
      `  ${row.label.padEnd(22)} ${colour(row.state.toUpperCase().padEnd(14))} ${C.dim(when)}  ${quote.padEnd(48)} ${C.dim(row.citations.join(" · ").replace(/PRUShield Product Brochure \(Apr 2026\) · /g, ""))}` +
        (row.risk ? `  ${C.amber("⚠ " + row.risk)}` : ""),
    );
  }

  if (fx.expect) {
    const [conceptId, want] = fx.expect.split(":");
    const got = want === "silent" ? (alerts === 0 ? "silent" : "alerted") : state.concepts[conceptId]?.state ?? "unseen";
    const ok = got === want;
    console.log("");
    console.log(`  ${ok ? C.green("PASS") : C.red("FAIL")}  expected ${conceptId} = ${want}, got ${got}`);
    return ok;
  }
  return true;
}

let failed = 0;
for (const f of files) {
  if (!(await replay(f))) failed++;
}
console.log("");
if (failed) {
  console.log(C.red(`${failed} of ${files.length} fixtures failed`));
  process.exit(1);
}
console.log(C.green(`${files.length} fixture${files.length === 1 ? "" : "s"} passed`));
