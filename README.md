# PRUAssist

AI co-pilot for Prudential financial representatives — a private assistant that listens to a live, **consented** advisory meeting, detects customer confusion, and surfaces **policy-grounded** talking points to the representative in real time. It supports the representative only: the customer never interacts with the AI, and it never makes the recommendation.

Built for the **PolyFinTech API100 Hackathon 2026** (Prudential "Insurance Navigator" challenge).

**Stack:** Next.js 16 · TypeScript · React 19 · LiveKit (video) · Google Gemini (talking points + embeddings) · browser Web Speech API (transcription).

> **Setting up on a brand-new computer?** Follow **[SETUP.md](SETUP.md)** — a full, from-scratch walkthrough. The section below is the short version for a machine that already has Node.js.

## Quick start

```bash
git clone https://github.com/mayaonaisu/pruassist.git
cd pruassist
npm install
```

Create your local environment file from the template and fill in your own keys:

```bash
# Windows PowerShell
Copy-Item .env.example .env.local
# macOS / Linux / Git Bash
cp .env.example .env.local
```

Then run it:

```bash
npm run dev
```

Open **http://localhost:3000**, then sign in at **/login** with the `REP_USERNAME` / `REP_PASSWORD` you set in `.env.local`. Full variable list + where to get each value: [`.env.example`](.env.example) (see also [SETUP.md](SETUP.md)).

---

## How it works

1. **Rep signs in** (`/login`) → lands on the console (`/rep`) → confirms consent, sets the meeting focus, and **starts a session**.
2. The rep gets a **private link** to send the customer. The customer opens it, **consents to recording**, and joins the video call — seeing **video only**, never the AI or transcript.
3. Each browser transcribes its own microphone with the **Web Speech API**. The customer's words are sent **privately to the rep** over LiveKit's data channel.
4. When the customer asks something, PRUAssist **retrieves the relevant policy clauses** (Gemini embeddings + cosine similarity over the knowledge base) and has **Gemini** generate concise, **grounded** talking points — shown privately to the rep, each with its source.
5. On end, the transcript is summarised into a **post-session brief** (concerns, points covered, follow-ups).

## App structure (routes)

| Route | Who | What |
|-------|-----|------|
| `/` | anyone | Marketing landing → "Representative sign in" |
| `/login` | rep | Sign in — sets a signed, httpOnly session cookie |
| `/rep` | rep (protected) | The console: Intro launchpad → Consent & context → Live session → Summary. Redirects to `/login` if not signed in. |
| `/c/[token]` | customer | Private per-session link: consent → camera/mic preview → **video-only** call |

## The two sides

**Representative** — signs in, controls the whole session, sees video + live transcript + the private co-pilot pointers, and copies the customer's private link. Makes every recommendation; PRUAssist only offers words to use, rephrase, or ignore.

**Customer** — opens their private link, consents to recording, joins a normal video call. Sees only video and their own mic/camera controls. Never sees the transcript or the AI.

## Transcription (free, no extra service)

Each browser runs the built-in **Web Speech API** on its *own* microphone:

- The **rep's** speech is transcribed locally and shown in the rep panel.
- The **customer's** speech is transcribed in the customer's browser and sent **privately to the rep** over LiveKit's data channel — the customer never sees a transcript.

Works in **Chrome / Edge** (which back the Web Speech API). For production-grade, server-side transcription of both parties, swap this for a LiveKit Agent + Amazon Transcribe / Deepgram.

## AI talking points (RAG, grounded)

The co-pilot's suggestions come from `/api/assist`, using **Google Gemini** via `@google/genai`:

- The knowledge base ([`src/lib/knowledge.ts`](src/lib/knowledge.ts)) holds PRUShield + PRUExtra clauses, each with a brochure **page citation**.
- On a customer question, the recent transcript is embedded (`text-embedding-004`) and matched to the closest clauses by cosine similarity.
- Gemini (`gemini-2.5-flash`) then writes concise talking points **grounded** in those clauses, returned with their sources. Change the model in [`src/app/api/assist/route.ts`](src/app/api/assist/route.ts).

Requires `GEMINI_API_KEY`; without it the co-pilot panel stays dormant.

## Video (LiveKit)

Video runs on **LiveKit Cloud** (free tier). A server-side token route ([`src/app/api/token/route.ts`](src/app/api/token/route.ts)) mints access tokens so the API secret never reaches the browser — only the `wss://` URL is public, which is expected. Create a project at **https://cloud.livekit.io** → **Settings → Keys** to get the three values below.

## Environment variables

Copy `.env.example` → `.env.local` and fill in:

| Variable | Where to get it |
|----------|-----------------|
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit Cloud → Settings → Keys |
| `NEXT_PUBLIC_LIVEKIT_URL` | The `wss://…livekit.cloud` URL of your LiveKit project |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `REP_USERNAME` / `REP_PASSWORD` | You choose these (the rep sign-in) |
| `AUTH_SECRET` | Any long random string — e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

`.env.local` is **gitignored** — never commit it. Changing it requires a dev-server restart.

## Cross-device demo (optional)

To let a customer join from a phone or a second laptop, expose the local server over **HTTPS** with a tunnel (e.g. **ngrok**) — browsers require HTTPS for camera/mic on anything but `localhost`. `next.config.ts` already allow-lists common tunnel domains. **Open the app at the tunnel URL (not `localhost`)** so the customer link you copy is shareable (it is built from `window.location.origin`). See [SETUP.md](SETUP.md) for the ngrok steps.

## Test it locally (two tabs, one laptop)

1. `npm run dev`
2. **Rep tab:** http://localhost:3000/login → sign in → start a session → copy the customer link.
3. **Customer tab:** paste the link → **I consent** → enter a name → Join.
4. Talk in both tabs: the rep panel shows a live, speaker-labelled transcript; when the customer asks a question, grounded pointers appear (needs `GEMINI_API_KEY`).
5. Confirm the customer tab shows **only** video — no transcript, no AI.

> Two tabs on one laptop is the easiest test — the two mics are separate tabs, so both sides of the transcript appear for the rep. Chrome lets multiple tabs share one webcam.

## Notes & caveats

- **In-memory state.** Session and consent are held in memory and **reset on server restart** — fine for a demo; production would move these to a database.
- **Demo-grade auth.** A single shared rep credential. For real use, add a user store with hashed passwords.
- **Grounding disclaimer.** `knowledge.ts` is grounded in Prudential's **public PRUShield brochure** with page citations. Re-verify figures against the latest brochure and policy documents before any real advisory use — the brochure is "for reference only and is not a contract of insurance."
- **Privacy of speech.** The Web Speech API sends audio to the browser's speech service (Google, in Chrome). The consent copy covers recording/transcription; an on-device path (e.g. faster-whisper) would remove that.
- **One-click launcher (Windows).** After the one-time setup, double-click `Start-PRUAssist.bat` to start the dev server + ngrok tunnel and open the public URL for you — it uses whatever Node/ngrok are on your PATH (see [SETUP.md](SETUP.md)).

## Further docs

- **[SETUP.md](SETUP.md)** — brand-new-computer setup, step by step.
