# Architecture & software-design research

Primary-source-backed recommendations for improving PRUAssist. Every non-obvious claim links to
the official doc/spec/source that owns it; where a claim could **not** be confirmed against a
primary source, that is stated explicitly rather than filled with a secondary write-up.

- **Scope reviewed:** the code as it stands on `agentic-integration` — the LangGraph orchestrator
  (`src/lib/agent/orchestrator/`), the Concept Ledger and deep pass (`src/lib/agent/`), the store
  seam (`src/lib/store.ts`), retrieval (`src/lib/retrieval.ts`), auth (`src/lib/auth.ts`,
  `src/app/api/login/route.ts`), transcription (`src/lib/useDeepgramSpeech.ts`, `useTranscript.ts`,
  `terms.ts`), and every route handler under `src/app/api/`.
- **Stack versions (verified):** `next@16.2.9`, `react@19.2.4`, `@langchain/langgraph@^1.4.12`,
  `@upstash/redis@^1.38.2`, `@google/genai@^2.10.0`, `jose@^6.2.3` (`package.json`). The current
  Next.js docs report v16.3.2, so version-specific APIs below (`after()`, Route Handlers) are checked
  against 16.x.
- **Method / limits:** researched August 2026 against `nextjs.org`, `vercel.com/docs`,
  `ai.google.dev`, `redis.io`, `upstash.com/docs`, `docs.langchain.com`, `docs.livekit.io`,
  `developers.deepgram.com`, `github.com/panva/jose`, OWASP Cheat Sheets, and MDN. Two facts the app's
  own docs assert could not be re-confirmed against a *current* primary source and are flagged inline
  (Gemini free-tier request numbers; "Next.js says stateless JWTs can't be revoked").

---

## Quick wins vs bigger bets

**Quick wins** — low effort, low risk, and each removes a real defect or unsupported assumption:

| # | Change | File(s) | Why it's cheap |
|---|--------|---------|----------------|
| QW1 | Rate-limit `/api/login`; constant-time credential compare; add a `role` check to `currentRep`; set `issuer`+`audience` on the JWT | `src/app/api/login/route.ts`, `src/lib/auth.ts` | A handful of lines; the public URL makes it matter even for the demo |
| QW2 | Route `/api/summary` through the shared key pool + `MODEL` constant instead of a raw `new GoogleGenAI` on a hardcoded `gemini-2.5-flash` | `src/app/api/summary/route.ts` | Deletes an inconsistency that can 404 mid-demo; reuses existing code |
| QW3 | Make the ledger write a true atomic compare-and-set via a Lua script (`redis.eval`) | `src/lib/agent/ledger.ts` (`saveState`) | ~15 lines of Lua; the SDK already exposes `eval()` |
| QW4 | Collapse Gemini round-trips per turn (parallel tool calls; skip phase-2 when phase-1 already produced prose) | `src/lib/agent/tools.ts`, `orchestrator/handlers.ts` | Fewer billed requests against the free-tier **request** ceiling |

**Bigger bets** — real value but a genuine architectural change, a new dependency, or a tradeoff to weigh:

| # | Change | Pain point | The tradeoff |
|---|--------|-----------|--------------|
| BB1 | Move post-response work off `after()` onto a durable queue (Vercel Queues / Workflows) | Serverless background work | `after()` is best-effort and killed on timeout; a queue survives crashes — but adds a beta dependency and a worker |
| BB2 | Strengthen the router: schema-validated structured output + a richer deterministic tier | Router reliability | More robust routing without the brain; but the brain is already a soft dependency that degrades |
| BB3 | Server-side transcription via a LiveKit Agent | Transcription | Better accuracy/consistency and vendor-supported delivery — but audio would leave the browser, weakening today's privacy property |
| BB4 | Only if cost becomes real: cheaper model tier for formatting calls + explicit context caching | Gemini cost | Cuts **token cost** on a *paid* plan; does **not** relieve the free-tier **request** ceiling |

The single most important framing for the cost discussion (below): on the free tier the ceiling is
**requests per project per day**, not tokens — so the lever is *fewer model round-trips*, and most
"cost" features (caching, cheaper models, batch) reduce token spend on a *paid* plan without moving
the request ceiling.

---

## How to read each recommendation

