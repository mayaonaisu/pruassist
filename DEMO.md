# Two-device demo script

A word-for-word run for a live demo on the Vercel deployment: **Device A** is the representative
(signed in, `/rep`), **Device B** is the customer (opened the join link). Every line below is drawn
from the replay fixtures, so the console reacts the way the callouts promise.

The arc: a false assent the console catches → a teach-back that settles it → three concepts
demonstrated → one differentiator (pro-ration) left merely agreed to → the comparison question →
the readiness panel showing exactly what is unsettled → settle it → recommend.

## Before you start

- **Both devices on Chrome or Edge.** Transcription is the Web Speech API. Safari and Firefox do
  not transcribe, and every iOS browser is Safari underneath — the customer device should be
  **Android Chrome or a desktop**.
- Both devices grant **microphone** permission (camera optional). The customer's words only reach
  the rep if the customer device is transcribing.
- Rep: start a session (Health Protection), copy the customer link, send it to Device B.
- Customer: open the link, consent, enter a name (e.g. **Mei Ling**), allow mic, join.
- Rep console header should show the customer's name instead of "awaiting customer".

**Pace it.** After each customer line marked ⏸, wait ~5–10 seconds. The scoring pass runs just
after each poll, so the alert or panel appears a beat later — not instantly. Watch the transcript
pane to confirm each line was heard correctly before moving on; if a line came out garbled, just
say it again.

---

## Beat 1 — The false assent

**REP (A):**
> So before we look at the plans, the piece everyone trips over is the deductible. That is the
> amount you pay yourself first, once per policy year, before MediShield Life or PRUShield pays
> anything at all.

**CUSTOMER (B):** ⏸
> Okay, yeah, that makes sense.

**On the rep console:** a **false-assent alert** appears — "They agreed, but they have not shown
it" — with the pause noted, and a teach-back question suggested. This is the moment every other
tool would score as a success.

---

## Beat 2 — The teach-back settles it

**REP (A):** press **Asked it** on the alert, then read its question aloud:
> Just so I know I explained it well — if your bill came to S$8,000 at a panel hospital, what would
> you expect to pay first, and who pays the rest?

**CUSTOMER (B):** ⏸
> I'd cover the first slice out of my own pocket, and that is only once for the whole year, then the
> insurance picks up the rest.

**On the rep console:** the deductible row flips to **demonstrated** — graded against the clause,
in the customer's own words. The alert clears.

---

## Beat 3 — Deductible amounts

**REP (A):**
> Right. Now the deductible amount depends on the ward — S$1,500 in a C ward, S$2,500 in B1, and
> S$3,500 in an A ward.

**CUSTOMER (B):** ⏸
> So it depends where I am treated — B1 is about S$2,500 and an A ward is S$3,500.

**On the rep console:** the deductible-amount row reaches **demonstrated**.

---

## Beat 4 — The yearly limits

**REP (A):**
> Exactly. The yearly limit differs too — Premier is S$2,000,000 a year, Plus is S$1,000,000, and
> Standard is S$200,000.

**CUSTOMER (B):** ⏸
> So Premier gives me the highest ceiling in a year and Standard the lowest of the three.

**On the rep console:** the limits-of-cover row reaches **demonstrated**.

---

## Beat 5 — Pro-ration, agreed but not shown

**REP (A):**
> And if you go to a hospital above what your plan entitles you to, the claim is pro-rated first —
> on Plus a private hospital is cut to 65%.

**CUSTOMER (B):** ⏸
> Okay, yeah, that makes sense.

**On the rep console:** pro-ration reaches **agreed only** — *not* demonstrated. This is the one
that changes the bill, and the console keeps it flagged.

---

## Beat 6 — The comparison question

**CUSTOMER (B):** ⏸
> So which plan would be better for me, Premier or Plus?

**On the rep console:** the **readiness panel** now reads **Which PRUShield tier?** with:
- Deductible — **shown**
- Deductible amount — **shown**
- Limits of cover — **shown**
- Pro-ration — **agreed only**
- **2 / 3 settled**, and an **Ask it** button pointing at pro-ration.

The line-to-say the rep gets is a comparison that *names what is not yet settled* — it will not hand
over a clean Premier-vs-Plus table, because the customer has not shown they understand pro-ration.

---

## Beat 7 — Settle the last differentiator

**REP (A):** press **Ask it** in the panel, then read the pro-ration question aloud:
> If you were on Plus and went to a private hospital, how much of that bill would you expect to be
> claimable?

**CUSTOMER (B):** ⏸
> On Plus, a private hospital bill gets scaled down to 65% first, and the claim is worked out from
> that.

**On the rep console:** pro-ration flips to **shown**, the panel reads **3 / 3 settled** and turns
to **Ready to recommend**.

---

## Beat 8 — Recommend, and close

**REP (A):**
> Then Plus is the one that fits — you have got the trade-off: the S$1,000,000 ceiling, and the
> private-hospital claim pro-rated to 65%. Shall we go with that?

**CUSTOMER (B):**
> Yes, let's do Plus.

**REP (A):** press **End session**.

**Result:** the **Understanding Record** — one row per concept, the customer's own timestamped
words as evidence, the brochure pages, and nothing left open. The recommendation was made by a
human, with evidence the customer understood what they chose between.

---

## If something does not land

- **No line appears in the transcript:** wrong browser, or mic blocked. Check the padlock in the
  address bar.
- **A line was misheard:** the transcript pane shows what was captured — just repeat the line.
- **No alert / no AI line:** a Gemini 429 (quota) or missing key. Check **Vercel → the deployment →
  Functions logs** for `[agent] … rev=…` and any `quotaId`.
- **"Comprehension tracking unavailable":** the Upstash env vars are missing on Vercel.
- **To run it again:** end the session and start a fresh one — a new customer link. Each full run
  spends roughly 10–20 Gemini calls across the key pool.
