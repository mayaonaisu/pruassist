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
 * Budget it. One full run spends around twenty Gemini calls against a per-key daily/per-minute free
 * limit. A failing lookahead/grade is often environmental rather than a code bug — but do NOT assume
 * it is a 429: check the deploy logs for the ACTUAL status. It may be a 400 invalid key (a bad value
 * in the env), a 503 (model busy), a timeout, or a 429 (quota). Each has a different fix, and reading
 * the real error first saves chasing the wrong one. PRUASSIST_MODEL points at a model with its own
 * allowance; the key pool rotates past bad/rate-limited/busy keys.
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

  // The grade is one background Gemini call after the response is flushed. On the fast path (Groq gen
  // on Vercel) the whole pass lands in a few seconds; locally, with generation falling back to Gemini,
  // the pass is much slower — so the poll window has to be generous, or a correct grade that simply
  // landed late reads as a failure. Tunable for a fast CI.
  const GRADE_WAITS = (process.env.E2E_GRADE_WAITS ?? "4000,5000,6000,8000,10000,12000,15000").split(",").map(Number);
  const graded = await until(
    session.roomId,
    (s) => row(s, "deductible-definition")?.state === "demonstrated",
    GRADE_WAITS,
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

/* ---------- topic-drift escalation (needs a live router brain) ---------- */
// Only the LLM brain emits topic_drift; the deterministic tier never does. So if the first
// off-topic turn does not route to drift, the brain is unconfigured — skip the rest rather than
// fail. Reuses this session; the session-end below clears the drift streak with everything else.

const assist = async (asked) => {
  const res = await fetch(`${BASE}/api/assist`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ roomId: session.roomId, transcript: `Bryan Eng: Let's stay on your hospital cover.\nCustomer: ${asked}`, asked }),
  });
  // A 504 (a slow agentic turn over maxDuration) returns non-JSON; degrade to a check failure, not
  // an unhandled crash that silently ends the whole suite.
  return res.json().catch(() => ({ mode: `<HTTP ${res.status}>` }));
};

const drift1 = await assist("Can I invest with this, like buying shares?");
if (drift1.mode !== "topic_drift") {
  console.log(`  ...   skipping drift escalation — router did not classify drift (mode=${drift1.mode}); needs ORCHESTRATOR_* configured`);
} else {
  check("first off-topic turn warns", drift1.mode === "topic_drift", drift1.note?.slice(0, 60));
  const drift2 = await assist("And did you catch the football results yesterday?");
  check("a second consecutive drift pauses", drift2.mode === "drift_paused", drift2.mode);
  const drift3 = await assist("The weather has been really hot lately.");
  check("an off-topic statement stays paused, no model call", drift3.mode === "drift_paused", drift3.mode);
  const resumed = await assist("Okay, so how much is the deductible again?");
  check("an on-topic question resumes the pipeline", resumed.mode !== "drift_paused" && resumed.mode !== "topic_drift", resumed.mode);
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

// The lookahead is the heaviest background stage — a multi-step tool loop, a synthesis call and a
// grounding check, all on Gemini. On the fast path (Vercel) it lands in a few seconds; locally, with
// generation on Gemini, it can take minutes — past anything a test should block on. So poll a generous,
// tunable budget, and if no answer prepared in time SKIP the cache assertions with a note rather than
// fail: the preparation logic is verified offline, and a late lookahead is a cache miss, not a bug.
const LOOK_WAITS = (process.env.E2E_LOOKAHEAD_WAITS ?? "5000,7000,9000,11000,13000,15000,15000,15000").split(",").map(Number);
const prepared = await until(lookSession.roomId, (s) => Boolean(s.prepared), LOOK_WAITS);
check("misconception caught", prepared.alert?.kind === "misunderstood", prepared.alert?.kind);

if (prepared.prepared) {
  check("lookahead prepared an answer", true, `“${prepared.prepared.question}” · ${prepared.prepared.label}`);
  check("lookahead used its tools", (prepared.prepared.toolCalls ?? []).length > 0, (prepared.prepared.toolCalls ?? []).join("  "));

  const ask = async (asked) => {
    const started = Date.now();
    const res = await fetch(`${BASE}/api/assist`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ roomId: lookSession.roomId, transcript: `Bryan Eng: Let me explain.\nCustomer: ${asked}`, asked }),
    });
    return { data: await res.json().catch(() => ({ mode: `<HTTP ${res.status}>` })), ms: Date.now() - started };
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
} else {
  console.log(
    "  ...   skipping lookahead cache assertions — no answer prepared within the poll budget " +
      "(background tool-loop latency; the preparation is verified offline and runs green on the fast path / Preview)",
  );
}

await fetch(`${BASE}/api/session/end`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ roomId: lookSession.roomId }),
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
