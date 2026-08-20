# PRUAssist

AI co-pilot for Prudential financial representatives — a private assistant that listens to a live, **consented** advisory meeting, catches the moment the customer stops following, and hands the representative one **policy-grounded** line to say, with the brochure page it came from.

It supports the representative only. The customer never interacts with the AI, never sees the prompts, and the representative makes every recommendation.

Built for the **PolyFinTech API100 Hackathon 2026** (Prudential "Insurance Navigator" challenge).

**Live:** https://pruassist.vercel.app

**Stack:** Next.js 16 · React 19 · TypeScript · LiveKit (video) · Google Gemini (talking points + embeddings) · Upstash Redis (session state) · browser Web Speech API (transcription)

---

## How it works

1. **The rep signs in** at `/login`, lands on the console at `/rep`, confirms consent, sets the meeting focus, and starts a session.
2. They send the customer a **private link**. The customer opens it, consents to recording, and joins the video call — seeing **video only**, never the AI or the transcript.
3. Each browser transcribes its **own** microphone with the Web Speech API. The customer's words travel privately to the rep over LiveKit's data channel.
4. When the customer asks something, PRUAssist retrieves the relevant policy clauses and Gemini writes **one line to say**, grounded in those clauses and shown with its page citation — privately, on the rep's screen.
5. In parallel, a slower pass tracks **what the customer has actually demonstrated** — not what they agreed to. When someone says "okay, that makes sense" without ever using the idea in their own words, the rep is told so privately, and given the question that would settle it.
6. On ending the session, the transcript is summarised into an **advisor brief**, and the comprehension evidence becomes an **Understanding Record**: per concept, what state it reached, the customer's own timestamped words, and the brochure pages it was grounded in.

## Routes

| Route | Who | What |
|-------|-----|------|
| `/` | anyone | Landing page → "Representative sign in" |
| `/login` | rep | Sign in — sets a signed, httpOnly session cookie (8-hour expiry) |
| `/rep` | rep (protected) | The console: Ready → Consent → Live → Brief. Redirects to `/login` when signed out. |
| `/c/[token]` | customer | Private per-session link: consent → camera/mic preview → **video-only** call |

---

## Setting it up

You need three free accounts: **Upstash** (session store), **Vercel** (hosting), and **Google AI Studio** (Gemini). LiveKit Cloud has a free tier for the video.

### 1. Create the Redis database

Sign up at **https://console.upstash.com**, create a database (pick the region closest to you — `ap-southeast-1` for Singapore), then open the **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

**This is not optional.** Vercel runs each API route as a serverless function, and separate invocations can land on different instances that share no memory. Kept in process memory, a session created by the rep would be invisible to the customer's request — so join links would fail *sometimes*, which is far harder to spot than failing always. `src/lib/store.ts` uses Redis when it's configured and process memory when it isn't.

Each session writes up to five keys — `sess:room:*`, `sess:tok:*`, `consent:*`, `sess:agent:*` (the concept ledger) and `sess:agent:*:acts` (rep actions queued for the next pass) — all expiring after 24 hours, so the database never fills up. The two `sess:agent:*` keys are deleted outright when the rep ends the session.

### 2. Import the repo into Vercel

Sign up at **https://vercel.com** with your GitHub account, then **Add New → Project** and import this repository.

Leave **Root Directory** at its default — the Next.js app sits at the repo root, and `vercel.json` pins the framework preset, so no build configuration is needed.

### 3. Add the environment variables

Add these under **Settings → Environment Variables** before the first deploy, selecting all three environments (Production, Preview, Development):

