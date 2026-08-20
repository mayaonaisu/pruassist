# Domain vocabulary

The words this codebase uses precisely, and the module that owns each. Started with the terms the
scoring refactor named; add to it as more get sharpened rather than letting definitions live only
in comments.

For architecture vocabulary — module, interface, seam, depth — see the `codebase-design` skill.
These are the *domain* terms.

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

## Degraded

Detection ran on word overlap alone because embeddings were unavailable. Thresholds differ between
the two modes, so this is tracked rather than hidden — the console says so, and the replay harness
runs both paths.
