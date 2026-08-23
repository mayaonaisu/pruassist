/**
 * End-to-end smoke test over HTTP, against a running server.
 *
 *   npm run build && npm start          # or: npx next start -p 3100
 *   npm run e2e                         # BASE=http://127.0.0.1:3100 npm run e2e
 *
 * The replay harness proves the ledger; this proves the wiring around it — auth, the session
 * record, the two-speed loop, `after()` actually firing, the teach-back act and its grade, the
 * lookahead and the cache hit it produces, and the evidence being deleted when the session ends.
 *
 * Run it against a Vercel preview too. `next dev` and `next start` both keep the process alive
 * forever, so neither proves `after()` survives on a real serverless invocation.
 *
 * Budget it. One full run spends around twenty Gemini calls, and the free tier allows twenty per
 * model per day and ten per minute. Two runs in a day will fail the lookahead half on quota, not
 * on anything wrong with the code — check the server log for a 429 and its quotaId before
 * believing otherwise. PRUASSIST_MODEL points at a different model with its own allowance.
 */

import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, pass, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function scriptedTurns(fixture, endingSecondsAgo = 120) {
  const fx = JSON.parse(readFileSync(fixture, "utf8"));
  const base = Date.now() - endingSecondsAgo * 1000;
  const secs = (t) => {
    const [m, s] = t.split(":").map(Number);
    return m * 60 + (s || 0);
  };
  return fx.turns.map((t) => ({
    at: base + secs(t.t) * 1000,
    role: t.role,
    speaker: t.role === "rep" ? "Bryan Eng" : "Customer",
    text: t.text,
  }));
}

/* ---------- sign in ---------- */

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: process.env.REP_USERNAME, password: process.env.REP_PASSWORD }),
});
await login.json();
check("rep can sign in", login.status === 200, login.status === 200 ? "" : `got ${login.status}`);
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
if (!cookie) {
  console.log("\nno session cookie — check REP_USERNAME / REP_PASSWORD / AUTH_SECRET");
  process.exit(1);
}
const H = { "Content-Type": "application/json", cookie };

const anon = await fetch(`${BASE}/api/agent/state?roomId=nope`);
check("comprehension state refuses anonymous callers", anon.status === 401, `got ${anon.status}`);

/* ---------- a session, and the customer's link ---------- */

const created = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ repName: "Bryan Eng", productArea: "Health Protection", focus: ["Hospital cover"] }),
});
const session = await created.json();
check("session created", Boolean(session.roomId), session.roomId);

const joined = await fetch(`${BASE}/api/session?token=${encodeURIComponent(session.joinToken)}`);
const joinInfo = await joined.json();
check("customer join link resolves without auth", joinInfo.active === true);

const post = async (body) => {
  const res = await fetch(`${BASE}/api/agent/state`, { method: "POST", headers: H, body: JSON.stringify(body) });
  // The body must be consumed: an unread response stream defers the after() callback, so the deep
  // pass would appear never to run.
  return res.json();
};
const read = async (roomId) =>
  (await fetch(`${BASE}/api/agent/state?roomId=${encodeURIComponent(roomId)}`, { headers: H })).json();

const until = async (roomId, done, waits) => {
  let state = await read(roomId);
  for (const ms of waits) {
    if (done(state)) return state;
    await wait(ms);
    state = await read(roomId);
  }
  return state;
};

/* ---------- the false assent, and the record it produces ---------- */

const turns = scriptedTurns("fixtures/false-assent.json", 180);
await post({ roomId: session.roomId, turns, final: true });

let state = await until(session.roomId, (s) => s.rev > 0, [3000, 4000, 6000, 8000]);
check("deep pass ran after the response was flushed", state.rev > 0, `rev=${state.rev}`);
check("false assent detected", state.alert?.kind === "false-assent", state.alert?.kind ?? "no alert");
check(
  "alert says asserted but never demonstrated",
  /Asserted .*never demonstrated/.test(state.alert?.detail ?? ""),
  state.alert?.detail,
);
check("alert cites brochure pages", (state.alert?.citations ?? []).length > 0);
check("alert carries a teach-back question", Boolean(state.alert?.teachBack));

const row = (s, id) => (s.record ?? []).find((r) => r.conceptId === id);
const deductible = row(state, "deductible-definition");
check("record row is asserted, not demonstrated", deductible?.state === "asserted", deductible?.state);
check("record quotes the customer's own words", deductible?.quote?.includes("makes sense") === true, deductible?.quote);
check("record leaves it open", Boolean(deductible?.risk), deductible?.risk);
check(
  "material concepts never raised are flagged",
  (state.record ?? []).filter((r) => r.state === "unseen" && r.risk).length > 0,
);

