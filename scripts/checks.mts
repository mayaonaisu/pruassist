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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
// The drift-resume checks exercise the deterministic leg of judgePausedTurn, so the router brain
// must be unconfigured here — otherwise .env.local (loaded by `npm run check`) would hand these
// tests a live OpenRouter call.
delete process.env.ORCHESTRATOR_BASE_URL;
delete process.env.ORCHESTRATOR_MODEL;
delete process.env.ORCHESTRATOR_API_KEY;

const { CONCEPTS, conceptById, conceptsForArea } = await import("../src/lib/concepts.ts");
const { scorePass } = await import("../src/lib/agent/score.ts");
const { clauseById, knowledgeDocuments, KNOWLEDGE } = await import("../src/lib/knowledge.ts");
const { applyActs, applyDetections, buildRecord, chooseAlert, saveState, loadState } = await import("../src/lib/agent/ledger.ts");
const { getStore } = await import("../src/lib/store.ts");
const { callWithRetry } = await import("../src/lib/agent/gemini.ts");
const { resetPool, isInvalidKeyError } = await import("../src/lib/genai.ts");
const { buildComplianceRecord, renderComplianceHtml } = await import("../src/lib/agent/record.ts");
const { rankByRisk, anchorClauses } = await import("../src/lib/agent/lookahead.ts");
const { matchesLookahead } = await import("../src/lib/agent/cache.ts");
const { isBareAssent, isQuestion } = await import("../src/lib/agent/utterance.ts");
const { prepare, runSignals } = await import("../src/lib/agent/signals.ts");
const { detectAssent, detectDivergence, detectLatency, detectRaised, detectReAsk, detectUptake } = await import("../src/lib/agent/detectors.ts");
const { unsupportedFigures } = await import("../src/lib/agent/verify.ts");
const { emptyState } = await import("../src/lib/agent/types.ts");
const { lastFromCustomer, newestAt, toTurns, windowToSend, applyLineEdit, applySpeakerSwap, groupCitations } = await import("../src/lib/transcript.ts");
const { splitRuns, emptySpeakerMap, attributeFinal, interimRole } = await import("../src/lib/diarize.ts");
const { createResampler, floatTo16BitPCM } = await import("../src/lib/pcm.ts");
const { DECISIONS, decisionById, decisionsForArea, looksComparative } = await import("../src/lib/decisions.ts");
const { activeDecision, readinessFor } = await import("../src/lib/agent/readiness.ts");
const { decideMode } = await import("../src/lib/agent/orchestrator/modes.ts");
const { resolveHotkey } = await import("../src/lib/hotkeys.ts");
const { chunkLines, toClauses, textToLines } = await import("../src/lib/ingest.ts");
const { addTextSource, listSources, removeSource, customClauses } = await import("../src/lib/custom-kb.ts");
const { DOCUMENTS, documentFor, locateSource } = await import("../src/lib/documents.ts");
const { reduceBoard, autoFocus, conceptsInPlay, conceptCard, sourceCard, figuresIn } = await import("../src/lib/board.ts");
const { runOrchestrator } = await import("../src/lib/agent/orchestrator/graph.ts");
const { handleGuider, agenticLiveEnabled } = await import("../src/lib/agent/orchestrator/handlers.ts");
const { DRIFT_PAUSE_AFTER, RESETS_DRIFT, loadDrift, recordDrift, clearDrift, judgePausedTurn } = await import("../src/lib/agent/orchestrator/drift.ts");
const { fixTerms } = await import("../src/lib/terms.ts");

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
    // Only `raised` comes from a rep turn, so this is the right default for fabricated
    // detections. Production never guesses — the detector copies it off the turn.
    role: over.argues === "raised" || over.argues === undefined ? "rep" : "customer",
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

