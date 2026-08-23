# Domain vocabulary

The words this codebase uses precisely, and the module that owns each. Add to it as terms get
sharpened, rather than letting definitions live only in comments.

For architecture vocabulary — module, interface, seam, depth — see the `codebase-design` skill.
These are the *domain* terms.

## The thesis, in one paragraph

Every product in this category models **the rep**: did they say the disclosure, did they handle the
objection. PRUAssist models the **customer**, because two separately-attributed transcripts make
that possible and because what a suitability record actually needs is evidence of comprehension,
not evidence of agreement. Everything below is in service of one distinction: **asserted is not
demonstrated**.

## Concept

A material idea the customer has to understand before a recommendation is suitable — the
deductible, panel providers, stop-loss. Authored in [`src/lib/concepts.ts`](src/lib/concepts.ts)
with the plain-language statement that is correct, the known wrong framings, the qualifiers that
change the answer, and the teach-back question that would settle it. Every concept is anchored to
clause ids that must exist in `KNOWLEDGE`; the module throws at import if one does not, so a
concept can never make an uncitable claim.

**Material** concepts are ones whose absence is itself a finding: never raising them appears on the
record as *not covered in this session*.

## Detection

What one detector observed about one turn. Defined in
[`src/lib/agent/types.ts`](src/lib/agent/types.ts). A detection *argues* for a state — it never
decides one; the ledger applies precedence. `argues: null` means evidence only.

`role` is carried from the turn the detector was looking at, never derived. The record quotes the
customer, so attributing a rep's sentence to them would be a lie in the one artifact where that
matters.

## Detector

A function from a prepared `TurnContext` to detections, in
[`src/lib/agent/detectors.ts`](src/lib/agent/detectors.ts). There are six, one per signal. They
have no ordering between them and none reads another's output.

## TurnContext

Everything a detector needs about one turn, computed once: whether it is a question, whether it is
a **bare assent**, which concepts its own words name, which are merely **in play**, what the
preceding rep turn was mainly about, and the approximate silence before it.

**Bare assent** is the compound fact — assent *to something the rep just said*. It is what stops
"okay, yeah, that makes sense" being scored as though it had content. An "okay" following another
customer turn is not a bare assent and suppresses nothing.

**In play** means the customer did not name the concept but the rep raised it in the last few
turns. A concept that is only in play can earn `demonstrated` but never `misunderstood` — claiming
a customer holds a misconception about something they never mentioned is the false alarm that
would teach the rep to ignore the assistant.

## Signal

The six things the detectors look for: **uptake** (used the idea, correctly or not), **assent**
(agreed with nothing behind it), **divergence** (restated it having dropped the qualifier that
changes the answer), **re-ask** (asked it again), **explain-back** (answered a teach-back, graded
against the clause), **latency** (the pause before agreeing — corroborating only, never decisive).

## Evidence

A detection folded into the ledger: the customer's own words, normalised and clipped, tied to a
concept. This is the *only* thing persisted from a transcript, which is what the consent copy
promises. Distinct from a detection: a detection is an observation, evidence is a record of one.

## Ledger

The per-concept state machine in [`src/lib/agent/ledger.ts`](src/lib/agent/ledger.ts):
`unseen → raised → asserted → demonstrated`, with `misunderstood` reachable from any of them.

**Asserted** and **demonstrated** are deliberately different states and the gap between them is the
product. Asserted means the customer signalled agreement. Demonstrated means they used the idea
correctly in their own words. "The rep said it and the customer agreed" is not evidence of
understanding.

**Misunderstood** means *said something matching a known misconception* — never *does not
understand*. The ledger records observed evidence; it does not return a verdict on a person.

## scorePass

The scoring half of the deep pass, in [`src/lib/agent/score.ts`](src/lib/agent/score.ts): turns in,
a folded ledger out, no I/O. It exists so there is exactly one statement of the pipeline — the
replay harness calls it rather than restating it, so the fixtures cannot drift from production.

`deepPass` ([`deep.ts`](src/lib/agent/deep.ts)) is the I/O around it: the store, the acts queue, the
revision counter, the model-call budget and the lookahead.

## Alert

The one thing shown to the rep mid-call, chosen by risk from the whole ledger. A second alert
competing for attention during a live conversation is worse than none, so `chooseAlert` returns at
most one. Five kinds: **false assent**, **misunderstood**, **divergence**, **explain-back**,
**re-ask**.

**False assent** is the signature moment: the customer agreed, the ledger has no evidence they
understood, and the alert says so with the pause and the returned-to question as corroboration.
It is the case every other product in this category treats as a success.

An alert presents evidence and suggests a question. It never blocks the rep, never scores the rep,
and never speaks to the customer. That is also the answer when someone asks what happens if the AI
is wrong: the record states what was observed, never a verdict.

## Decision

A comparison the representative works through with a customer — which PRUShield tier, whether to
add PRUExtra. Authored in [`src/lib/decisions.ts`](src/lib/decisions.ts) with the clauses that
describe each option.

Each decision splits its concepts in two. **Prerequisites** are what the comparison rests on: you
cannot weigh two deductibles against each other without knowing what a deductible is.
**Differentiators** are what changes which option is right. Only differentiators gate a
recommendation — that is where the money differs.

## Readiness

What the ledger says about a decision, in [`src/lib/agent/readiness.ts`](src/lib/agent/readiness.ts).
Per concept: its standing. Overall: what is blocking, what is open, whether the representative is
ready, and the single question most worth asking next.

