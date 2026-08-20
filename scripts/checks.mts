/**
 * Unit checks for the parts of the agent that are pure functions — the state machine's rank
 * guard, the scoring pass, the grounding figure check, the risk ranking, the record builder, and
 * the cache gate.
 *
 *   npm run check
 *
 * Deliberately dependency-free: node:test is built in, and adding a test framework to a hackathon
 * repo the day before the demo is not the trade this needs. The replay harness covers behaviour
 * end to end; this covers the pieces where a wrong edge case would be invisible there.
 *
 * Everything here runs offline except one cache check, which is skipped without GEMINI_API_KEY.
 */

import test from "node:test";
import assert from "node:assert/strict";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { CONCEPTS, conceptById, conceptsForArea } = await import("../src/lib/concepts.ts");
const { scorePass } = await import("../src/lib/agent/score.ts");
const { clauseById } = await import("../src/lib/knowledge.ts");
const { applyActs, applyDetections, buildRecord, chooseAlert } = await import("../src/lib/agent/ledger.ts");
const { rankByRisk } = await import("../src/lib/agent/lookahead.ts");
const { matchesLookahead } = await import("../src/lib/agent/cache.ts");
const { isBareAssent, isQuestion } = await import("../src/lib/agent/utterance.ts");
const { runSignals } = await import("../src/lib/agent/signals.ts");
const { unsupportedFigures } = await import("../src/lib/agent/verify.ts");
const { emptyState } = await import("../src/lib/agent/types.ts");

type Detection = import("../src/lib/agent/types.ts").Detection;
type Lookahead = import("../src/lib/agent/types.ts").Lookahead;
type Turn = import("../src/lib/agent/types.ts").Turn;

const AREA = "Health Protection";
const AT = Date.UTC(2026, 7, 20, 6, 30, 0);

function detection(over: Partial<Detection>): Detection {
  return {
    conceptId: "deductible-definition",
    kind: "uptake",
    argues: "raised",
    turnIndex: 0,
    at: AT,
    quote: "q",
    detail: "d",
    score: 1,
    ...over,
  };
}

/* ---------- the concept map has to stay citable ---------- */

test("every concept anchors to clauses that exist", () => {
  for (const c of CONCEPTS) {
    assert.ok(c.clauseIds.length > 0, `${c.id} has no clause ids`);
    for (const id of c.clauseIds) assert.ok(clauseById(id), `${c.id} cites missing clause ${id}`);
    assert.ok(c.misconceptions.length > 0, `${c.id} has no misconceptions to detect`);
    assert.ok(c.teachBack.trim().length > 0, `${c.id} has no teach-back question`);
  }
});

/* ---------- the rank guard is the whole state machine ---------- */

test("assent never downgrades a demonstrated concept", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ argues: "demonstrated", kind: "uptake" })]);
  s = applyDetections(s, [detection({ argues: "asserted", kind: "assent", at: AT + 1000, turnIndex: 1 })]);
  assert.equal(s.concepts["deductible-definition"].state, "demonstrated");
});

test("a later misconception overrides an earlier demonstration", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ argues: "demonstrated" })]);
  s = applyDetections(s, [detection({ argues: "misunderstood", at: AT + 1000, turnIndex: 1 })]);
  assert.equal(s.concepts["deductible-definition"].state, "misunderstood");
});

test("re-scoring the same turn does not stack duplicate evidence", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ argues: "asserted", kind: "assent" })]);
  s = applyDetections(s, [detection({ argues: "asserted", kind: "assent" })]);
  assert.equal(s.concepts["deductible-definition"].evidence.length, 1);
});

test("a graded teach-back is recorded once", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ kind: "explain-back", argues: "demonstrated" })]);
  assert.equal(s.concepts["deductible-definition"].explainBackGradedAt, AT);
});

/* ---------- alerts ---------- */

