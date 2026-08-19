# PRUAssist — setup on a brand-new computer

A complete, from-scratch walkthrough to get PRUAssist running on a machine that has **nothing installed yet**. Windows is the primary path (with macOS / Linux notes). Budget ~15 minutes, most of it downloads.

For what the app *is* and how it works, see **[README.md](README.md)**.

## 0. What you'll end up with

- The app running at **http://localhost:3000**
- A rep sign-in you can use, backed by your own LiveKit + Gemini keys
- (Optional) a public HTTPS link so a customer can join from a phone

## 1. Install the prerequisites

| Tool | Why | Get it |
|------|-----|--------|
| **Node.js 20 or newer** (LTS) | runs the app | https://nodejs.org — download the LTS installer, accept the defaults |
| **Google Chrome** or **Microsoft Edge** | the live transcription uses the browser's Web Speech API (Chrome/Edge only) | https://www.google.com/chrome |
| **Git** *(optional)* | only if you'll clone from a Git host | https://git-scm.com |

Open a **new** terminal (**PowerShell** on Windows, **Terminal** on macOS) and confirm Node is installed:

```
node -v
npm -v
```

Both should print version numbers, and `node -v` should be **v20** or higher.

## 2. Get the project onto this computer

**Option A — clone from GitHub (recommended)**

```
git clone https://github.com/mayaonaisu/pruassist.git
cd pruassist
```

This downloads everything you need. (`node_modules`, `.next`, and `.env.local` are intentionally **not** in the repo — you create those in the next steps.)

**Option B — copy the folder (offline)**

If you can't use Git, copy the whole project folder from another machine via a USB drive, OneDrive/Google Drive, or a zip. To keep it small and clean, **don't copy** these (they are regenerated or secret):

- `node_modules/` — large; recreated by `npm install`
- `.next/` — build cache; regenerated automatically
- `.env.local` — your secrets; recreate it in step 4

## 3. Install dependencies

From the project folder you just cloned/copied, install the dependencies:

```
cd pruassist
npm install
```

This reads `package.json` and downloads everything into a fresh `node_modules/` (a few minutes the first time).

## 4. Create your environment file

The app needs API keys and a login, kept in `.env.local` — which is **gitignored; never commit or share it publicly**.

> **Were you sent a ready-made `.env.local`?** Just drop it into the project folder and skip to **step 5** — it already has working keys, so you don't need your own LiveKit/Gemini accounts. Keep it private (don't commit or post it anywhere public).

Otherwise, copy the template:

```
# Windows PowerShell
Copy-Item .env.example .env.local
# macOS / Linux / Git Bash
cp .env.example .env.local
```

Open `.env.local` in a text editor and fill in the six values:

**LiveKit (video)** — create a free project at **https://cloud.livekit.io**, then **Settings → Keys → Create Key**:

```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
NEXT_PUBLIC_LIVEKIT_URL=wss://<your-project>.livekit.cloud
```

**Google Gemini (AI talking points + embeddings)** — get a free key at **https://aistudio.google.com/apikey**:

```
GEMINI_API_KEY=...
```

**Representative login** — you choose these; they're what you type at `/login`:

```
REP_USERNAME=rep
REP_PASSWORD=<pick a strong password>
```

**Session signing secret** — any long random string. Generate one with Node (already installed):

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output:

```
AUTH_SECRET=<the generated hex string>
```

## 5. Run it

```
npm run dev
```

Leave this running — it serves the app on port 3000. To stop it later, press **Ctrl+C**.

> This is a **cross-device demo** (rep on your laptop, customer on a phone), so you'll open the app at the **tunnel URL** from step 6 — not `localhost`.

## 6. Expose it over HTTPS with ngrok

Phones need **HTTPS** for camera + mic, so put the running app behind a tunnel. With `npm run dev` still running:

1. Install ngrok once:
   - Windows: `winget install ngrok.ngrok`
   - macOS: `brew install ngrok`
   - or download it: https://ngrok.com/download
2. Sign up (free) and copy your authtoken from **https://dashboard.ngrok.com/get-started/your-authtoken**, then register it once:
   ```
   ngrok config add-authtoken <your-token>
   ```
3. In a **second terminal**, run:
   ```
   ngrok http 3000
   ```
4. It prints a `https://<random>.ngrok-free.app` URL — that's your demo link. The first time a device opens it, ngrok shows a one-time **"Visit Site"** page; just click through.

*Alternative — Cloudflare quick tunnel (no account):* install cloudflared, then `cloudflared tunnel --url http://localhost:3000` and use the `https://…trycloudflare.com` URL. (`next.config.ts` allow-lists both `*.ngrok-free.app` / `.dev` and `*.trycloudflare.com`.)

## 7. Run the cross-device demo

1. On your **laptop**, open the **tunnel URL** from step 6 — the `https://…ngrok-free.app` link, **not** `localhost`.
2. Click **Representative sign in**, log in with your `REP_USERNAME` / `REP_PASSWORD`, and **Start** the session.
3. **Copy the customer link**, then open it on your **phone** (or send it to a friend's phone).
4. On the phone: tap **I consent** → enter a name → **Join**. You're now in a live cross-device call — video for the customer, and the private co-pilot on the rep's laptop.

## Shortcut — one-click launch (after the one-time setup)

Once you've done the setup above once (installed Node + ngrok, ran `ngrok config add-authtoken …`, and put `.env.local` in place), you don't have to run the commands by hand each time — just **double-click `Start-PRUAssist.bat`** from the project's top folder.

It installs dependencies on first run, starts the dev server **and** the ngrok tunnel, then opens the public `https://…` URL in your browser automatically. Close the two windows to stop. It uses whatever Node/ngrok are on your PATH — and if you've reserved your own ngrok domain, set it once at the top of the script.

## 8. Troubleshooting

**Port 3000 is already in use / the tunnel shows the wrong app.**
Something else grabbed port 3000, so Next.js bounced PRUAssist to **3001** (and any tunnel pointed at 3000 now serves the other app). Check what's on each port, then free 3000 or point your tunnel at the port PRUAssist actually printed:

```powershell
Get-NetTCPConnection -LocalPort 3000,3001 -State Listen | ForEach-Object { "$($_.LocalPort) -> PID $($_.OwningProcess)" }
Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object CommandLine
```

**"No microphone" in the rep console.**
Chrome sometimes starts with zero audio inputs if another app holds the mic. Close apps using the mic (Teams / Zoom / Discord / NVIDIA Broadcast), then fully restart Chrome and reload.

**Camera / mic won't work on a phone.**
Browsers block them on plain `http://` for anything but localhost — you must use the **HTTPS tunnel** (step 7).

**Transcription does nothing.**
Use **Chrome or Edge** — the Web Speech API isn't available in Safari / Firefox.

**Changed `.env.local` but nothing changed.**
Stop (`Ctrl+C`) and re-run `npm run dev` — environment variables load only at startup.

**`npm install` fails.**
Make sure `node -v` is v20+. Delete `node_modules` and `package-lock.json` and run `npm install` again.