| Variable | Where to get it |
|----------|-----------------|
| `LIVEKIT_API_KEY` | LiveKit Cloud → Settings → Keys |
| `LIVEKIT_API_SECRET` | LiveKit Cloud → Settings → Keys |
| `NEXT_PUBLIC_LIVEKIT_URL` | The `wss://….livekit.cloud` URL of your LiveKit project |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `UPSTASH_REDIS_REST_URL` | Upstash → your database → REST API |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash → your database → REST API |
| `REP_USERNAME` | You choose it — the rep sign-in |
| `REP_PASSWORD` | You choose it — **use a strong one, the URL is public** |
| `AUTH_SECRET` | At least 32 characters: `openssl rand -hex 32` |
| `REP_DISPLAY_NAME` | *(optional)* fallback name the customer sees if the rep leaves the consent signature blank |

`AUTH_SECRET` shorter than 32 characters is rejected at startup and every sign-in will fail until it's long enough.

Then hit **Deploy**.

### 4. Check it works

1. The root URL loads the landing page.
2. `/login` accepts your credentials.
3. Start a session and **open the customer link on a different device**. This is the check that matters — it is what proves the shared store is working, and testing in the same browser can pass while it is still broken. If it says *"This session link is not valid"*, the two `UPSTASH_*` variables are missing or scoped to the wrong environment.
4. Allow the microphone when prompted; the control on your own camera tile should not show a blocked state.
5. Say a sentence about the deductible, have the customer reply *"okay, yeah, that makes sense"*, and wait a few seconds. A private comprehension alert should appear above the line block. If it never does, check the server log for `[agent]` lines — and note that `next dev` keeps the process alive forever, so a broken `after()` still appears to work locally. **Verify it on a Vercel preview deployment** before relying on it.

---

## How the AI works

Suggestions come from `/api/assist`, which is **retrieval-first** — the model only ever writes from clauses that were actually retrieved:

- The knowledge base ([`src/lib/knowledge.ts`](src/lib/knowledge.ts)) holds 32 clauses across five Prudential brochures, each carrying a page citation. Retrieval is scoped to the product area the rep picked at consent.
- The recent transcript is embedded with **`gemini-embedding-001`** and matched to the closest clauses by cosine similarity, with the corpus and the query embedded for different task types (asymmetric retrieval ranks measurably better than using the default for both).
- A calibrated relevance floor means off-topic conversation returns **nothing** rather than a confident answer citing a real page number.
- **`gemini-2.5-flash`** then writes the line, grounded in those clauses and returned with their sources. Change the model in [`src/app/api/assist/route.ts`](src/app/api/assist/route.ts).

Both `/api/assist` and `/api/summary` require a signed-in rep — they spend billed API calls, so they are not open to the public URL.

Without `GEMINI_API_KEY` the co-pilot stays dormant and the rest of the app still works.

## The Concept Ledger

Every product in this category models **the rep** — did they say the disclosure, did they handle the
objection. PRUAssist models the **customer**, because two separately-attributed transcripts make that
possible and because "evidence of customer comprehension, not just their agreement" is what a
suitability record actually needs.

Each material concept moves through a state machine with an evidentiary standard:

```
unseen → raised          the rep introduced it
       → asserted        the customer signalled assent ("okay", "yeah") — NOT understanding
       → demonstrated    the customer used it correctly in their own words
       → misunderstood   the customer used it incorrectly ← highest-priority alert
```

`asserted` and `demonstrated` are deliberately different states, and the gap between them is the
product. Concepts and their canonical statements live in [`src/lib/concepts.ts`](src/lib/concepts.ts),
anchored to clause ids that must exist in `KNOWLEDGE` — the module throws at import if one does not,
so a concept can never produce an uncitable claim.

**How a state is decided.** Every utterance is read twice. Embeddings handle paraphrase but are weak
on polarity: *"I pay the first chunk myself"* and *"the insurer pays the first part and I pay the
rest"* are opposites that share nearly all their vocabulary, and cosine ranks the wrong one first.
Word overlap gets that case right. So `misunderstood` requires **both** readings to agree, while
`demonstrated` needs only one — a wrong "they're confused" costs far more than a teach-back the rep
did not need. Thresholds come from [`scripts/scores.mts`](scripts/scores.mts), not intuition.