- **Effort:** S (an afternoon) · M (a few days) · L (a week+ / new infra).
- **Risk:** how likely the change is to break something or need careful rollout.
- **Demo vs production:** whether it matters for the hackathon run or only for real advisory use.

---

# Architecture

System structure, state, scaling, reliability, cost.

## A1 — Make the ledger write atomic (state-race correctness)

**Problem.** `saveState` (`src/lib/agent/ledger.ts`) reads the current record, compares its `rev`,
then writes — a read-then-write with a gap between the check and the set. Its own comment is honest
that this is "best-effort rather than a compare-and-swap." On serverless the write itself is
`redis.set(key, value, {ex})` (`src/lib/store.ts`). Two `deepPass` runs for the same room (scheduled
via `after()` and only debounced by a 5 s wall-clock check) can both read `rev = N`, both pass the
guard, and both write — a lost update. Blast radius is currently small (the deep pass is the sole
writer of `sess:agent:*`, it's debounced, and a dropped write is recovered next pass because the
cursor only advances on success), so this is correctness hardening, not a live-demo fire.

**Primary-source approach.** The clean fix depends on what Upstash's REST client actually supports:

- **`WATCH`/`MULTI` optimistic locking is unavailable on Upstash.** Upstash supports MULTI/EXEC
  transactions over REST, but its REST compatibility explicitly lists WATCH/UNWATCH/DISCARD as
  unsupported, and a MULTI/EXEC block can't branch on a value it read mid-transaction
  ([Upstash REST API](https://upstash.com/docs/redis/features/restapi)). So the textbook
  "WATCH the key, read, MULTI-set if unchanged" pattern cannot be used here.
- **Lua (`EVAL`) is the atomic conditional primitive.** A Lua script runs on the server as a single
  atomic step, so it can read the stored JSON, compare just its `rev` field, and set only on a match
  — the compare-and-set the current code approximates. `@upstash/redis` exposes this as
  `redis.eval(script, keys, args)`
  ([Upstash `eval`](https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval)). Redis's own docs
  use exactly this read-check-write Lua shape for safe conditional updates
  ([Redis `SET` — Patterns](https://redis.io/docs/latest/commands/set/)).
- **Alternative (simpler, if you split `rev` out):** keep the revision in its own key and use either
  atomic `INCR` for issuing revisions, or `SET key value IFEQ <old>` — the `IFEQ`/`IFNE` conditional
  set added in Redis 8.4 sets only when the current value matches
  ([Redis `SET`](https://redis.io/docs/latest/commands/set/)). Caveat: `IFEQ` compares the **whole
  stored value**, so it only works cleanly on a small scalar (a rev counter), not the JSON blob —
  and it depends on Upstash's engine being on 8.4+, which I did **not** confirm. Prefer the Lua CAS,
  which is version-independent.

The same reasoning applies to `drift.ts`, which does a plain read-modify-write on `sess:drift:*` and
justifies it with "the client is single-flight per room." That holds only while the assist route is
never hit concurrently for one room (two rep tabs, a retry, a double-submit break it). If you adopt
the Lua CAS for the ledger, the drift counter is a natural `INCR`/`EVAL` too.

**Effort / risk:** S–M / low. It's an isolated change behind the `Store` seam; add an
`Store.compareAndSet` (Redis: Lua; memory fallback: trivial) and have `saveState` call it.
**Demo vs production:** production. The demo almost never triggers the race; a real multi-writer
deployment will.

## A2 — Gemini free-tier survival and cost

**Problem.** A generating turn spends up to ~4 Gemini calls (tool loop ≤3 steps in
`src/lib/agent/tools.ts` + one synthesis in `orchestrator/handlers.ts`), and a lookahead up to ~5
(tool loop + synthesis + `verifyGrounding`). The session ceiling is `MAX_BACKGROUND_CALLS = 60`
(`src/lib/agent/gemini.ts`) with a 16-key rotating pool (`src/lib/genai.ts`). The README frames the
constraint as "20 `generateContent` requests a day and 10 a minute."

**What the primary sources actually say — and the key distinction.** Google no longer publishes
per-model free-tier RPM/RPD numbers in the docs; the rate-limit page defers to the per-project Google
AI Studio dashboard and states only that limits are applied **per project** (not per key) and that
daily quotas reset at midnight Pacific
([Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)). **I could not confirm the
README's "20/day, 10/min" against a current primary source** — it may be stale or model-specific;
this matches the README's own hedge to "confirm the quota on the key you are demoing with." The load-
bearing fact for design is the *shape*: the free-tier ceiling is a **request count per project per
day**, so the effective lever is **fewer round-trips**, and the key-pool rotation multiplies the
ceiling by adding projects — which the code already does well.

Concrete, primary-source-backed moves, in priority order:

1. **Cut round-trips with parallel function calling (helps the free-tier ceiling).** Gemini supports
   calling multiple independent functions in a single turn
   ([function calling](https://ai.google.dev/gemini-api/docs/function-calling)). The tool loop today
   iterates up to 3 sequential steps; letting the model issue `search_policy` + `read_ledger` in one
   turn collapses two billed requests into one. Also short-circuit the two-phase pattern when phase 1
   already returned usable prose, and keep the `MAX_TOOL_STEPS = 3` cap (well under the docs' "10–20
   tools" guidance — you have 3 tools, so tool count isn't the issue; round-trips are).
2. **Keep thinking off for formatting calls (already done — and correct).** Response billing is the
   sum of output **and** thinking tokens ([thinking](https://ai.google.dev/gemini-api/docs/thinking)),
   so the code's `thinking("off")` for synthesis/verify/grade is the right call; the family-specific
   `thinkingBudget` vs `thinkingLevel` split in `gemini.ts` matches the documented API difference.
3. **(Paid only) Cheaper model for formatting-only calls.** Flash-Lite models are positioned as
   faster and cheaper than Flash ([models](https://ai.google.dev/gemini-api/docs/models),
   [pricing](https://ai.google.dev/gemini-api/docs/pricing)). `PRUASSIST_MODEL` already lets you swap;
   a `FORMAT_MODEL` for synthesis/verify/grade (non-reasoning) while the tool loop keeps the reasoning
   model would cut token cost. Caveat that motivates the current `gemini-3.6-flash` default: Google
   documents only "limited access to certain models" on the free tier and gates the exact set to AI
   Studio, so a newly created project's key may not serve every model — the code's "every key must
   serve `MODEL`" rule is sound; validate any `FORMAT_MODEL` against all keys.
4. **(Paid only) Explicit context caching for the repeated system prompt + clause block.** Implicit
   caching is on by default for 2.5+ models and passes through savings automatically; explicit caching
   gives guaranteed savings but requires the legacy `generateContent` API and has a minimum cached
   size (2,048 tokens on 2.5, 4,096 on 3.x)
   ([context caching](https://ai.google.dev/gemini-api/docs/caching)). This reduces **token cost**, not
   request count, so it helps a paid deployment, not the free-tier ceiling. Free-tier eligibility of
   *explicit* caching is **not stated** in the docs.
5. **Batch API is not applicable to the live or session-end paths.** It runs asynchronously at 50% cost
   with a 24-hour turnaround ([Batch API](https://ai.google.dev/gemini-api/docs/batch-api)) — fine for
   offline eval, wrong for anything a rep waits on.

**Effort / risk:** parallel tool calls M / medium (touches the loop and the thoughtSignature echo);
model split S / low. **Demo vs production:** round-trip reduction helps the demo (request ceiling);
caching/model-tier are production cost levers.

## A3 — Post-response work: `after()` is best-effort, not durable

**Problem.** `/api/agent/state` schedules the scoring pass with `after()` (`maxDuration = 60`), and the
README already worries that `next dev`/`start` can't prove `after()` survives real serverless.

**Primary-source approach — the guarantees are now unambiguous.**

- `after()` schedules work to run after the response is sent and became **stable in Next.js 15.1**
  (so it's stable in 16.x), but it runs **inside the same invocation** and is bounded by the route's
  `maxDuration` ([`after()`](https://nextjs.org/docs/app/api-reference/functions/after)).
- On Vercel it's implemented on top of `waitUntil`, and the contract is explicit: promises passed to
  `waitUntil` share the function's timeout, and **if the function times out the promises are
  cancelled**; `getDeadline()` counts `waitUntil` work against `maxDuration`
  ([`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)).
  So a lookahead that runs long under throttling can be killed mid-flight — there is **no durable-
  completion guarantee**. (This is also why the code's choice to save the ledger *before* starting the
  lookahead is correct: the durable result is committed before the killable work begins.)
- Fluid compute (default-on for new projects since April 2025) enables post-response work via
  `waitUntil` but does **not** exempt it from the duration limit
  ([Fluid compute](https://vercel.com/docs/fluid-compute)); duration caps are 300 s on Hobby, up to
  800 s on Pro ([function duration](https://vercel.com/docs/functions/configuring-functions/duration)).

**What to do.** For a hackathon, `after()` is acceptable *if* you accept that a throttled lookahead may
not finish — which the design already tolerates (comprehension tracking continues on the deterministic
detectors). For production-grade durability the documented options are:

- **Vercel Queues** — a durable, append-only log that guarantees delivery even if a function crashes or
  a deploy rolls out, with at-least-once semantics and automatic retries
  ([Vercel Queues](https://vercel.com/docs/queues)). This is exactly the property `after()` lacks:
  publish "score room X" after responding, a consumer runs the deep pass with retries. **Status: public
  beta and permission-gated** (per the docs page header) — a real dependency risk to weigh.
- **Vercel Workflows** for multi-step/unlimited-duration orchestration (built on Queues), if the deep
  pass ever grows beyond one bounded step ([duration page](https://vercel.com/docs/functions/configuring-functions/duration)).
- **Vercel Cron** is **not** a fit for per-turn work: Hobby crons run at most once per day
  ([Cron Jobs](https://vercel.com/docs/cron-jobs)).

**Effort / risk:** Queues L / medium (new infra, beta). **Demo vs production:** the honest verdict is
`after()` is fine for the demo (and the README's "verify on a real Vercel preview" advice stands); a
durable queue is the production answer.

## A4 — Real-time delivery: polling is a defensible serverless choice

**Problem.** The console polls: `useComprehension` POSTs `/api/agent/state` every 5 s and
`useConsent` GETs `/api/consent` every 4 s. The question is whether Server-Sent Events or WebSockets
would be better.

**Primary-source tradeoffs.** Next.js Route Handlers can stream via a `ReadableStream` and Vercel
supports streaming natively, which is the basis for SSE
([streaming](https://nextjs.org/docs/app/guides/streaming),
[Vercel streaming](https://vercel.com/docs/functions/streaming-functions)); SSE's wire format is
`text/event-stream` with built-in auto-reconnect and `id:`/`retry:` fields
([MDN: Using SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)).
But on serverless the costs are real:

- A streamed response **counts against `maxDuration`** — the connection is force-closed at the cap
  (300 s Hobby / 800 s Pro; Edge must start within 25 s and can stream up to 300 s)
  ([duration](https://vercel.com/docs/functions/configuring-functions/duration)), so a long-lived SSE
  channel must reconnect on a timer regardless, and each connected client holds an invocation open.
- Idle HTTP/1.1 connections can be dropped by intermediaries, so an SSE stream needs heartbeat traffic
  ([`@vercel/functions` duration notes](https://vercel.com/docs/functions/configuring-functions/duration)).
- Once streaming starts you can't change status or headers
  ([Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)).

**Assessment.** Neither Next.js nor Vercel publishes a "prefer polling over SSE" recommendation — it's
an architect's call. For PRUAssist, polling is the pragmatic fit, for a reason specific to this code:
the comprehension "poll" is not a read — it's the **two-speed uplink** that carries the transcript
window up and schedules the deep pass (`src/app/api/agent/state/route.ts` POST). SSE is server→client
only, so it can't replace that POST; it could only push alerts *down* faster, while you'd still POST
the transcript up. That split (SSE downlink + POST uplink) adds a long-lived connection and its own
300 s-cap/heartbeat complexity for a few seconds of alert latency. If you ever want it, Vercel also
exposes `experimental_upgradeWebSocket()` for a true bidirectional channel, with the documented caveat
that it's Vercel-only and gives less lifecycle control
([`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)).
The one clean SSE candidate is the pure-read consent poll — low value, so likely not worth it.

**Effort / risk:** SSE downlink M / medium. **Demo vs production:** keep polling for both; revisit only
if alert latency becomes a product complaint.

## A5 — Router reliability (the brain and the deterministic tier)

**Problem.** Only the LLM brain (`orchestrator/brain.ts`) emits `topic_drift`/`guider`/`clarification`;
the deterministic tier (`modes.ts`) deliberately handles just ack/comparison/question and otherwise
falls back to `keep_listening`. The brain is a hand-rolled `fetch` to OpenRouter's OpenAI-compatible
endpoint with `response_format: json_object`, a manual `JSON.parse`, a 4 s timeout, and a 0.4
confidence gate — any failure returns `null` and drops a tier. This is a sensible degradation design,
but the classification's reliability rests entirely on unvalidated JSON parsing.

**Primary-source approach.**

- **Schema-validated structured output.** LangChain's `withStructuredOutput` validates a model's reply
  against a Zod/JSON schema and treats provider-native structured output as the most reliable path,
  because the provider enforces the schema
  ([structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)). Since
  the brain already speaks the OpenAI-compatible contract, wrapping it as a `ChatOpenAI` (custom
  `baseURL`) with `withStructuredOutput(z.object({ mode: z.enum([...]), confidence: z.number() }))`
  would replace the hand-rolled parse with schema validation + retries, and make the mode enum a
  compile-time source of truth shared with the `Mode` type.
- **LangGraph routing is already idiomatic.** The `scopeCheck` → `addConditionalEdges` design matches
  the documented pattern (a routing function returning the next node, with a path map)
  ([Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)). No change needed there.
- **Checkpointers are *not* a needed fix here — worth stating to avoid a wrong "best practice."**
  Checkpointer persistence exists for durable, resumable, human-in-the-loop graphs and thread-scoped
  memory ([persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)). PRUAssist
  invokes the graph statelessly per turn (`compiled.invoke({ input })`) and already keeps durable state
  in Redis; the one cross-turn flow (clarification re-ask) is handled by passing `clarifyContext` back
  in. There is also **no official Redis checkpointer for JS** (the JS savers are Memory/SQLite/Postgres),
  so adopting one would mean a new datastore for no current benefit. Skip it.
- **Richer deterministic fallback.** Because the brain can be down (no key, timeout, low confidence),
  the deterministic tier is the real floor. Today it can't produce `guider`/`clarification`/`drift`.
  A cheap, well-scoped upgrade: treat a customer statement that names a concept but isn't a question as
  a candidate `guider` (the handler already re-gates on `conceptsMentioned`), and flag very short/vague
  questions as `clarification`. This is deterministic logic, not a model, so it costs nothing and
  hardens the offline oracle the replay harness depends on.

**Effort / risk:** structured-output brain M / low; deterministic upgrades S / low. **Demo vs
production:** matters most when the OpenRouter key is absent or throttled at the venue — i.e., exactly
the demo failure mode.

## A6 — Transcription architecture

**Problem.** Both sides transcribe in the browser (Web Speech, or optional browser-side Deepgram over a
raw WebSocket to `wss://api.deepgram.com`), and the customer's text is shipped to the rep over the
LiveKit **data channel** as a custom `{type:"transcript"}` message (`useTranscript.ts`). Deepgram
tokens are minted server-side (`/api/deepgram/token`, grant TTL 300 s). `terms.ts` post-corrects brand
terms.

**What the primary sources confirm — and one thing they don't.**

- **The current browser-Deepgram token pattern is exactly the vendor-recommended one.** Deepgram
  recommends short-lived tokens for client-side/untrusted apps and warns that using a raw API key
  securely requires proxying through your own server
  ([Deepgram token auth](https://developers.deepgram.com/docs/token-based-authentication)). The
  server-minted grant in `/api/deepgram/token` is correct; note Deepgram's grant default TTL is 30 s
  (max 3600), so the 300 s choice is fine.
- **Server-side transcription is a first-class LiveKit path.** The Agents framework runs a Node/Python
  program in the room as a participant that subscribes to audio and runs STT (Deepgram, AssemblyAI,
  Amazon Transcribe, etc.), including a standalone STT mode
  ([LiveKit Agents](https://docs.livekit.io/agents/),
  [STT models](https://docs.livekit.io/agents/models/stt/),
  [Deepgram plugin](https://docs.livekit.io/agents/integrations/deepgram/)).
- **If you migrate, use LiveKit's transcription text streams, not the data channel.** LiveKit delivers
  transcription over the `lk.transcription` text-stream topic with interim/final segments, and the older
  `publish_transcription()` / `TranscriptionReceived` path is deprecated
  ([text & transcriptions](https://docs.livekit.io/agents/build/text/)). The app's custom data-channel
  message predates/sidesteps this feature.
- **Deepgram streaming hygiene.** KeepAlive should be sent every 3–5 s or the socket closes after ~10 s
  idle; UtteranceEnd needs `interim_results=true` and `utterance_end_ms ≥ 1000`; keyterm prompting
  (Nova-3) is capped at 500 tokens
  ([KeepAlive](https://developers.deepgram.com/docs/audio-keep-alive),
  [endpointing/interim](https://developers.deepgram.com/docs/understand-endpointing-interim-results),
  [keyterm](https://developers.deepgram.com/docs/keyterm)). The hook's 8 s KeepAlive interval sits just
  under the 10 s window but is looser than Deepgram advises — tighten to ~5 s.

**The tradeoff to weigh honestly.** A server-side agent gives better accuracy, consistent handling of
both speakers, and a supported delivery channel — but it **changes the privacy property the product
leans on**: today audio never transits PRUAssist's servers (browser→Google or browser→Deepgram
directly), and the consent copy is written around that. LiveKit's docs do **not** publish a server-vs-
browser transcription tradeoff comparison (confirmed absent), so this is an engineering/compliance
judgment, not a vendor recommendation. For a suitability-record product, keeping audio off your own
servers is a feature; a server-side agent trades it for quality and control.

**Effort / risk:** server-side agent L / medium-high (new worker + consent-copy review). **Demo vs
production:** the current approach is genuinely fine for the demo and defensible in production; treat
this as an option, not a defect.

## A7 — Retrieval quality

**Problem.** Hybrid vector (`gemini-embedding-001`, asymmetric task types) + lexical fallback over ~33
hand-authored clauses (`src/lib/retrieval.ts`, `knowledge.ts`), with calibrated score floors and no
reranking.

**Primary-source assessment — the current design is well-aligned with what the Gemini API offers.**

- **Asymmetric task types are exactly right.** Google documents distinct task types and endorses
  `RETRIEVAL_QUERY` for queries vs `RETRIEVAL_DOCUMENT` for documents, and `SEMANTIC_SIMILARITY` for
  utterance-to-utterance comparison — precisely how the code splits them
  ([embeddings](https://ai.google.dev/gemini-api/docs/embeddings)). No change needed.
- **There is no first-party reranker on the Gemini Developer API.** Google's own managed RAG (the File
  Search tool) retrieves by vector similarity with **no rerank step**, and configurable chunking
  ([File Search](https://ai.google.dev/gemini-api/docs/file-search)). A semantic reranker exists only in
  Vertex AI / Agent Builder (`semantic-ranker-*-004`), which requires Google Cloud auth and is **not**
  reachable from a free `ai.google.dev` key
  ([Vertex ranking API](https://docs.cloud.google.com/generative-ai-app-builder/docs/ranking)). So a
  reranker is not a cheap add here, and for 33 short clauses it would be over-engineering.
- **Minor, sourced tuning if you want it.** Embedding input is capped at 2,048 tokens/request (your
  clauses are well under), and non-default output dimensions require manual normalization because the
  model uses Matryoshka representation learning ([embeddings](https://ai.google.dev/gemini-api/docs/embeddings)).
  Staying at the default 3,072 dims (as the code does) avoids that footgun. If the corpus grows, the
  File Search chunking parameters (`max_tokens_per_chunk`, `max_overlap_tokens`) are the first-party
  knobs to mirror.

**Verdict.** Retrieval is the *least* in need of change. The hybrid vector+lexical approach — with
lexical catching the polarity cases embeddings miss (documented in `detectors.ts`) — is a reasonable
design that mirrors what Google's own tooling does short of Vertex. **Effort / risk:** n/a.
**Demo vs production:** leave as-is; re-tune floors with `scripts/scores.mts` only if the corpus grows.

## A8 — Auth hardening (security posture)

**Problem.** `/api/login` compares credentials with `username !== U || password !== P` (plaintext,
non-constant-time), has **no rate limiting**, and issues a stateless `jose` HS256 JWT.
`verifySessionToken` checks `algorithms:['HS256']` + required `exp`/`sub` but **no `audience`, no
`issuer`, and no role**; `currentRep` returns the payload and callers only test truthiness, never
`role === "rep"`. Logout can't revoke a token before its 8 h expiry.

**Primary-source-backed minimal hardening path.**

1. **Rate-limit the login route.** OWASP calls for login throttling and account lockout against brute
   force/credential stuffing, plus generic error messages to prevent enumeration
   ([OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
   The app already has a Redis seam — a fixed-window counter keyed on IP+username (ideally the Lua
   pattern from A1) is a few lines.
2. **Constant-time comparison now; hashing when you add a user store.** OWASP requires never storing
   plaintext passwords and comparing hashes with a constant-time function to avoid timing leaks
   ([Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
   [Authentication — safe compare](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
   For the single shared credential, swap `!==` for `crypto.timingSafeEqual`; for real accounts, store
   Argon2id hashes.
3. **Validate `issuer` + `audience` and check the role.** `jose`'s `jwtVerify` makes the `iss`/`aud`
   claims required and validated when you pass `issuer`/`audience`
   ([jose `JWTVerifyOptions`](https://github.com/panva/jose/blob/main/docs/jwt/verify/interfaces/JWTVerifyOptions.md)),
   and OWASP requires validating `alg`/`iss`/`aud`/`exp` and rejecting `alg:none`
   ([OWASP JWT](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html)). Add
   `issuer`/`audience` to both `createSessionToken` and `verifySessionToken`, and make `currentRep`
   enforce `payload.role === "rep"` so the claim the token already carries is actually checked.
4. **Revocation reality.** The README's phrasing that "signing out cannot revoke an already-issued
   token" is correct, but note the **Next.js auth guide does not literally make that claim** — it
   frames database sessions as more secure and as what enables "log out of all devices," and recommends
   keeping authz checks close to the data (a Data Access Layer)
   ([Next.js Authentication](https://nextjs.org/docs/app/guides/authentication)). The non-revocability
   argument belongs to OWASP: mitigate with short token lifetimes plus a status/deny list, or move to
   server-side sessions for true revocation
   ([OWASP JWT](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html),
   [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).

**Effort / risk:** items 1–3 are S / low and independent; item 4 (server-side sessions) is M.
**Demo vs production:** the URL is public, so rate-limiting + constant-time compare + role check are
worth doing even for the demo; hashing and revocation are production items.

---

# Software design

Module boundaries, interfaces, testability. Grounded in the files as they are; PRUAssist's design is
generally strong here, so this section is mostly "keep doing this" plus a few concrete seams.

## S1 — Unify Gemini access; `/api/summary` is the outlier

**Problem.** Every Gemini caller goes through the key pool + retry/rotation (`genai.ts`,
`agent/gemini.ts`) and the swappable `MODEL` constant — **except** `/api/summary`, which does
`new GoogleGenAI({ apiKey })` directly on a hardcoded `gemini-2.5-flash` with `thinkingBudget: 0`
(`src/app/api/summary/route.ts`). That single route: (a) bypasses key rotation, so it can't survive a
429 the way the rest of the app can; (b) ignores `PRUASSIST_MODEL`; and (c) hardcodes exactly the model
`genai.ts` warns a newly created project's key cannot serve — the 404-on-every-call failure the
`gemini-3.6-flash` default exists to prevent.

**Approach.** Route the brief through `callWithRetry` + `MODEL` + `thinking("off")` like every other
call. This is pure consolidation behind an interface that already exists — no primary source needed
beyond the Route Handler conventions the rest of the app follows
([Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)).
**Effort / risk:** S / low. **Demo vs production:** demo — it's a mid-session 404/429 waiting to happen.

## S2 — Make the router classifier a testable, schema-typed unit

**Problem.** `brain.ts` couples three concerns in one function: transport (the `fetch`), parsing
(`JSON.parse` + shape checks), and policy (confidence gate, mode allowlist). That's hard to unit-test
without a live endpoint, and the mode enum is duplicated between the prompt string, the `MODES` array,
and the `Mode` type.

**Approach.** Adopting `withStructuredOutput` (see A5) collapses transport+parsing into a validated call
and lets the mode enum be one Zod schema derived from the `Mode` type
([structured output](https://docs.langchain.com/oss/javascript/langchain/structured-output)). Keep the
policy (confidence gate, degrade-to-`null`) as a thin pure function over the validated result, so it can
be tested without a network. This mirrors the seam the ledger already gets right (below).
**Effort / risk:** M / low. **Demo vs production:** both — testability plus the reliability win from A5.

## S3 — What's already well-designed (preserve these seams)

These are load-bearing design decisions worth naming so they aren't eroded:

- **`scorePass` is a pure function reused by the replay harness** (`agent/score.ts`), with `deepPass`
  holding all the I/O around it (`agent/deep.ts`). This is textbook "one statement of the pipeline" —
  the fixtures exercise production code, not a copy. Keep the purity boundary intact.
- **The detectors are pure and independent** (`agent/detectors.ts`, driven by `signals.ts`): each takes
  a prepared `TurnContext` and reads no other detector's output, so a single detector can be tested in
  isolation. This is the right shape for the comprehension logic.
- **The `Store` interface** (`store.ts`) cleanly hides Redis-vs-memory and gives the append-only acts
  queue its own atomic primitive (RPUSH/LPOP), which is the correct pattern for the multi-writer acts
  case ([Upstash REST — append/atomicity](https://upstash.com/docs/redis/features/restapi)). The A1
  fix (a `compareAndSet` on this interface) fits the existing seam rather than fighting it.
- **Import-time integrity checks** (`concepts.ts`/`decisions.ts` throw on a dangling clause id) turn a
  class of runtime bugs into startup failures — keep this discipline when authoring new products
  (`docs/kb-authoring.md`).
- **Route handlers are consistent** (`runtime="nodejs"`, `dynamic="force-dynamic"`, per-route
  `maxDuration`), matching the documented segment-config surface
  ([Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)). S1 is the one
  place to bring back into line.

## S4 — Isolate the hand-rolled Gemini tool loop

**Problem.** `tools.ts` is coupled to `@google/genai` specifics — echoing the model turn verbatim to
preserve `thoughtSignature`, the two-phase split because (per the code's rationale) structured output
can't be combined with tools, and manual function-call execution because automatic function calling is
off for `functionDeclarations`-built tools. The *reasons* are well-documented in comments, and I did not
find a primary source contradicting them (nor one I could cite to *confirm* the tools-plus-schema
incompatibility — treat that as the code's own finding, not a sourced claim).

**Approach.** This is fine to keep, but it's the most SDK-version-fragile module in the codebase. Two
low-risk moves: (a) keep it behind its current `runToolLoop` interface (it already is) so a future SDK
that fixes automatic function calling can be swapped in without touching callers; and (b) revisit
whether parallel function calling (A2) lets you drop a loop iteration — that's a sourced optimization
([function calling](https://ai.google.dev/gemini-api/docs/function-calling)) that also simplifies the
control flow. **Effort / risk:** S / low. **Demo vs production:** production (maintainability), with the
A2 round-trip win as a bonus.

---

## Explicit uncertainties (what could not be confirmed against a primary source)

- **Gemini free-tier request numbers.** Current Gemini docs don't publish per-model free-tier RPM/RPD;
  they defer to the AI Studio dashboard ([rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)).
  The README's "20/day, 10/min" is therefore **unverified** against a current primary source (may be
  stale/model-specific) — its own "confirm on the key you're demoing" caveat is the right posture.
- **Free-tier eligibility of *explicit* context caching and of specific Flash-Lite models** is not
  stated in the Gemini docs (gated to the AI Studio dashboard).
- **"Next.js says stateless JWTs can't be revoked."** Not literally on the Next.js auth page; that
  argument is OWASP's, cited accordingly in A8.
- **OWASP constant-time comparison** lives in the Authentication Cheat Sheet, not the Password Storage
  Cheat Sheet (both linked in A8).
- **LiveKit does not publish a server-vs-browser transcription tradeoff comparison** — A6's privacy
  point is engineering judgment, not a vendor recommendation.
- **MDN's two SSE pages don't document the `Last-Event-ID` reconnect *request header*** (only the `id:`
  field and auto-reconnect); server-side resume-by-id is real per the WHATWG HTML spec, outside the
  primary-source set used here.
- **Upstash's underlying Redis engine version** (whether it supports the 8.4 `SET ... IFEQ`) was not
  confirmed — which is why A1 recommends the version-independent Lua CAS.