test("the lookahead prefers a concept blocking the decision in play", () => {
  // Two concepts at the same ledger state; only one decides the comparison being discussed.
  // `limits-of-cover` is declared after `medisave-premiums` in CONCEPTS, so at equal risk the
  // stable sort puts medisave first — the assertion only holds once the decision bonus exists.
  let s = emptyState("r", AREA);
  s = applyDetections(s, [
    detection({ conceptId: "medisave-premiums", argues: "asserted", kind: "assent" }),
    detection({ conceptId: "limits-of-cover", argues: "asserted", kind: "assent", turnIndex: 1, at: AT + 1000 }),
    // Puts which-tier in play: limits-of-cover and pro-ration are its differentiators, medisave is not.
    detection({ conceptId: "pro-ration", argues: "asserted", kind: "assent", turnIndex: 2, at: AT + 2000 }),
  ]);
  const order = rankByRisk(s).map((c) => c.id);
  assert.ok(
    order.indexOf("limits-of-cover") < order.indexOf("medisave-premiums"),
    `expected a which-tier differentiator first, got ${order.join(" > ")}`,
  );
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

test("role is carried from the turn, never derived from what the detector argues", async () => {
  const turns: Turn[] = [
    { at: AT, role: "rep", speaker: "rep", text: DEDUCTIBLE_EXPLAINED },
    { at: AT + 8000, role: "customer", speaker: "customer", text: "So I pay the first chunk myself each year, and only after that does the insurance start paying." },
    { at: AT + 20000, role: "customer", speaker: "customer", text: "How much would I have to pay upfront on the day?" },
  ];
  const { detections } = await runSignals(turns, conceptsForArea(AREA), 0);
  assert.ok(detections.length > 0);
  for (const d of detections) {
    assert.equal(d.role, turns[d.turnIndex].role, `${d.kind} on turn ${d.turnIndex} carried the wrong role`);
  }

  // And the ledger copies it rather than re-deriving. A rep-side detection that argues something
  // other than `raised` does not exist today; the point is that if one ever did, the record would
  // not quote the representative as if the customer had said it.
  const s = applyDetections(emptyState("r", AREA), [
    detection({ argues: "asserted", kind: "assent", role: "rep", quote: "the rep said this" }),
  ]);
  assert.equal(s.concepts["deductible-definition"].evidence[0].role, "rep");
});

test("a detector can be driven on its own", async () => {
  // Directly, not through the sweep — this is what splitting them was for. `prepare` builds the
  // contexts so the check does not have to restate the setup runSignals owns.
  const turns: Turn[] = [
    { at: AT, role: "rep", speaker: "rep", text: DEDUCTIBLE_EXPLAINED },
    { at: AT + 9000, role: "customer", speaker: "customer", text: "Okay." },
  ];
  const { contexts } = await prepare(turns, conceptsForArea(AREA), 0);
  const [repTurn, assentTurn] = contexts;

  // Each detector answers for itself, in any order, with no sweep around it.
  assert.equal(detectRaised(repTurn).length > 0, true);
  assert.deepEqual(detectRaised(assentTurn), [], "raised is rep-only");
  assert.deepEqual(detectAssent(repTurn), [], "assent is customer-only");
  assert.equal(detectAssent(assentTurn).length > 0, true);
  assert.deepEqual(detectUptake(assentTurn), [], "a bare assent has nothing to score");
  assert.deepEqual(detectDivergence(assentTurn), []);
  assert.deepEqual(detectReAsk(assentTurn), []);
  assert.equal(detectLatency(assentTurn).length > 0, true, "nine seconds is a pause");
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

/* ---------- decisions ---------- */

test("every decision anchors to real clauses and real concepts", () => {
  for (const d of DECISIONS) {
    assert.ok(d.options.length >= 2, `${d.id} needs at least two options`);
    assert.ok(d.differentiators.length > 0, `${d.id} has no differentiators`);
    for (const o of d.options) {
      assert.ok(o.clauseIds.length > 0, `${d.id}/${o.id} cites no clauses`);
      for (const id of o.clauseIds) assert.ok(clauseById(id), `${d.id}/${o.id} cites missing clause ${id}`);
      assert.ok(o.gist.trim().length > 0, `${d.id}/${o.id} has no gist`);
    }
    for (const id of [...d.prerequisites, ...d.differentiators]) {
      assert.ok(conceptById(id), `${d.id} names missing concept ${id}`);
    }
    // A concept cannot both underpin the comparison and decide it.
    for (const id of d.differentiators) {
      assert.ok(!d.prerequisites.includes(id), `${d.id} lists ${id} as both`);
    }
  }
});

test("decisions are scoped to a product area and addressable by id", () => {
  assert.ok(decisionsForArea(AREA).length >= 2);
  assert.deepEqual(decisionsForArea("Retirement"), []);
  assert.equal(decisionById("which-tier")?.id, "which-tier");
  assert.equal(decisionById("nope"), undefined);
});

test("a comparison question is recognised, an explanation question is not", () => {
  const tier = decisionById("which-tier")!;
  assert.equal(looksComparative("What is the difference between Premier and Plus?", tier), true);
  assert.equal(looksComparative("Which plan should I take?", tier), true);
  assert.equal(looksComparative("What is a deductible?", tier), false);
});

/* ---------- readiness ---------- */

// Builds a ledger in which the named concepts have reached the named states.
function ledgerWith(pairs: [string, "raised" | "asserted" | "demonstrated" | "misunderstood"][]) {
  let s = emptyState("r", AREA);
  pairs.forEach(([conceptId, argues], i) => {
    s = applyDetections(s, [detection({ conceptId, argues, turnIndex: i, at: AT + i * 1000 })]);
  });
  return s;
}

test("a recommendation is not ready while a differentiator is unshown", () => {
  const tier = decisionById("which-tier")!;
  const r = readinessFor(tier, ledgerWith([
    ["deductible-definition", "demonstrated"],
    ["pro-ration", "demonstrated"],
    ["deductible-amounts", "demonstrated"],
    ["limits-of-cover", "asserted"],
  ]));
  assert.equal(r.ready, false);
  // Only differentiators are counted: the prerequisite demonstrated above is not one of them.
  assert.equal(r.settled, 2);
  assert.equal(r.total, 3);
  assert.ok(r.open.some((s) => s.conceptId === "limits-of-cover"));
  assert.equal(r.nextConceptId, "limits-of-cover");
  assert.ok(r.nextQuestion && r.nextQuestion.length > 0);
});

test("a recommendation is ready once every differentiator is shown", () => {
  const tier = decisionById("which-tier")!;
  const r = readinessFor(tier, ledgerWith([
    ["pro-ration", "demonstrated"],
    ["deductible-amounts", "demonstrated"],
    ["limits-of-cover", "demonstrated"],
  ]));
  assert.equal(r.ready, true, "prerequisites must not gate the recommendation");
  assert.equal(r.nextConceptId, "deductible-definition", "but an unsettled prerequisite is still worth asking");
});

test("a misunderstood concept blocks, and never counts as merely open", () => {
  const tier = decisionById("which-tier")!;
  const r = readinessFor(tier, ledgerWith([
    ["pro-ration", "misunderstood"],
    ["deductible-amounts", "demonstrated"],
    ["limits-of-cover", "demonstrated"],
  ]));
  assert.equal(r.ready, false);
  assert.deepEqual(r.blocking.map((s) => s.conceptId), ["pro-ration"]);
  assert.ok(!r.open.some((s) => s.conceptId === "pro-ration"));
  assert.equal(r.nextConceptId, "pro-ration", "correcting a misconception outranks everything");
});

test("the next question prefers agreed-but-unshown over never-raised", () => {
  const tier = decisionById("which-tier")!;
  const r = readinessFor(tier, ledgerWith([["deductible-amounts", "asserted"]]));
  assert.equal(r.nextConceptId, "deductible-amounts");
});

test("the active decision is the one the conversation is actually about", () => {
  assert.equal(activeDecision(emptyState("r", AREA)), null);
  assert.equal(activeDecision(ledgerWith([["pro-ration", "asserted"]]))?.id, "which-tier");
  assert.equal(activeDecision(ledgerWith([["stop-loss", "asserted"], ["panel-providers", "misunderstood"]]))?.id, "add-pruextra");
});

/* ---------- the orchestrator router (deterministic tier) ---------- */

// decideMode is the deterministic fallback AND the offline oracle. It is trusted on the core three
// modes; guider / clarification / topic_drift are LLM-brain modes, so the fallback leaves a bare
// statement at keep_listening rather than risk a wrong interjection when the model is unavailable.
function routerInput(asked: string, state = emptyState("r", AREA)) {
  return { asked, transcript: asked, state, scope: AREA };
}

test("router: a bare assent keeps listening", () => {
  assert.equal(decideMode(routerInput("Okay, thanks.")).mode, "keep_listening");
  assert.equal(decideMode(routerInput("Right, okay.")).mode, "keep_listening");
});

test("router: a comparative question about the active decision routes to comparison", () => {
  // pro-ration + deductible-amounts are which-tier differentiators, so which-tier is the active decision.
  const s = ledgerWith([["pro-ration", "asserted"], ["deductible-amounts", "asserted"]]);
  assert.equal(decideMode(routerInput("So which plan would be better for me, Premier or Plus?", s)).mode, "comparison");
});

test("router: an in-scope question routes to policy guidance", () => {
  assert.equal(decideMode(routerInput("Why do I need PRUExtra?")).mode, "policy_guidance");
  assert.equal(decideMode(routerInput("How much is the deductible?")).mode, "policy_guidance");
});

test("router: the deterministic tier leaves a bare statement at keep_listening", () => {
  // guider is an LLM-brain mode; with the brain down the safe fallback is silence, not a guess.
  assert.equal(decideMode(routerInput("I really like PRUShield.")).mode, "keep_listening");
});

test("router: a clearly off-scope statement is flagged as drift, even with the brain down", () => {
  // The deterministic tier used to stay silent on drift; a high-precision off-domain cue now catches
  // it, so drift no longer depends solely on the LLM brain classifying it.
  assert.equal(decideMode(routerInput("The weather has been really hot lately.")).mode, "topic_drift");
  assert.equal(decideMode(routerInput("Did you catch the football last night?")).mode, "topic_drift");
});

test("router: finance chatter is off-scope in Health Protection, but not in a scope where it belongs", () => {
  assert.equal(decideMode(routerInput("Can I invest in stocks with this instead?")).mode, "topic_drift");
  // In a Retirement scope, investing is on-topic — only the universal social cues apply there.
  const inRetirement = { asked: "Can I invest more each month?", transcript: "Can I invest more each month?", state: emptyState("r", "Retirement"), scope: "Retirement" };
  assert.notEqual(decideMode(inRetirement).mode, "topic_drift");
});

test("router: an off-domain word alongside an in-scope concept is not drift", () => {
  // Names the deductible — a policy question that happens to mention investing, not a drift.
  assert.notEqual(decideMode(routerInput("Is paying the deductible like investing my money?")).mode, "topic_drift");
  // And a plain in-scope question is never mistaken for drift.
  assert.equal(decideMode(routerInput("How much is the deductible?")).mode, "policy_guidance");
});

test("the agentic live path is on by default and off only when explicitly disabled", () => {
  // The quota safety valve: with it off, the live handlers use the cheap single-retrieve path.
  const prior = process.env.PRUASSIST_AGENTIC_LIVE;
  delete process.env.PRUASSIST_AGENTIC_LIVE;
  assert.equal(agenticLiveEnabled(), true, "default on");
  process.env.PRUASSIST_AGENTIC_LIVE = "0";
  assert.equal(agenticLiveEnabled(), false, "0 disables the tool loop on the live path");
  process.env.PRUASSIST_AGENTIC_LIVE = "1";
  assert.equal(agenticLiveEnabled(), true);
  if (prior === undefined) delete process.env.PRUASSIST_AGENTIC_LIVE;
  else process.env.PRUASSIST_AGENTIC_LIVE = prior;
});

test("guider spends no model call when the remark names no concept", async () => {
  // Hermetic: with no concept named the handler returns before any retrieve/generate, so this
  // pins the Gemini-burn guard without touching the network.
  const r = await handleGuider({ asked: "I need to think about it.", transcript: "Customer: I need to think about it.", state: emptyState("r", AREA), scope: AREA });
  assert.equal(r.mode, "keep_listening");
  assert.ok(!r.pointers);
});

test("the LangGraph orchestrator compiles and the wake-gate short-circuits an ack", async () => {
  // Hermetic: a bare assent is caught by the wake-gate before any brain call or retrieval, so this
  // proves the graph builds and invokes without touching the network.
  const r = await runOrchestrator({ asked: "Okay, thanks.", transcript: "Customer: Okay, thanks.", state: emptyState("r", AREA), scope: AREA });
  assert.equal(r.mode, "keep_listening");
  assert.ok(!r.pointers);
});

test("a preset mode dispatches straight to its handler without the router", async () => {
  // presetMode is the drift-resume path: the mode was already decided, so the graph must not
  // classify again. keep_listening is a no-network handler, so this stays hermetic.
  const r = await runOrchestrator({ asked: "How much is the deductible?", transcript: "Customer: How much is the deductible?", state: emptyState("r", AREA), scope: AREA, presetMode: "keep_listening" });
  assert.equal(r.mode, "keep_listening");
});

/* ---------- topic-drift escalation (warn → pause → resume) ---------- */

test("drift warns once, then pauses on the second consecutive drift", async () => {
  const room = "drift-count";
  await clearDrift(room);
  const first = await recordDrift(room, await loadDrift(room));
  assert.equal(first.count, 1);
  assert.equal(first.pausedAt, null, "one drift is a warning, not a pause");
  const second = await recordDrift(room, first);
  assert.equal(second.count, DRIFT_PAUSE_AFTER);
  assert.ok(second.pausedAt, "the second consecutive drift pauses");
  assert.deepEqual(await loadDrift(room), second, "the streak round-trips through the store");
});

test("clearing drift returns to the zero state", async () => {
  const room = "drift-clear";
  await recordDrift(room, await recordDrift(room, await loadDrift(room)));
  await clearDrift(room);
  assert.deepEqual(await loadDrift(room), { count: 0, pausedAt: null });
});

test("only substantive result modes reset a drift streak", () => {
  assert.ok(RESETS_DRIFT.has("policy_guidance"));
  assert.ok(RESETS_DRIFT.has("comparison"));
  assert.ok(RESETS_DRIFT.has("guider"));
  assert.ok(RESETS_DRIFT.has("clarification"));
  // A quiet turn must not grant amnesty to an off-topic streak.
  assert.ok(!RESETS_DRIFT.has("keep_listening"));
  assert.ok(!RESETS_DRIFT.has("topic_drift"));
});

test("while paused, an on-topic turn resumes (deterministic leg, no brain configured)", async () => {
  // The brain env is deleted above, so judgePausedTurn falls to decideMode — proving the pause is
  // never a dead end even when the router is down.
  const question = await judgePausedTurn({ asked: "How much is the deductible?", transcript: "Customer: How much is the deductible?", state: emptyState("r", AREA), scope: AREA });
  assert.deepEqual(question, { resume: "policy_guidance" });

  const s = ledgerWith([["pro-ration", "asserted"], ["deductible-amounts", "asserted"]]);
  const compare = await judgePausedTurn({ asked: "So which plan, Premier or Plus?", transcript: "Customer: So which plan, Premier or Plus?", state: s, scope: AREA });
  assert.deepEqual(compare, { resume: "comparison" });
});

test("while paused, an off-topic statement stays paused and spends no model call", async () => {
  // A fetch here would be the brain call; with the brain unconfigured judgePausedTurn must decide
  // from the deterministic tier alone. The thrower proves nothing reached the network.
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const verdict = await judgePausedTurn({ asked: "The traffic on the way here was terrible.", transcript: "Customer: The traffic on the way here was terrible.", state: emptyState("r", AREA), scope: AREA });
    assert.deepEqual(verdict, { paused: true });
    assert.equal(fetches, 0, "no brain call went out");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- transcript term correction ---------- */

test("fixTerms rewrites mis-heard domain terms to canonical spelling", () => {
  assert.equal(fixTerms("i want peru shield"), "i want PRUShield");
  assert.equal(fixTerms("tell me about pru active protect"), "tell me about PRUActive Protect");
  assert.equal(fixTerms("can i pay from medi save"), "can i pay from MediSave");
  assert.equal(fixTerms("what about the co insurance"), "what about the co-insurance");
});

test("fixTerms canonicalizes product tiers, rider variants and PRUPanel Connect", () => {
  // Multiword names must resolve before the bare product name (RULES sorts longest-alias-first).
  assert.equal(fixTerms("is pru shield premier better than pru shield standard"), "is PRUShield Premier better than PRUShield Standard");
  assert.equal(fixTerms("pru extra preferred care"), "PRUExtra Preferred Care");
  assert.equal(fixTerms("use pool panel connect specialists"), "use PRUPanel Connect specialists");
  assert.equal(fixTerms("pru active retirement two"), "PRUActive Retirement II");
});

test("fixTerms leaves ordinary speech untouched and is idempotent", () => {
  const plain = "How much would I actually have to pay first?";
  assert.equal(fixTerms(plain), plain);
  const once = fixTerms("pru shield and pru extra");
  assert.equal(once, "PRUShield and PRUExtra");
  assert.equal(fixTerms(once), once, "a second pass changes nothing");
});

/* ---------- a bad key must not kill a generation call ---------- */

test("isInvalidKeyError flags a bad key across shapes — and only a bad key, not any 400", () => {
  const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
  assert.equal(isInvalidKeyError(bad("API key not valid. Please pass a valid API key.")), true);
  assert.equal(isInvalidKeyError(bad('{"error":{"status":"INVALID_ARGUMENT","message":"API_KEY_INVALID"}}')), true);
  // A different 400 (e.g. an unsupported thinking level) is NOT a key error — rotating every key on
  // it would be wrong, so it must return false.
  assert.equal(isInvalidKeyError(bad("Thinking level MINIMAL is not supported for this model.")), false);
  assert.equal(isInvalidKeyError(bad("API key not valid", 429)), false, "429 is not a key error");
});

test("callWithRetry rotates past an invalid-key 400 instead of failing the whole call", async () => {
  // A revoked/mis-pasted key in the pool returns 400 API_KEY_INVALID. With other keys available it
  // must be skipped, not treated as a terminal failure. (Needs >1 key configured — .env.local has 14.)
  let calls = 0;
  const r = await callWithRetry(
    "test-badkey",
    async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(
          new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'),
          { status: 400 },
        );
      }
      return "ok";
    },
    { allowSleep: false },
  );
  assert.equal(r, "ok", "rotated to another key and succeeded");
  assert.ok(calls >= 2, "the call was retried on a different key");
  resetPool();
});

test("callWithRetry rotates past a transient 503 on the live path (no sleeping) instead of failing", async () => {
  // A busy model returns 503 UNAVAILABLE on some keys. On the live path (allowSleep:false) that must
  // rotate to a free key immediately, not die — otherwise one busy key rate-limit-notes the rep.
  let calls = 0;
  const r = await callWithRetry(
    "test-503",
    async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("503 The model is overloaded. Please try again later."), { status: 503 });
      return "ok";
    },
    { allowSleep: false },
  );
  assert.equal(r, "ok", "rotated past the 503 to a healthy key");
  assert.ok(calls >= 2, "the call was retried on a different key");
  resetPool();
});

/* ---------- the compliance record export (the suitability trail) ---------- */

const CR_META = { productArea: AREA, signedBy: "Nikole Tan", customerName: "Mr Lim", durationMin: 18 };
const CR_ROWS = [
  { conceptId: "deductible-definition", label: "Deductible", state: "demonstrated" as const, at: AT, quote: "the part you settle first, once a year", citations: ["PRUShield brochure (Apr 2026) · p.12"], risk: "" },
  { conceptId: "co-insurance", label: "Co-insurance", state: "asserted" as const, at: AT + 1000, quote: "okay, that makes sense", citations: ["PRUShield brochure (Apr 2026) · p.13"], risk: "Agreed, never demonstrated" },
  { conceptId: "panel-providers", label: "Panel providers", state: "misunderstood" as const, at: AT + 2000, quote: "any hospital, it's the same coverage right?", citations: ["PRUShield brochure (Apr 2026) · p.14, p.15"], risk: "Correct this next time" },
];

test("the compliance verdict withholds a recommendation while any concept is unsettled", () => {
  const r = buildComplianceRecord(CR_ROWS, CR_META);
  assert.equal(r.verdict.settled, 1, "one demonstrated");
  assert.equal(r.verdict.contradicting, 1, "one misunderstood");
  assert.equal(r.verdict.open, 2, "asserted + misunderstood are both open");
  assert.equal(r.verdict.clear, false);
  assert.match(r.verdict.line, /not ready to recommend/i);
});

test("the compliance verdict clears only when every concept is demonstrated", () => {
  const allShown = CR_ROWS.map((r) => ({ ...r, state: "demonstrated" as const, risk: "" }));
  const r = buildComplianceRecord(allShown, CR_META);
  assert.equal(r.verdict.clear, true);
  assert.equal(r.verdict.open, 0);
  assert.match(r.verdict.line, /ready to recommend/i);
});

test("compliance rows carry the customer's own words, the brochure pages, and a plain state label", () => {
  const r = buildComplianceRecord(CR_ROWS, CR_META);
  const panel = r.rows.find((x) => x.label === "Panel providers");
  assert.ok(panel);
  assert.equal(panel.quote, "any hospital, it's the same coverage right?");
  assert.equal(panel.pages, "p.14, p.15", "document name stripped, pages kept");
  assert.equal(panel.stateLabel, "Misunderstood");
  assert.equal(r.meta.customerName, "Mr Lim");
  assert.ok(r.disclaimer.length > 0);
});

test("an empty session produces a record with a defensible empty verdict, not a crash", () => {
  const r = buildComplianceRecord([], CR_META);
  assert.equal(r.rows.length, 0);
  assert.equal(r.verdict.settled, 0);
  assert.equal(r.verdict.open, 0);
});

test("the rendered document carries the verdict, the customer, and escapes quoted words safely", () => {
  const html = renderComplianceHtml(buildComplianceRecord(CR_ROWS, CR_META), { generatedAt: "23 Aug 2026" });
  assert.match(html, /not ready to recommend/i);
  assert.ok(html.includes("Mr Lim"));
  assert.ok(html.includes("Panel providers"));
  // A quote containing markup must not break out of the document.
  const evil = buildComplianceRecord([{ ...CR_ROWS[0], quote: '<script>x</script>' }], CR_META);
  assert.ok(!renderComplianceHtml(evil).includes("<script>x"), "quotes are HTML-escaped");
});

/* ---------- the ledger write is a true compare-and-set (QW3) ---------- */

test("casByRev writes when the key is empty, and round-trips the value", async () => {
  const store = getStore();
  const k = "cas:new";
  await store.del(k);
  assert.equal(await store.casByRev(k, 0, { rev: 1, v: "a" }), true);
  assert.deepEqual(await store.get(k), { rev: 1, v: "a" });
});

test("casByRev rejects a write whose expected rev no longer matches the stored one", async () => {
  const store = getStore();
  const k = "cas:stale";
  await store.set(k, { rev: 5, v: "current" });
  // A writer that read rev 4 must lose: the value moved on under it.
  assert.equal(await store.casByRev(k, 4, { rev: 6, v: "stale-writer" }), false);
  assert.deepEqual(await store.get(k), { rev: 5, v: "current" }, "the stored value is untouched");
  // A writer that read the current rev succeeds.
  assert.equal(await store.casByRev(k, 5, { rev: 6, v: "fresh-writer" }), true);
  assert.deepEqual(await store.get(k), { rev: 6, v: "fresh-writer" });
});

test("saveState is a true compare-and-set: two passes at the same rev cannot both win", async () => {
  const base = { ...emptyState("cas-room", AREA), rev: 2 };
  // First pass loaded rev 2 and writes rev 3.
  assert.equal(await saveState({ ...base, rev: 3, updatedAt: 1 }, 2), true);
  assert.equal((await loadState("cas-room", AREA)).rev, 3);
  // Second pass also loaded rev 2 — it must be rejected rather than clobber rev 3 (a lost update).
  assert.equal(await saveState({ ...base, rev: 3, updatedAt: 2 }, 2), false);
  assert.equal((await loadState("cas-room", AREA)).rev, 3, "no lost update");
});

test("anchorClauses gives the lookahead a reliable, on-topic fallback when the tool loop gathers nothing", () => {
  const panel = conceptById("panel-providers");
  assert.ok(panel, "panel-providers concept exists");
  const hits = anchorClauses(panel);
  assert.ok(hits.length > 0, "the fallback is never empty");
  assert.equal(hits.length, panel.clauseIds.length, "every anchor clause id resolves to a clause");
  for (const h of hits) {
    assert.ok(h.source && h.text, "each hit carries source and text for grounding and citation");
    assert.equal(h.score, 1);
  }
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

/* ---------- the console's transcript rules ---------- */

// The console's own logic is React and cannot be driven from here, but the decisions that matter
// were pulled out of it as plain functions: who a line belongs to, and which lines are new.

test("everyone who is not the rep is the customer", () => {
  const lines = [
    { id: "1", at: AT, speaker: "Bryan Eng", text: "The deductible comes first." },
    { id: "2", at: AT + 1000, speaker: "Mei Ling", text: "Okay." },
    { id: "3", at: AT + 2000, speaker: "Customer", text: "And after that?" },
  ];
  assert.deepEqual(
    toTurns(lines, "Bryan Eng").map((t) => t.role),
    ["rep", "customer", "customer"],
  );
  // The rep's own name is the only thing that decides it — a renamed participant is still not
  // the representative.
  assert.deepEqual(
    toTurns(lines, "Someone Else").map((t) => t.role),
    ["customer", "customer", "customer"],
  );
});

test("the question sent for the prepared-answer check is the customer's last line", () => {
  const lines = [
    { id: "1", at: AT, speaker: "Mei Ling", text: "What is a deductible?" },
    { id: "2", at: AT + 1000, speaker: "Bryan Eng", text: "It is the amount you pay first." },
    { id: "3", at: AT + 2000, speaker: "Mei Ling", text: "So how much would that be?" },
    { id: "4", at: AT + 3000, speaker: "Bryan Eng", text: "It depends on the ward." },
  ];
  assert.equal(lastFromCustomer(lines, "Bryan Eng"), "So how much would that be?");
  assert.equal(lastFromCustomer([], "Bryan Eng"), "");
  assert.equal(newestAt(lines), AT + 3000);
  assert.equal(newestAt([]), 0);
});

test("the console sends the window only when there is something new — and always on the last pass", () => {
  const lines = [
    { id: "1", at: AT, speaker: "Bryan Eng", text: "The deductible comes first." },
    { id: "2", at: AT + 1000, speaker: "Mei Ling", text: "Okay." },
  ];

  // Nothing sent yet: the whole window goes up.
  const first = windowToSend(lines, "Bryan Eng", 0);
  assert.equal(first.fresh, true);
  assert.equal(first.turns.length, 2);
  assert.equal(first.newest, AT + 1000);

  // Cursor caught up: the poll still happens — the reply carries the ledger back — but the server
  // is not asked to re-score turns it has already folded in.
  const again = windowToSend(lines, "Bryan Eng", first.newest);
  assert.equal(again.fresh, false);
  assert.deepEqual(again.turns, []);

  // Ending forces it regardless: the record is the deliverable and the last exchange has to land.
  const closing = windowToSend(lines, "Bryan Eng", first.newest, true);
  assert.equal(closing.fresh, true);
  assert.equal(closing.turns.length, 2);

  // One new line makes it fresh again.
  const grown = [...lines, { id: "3", at: AT + 2000, speaker: "Mei Ling", text: "And after that?" }];
  assert.equal(windowToSend(grown, "Bryan Eng", first.newest).fresh, true);
});

test("the sent window is capped, so a long session does not grow the request forever", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    id: String(i),
    at: AT + i * 1000,
    speaker: i % 2 ? "Mei Ling" : "Bryan Eng",
    text: `line ${i}`,
  }));
  const send = windowToSend(many, "Bryan Eng", 0);
  assert.equal(send.turns.length, 60);
  // The cap keeps the newest, never the oldest.
  assert.equal(send.turns[send.turns.length - 1].text, "line 199");
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

// --- live-console keyboard shortcuts (resolveHotkey) ---
test("hotkey: Enter marks the suggested line said", () => {
  assert.equal(resolveHotkey({ key: "Enter" }), "said");
});

test("hotkey: R (any case, shift allowed) says it simpler", () => {
  assert.equal(resolveHotkey({ key: "r" }), "simpler");
  assert.equal(resolveHotkey({ key: "R" }), "simpler");
});

test("hotkey: Escape dismisses the line", () => {
  assert.equal(resolveHotkey({ key: "Escape" }), "dismiss");
});

test("hotkey: focus in a field or on a control lets native handling win", () => {
  // Typing "r" into the clarify input, or pressing Enter on a focused button, must not fire.
  assert.equal(resolveHotkey({ key: "r", inControl: true }), null);
  assert.equal(resolveHotkey({ key: "Enter", inControl: true }), null);
  assert.equal(resolveHotkey({ key: "Escape", inControl: true }), null);
});

test("hotkey: a modifier combo is left to the browser (Ctrl+R must still reload)", () => {
  assert.equal(resolveHotkey({ key: "r", ctrlKey: true }), null);
  assert.equal(resolveHotkey({ key: "r", metaKey: true }), null);
  assert.equal(resolveHotkey({ key: "Enter", altKey: true }), null);
});

test("hotkey: an unmapped key does nothing", () => {
  assert.equal(resolveHotkey({ key: "q" }), null);
  assert.equal(resolveHotkey({ key: " " }), null);
});

// --- rep edits a mis-heard transcript line (applyLineEdit) ---
const LINES = [
  { id: "a", at: 1, speaker: "You", text: "hello there" },
  { id: "b", at: 2, speaker: "Naomi", text: "what is pro shield", flag: true },
];

test("edit: replaces the matching line's text, leaves the rest untouched", () => {
  const out = applyLineEdit(LINES, "a", "hello, good morning");
  assert.equal(out.find((l) => l.id === "a")!.text, "hello, good morning");
  assert.equal(out.find((l) => l.id === "b")!.text, "what is pro shield");
});

test("edit: trims and normalises brand terms, like a freshly-heard line", () => {
  const out = applyLineEdit(LINES, "b", "  what does pro shield cover?  ");
  assert.equal(out.find((l) => l.id === "b")!.text, "what does PRUShield cover?");
});

test("edit: blanking a line is ignored (no empty lines), unknown id is a no-op", () => {
  assert.deepEqual(applyLineEdit(LINES, "a", "   "), LINES);
  assert.deepEqual(applyLineEdit(LINES, "missing", "hi there"), LINES);
});

test("edit: preserves id, timestamp, speaker and the question flag", () => {
  const out = applyLineEdit(LINES, "b", "what does pro shield cover?");
  const b = out.find((l) => l.id === "b")!;
  assert.equal(b.id, "b");
  assert.equal(b.at, 2);
  assert.equal(b.speaker, "Naomi");
  assert.equal(b.flag, true);
});

// --- deduped citation sidebar (groupCitations) ---
test("cite: one row per document, pages merged and de-duplicated in order", () => {
  const out = groupCitations([
    "PRUShield Product Brochure (Apr 2026) · p.3",
    "PRUShield Product Brochure (Apr 2026) · p.6, p.10",
    "PRUShield Product Brochure (Apr 2026) · p.2, p.6",
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].doc, "PRUShield Product Brochure (Apr 2026)");
  assert.equal(out[0].pages, "p.3, p.6, p.10, p.2");
});

test("cite: keeps distinct documents as separate rows, in first-seen order", () => {
  const out = groupCitations(["Doc B · p.1", "Doc A · p.9", "Doc B · p.2"]);
  assert.deepEqual(out, [
    { doc: "Doc B", pages: "p.1, p.2" },
    { doc: "Doc A", pages: "p.9" },
  ]);
});

test("cite: a source with no page part yields the doc with empty pages; empty input yields nothing", () => {
  assert.deepEqual(groupCitations(["Some Brochure"]), [{ doc: "Some Brochure", pages: "" }]);
  assert.deepEqual(groupCitations([]), []);
});

// --- rep-added knowledge: shaping chunks into cited clauses (toClauses) ---
test("kb: a link source cites '<doc> · <url>' with sequential non-colliding ids", () => {
  const cs = toClauses(["first chunk", "second chunk"], { doc: "Panel memo (added)", url: "https://x.test/a", idPrefix: "custom-abc" });
  assert.equal(cs.length, 2);
  assert.equal(cs[0].id, "custom-abc-1");
  assert.equal(cs[1].id, "custom-abc-2");
  assert.equal(cs[0].source, "Panel memo (added) · https://x.test/a");
  assert.equal(cs[0].text, "first chunk");
});

test("kb: a pasted note cites the label alone (no url segment)", () => {
  const cs = toClauses(["a fact the rep typed"], { doc: "Rate note (added)", idPrefix: "custom-xyz" });
  assert.equal(cs[0].source, "Rate note (added)");
});

test("kb: chunkLines joins short lines, splits before exceeding max, drops a sub-minLine tail", () => {
  assert.deepEqual(chunkLines(["hello", "world"], { target: 700, max: 1000, minLine: 1 }), ["hello world"]);
  assert.deepEqual(chunkLines(["short"], { minLine: 40 }), []);
  const big = "x".repeat(600);
  assert.deepEqual(chunkLines([big, big], { target: 700, max: 1000, minLine: 40 }), [big, big]);
});

test("kb: textToLines keeps every non-empty line, collapsing inline whitespace", () => {
  assert.deepEqual(textToLines("  a  b \n\n c \n"), ["a b", "c"]);
});

// --- rep-added knowledge: the shared store CRUD (text path, against the in-memory store) ---
test("kb: addTextSource chunks a pasted note into cited clauses and lists it", async () => {
  const s = await addTextSource({
    label: "Panel rate note",
    area: "KB-Test-A",
    text: "Panel providers unlock the 95% deductible coverage above S$3,500 per policy year, so staying in panel avoids pro-ration.",
  });
  try {
    assert.ok(s.clauses.length >= 1, "should produce at least one clause");
    assert.match(s.clauses[0].text, /panel/i);
    assert.match(s.clauses[0].source, /Panel rate note \(added\)/);
    assert.ok((await listSources()).some((x) => x.id === s.id));
  } finally {
    await removeSource(s.id);
  }
});

test("kb: customClauses returns a source's clauses only for its own area", async () => {
  const s = await addTextSource({ label: "n", area: "KB-Test-B", text: "A distinctive fact about panel pro-ration that is long enough to survive chunking into a clause." });
  try {
    assert.ok((await customClauses("KB-Test-B")).some((c) => c.id === s.clauses[0].id));
    assert.ok(!(await customClauses("KB-Test-Other")).some((c) => c.id === s.clauses[0].id));
  } finally {
    await removeSource(s.id);
  }
});

// ---- generation subgraph: evaluator-optimizer retry ----

const { shouldRetry } = await import("../src/lib/agent/orchestrator/generation.ts");

test("generation: retries when figures are unsupported and attempts remain", () => {
  assert.strictEqual(shouldRetry(["3500"], 1), true);
});

test("generation: does not retry when no unsupported figures", () => {
  assert.strictEqual(shouldRetry([], 1), false);
});

test("generation: does not retry when attempt cap reached", () => {
  assert.strictEqual(shouldRetry(["3500"], 2), false);
});

test("generation: does not retry on attempt 3 even with unsupported figures", () => {
  assert.strictEqual(shouldRetry(["3500", "200000"], 3), false);
});

test("kb: removeSource drops it from the shared list", async () => {
  const s = await addTextSource({ label: "n", area: "KB-Test-C", text: "Content long enough to chunk into a clause for the removal test to work." });
  await removeSource(s.id);
  assert.ok(!(await listSources()).some((x) => x.id === s.id));
});

// ---------- in-person diarization: splitter, mapper, PCM, speaker swap ----------

const word = (w: string, speaker: number | undefined, punct?: string) =>
  ({ word: w, speaker, start: 0, end: 0, ...(punct !== undefined ? { punctuated_word: punct } : {}) });

test("splitRuns: splits a diarized final into one line-run per consecutive speaker", () => {
  const runs = splitRuns([word("a", 0), word("b", 0), word("c", 1), word("d", 1), word("e", 0)]);
  assert.strictEqual(runs.length, 3);
  assert.deepStrictEqual(runs.map((r) => r.speakerIndex), [0, 1, 0]);
  assert.deepStrictEqual(runs.map((r) => r.text), ["a b", "c d", "e"]);
});

test("splitRuns: a single-speaker final is one run", () => {
  const runs = splitRuns([word("hello", 2), word("there", 2)]);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].text, "hello there");
  assert.strictEqual(runs[0].speakerIndex, 2);
});