**Two speeds.** `/api/agent/state` returns the ledger as it stands and schedules the scoring pass with
`after()` from `next/server`, so it runs once the response is flushed. The rep's view is one cycle
behind the scoring and never waits on it. The pass is debounced per room, and rep actions ("Asked
it", "Not now") are appended to their own key so they can never race it. Set `PRUASSIST_DEEP=0` to
turn the whole thing off without a deploy.

### Running it without a browser

The ledger has its own development loop — a scripted two-speaker transcript fed through the real
detectors and the real ledger, with no video and no second device:

```bash
npm run replay -- fixtures/false-assent.json
```

It prints every signal that fires, every transition with its evidence quote, and the final
Understanding Record. `--no-ai` forces the keyword fallback, which is what runs when Gemini is
unreachable; both paths must pass. This is also the deterministic fallback if live demo conditions
are bad — browser speech recognition on venue wifi is not something to stake a run on.

```bash
npm run replay:all
```

The five fixtures cover a false assent, the panel-provider misconception, a re-asked question, a
correct explain-back, and small talk the assistant must stay silent through. Each one declares the
state it expects, so the run exits non-zero when a change breaks one.

## Video and transcription

Video runs on **LiveKit Cloud**. A server-side route ([`src/app/api/token/route.ts`](src/app/api/token/route.ts)) mints access tokens so the API secret never reaches the browser — only the `wss://` URL is public, which is expected. Create a project at **https://cloud.livekit.io** → **Settings → Keys**.

Transcription needs no extra service: each browser runs the built-in **Web Speech API** on its own microphone. The rep's speech is transcribed locally; the customer's is transcribed in their browser and sent privately to the rep. This works in **Chrome and Edge**. For production-grade server-side transcription of both parties, swap it for a LiveKit Agent with Amazon Transcribe or Deepgram.

## Design

The interface is one warm paper world — a marked-up policy brochure. Typography carries meaning rather than decoration: **Newsreader** is used only for the human voice (the line to say, the customer's own words, a signed name), **Geist Mono** only for citations, timestamps and measured values, **Fraunces** only for document titles, and **Inter** for everything else. A highlighter marks one thing and one thing only — where the customer lost the thread.

## Notes and caveats

- **Demo-grade auth.** One shared credential for the representative, compared in plaintext against the environment variables. There is no rate limiting on `/api/login`, and signing out cannot revoke an already-issued token before its 8-hour expiry. Real use needs a user store with hashed passwords.
- **Grounding disclaimer.** The knowledge base is grounded in Prudential's **public PRUShield brochure** (April 2026) with page citations. Re-verify every figure against the latest brochure and the policy documents before any real advisory use — the brochure itself states it is "for reference only and is not a contract of insurance."
- **Privacy of speech.** The Web Speech API sends audio to the browser's speech service (Google, in Chrome). The consent copy covers recording and transcription; an on-device path such as faster-whisper would remove that dependency.
- **Sessions expire after 24 hours.** The raw transcript is never persisted — it lives in the rep's browser and is discarded when they leave the page. The concept ledger does persist **short quotes tied to a specific policy concept**, because those quotes are the Understanding Record; both consent screens say so, and the keys are deleted when the session ends.
- **Comprehension is inferred from language and timing only.** The Web Speech API returns words and timestamps, not tone or hesitation, so there is no prosody anywhere in this system. Response latency is corroborating evidence in the alert copy and never changes a concept's state — network jitter and voice-activity endpointing both distort it.
- **`misunderstood` means "said something matching a known misconception"**, not "does not understand". The misconceptions are authored in [`src/lib/concepts.ts`](src/lib/concepts.ts): the system detects known wrong framings, not arbitrary ones. The record states what was observed and never returns a verdict on a person.
- **Vercel's Hobby plan is non-commercial.** Fine for a hackathon; a commercial deployment needs Pro.