test("a bare assent raises a false-assent alert; a dismissal silences it", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [
    detection({ argues: "raised" }),
    detection({ argues: "asserted", kind: "assent", at: AT + 1000, turnIndex: 1 }),
  ]);
  assert.equal(chooseAlert(s)?.kind, "false-assent");
  assert.equal(chooseAlert({ ...s, dismissed: ["deductible-definition"] }), null);
});

test("an alert never fires without something the customer said", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ argues: "raised" })]);
  assert.equal(chooseAlert(s), null);
});

/* ---------- the record ---------- */

test("the record quotes the customer only where they showed something", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ argues: "raised" })]);
  const raised = buildRecord(s).find((r) => r.conceptId === "deductible-definition")!;
  assert.equal(raised.quote, "");
  assert.equal(raised.state, "raised");

  s = applyDetections(s, [
    detection({ argues: "asserted", kind: "assent", at: AT + 1000, turnIndex: 1, quote: "okay" }),
  ]);
  const asserted = buildRecord(s).find((r) => r.conceptId === "deductible-definition")!;
  assert.equal(asserted.quote, "okay");
  assert.match(asserted.risk, /never demonstrated/);
});

test("material concepts that never came up are flagged, optional ones are not", () => {
  const rows = buildRecord(emptyState("r", AREA));
  const material = rows.find((r) => r.conceptId === "panel-providers")!;
  const optional = rows.find((r) => r.conceptId === "limits-of-cover")!;
  assert.equal(material.state, "unseen");
  assert.match(material.risk, /Not covered/);
  assert.equal(optional.risk, "");
});

/* ---------- lookahead risk order ---------- */

test("risk order puts a misconception above a bare assent, and both above silence", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [
    detection({ conceptId: "panel-providers", argues: "misunderstood" }),
    detection({ conceptId: "co-insurance", argues: "raised", turnIndex: 1, at: AT + 1000 }),
    detection({ conceptId: "co-insurance", argues: "asserted", kind: "assent", turnIndex: 2, at: AT + 2000 }),
  ]);
  const order = rankByRisk(s).map((c) => c.id);
  assert.equal(order[0], "panel-providers");
  assert.equal(order[1], "co-insurance");
  assert.ok(order.includes("stop-loss"), "a material concept never raised is still worth preparing");
});

test("a demonstrated concept is not worth preparing for", () => {
  let s = emptyState("r", AREA);
  s = applyDetections(s, [detection({ conceptId: "stop-loss", argues: "demonstrated" })]);
  assert.ok(!rankByRisk(s).some((c) => c.id === "stop-loss"));
});

/* ---------- grounding: the figures have to come from the pages ---------- */

test("figures present in the cited clauses pass", () => {
  const clauses = [clauseById("deductible-amounts")!];
  assert.deepEqual(unsupportedFigures("The A ward deductible is S$3,500 per policy year.", clauses), []);
});

test("a figure that is nowhere in the clauses is reported", () => {
  const clauses = [clauseById("deductible-amounts")!];
  assert.deepEqual(unsupportedFigures("The A ward deductible is S$4,250.", clauses), ["4250"]);
});

test("small numbers and years are not treated as policy figures", () => {
  const clauses = [clauseById("co-insurance")!];
  assert.deepEqual(unsupportedFigures("There are 3 tiers, revised in 2026.", clauses), []);
});

/* ---------- utterance shape ---------- */

test("bare assent is assent and nothing more", () => {
  assert.equal(isBareAssent("Okay, yeah, that makes sense."), true);
  assert.equal(isBareAssent("Right, okay."), true);
  assert.equal(isBareAssent("Yes — so I pay the first chunk myself each year."), false);
  assert.equal(isBareAssent("What happens if I go private?"), false);
});

test("questions are recognised with and without the question mark", () => {
  assert.equal(isQuestion("how much would I pay"), true);
  assert.equal(isQuestion("so any hospital is fine then?"), true);
  assert.equal(isQuestion("so any hospital is fine then"), false);
});

/* ---------- the detectors ---------- */

// The split moved six detectors behind one internal seam. These pin the rules that used to be
// expressed by where the code sat in a single loop — a `continue`, and two separate loops — and
// are now expressed as facts on the context. Nothing else asserts them.