test("splitRuns: missing or empty words produce no runs", () => {
  assert.deepStrictEqual(splitRuns(undefined), []);
  assert.deepStrictEqual(splitRuns([]), []);
  // A metadata / diarize-off frame: words present but no speaker index — unattributable, not a throw.
  assert.deepStrictEqual(splitRuns([word("um", undefined), word("okay", undefined)]), []);
});

test("splitRuns: prefers punctuated_word over word", () => {
  const runs = splitRuns([word("hello", 0, "Hello,"), word("there", 0, "there.")]);
  assert.strictEqual(runs[0].text, "Hello, there.");
});

test("attributeFinal: the first speaker index binds to the rep (consent-script calibration)", () => {
  const r = attributeFinal(emptySpeakerMap(), splitRuns([word("welcome", 0)]), null);
  assert.strictEqual(r.lines[0].role, "rep");
  assert.strictEqual(r.map.assigned[0], "rep");
  assert.strictEqual(r.lastRole, "rep");
});

test("attributeFinal: the first differing index binds to the customer", () => {
  const a = attributeFinal(emptySpeakerMap(), splitRuns([word("hi", 0)]), null);
  const b = attributeFinal(a.map, splitRuns([word("yes", 1)]), null);
  assert.strictEqual(b.lines[0].role, "customer");
  assert.strictEqual(b.map.assigned[1], "customer");
});