/* ---------- the teach-back, asked and graded ---------- */

if (state.alert) {
  await post({ roomId: session.roomId, act: { type: "teach-back-asked", conceptId: state.alert.conceptId } });
  await wait(1500);

  const answered = [
    ...turns,
    {
      at: Date.now(),
      role: "customer",
      speaker: "Customer",
      text: "I'd cover the first slice out of my own pocket, and that is only once for the whole year, then the insurance picks up the rest.",
    },
  ];
  await post({ roomId: session.roomId, turns: answered, final: true });

  const graded = await until(
    session.roomId,
    (s) => row(s, "deductible-definition")?.state === "demonstrated",
    [4000, 5000, 6000, 8000],
  );
  const gradedRow = row(graded, "deductible-definition");
  check("the teach-back answer is graded to demonstrated", gradedRow?.state === "demonstrated", gradedRow?.state);
  check("a demonstrated concept leaves nothing open", gradedRow?.risk === "", `"${gradedRow?.risk}"`);

  const withReadiness = await read(session.roomId);
  check("readiness rides the state poll", Boolean(withReadiness.readiness), withReadiness.readiness?.question);
  if (withReadiness.readiness) {
    const r = withReadiness.readiness;
    check("readiness names its options", r.options.length >= 2, r.options.map((o) => o.label).join(" · "));
    check(
      "readiness reports what is still open",
      r.ready === false && r.open.length + r.blocking.length > 0,
      `${r.settled}/${r.total} settled, next: ${r.nextQuestion?.slice(0, 60)}`,
    );
  }
}

await fetch(`${BASE}/api/session/end`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ roomId: session.roomId }),
});
const ended = await read(session.roomId);
check("ending the session deletes the comprehension evidence", ended.rev === 0 && !ended.alert, `rev=${ended.rev}`);
check("no quoted customer words remain", (ended.record ?? []).every((r) => !r.quote));

/* ---------- the lookahead, and the cache hit it earns ---------- */
// Its own session: the riskiest possible ledger state gives the background pass something obvious
// to prepare for, and a fresh room keeps this independent of everything above.
//
// The pause is for the free tier's per-minute ceiling, not for the app. Everything above spends
// around a dozen calls, and one lookahead is another six or seven; run back to back they trip the
// rate limit and this half fails for a reason that has nothing to do with the code.

const PACE_MS = Number(process.env.E2E_PACE_MS ?? 65_000);
if (PACE_MS > 0) {
  console.log(`  ...   pausing ${Math.round(PACE_MS / 1000)}s for the per-minute model quota (E2E_PACE_MS=0 to skip)`);
  await wait(PACE_MS);
}

const look = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ repName: "Bryan Eng", productArea: "Health Protection", focus: [] }),
});
const lookSession = await look.json();
await post({ roomId: lookSession.roomId, turns: scriptedTurns("fixtures/panel-misconception.json"), final: true });

const prepared = await until(lookSession.roomId, (s) => Boolean(s.prepared), [4000, 6000, 8000, 10000, 12000, 15000]);
check("misconception caught", prepared.alert?.kind === "misunderstood", prepared.alert?.kind);
check(
  "lookahead prepared an answer",
  Boolean(prepared.prepared),
  prepared.prepared ? `“${prepared.prepared.question}” · ${prepared.prepared.label}` : "none — check the log for a 429",
);

if (prepared.prepared) {
  check("lookahead used its tools", (prepared.prepared.toolCalls ?? []).length > 0, (prepared.prepared.toolCalls ?? []).join("  "));

  const ask = async (asked) => {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/assist`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ roomId: lookSession.roomId, transcript: `Bryan Eng: Let me explain.\nCustomer: ${asked}`, asked }),
    });
    return { data: await res.json(), ms: Date.now() - started };
  };

  const hit = await ask(prepared.prepared.question);
  check("the prepared question is served from cache", hit.data.cached === true, `${hit.ms}ms`);
  check("the served answer was grounding-verified before caching", hit.data.verified === true);
  check("the served answer has a line to say", Boolean(hit.data.suggestedLine));
  check("assist tags the response with an orchestrator mode", typeof hit.data.mode === "string", hit.data.mode);

  const miss = await ask("Can I pay the premium from MediSave?");
  check("an unrelated question is not served from cache", miss.data.cached !== true, `${miss.ms}ms`);
  if (hit.data.cached === true && miss.data.cached !== true && !miss.data.note) {
    check("the cache hit is the faster path", hit.ms < miss.ms, `${hit.ms}ms cached vs ${miss.ms}ms live`);
  }
}

await fetch(`${BASE}/api/session/end`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ roomId: lookSession.roomId }),
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
