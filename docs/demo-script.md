# Demo script — "it refused to recommend"

The one beat that lands the pitch: PRUAssist **won't hand the rep a recommendation while the customer
has misunderstood something** — it names what to settle first, and the whole call leaves an auditable
Understanding Record. This is the suitability/anti-mis-selling story a Prudential panel cares about.

Two people: **Rep** (laptop, `/rep`) and **Customer** (phone, the join link). Scope the session to
**Health Protection**. Keep it to ~3 minutes.

## The flow (say these lines)

1. **Deductible — demonstrated.**
   - Rep: "The deductible is the part you settle first, once a policy year, before the plan pays."
   - Customer: "So I'd pay that first each year, then you cover the rest?"
   - → Ledger row **Deductible → Demonstrated** (green). Customer used it in their *own words*.

2. **Co-insurance — agreed, not shown (the false-assent catch).**
   - Rep: "On top of that there's 10% co-insurance — your share of the bill."
   - Customer: "Okay, yeah, that makes sense."
   - → Alert: **Agreed, not demonstrated.** The console offers the teach-back. This is the point most
     copilots miss — agreement is not understanding.

3. **Panel providers — misunderstood (the trigger).**
   - Customer: "So any hospital is the same coverage, right?"
   - → Ledger row **Panel providers → Misunderstood** (red). The readiness seal drops to **not ready**.

4. **THE BEAT — ask for a recommendation.**
   - Rep (out loud): "Which tier should he go with?"
   - → PRUAssist does **not** produce a recommendation. The comparison names the unsettled dimension:
     *"Settle panel vs non-panel coverage before advising a tier — the customer has it wrong."* The
     readiness panel shows **2 of 3 settled** and the one blocker.
   - Say to the room: *"Every other assistant would just answer. Ours refuses — because recommending on
     something the customer got wrong is exactly how mis-selling happens."*

5. **Correct it — the gate opens.**
   - Rep presses **Ask the teach-back**, asks the panel-providers question.
   - Customer: "Ah — only panel hospitals get the full coverage; other hospitals I pay more."
   - → **Panel providers → Demonstrated.** Readiness flips to **ready**; now the comparison will weigh
     the options.

6. **The finish — the audit trail.**
   - End the session → **Export understanding record**.
   - A print-ready document: each concept, the customer's **own quoted words**, the **brochure pages**,
     timestamps, and the verdict banner (**Ready / Not ready to recommend**). Save as PDF.
   - Say: *"This is the file that settles a mis-selling dispute two years from now — and it wrote itself."*

## What makes it true (not theatre)

- The readiness verdict is a **deterministic projection of the ledger** (`readinessFor`,
  `src/lib/agent/readiness.ts`), not a model guess — `ready` requires every differentiator
  *demonstrated* and nothing *misunderstood*.
- The co-pilot never makes the recommendation by design (`POSTURE`, `src/lib/agent/prompts.ts`); the
  comparison prompt is *forbidden* from advising on an undemonstrated dimension
  (`comparisonSystemInstruction`).
- The export is the same record shown on screen, built by `buildComplianceRecord`
  (`src/lib/agent/record.ts`) and rendered as a standalone document.

## Fallback if the live call is flaky

Drive the states from fixtures instead of talking:
```bash
npm run drive   # posts scripted turns to a live room; see scripts/drive.mjs
```
`fixtures/panel-misconception.json` produces the misunderstood-panel state, `fixtures/false-assent.json`
the agreed-not-shown state, `fixtures/tier-decision.json` the comparison. Rehearse once with these so
the beat lands even if the room's transcription misfires on the day.

## Rehearsal checklist
- [ ] Deepgram on (transcript shows "PRUShield", not "pru shield") — or Web Speech fallback is fine.
- [ ] The misunderstood-panel line reliably flips the readiness seal to **not ready**.
- [ ] Asking for a tier while not-ready shows the *withhold* message, not a recommendation.
- [ ] The teach-back correction flips it to **ready**.
- [ ] Export opens the record with the red verdict, then (after correction) the green one.