test("attributeFinal: an unseen third index defaults to customer", () => {
  const map = { assigned: { 0: "rep" as const, 1: "customer" as const }, calibrated: true };
  const r = attributeFinal(map, splitRuns([word("mm", 2)]), null);
  assert.strictEqual(r.lines[0].role, "customer");
  assert.strictEqual(r.map.assigned[2], "customer");
});

test("attributeFinal: override forces the role and rebinds a single-run final's index", () => {
  const map = { assigned: { 0: "rep" as const }, calibrated: true };
  const forced = attributeFinal(map, splitRuns([word("actually", 0)]), "customer");
  assert.strictEqual(forced.lines[0].role, "customer");
  assert.strictEqual(forced.map.assigned[0], "customer"); // rebound
  // and the next auto final on that index now reads customer (relabel recovery)
  const next = attributeFinal(forced.map, splitRuns([word("right", 0)]), null);
  assert.strictEqual(next.lines[0].role, "customer");
});

test("attributeFinal: override on a multi-run final forces roles but does not rebind", () => {
  const map = { assigned: { 0: "rep" as const, 1: "customer" as const }, calibrated: true };
  const r = attributeFinal(map, splitRuns([word("a", 0), word("b", 1)]), "customer");
  assert.deepStrictEqual(r.lines.map((l) => l.role), ["customer", "customer"]);
  assert.deepStrictEqual(r.map.assigned, { 0: "rep", 1: "customer" }); // unchanged
});