`ready` means no misconception is outstanding and every differentiator has been **demonstrated** —
not agreed to. It is a pure projection of the ledger, deliberately: whether a recommendation is
safe to make is not a judgement to hand a model.

## Orchestrator

The agentic front door on the live path, in
[`src/lib/agent/orchestrator/`](src/lib/agent/orchestrator). On each substantive customer turn it
decides a **mode** — keep-listening, policy guidance, comparison, guider, topic drift, or
clarification — and a LangGraph routes to the handler for it.

The decision node (`scopeCheck`) has three tiers: an LLM **brain** (NVIDIA Nemotron 3.5 Lightning
over the OpenAI-compatible OpenRouter endpoint, `ORCHESTRATOR_*` env), a deterministic `decideMode`
([`modes.ts`](src/lib/agent/orchestrator/modes.ts)) as the fallback and offline oracle, and a cheap
wake-gate that never spends a brain call on a bare acknowledgement. Every tier degrades rather than
failing — no key, a timeout, or non-JSON output falls through to the next tier.

The orchestrator decides *how to help this turn*; it never decides *whether a recommendation is
safe* — that stays with the deterministic **Readiness** spine on the state poll. The generating
modes (policy / comparison) run the two-phase agentic path — a bounded tool loop
([`tools.ts`](src/lib/agent/tools.ts), ≤3 steps) lets the model choose what to search and whether to
read the ledger, then a structured generation writes the pointers over exactly those clauses and the
same grounding-check labels anything ungrounded; both fall back to a plain retrieve if the loop
returns nothing. `guider` stays a single grounded call and only when the remark names a concept —
so its benefits can be grounded — and stays quiet (no retrieval, no generation) otherwise.

**Topic drift escalates.** The first drift-routed turn warns; a second consecutive drift **pauses**
the assist surface ([`drift.ts`](src/lib/agent/orchestrator/drift.ts), state in `sess:drift:<room>`,
separate from the ledger key so it never races the deep pass). While paused, a turn costs one brain
call and no Gemini: the brain judges whether the talk is back on scope (the deterministic tier stands
in when the brain is down — a question resumes, a bare off-topic statement does not), and the first
in-scope turn resumes the full pipeline. No rep action needed.

**Transcript terms** are corrected before anything reads them: the browser transcriber mishears
"PRUShield" as "pru shield" or "peru shield", so [`terms.ts`](src/lib/terms.ts) rewrites known
aliases to canonical spellings in `useTranscript`, fixing display, the guider's concept gate,
retrieval, and the detectors in one pass.

Optionally, **Deepgram** replaces the browser recognizer for accuracy at the source: keyterm
boosting recognises the brand vocabulary at decode time rather than repairing it after. It is opt-in
(`NEXT_PUBLIC_ENABLE_DEEPGRAM`) and degrades open — [`useDeepgramSpeech`](src/lib/useDeepgramSpeech.ts)
streams the mic to Deepgram with a short-lived token minted by [`/api/deepgram/token`](src/app/api/deepgram/token/route.ts)
(the real key never reaches the browser; it must be Owner-scoped to grant tokens), and both the rep
and customer sides fall back to Web Speech if it is unconfigured or errors. `terms.ts` still runs as
the backstop over whatever STT is active.

## Teach-back

The question that would settle a concept, authored per concept — "if your bill came to S$8,000 at a
panel hospital, what would you expect to pay first?" The rep presses **Asked it**, which is a
**rep act**: it goes to its own store key rather than into the ledger, so it can never race the
deep pass. The customer's next substantive reply is then graded once against the clause, and the
grade names *which part* was wrong rather than returning a score.

## Lookahead

Speculative execution for a conversation. The ledger is ranked by risk — got it wrong beats agreed
without showing beats material and never raised — and the background pass runs a tool loop over the
riskiest concept, writes the answer and grounding-checks it before caching. When the question
arrives, `/api/assist` serves it with no model call.

Aimed at *this* customer's unresolved concepts, which is what separates it from predicting a
generic next question. An answer that fails verification is dropped rather than cached: served
instantly and with a citation, an ungrounded answer is worse than a cache miss.

The tool loop occasionally returns without searching, gathering no clauses. Rather than skip
preparing, the pass then retrieves the target concept's clauses directly (and its anchor clauses as
a last resort), so the prepared answer is reliable instead of intermittently empty — `anchorClauses`
in [`lookahead.ts`](src/lib/agent/lookahead.ts).

## Grounding

Every figure and claim must come from a retrieved clause. Checked at two speeds: a model checks the
whole answer on the background path, and on the live path a deterministic check confirms every
figure in the suggested line appears in the cited pages. The live check **labels rather than
blocks** — a hypothetical the rep offers the customer is legitimate, and the rep decides what to
say.

## Understanding Record

The artifact. One row per material concept: the state it reached, the customer's own timestamped
words as evidence, the brochure pages, and what is still open. Signed with the rep's consent
signature and exported with the brief.

It is the reason the privacy property changed: the raw transcript is still never persisted, but
concept-tied quotes are, for 24 hours, and both consent screens say so.

## Degraded

Detection ran on word overlap alone because embeddings were unavailable. Thresholds differ between
the two modes, so this is tracked rather than hidden — the console says so, and the replay harness
runs both paths.

## Replay harness

`npm run replay` — a scripted two-speaker transcript through the real detectors and the real
ledger, no browser and no second device. It is the development loop, and the deterministic fallback
if live demo conditions are bad. Fixtures declare the state they expect, so the run fails when a
change breaks one.