const DEDUCTIBLE_EXPLAINED = "The deductible is the amount you pay yourself first, once per policy year, before MediShield Life or PRUShield pays anything.";

async function detectionsFor(script: [role: "rep" | "customer", text: string, offset: number][], index?: number) {
  const turns: Turn[] = script.map(([role, text, offset]) => ({
    at: AT + offset * 1000,
    role,
    speaker: role,
    text,
  }));
  const from = index ?? turns.length - 1;
  const { detections } = await runSignals(turns, conceptsForArea(AREA), from);
  return detections;
}

test("a bare assent suppresses uptake, divergence and re-ask", async () => {
  const kinds = (
    await detectionsFor([
      ["rep", DEDUCTIBLE_EXPLAINED, 0],
      ["customer", "Okay, yeah, that makes sense.", 8],
    ])
  ).map((d) => d.kind);
  assert.ok(kinds.includes("assent"), "the assent itself must still be detected");
  assert.deepEqual(
    kinds.filter((k) => k === "uptake" || k === "divergence" || k === "re-ask"),
    [],
    "a contentless agreement was scored as if it had content",
  );
});

test("assent only counts against something the rep just said", async () => {
  // The same words, but answering another customer turn rather than the rep. Not a bare assent,
  // so the downstream detectors are free to run.
  const kinds = (
    await detectionsFor([
      ["rep", DEDUCTIBLE_EXPLAINED, 0],
      ["customer", "Let me think about that for a second.", 8],
      ["customer", "Okay, yeah, that makes sense.", 14],
    ])
  ).map((d) => d.kind);
  assert.ok(!kinds.includes("assent"));
});

test("only rep turns raise a concept", async () => {
  const fromRep = await detectionsFor([["rep", DEDUCTIBLE_EXPLAINED, 0]], 0);
  assert.deepEqual(
    fromRep.map((d) => d.argues),
    ["raised"],
  );

  // A customer using the same words is scored, never credited with raising it.
  const fromCustomer = await detectionsFor([["customer", DEDUCTIBLE_EXPLAINED, 0]], 0);
  assert.ok(!fromCustomer.some((d) => d.argues === "raised"));
});

test("a pause is reported above two seconds and not below", async () => {
  // "Okay." is ~0.4s of speech, so the gap is the offset minus roughly that.
  const quick = await detectionsFor([
    ["rep", DEDUCTIBLE_EXPLAINED, 0],
    ["customer", "Okay.", 1],
  ]);
  assert.ok(!quick.some((d) => d.kind === "latency"), "reported a pause that was not there");

  const slow = await detectionsFor([
    ["rep", DEDUCTIBLE_EXPLAINED, 0],
    ["customer", "Okay.", 6],
  ]);
  assert.ok(slow.some((d) => d.kind === "latency"), "missed a five-second silence");
  assert.ok(
    slow.every((d) => d.kind !== "latency" || d.argues === null),
    "timing must never argue for a state",
  );
});

test("dropping every qualifier the rep used is a divergence", async () => {
  const detections = await detectionsFor([
    [
      "rep",
      "Using a panel or Extended Panel provider is what unlocks the cover; at a non-panel provider the deductible is not covered and stop-loss does not apply.",
      0,
    ],
    ["customer", "So I would just pick whichever hospital and any doctor I like.", 12],
  ]);
  const divergence = detections.filter((d) => d.kind === "divergence");
  assert.equal(divergence.length, 1, `expected one divergence, got ${JSON.stringify(detections.map((d) => d.kind))}`);
  assert.equal(divergence[0].conceptId, "panel-providers");
  assert.match(divergence[0].detail, /Dropped the qualifier/);
});

/* ---------- the scoring pass ---------- */

const POOL = conceptsForArea(AREA);

function turn(role: "rep" | "customer", text: string, offsetSeconds: number): Turn {
  return { at: AT + offsetSeconds * 1000, role, speaker: role, text };
}

