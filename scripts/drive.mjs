/**
 * Drive a live session from the terminal, so the console can be rehearsed alone.
 *
 *   npm run drive                       # the false assent, into whichever session is live
 *   npm run drive -- fixtures/panel-misconception.json
 *   npm run drive -- --room pru-xxxx fixtures/re-ask.json
 *   npm run drive -- --list
 *
 * Against a deployment rather than localhost:
 *
 *   BASE=https://your-app.vercel.app npm run drive
 *
 * It pushes a fixture's turns to /api/agent/state as if they had been spoken, then polls until
 * the deep pass produces an alert and prints what the representative is now seeing.
 *
 * The session is found by reading `sess:room:*` straight from Upstash and taking the newest one
 * still active, which is why this is a rehearsal tool and not part of the app. It works against a
 * deployment because Upstash is the same store either way.
 *
 * One thing to expect: the injected lines do not appear in the console's transcript pane. That
 * pane renders what the browser itself captured, and these turns went to the server directly. The
 * alert, the readiness panel and the record all update normally.
 */

import { readFileSync } from "node:fs";
import { Redis } from "@upstash/redis";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? "");
};
const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const fixture = args.find((a) => a.endsWith(".json")) ?? "fixtures/false-assent.json";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function liveSessions() {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, { match: "sess:room:*", count: 100 });
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");

  const rooms = await Promise.all(keys.map((k) => redis.get(k)));
  return rooms
    .filter((s) => s && s.active)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

async function main() {
  if (args.includes("--list")) {
    const all = await liveSessions();
    if (!all) return fail("No Upstash credentials in this environment.");
    if (!all.length) return console.log("no active sessions — start one in the console first");
    for (const s of all) console.log(`  ${s.roomId}  ${s.context.productArea}  started ${s.startedAt}`);
    return;
  }

  let roomId = flag("room");
  if (!roomId) {
    const all = await liveSessions();
    if (!all) {
      return fail(
        "No Upstash credentials — pass --room pru-xxxx instead.\n" +
          "Find it in DevTools → Network → any 'state' request → Payload → roomId.",
      );
    }
    const [newest] = all;
    if (!newest) return fail("No active session. Start one in the console first, then run this again.");
    roomId = newest.roomId;
    console.log(`driving ${roomId} · ${newest.context.productArea} · ${BASE}\n`);
  }

  const login = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.REP_USERNAME, password: process.env.REP_PASSWORD }),
  });
  await login.json().catch(() => ({}));
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    return fail(
      `Could not sign in at ${BASE}.\n` +
        "Is the server up, and do REP_USERNAME / REP_PASSWORD here match the ones it was deployed with?",
    );
  }
  const H = { "Content-Type": "application/json", cookie };

  const fx = JSON.parse(readFileSync(fixture, "utf8"));
  const secs = (t) => {
    const [m, s] = t.split(":").map(Number);
    return m * 60 + (s || 0);
  };
  // Timed to end a moment ago, so the pauses between turns are the ones the fixture scripted and
  // the whole exchange is newer than anything the console has already sent.
  const span = secs(fx.turns[fx.turns.length - 1].t);
  const base = Date.now() - (span + 2) * 1000;
  const turns = fx.turns.map((t) => ({
    at: base + secs(t.t) * 1000,
    role: t.role,
    speaker: t.role === "rep" ? "Rep" : "Customer",
    text: t.text,
  }));

  for (const t of turns) console.log(`  ${t.role === "rep" ? "REP     " : "CUSTOMER"}  ${t.text}`);

  const res = await fetch(`${BASE}/api/agent/state`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ roomId, turns, final: true }),
  });
  if (!res.ok) return fail(`\n${BASE}/api/agent/state returned ${res.status}`);
  // The body must be read: an unread response stream defers the after() callback, so the deep
  // pass would never run.
  await res.json();

  console.log("\n  waiting for the deep pass…");
  let state = null;
  for (const ms of [2500, 3000, 4000, 5000, 6000]) {
    await wait(ms);
    state = await (await fetch(`${BASE}/api/agent/state?roomId=${encodeURIComponent(roomId)}`, { headers: H })).json();
    if (state.alert) break;
  }

  if (!state?.alert) {
    console.log("\n  no alert yet. Check the server log for an [agent] line saying why.");
  } else {
    const a = state.alert;
    console.log(`\n  ▲ ${a.headline}   (${a.kind} · ${a.label})`);
    console.log(`    “${a.quote}”`);
    console.log(`    ${a.detail}`);
    console.log(`    Ask: ${a.teachBack}`);
    console.log(`    ${a.citations.join(" · ")}`);
  }

  const touched = (state?.record ?? []).filter((r) => r.state !== "unseen").length;
  const open = (state?.record ?? []).filter((r) => r.risk).length;
  console.log(`\n  record: ${touched} concepts touched, ${open} still open`);
  if (state?.prepared) console.log(`  prepared for: “${state.prepared.question}”`);
  console.log("\n  The console should be showing this within five seconds.");
}

await main();