test("interimRole: goes to the override, else the last final's role, else the rep", () => {
  assert.strictEqual(interimRole("customer", "rep"), "customer");
  assert.strictEqual(interimRole(null, "customer"), "customer");
  assert.strictEqual(interimRole(null, null), "rep");
});

test("pcm: 48k->16k output length is one third and a constant signal stays constant", () => {
  const rs = createResampler(48000, 16000);
  const out = rs.push(new Float32Array(48000).fill(0.5));
  assert.ok(Math.abs(out.length - 16000) <= 1, `len ${out.length}`);
  assert.ok(out.every((v) => v === 0.5)); // linear interpolation of a constant is exact
});

test("pcm: non-integer ratios (44100, 22050 -> 16000) carry phase across chunks", () => {
  for (const rate of [44100, 22050]) {
    const rs = createResampler(rate, 16000);
    const chunk = new Float32Array(160).fill(0.25);
    const chunks = 50;
    let total = 0;
    for (let i = 0; i < chunks; i++) total += rs.push(chunk).length;
    const expected = (160 * chunks * 16000) / rate;
    assert.ok(Math.abs(total - expected) <= 2, `rate ${rate}: got ${total}, expected ~${expected}`);
  }
});

test("pcm: floats clamp and encode little-endian int16", () => {
  const buf = floatTo16BitPCM(new Float32Array([1.0, -1.0, 2.0, 0]));
  const view = new DataView(buf);
  assert.strictEqual(view.getInt16(0, true), 32767);
  assert.strictEqual(view.getInt16(2, true), -32768);
  assert.strictEqual(view.getInt16(4, true), 32767); // 2.0 clamps to full scale
  assert.strictEqual(view.getInt16(6, true), 0);
});

