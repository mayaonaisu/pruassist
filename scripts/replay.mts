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
const withLookahead = args.includes("--lookahead");
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
// Every key, not just the first: one left set would keep the vector path alive.
if (noAi) for (const k of Object.keys(process.env)) if (/^GEMINI_API_KEY(_\d+)?$/.test(k)) delete process.env[k];

const { conceptsForArea } = await import("../src/lib/concepts.ts");
const { applyActs, buildRecord, sameAlert } = await import("../src/lib/agent/ledger.ts");
const { prepareLookahead, rankByRisk } = await import("../src/lib/agent/lookahead.ts");
const { scorePass } = await import("../src/lib/agent/score.ts");
const { emptyState } = await import("../src/lib/agent/types.ts");
type Turn = import("../src/lib/agent/types.ts").Turn;
type AgentState = import("../src/lib/agent/types.ts").AgentState;
type Alert = import("../src/lib/agent/types.ts").Alert;

type Fixture = {
  name: string;
  productArea: string;
  expect?: string;
  expectAlert?: string;
  // Grading a teach-back needs a model. Such a fixture is skipped rather than failed under --no-ai.
  needsAi?: boolean;
  turns: {
    t: string;
    role: "rep" | "customer";
    text: string;
    // The rep pressing "Asked it" on an alert, scripted so the teach-back loop is replayable.
    act?: "teach-back-asked" | "dismiss";
    conceptId?: string;
  }[];
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

async function replay(file: string): Promise<boolean | null> {
  const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  if (fx.needsAi && noAi) {
    console.log("");
    console.log(C.bold(basename(file)) + C.dim(" · skipped — grading a teach-back needs a model"));
    return null;
  }
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

    // A scripted rep action lands before the turn is scored, exactly as the deep pass folds the
    // acts queue in before it runs the detectors.
    const scripted = fx.turns[i];
    if (scripted.act && scripted.conceptId) {
      state = applyActs(state, [{ type: scripted.act, conceptId: scripted.conceptId, at: turn.at }]);
      console.log(C.dim(`              ↳ rep act     ${scripted.act} on ${scripted.conceptId}`));
    }

    const before = new Map(Object.entries(state.concepts).map(([k, v]) => [k, v.state]));
    // The same call production makes, with the same cursor semantics — the turns so far, and a
    // ledger whose cursorAt sits on the previous one. Budget is unbounded here: the harness is
    // meant to exercise every stage, and it is not spending a live session's quota.
    const scored = await scorePass({ state, turns: turns.slice(0, i + 1), pool, budget: Infinity });
    const detections = scored.detections;
    state = scored.state;

    for (const d of detections) {
      // What the ledger applied, not what the detector argued: `asserted → raised` is a
      // transition the rank guard refuses, and printing the argument would hide that.
      const from = before.get(d.conceptId) ?? "unseen";
      const to = state.concepts[d.conceptId]?.state ?? from;
      const arrow = d.argues && to !== from ? ` ${from} → ${to}` : d.argues ? ` (stays ${to})` : "";
      console.log(
        C.dim(`              ↳ ${d.kind.padEnd(13)}`) +
          `${d.conceptId}${C.dim(arrow)}  ${C.dim(d.detail)}` +
          (d.score > 0 && d.score < 1 ? C.dim(`  [${d.score.toFixed(3)}]`) : ""),
      );
    }

    const alert = state.alert;
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

  // The lookahead is a tool loop and several model calls, so it is opt-in rather than part of the
  // normal loop. It prints what the background pass would have prepared at the end of this
  // conversation, and which concept it judged riskiest.
  if (withLookahead && !noAi) {
    console.log("");
    console.log(C.bold("  Lookahead"));
    console.log(C.dim(`  risk order: ${rankByRisk(state).map((c) => c.label).join(" > ") || "(nothing open)"}`));
    const look = await prepareLookahead(state, turns.map((t) => `${t.role === "rep" ? "Rep" : "Customer"}: ${t.text}`).join("\n"));
    if (!look) {
      console.log(C.dim("  nothing prepared — no open concept, or the answer failed verification"));
    } else {
      console.log(`  ${C.dim("expects")} ${C.cyan(`“${look.question}”`)} ${C.dim(`· ${look.label}`)}`);
      console.log(`  ${C.dim("answer ")} “${look.pointers.suggestedLine}”`);
      console.log(C.dim(`  tools:  ${look.toolCalls.join("  ") || "(none)"}`));
      console.log(C.dim(`  grounding verified: ${look.verified}`));
    }
  }

  let ok = true;
  const results: string[] = [];
  if (fx.expect) {
    const [conceptId, want] = fx.expect.split(":");
    const got = want === "silent" ? (alerts === 0 ? "silent" : "alerted") : (state.concepts[conceptId]?.state ?? "unseen");
    ok &&= got === want;
    results.push(`${conceptId} = ${want}, got ${got}`);
  }
  if (fx.expectAlert) {
    const got = state.alert?.kind ?? "none";
    ok &&= got === fx.expectAlert;
    results.push(`alert = ${fx.expectAlert}, got ${got}`);
  }
  if (!results.length) return true;
  console.log("");
  console.log(`  ${ok ? C.green("PASS") : C.red("FAIL")}  expected ${results.join(" · ")}`);
  return ok;
}

let failed = 0;
let skipped = 0;
for (const f of files) {
  const result = await replay(f);
  if (result === null) skipped++;
  else if (!result) failed++;
}
const ran = files.length - skipped;
console.log("");
const tail = skipped ? C.dim(` · ${skipped} skipped`) : "";
if (failed) {
  console.log(C.red(`${failed} of ${ran} fixtures failed`) + tail);
  process.exit(1);
}
console.log(C.green(`${ran} fixture${ran === 1 ? "" : "s"} passed`) + tail);