const EXPLAINED = turn("rep", "The deductible is the amount you pay yourself first, once per policy year, before MediShield Life or PRUShield pays anything.", 0);
const AGREED = turn("customer", "Okay, yeah, that makes sense.", 8);
const ASKED_LATER = turn("customer", "How much would I actually have to pay upfront on the day?", 40);

test("scorePass scores only what is past the cursor, and advances it", async () => {
  const first = await scorePass({ state: emptyState("r", AREA), turns: [EXPLAINED, AGREED], pool: POOL, budget: 0 });
  assert.equal(first.scoredFrom, 0);
  assert.ok(first.detections.length > 0);
  assert.equal(first.state.cursorAt, AGREED.at);

  // Same turns again: nothing is new, so nothing is scored and the caller can skip the write.
  const again = await scorePass({ state: first.state, turns: [EXPLAINED, AGREED], pool: POOL, budget: 0 });
  assert.equal(again.scoredFrom, -1);
  assert.deepEqual(again.detections, []);
  assert.equal(again.changed, false);

  // One more turn: only that turn is scored, not the whole window again.
  const third = await scorePass({
    state: first.state,
    turns: [EXPLAINED, AGREED, ASKED_LATER],
    pool: POOL,
    budget: 0,
  });
  assert.equal(third.scoredFrom, 2);
  // Non-vacuous: the third turn does produce detections, so `every` below is actually testing.
  assert.ok(third.detections.length > 0);
  assert.ok(third.detections.every((d) => d.at === ASKED_LATER.at), "re-scored a turn already behind the cursor");
  assert.equal(third.state.cursorAt, ASKED_LATER.at);
});

test("at zero budget the detectors still run but nothing is graded", async () => {
  // A concept with an outstanding teach-back and a substantive answer after it — the one shape
  // that would spend a model call. Without GEMINI_API_KEY the grader declines anyway, so this
  // pins the gate rather than the grader: the assertion is that no explain-back reaches the
  // ledger, and that the deterministic detectors are unaffected by the budget being spent.
  let state = emptyState("r", AREA);
  state = applyActs(state, [{ type: "teach-back-asked", conceptId: "deductible-definition", at: AT }]);

  const answered = turn("customer", "I would cover the first slice myself and then the insurance takes over.", 20);
  const scored = await scorePass({ state, turns: [EXPLAINED, answered], pool: POOL, budget: 0 });

  assert.ok(scored.detections.length > 0, "detectors are not gated by the model budget");
  assert.ok(!scored.detections.some((d) => d.kind === "explain-back"), "graded with no budget for it");
});

/* ---------- the cache gate ---------- */

function lookahead(over: Partial<Lookahead> = {}): Lookahead {
  const c = conceptById("panel-providers")!;
  return {
    conceptId: c.id,
    label: c.label,
    question: "Is the coverage the same whichever hospital I go to?",
    pointers: { concern: "", firstStep: "", suggestedLine: "line", explainer: "", comparison: "", followUp: "" },
    sources: [],
    citations: [],
    toolCalls: [],
    verified: true,
    preparedAt: Date.now(),
    rev: 1,
    ...over,
  };
}

test("an unrelated question never hits the cache", async () => {
  const r = await matchesLookahead(lookahead(), "Can I pay the premium from MediSave?");
  assert.equal(r.hit, false);
});

test("a stale or unverified answer is never served", async () => {
  assert.equal((await matchesLookahead(lookahead({ preparedAt: 0 }), "Is the coverage the same whichever hospital I go to?")).hit, false);
  assert.equal((await matchesLookahead(lookahead({ verified: false }), "Is the coverage the same whichever hospital I go to?")).hit, false);
  assert.equal((await matchesLookahead(null, "anything")).hit, false);
});

test(
  "the question it was prepared for hits",
  { skip: process.env.GEMINI_API_KEY ? false : "needs embeddings" },
  async () => {
    const r = await matchesLookahead(lookahead(), "So is the cover the same no matter which hospital I go to?");
    assert.equal(r.hit, true, `expected a hit, scored ${r.score}`);
  },
);
