# Deploying PRUAssist to Vercel

Once this is done the app stays online at a permanent URL — no `npm run dev`, no tunnel, no laptop
required. Every `git push` redeploys it automatically.

Total time: about 10 minutes. Everything used here is free.

---

## Why Redis is required

Advisory sessions and consent records are keyed state: the representative creates a session, and
the customer's join link has to find it again.

Vercel runs each API route as a **serverless function**, and separate invocations can land on
different instances that share no memory. Kept in a plain in-process `Map`, a session created by
the rep would be invisible to the customer's request — so join links would fail *sometimes*,
which is harder to spot than failing always.

`src/lib/store.ts` therefore keeps that state in Redis when it's configured, and in process memory
when it isn't. Local `npm run dev` needs no setup; a deployed instance needs Redis.

---

## Step 1 — Redis database ✅ done

The Upstash database is already created and verified working. Its two REST credentials are in
`pruassist-ui/.env.local` (gitignored) and are needed again in step 3.

Verified end to end: a session written by one process was read back by a *separate* process — the
same condition serverless creates. Each session writes exactly three keys
(`sess:room:*`, `sess:tok:*`, `consent:*`), all expiring after 24 hours, so the database never
fills up.

---

## Step 2 — Import the repo into Vercel

1. Sign up at **https://vercel.com** with your GitHub account.
2. **Add New → Project**, then import `mayaonaisu/pruassist`.
3. Set **Root Directory** to `pruassist-ui`. This matters — the Next.js app is not at the repo
   root, and the build fails without it.
4. Leave the framework preset as Next.js and the build settings at their defaults.

---

## Step 3 — Add the environment variables

Before the first deploy, add these under **Settings → Environment Variables** (select all three
environments: Production, Preview, Development):

| Variable | Value |
|---|---|
| `LIVEKIT_API_KEY` | from your `.env.local` |
| `LIVEKIT_API_SECRET` | from your `.env.local` |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://hackathon-4yosr7jf.livekit.cloud` |
| `GEMINI_API_KEY` | from your `.env.local` |
| `REP_USERNAME` | your chosen login |
| `REP_PASSWORD` | **use a strong one — this URL is public** |
| `AUTH_SECRET` | at least 32 characters (`openssl rand -hex 32`) |
| `UPSTASH_REDIS_REST_URL` | from step 1 |
| `UPSTASH_REDIS_REST_TOKEN` | from step 1 |
| `REP_DISPLAY_NAME` | *(optional)* fallback name the customer sees |

`AUTH_SECRET` shorter than 32 characters is rejected at startup, and every sign-in will fail until
it's long enough.

`PUBLIC_TUNNEL` is **not** needed here — Vercel sets `NODE_ENV=production`, so the session cookie
is already marked `Secure`.

Then hit **Deploy**.

---

## Step 4 — Check it works

Open the deployed URL and confirm:

1. `/login` accepts your credentials.
2. Starting a session produces a customer link.
3. **Open that link in a different browser or on your phone** — this is the check that matters,
   because it is what proves the shared store is working. If it says *"This session link is not
   valid"*, the Redis variables are missing or wrong.
4. Allow the microphone when prompted; the control bar should read "Mic", not "Mic blocked".

---

## Notes

- **Custom domain** — add one under Settings → Domains. Vercel handles HTTPS.
- **Cost** — Vercel Hobby and Upstash free tiers cover a demo comfortably. Gemini and LiveKit bill
  separately under their own free tiers.
- **Hobby plan is non-commercial.** Fine for a hackathon; a commercial deployment needs Pro.
- **Set a strong `REP_PASSWORD` in Vercel before sharing the URL.** The local `.env.local` still
  holds the original demo credentials, and the deployed app is reachable by anyone with the link.
- **Auth is still demo-grade** — one shared login, no rate limiting on `/api/login`, and signing
  out cannot revoke an already-issued token before its 8-hour expiry.