test("applySpeakerSwap: swapping to customer re-derives the question flag; swapping to rep clears it", () => {
  const line = { id: "x", at: 1, speaker: "Bryan", text: "what does the deductible cover?", flag: false };
  const toCust = applySpeakerSwap([line], "x", "Bryan", "Mrs Tan");
  assert.strictEqual(toCust[0].speaker, "Mrs Tan");
  assert.strictEqual(toCust[0].flag, true);
  const back = applySpeakerSwap(toCust, "x", "Bryan", "Mrs Tan");
  assert.strictEqual(back[0].speaker, "Bryan");
  assert.strictEqual(back[0].flag, false);
});

test("applySpeakerSwap: swap with an unknown id returns the same array", () => {
  const lines = [{ id: "x", at: 1, speaker: "Bryan", text: "hello there friend", flag: false }];
  assert.strictEqual(applySpeakerSwap(lines, "nope", "Bryan", "Mrs Tan"), lines);
});

// ---------- sharing mode: document registry + source locator (documents.ts) ----------

test("locateSource: a PRUShield clause source resolves to its committed PDF and pages", () => {
  const loc = locateSource("PRUShield Product Brochure (Apr 2026) · p.2, p.12, p.17");
  assert.strictEqual(loc.kind, "pdf");
  assert.strictEqual(loc.doc, "PRUShield Product Brochure (Apr 2026)");
  assert.strictEqual(loc.file, "/docs/prushield-apr-2026.pdf");
  assert.deepStrictEqual(loc.pages, [2, 12, 17]);
  assert.match(loc.url ?? "", /^https:\/\//);
});

test("locateSource: a registered doc with no page part yields empty pages", () => {
  const loc = locateSource("PRUActive Term Brochure");
  assert.strictEqual(loc.kind, "pdf");
  assert.strictEqual(loc.file, "/docs/pruactive-term.pdf");
  assert.deepStrictEqual(loc.pages, []);
});

test("locateSource: a web-sourced clause is web, with its url and no pages", () => {
  const loc = locateSource(
    "PRUShield & PRUExtra (prudential.com.sg) · https://www.prudential.com.sg/products/health-insurance/medical/prushield",
  );
  assert.strictEqual(loc.kind, "web");
  assert.strictEqual(loc.url, "https://www.prudential.com.sg/products/health-insurance/medical/prushield");
  assert.strictEqual(loc.file, undefined);
  assert.deepStrictEqual(loc.pages, []);
});

test("locateSource: an unknown document label is 'unknown' but still parses its pages", () => {
  const loc = locateSource("Panel rate note (added) · p.4, p.3, p.3");
  assert.strictEqual(loc.kind, "unknown");
  assert.strictEqual(loc.file, undefined);
  assert.deepStrictEqual(loc.pages, [3, 4], "pages are unique and ascending regardless of authored order");
});

test("locateSource: a string rebuilt by groupCitations round-trips to the same location", () => {
  const [g] = groupCitations([
    "PRUShield Product Brochure (Apr 2026) · p.3",
    "PRUShield Product Brochure (Apr 2026) · p.6, p.10",
  ]);
  const rebuilt = `${g.doc}${g.pages ? " · " + g.pages : ""}`;
  const loc = locateSource(rebuilt);
  assert.strictEqual(loc.kind, "pdf");
  assert.strictEqual(loc.doc, "PRUShield Product Brochure (Apr 2026)");
  assert.deepStrictEqual(loc.pages, [3, 6, 10]);
});

test("documentFor: resolves a registered doc and is undefined otherwise", () => {
  assert.strictEqual(documentFor("PRUShield Product Brochure (Apr 2026)")?.file, "/docs/prushield-apr-2026.pdf");
  assert.strictEqual(documentFor("Nonexistent Brochure"), undefined);
  assert.strictEqual(DOCUMENTS.length, 5, "the five registered brochures");
});

test("every cited brochure resolves to a committed PDF that exists on disk (the .gitignore trap)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let checked = 0;
  for (const doc of knowledgeDocuments()) {
    const source = KNOWLEDGE.find((c) => c.source.split(" · ")[0] === doc)!.source;
    const loc = locateSource(source);
    if (loc.kind === "web") continue; // prudential.com.sg pages are linked out, never rendered
    assert.strictEqual(loc.kind, "pdf", `${doc} is cited but is not a registered PDF`);
    assert.ok(
      loc.file && existsSync(join(root, "public", loc.file.replace(/^\//, ""))),
      `${doc} → ${loc.file} is missing under public/ (did .gitignore drop it on a fresh clone?)`,
    );
    checked++;
  }
  assert.ok(checked > 0, "at least one brochure PDF is exercised");
});

// ---------- sharing mode: board projections (board.ts) ----------

test("figuresIn: extracts unique S$ figures and ignores counts and years", () => {
  assert.deepStrictEqual(
    figuresIn(["The A ward deductible is S$3,500, the C ward S$1,500, and stop-loss caps at S$ 6,000."]),
    ["S$3,500", "S$1,500", "S$ 6,000"],
  );
  // de-duplicated across texts, kept in first-seen order
  assert.deepStrictEqual(figuresIn(["S$1,500 here", "and S$1,500 again, plus S$2,000"]), ["S$1,500", "S$2,000"]);
  // a plain count and a year are not policy figures
  assert.deepStrictEqual(figuresIn(["There are 3 tiers, revised in 2026."]), []);
});

test("conceptCard: projects only the customer-safe fields, with page locations and figure highlights", () => {
  const card = conceptCard("deductible-amounts");
  assert.ok(card);
  assert.strictEqual(card.label, "Deductible amount");
  assert.match(card.canonical, /depends on the ward/);
  // anchored to its clauses, each located to the brochure
  assert.ok(card.excerpts.length > 0);
  assert.ok(card.excerpts.every((e) => e.doc === "PRUShield Product Brochure (Apr 2026)"));
  // the default page is the first page of the first clause; page locations carry the file to render
  assert.ok(card.pages.length > 0);
  assert.strictEqual(card.pages[0].file, "/docs/prushield-apr-2026.pdf");
  // the S$ figures in the clauses become highlights
  assert.ok(card.highlights.includes("S$1,500"));
  assert.strictEqual(conceptCard("nope"), null);
});

test("conceptCard: leaks none of a concept's misconceptions, teach-back or authored arrays", () => {
  for (const c of CONCEPTS) {
    const card = conceptCard(c.id);
    if (!card) continue;
    const json = JSON.stringify(card);
    // no authored field leaks by key — guards against a future `{ ...concept }` spread
    for (const key of ['"misconceptions"', '"teachBack"', '"terms"', '"qualifiers"']) {
      assert.ok(!json.includes(key), `${c.id} card leaked the ${key} field`);
    }
    // no wrong-framing sentence and no teach-back question leaks by content
    for (const m of c.misconceptions) assert.ok(!json.includes(m), `${c.id} card leaked a misconception`);
    assert.ok(!json.includes(c.teachBack), `${c.id} card leaked its teach-back`);
  }
});

test("sourceCard: resolves the excerpt by clause id, then page intersection, then snippet-only", () => {
  // 1. an explicit clause id wins
  const byId = sourceCard({ kind: "source", source: "PRUShield Product Brochure (Apr 2026) · p.17", clauseId: "deductible-amounts", snippet: "ignored" });
  assert.strictEqual(byId.kind, "pdf");
  assert.strictEqual(byId.file, "/docs/prushield-apr-2026.pdf");
  assert.strictEqual(byId.excerpts[0].clauseId, "deductible-amounts");
  assert.match(byId.excerpts[0].text, /S\$1,500/);

  // 2. no id: fall back to KNOWLEDGE clauses on the same document whose pages intersect
  const byPage = sourceCard({ kind: "source", source: "PRUShield Product Brochure (Apr 2026) · p.17" });
  assert.ok(byPage.excerpts.length > 0);
  assert.ok(byPage.excerpts.every((e) => e.clauseId && clauseById(e.clauseId)!.source.includes("p.17")));

  // 3. neither an id nor a page match: the snippet is all we have
  const bySnippet = sourceCard({ kind: "source", source: "Rate note (added) · p.99", snippet: "a pasted custom fact about panel pricing" });
  assert.strictEqual(bySnippet.kind, "unknown");
  assert.strictEqual(bySnippet.excerpts.length, 1);
  assert.strictEqual(bySnippet.excerpts[0].text, "a pasted custom fact about panel pricing");
  assert.strictEqual(bySnippet.excerpts[0].clauseId, undefined);
});

// ---------- sharing mode: board focus machine (board.ts) ----------

type Alert_ = import("../src/lib/agent/types.ts").Alert;
type RecordRow_ = import("../src/lib/agent/types.ts").RecordRow;
type Readiness_ = import("../src/lib/agent/readiness.ts").Readiness;
type AgentSlice_ = import("../src/lib/board.ts").AgentSlice;
type BoardSnapshot_ = import("../src/lib/board.ts").BoardSnapshot;
type BoardState_ = import("../src/lib/board.ts").BoardState;

const bAlert = (conceptId: string, at: number): Alert_ =>
  ({ kind: "false-assent", conceptId, label: conceptId, headline: "", detail: "", teachBack: "", citations: [], quote: "", at });
const bRow = (conceptId: string, state: RecordRow_["state"], at: number): RecordRow_ =>
  ({ conceptId, label: conceptId, state, at, quote: "", citations: [], risk: "" });
const bReadiness = (nextConceptId: string, state: RecordRow_["state"]): Readiness_ =>
  ({ decisionId: "d", question: "", options: [], standing: [{ conceptId: nextConceptId, label: nextConceptId, state, role: "differentiator", citations: [], teachBack: "" }], settled: 0, total: 1, blocking: [], open: [], ready: false, nextQuestion: null, nextConceptId });
const bAgent = (over: Partial<AgentSlice_>): AgentSlice_ => ({ alert: null, record: [], readiness: null, ...over });

test("board.autoFocus: a new alert beats a changed row", () => {
  const prev: BoardSnapshot_ = { alertAt: 1000, rows: { "co-insurance": { state: "raised", at: 500 } } };
  const agent = bAgent({ alert: bAlert("panel-providers", 2000), record: [bRow("co-insurance", "asserted", 1500)] });
  assert.deepStrictEqual(autoFocus(agent, prev).focus, { kind: "concept", conceptId: "panel-providers" });
});

test("board.autoFocus: a changed row beats readiness.nextConceptId", () => {
  const prev: BoardSnapshot_ = { alertAt: 0, rows: { "co-insurance": { state: "raised", at: 500 } } };
  const agent = bAgent({ record: [bRow("co-insurance", "asserted", 1500)], readiness: bReadiness("deductible-amounts", "asserted") });
  assert.deepStrictEqual(autoFocus(agent, prev).focus, { kind: "concept", conceptId: "co-insurance" });
});

test("board.autoFocus: an unchanged poll keeps focus (null) and refreshes the snapshot", () => {
  const agent = bAgent({ alert: bAlert("panel-providers", 2000), record: [bRow("co-insurance", "asserted", 1500)] });
  const first = autoFocus(agent, null);
  const again = autoFocus(agent, first.snap);
  assert.strictEqual(again.focus, null);
  assert.deepStrictEqual(again.snap, first.snap);
});

test("board.autoFocus: the first snapshot seeds from readiness.nextConceptId only", () => {
  // A changed row would win by rule 2, but rule 2 needs a previous poll — the first snapshot uses
  // rule 3 (nextConceptId) alone, so entering sharing mode lands on the concept worth asking about.
  const agent = bAgent({ record: [bRow("deductible-amounts", "asserted", 1500)], readiness: bReadiness("deductible-amounts", "asserted") });
  const { focus, snap } = autoFocus(agent, null);
  assert.deepStrictEqual(focus, { kind: "concept", conceptId: "deductible-amounts" });
  assert.strictEqual(snap.rows["deductible-amounts"].state, "asserted");
});

test("board.reduceBoard: pick pins the focus and a later agent poll does not move it", () => {
  const start: BoardState_ = { focus: { kind: "idle" }, pinned: false, snap: null };
  const picked = reduceBoard(start, { type: "pick", focus: { kind: "source", source: "PRUShield Product Brochure (Apr 2026) · p.17", clauseId: "deductible-amounts" } });
  assert.strictEqual(picked.pinned, true);
  assert.strictEqual(picked.focus.kind, "source");
  const agent = bAgent({ alert: bAlert("panel-providers", 5000), record: [bRow("panel-providers", "misunderstood", 5000)] });
  const after = reduceBoard(picked, { type: "agent", agent });
  assert.deepStrictEqual(after.focus, picked.focus, "a pinned board ignores the poll");
  assert.strictEqual(after.pinned, true);
});

test("board.reduceBoard: follow unpins, empties the snapshot, and the next poll re-derives", () => {
  const pinned: BoardState_ = { focus: { kind: "source", source: "x" }, pinned: true, snap: { alertAt: 9, rows: {} } };
  const followed = reduceBoard(pinned, { type: "follow" });
  assert.strictEqual(followed.pinned, false);
  assert.strictEqual(followed.snap, null, "the snapshot is emptied so the next poll re-derives from scratch");
  const agent = bAgent({ readiness: bReadiness("deductible-amounts", "asserted") });
  const moved = reduceBoard(followed, { type: "agent", agent });
  assert.deepStrictEqual(moved.focus, { kind: "concept", conceptId: "deductible-amounts" });
});

test("board.reduceBoard: reset returns to idle and unpinned", () => {
  const s: BoardState_ = { focus: { kind: "concept", conceptId: "x" }, pinned: true, snap: { alertAt: 1, rows: {} } };
  assert.deepStrictEqual(reduceBoard(s, { type: "reset" }), { focus: { kind: "idle" }, pinned: false, snap: null });
});

test("board.conceptsInPlay: lists touched concepts and flags the active one, never an unseen concept", () => {
  const agent = bAgent({
    alert: bAlert("panel-providers", 3000),
    record: [bRow("deductible-definition", "raised", 1000), bRow("panel-providers", "misunderstood", 3000), bRow("stop-loss", "unseen", 0)],
  });
  const chips = conceptsInPlay(agent, "Health Protection");
  const ids = chips.map((c) => c.conceptId);
  assert.ok(ids.includes("deductible-definition") && ids.includes("panel-providers"));
  assert.ok(!ids.includes("stop-loss"), "an unseen concept is not in play");
  assert.strictEqual(chips.find((c) => c.conceptId === "panel-providers")!.active, true, "the alert concept is active");
  assert.strictEqual(chips.find((c) => c.conceptId === "deductible-definition")!.active, false);
});
