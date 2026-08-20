"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import "@livekit/components-styles";
import { CAM_LABEL, Faces, isBroken } from "@/components/Faces";
import { useComprehension } from "@/lib/useComprehension";
import { useConsent } from "@/lib/useConsent";
import { useLocalMedia } from "@/lib/useLocalMedia";
import { usePointers } from "@/lib/usePointers";
import { useTranscript } from "@/lib/useTranscript";
import { transcriptText } from "@/lib/transcript";
import type { Comprehension, SessionInfo, Stats } from "@/lib/console-types";
import type { Alert } from "@/lib/agent/types";

export default function LiveStep({
  repName,
  session,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number, comprehension: Comprehension) => void;
}) {
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/token?room=${encodeURIComponent(session.roomId)}&username=${encodeURIComponent(repName)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to connect.");
        if (!cancelled) setToken(data.token);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.roomId, repName]);

  if (!serverUrl) return <div className="notice bad">NEXT_PUBLIC_LIVEKIT_URL is not set in .env.local.</div>;
  if (error) return <div className="notice bad">{error}</div>;
  if (!token) return <div className="notice">Connecting to the secure room…</div>;

  return (
    <LiveKitRoom token={token} serverUrl={serverUrl} connect audio video>
      <RoomAudioRenderer />
      <LiveConsole repName={repName} session={session} onEnd={onEnd} />
    </LiveKitRoom>
  );
}

const BUCKETS = 16;

// Isolated so the ticking clock re-renders a <span>, not the whole console every second.
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <>{`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`}</>;
}

/**
 * The rep's live console. Four concerns, four hooks — the transcript, the consent poll, the AI
 * pointers and the comprehension ledger — leaving this to compose them and lay them out.
 */
function LiveConsole({
  repName,
  session,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number, comprehension: Comprehension) => void;
}) {
  const room = useRoomContext();
  const media = useLocalMedia(room);

  const { lines, interim, speech, latest } = useTranscript(room, repName, media.mic === "on");
  const consent = useConsent(session.roomId);

  const [auto, setAuto] = useState(true);
  const pointers = usePointers({ roomId: session.roomId, repName, lines, latest, auto });
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest });
  const { agent } = comprehension;

  const [copied, setCopied] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const startRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startRef.current = Date.now();
    setStartedAt(startRef.current);
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [lines, interim]);

  const end = useCallback(async () => {
    if (comprehension.ending) return;
    const record = await comprehension.close();
    const dur = Math.max(1, Math.round((Date.now() - startRef.current) / 60000));
    onEnd(transcriptText(latest()), pointers.stats(), dur, { record, customerName: consent?.name ?? "" });
  }, [comprehension, consent?.name, latest, onEnd, pointers]);

  const joinUrl = typeof window !== "undefined" ? window.location.origin + session.joinPath : session.joinPath;
  const copy = () => {
    navigator.clipboard?.writeText(joinUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Ledger transitions, plotted where in the session they happened. This used to plot regex hits
  // on the transcript, which looked like comprehension data without being any.
  const { bars, openCount } = useMemo(() => {
    const out = new Array(BUCKETS).fill(0) as number[];
    const timed = agent.record.filter((r) => r.at && r.state !== "unseen");
    // Spanned by the evidence itself rather than by the clock, so the memo stays pure and the
    // bars do not creep leftward every second the rep sits idle.
    const last = timed.reduce((m, r) => Math.max(m, r.at ?? 0), startedAt);
    const span = Math.max(1, last - startedAt);
    let open = 0;
    for (const row of timed) {
      if (row.risk) open += 1;
      const weight = row.state === "misunderstood" ? 2 : row.state === "asserted" ? 1 : 0;
      if (!weight) continue;
      const slot = Math.floor(((row.at! - startedAt) / span) * (BUCKETS - 1));
      out[Math.min(BUCKETS - 1, Math.max(0, slot))] += weight;
    }
    return { bars: out, openCount: open };
  }, [agent.record, startedAt]);

  // While the rep is muted, drop their half-captured phrase so no stale "live" text lingers.
  const visibleInterim = media.mic === "on" ? interim : { ...interim, [repName]: "" };

  // The tile badge is easy to miss mid-call, so a camera failure also gets a notice.
  const camAlert = isBroken(media.cam) ? `${CAM_LABEL[media.cam].hint} The call and your audio are unaffected.` : null;

  const micAlert =
    media.mic === "missing"
      ? "No microphone detected. Your speech won’t be transcribed. Enable a mic in your OS sound settings, then click the mic button to retry."
      : media.mic === "blocked"
        ? "Your browser is blocking microphone access, so your speech won’t be transcribed. Allow the microphone for this site (padlock in the address bar), then reload."
        : speech === "unsupported"
          ? "Live transcription needs Chrome or Edge. The call works normally here, but your speech won’t appear in the transcript."
          : speech === "denied"
            ? "Speech recognition was blocked by the browser, so your side of the conversation won’t be transcribed. Allow microphone access and reload."
            : null;

  // Everything that is not the line itself, collapsed to one row each.
  const result = pointers.result;
  const support = result
    ? ([
        { key: "firstStep", label: "Do first", text: result.firstStep },
        { key: "explainer", label: "Explainer", text: result.explainer },
        { key: "comparison", label: "Compare", text: result.comparison },
        { key: "followUp", label: "Ask next", text: result.followUp },
      ] as const).filter((r) => r.text)
    : [];

  return (
    <div className="pru-live">
      <div className="c-rail">
        <span className="rec">
          <span className="pru-rec-dot" />
          REC
        </span>
        <span className="c-t">{startedAt ? <Elapsed startedAt={startedAt} /> : "00:00"}</span>
        <span className="c-ctx">
          {session.productArea} · <b>{consent ? consent.name : "awaiting customer"}</b>
        </span>
        <span className="c-r">
          <button className="pru-btn pru-btn-sm" onClick={copy}>
            {copied ? "✓ Link copied" : "Copy customer link"}
          </button>
          <button
            className={`pru-chip ${auto ? "on" : ""}`}
            style={{ padding: "6px 11px", fontSize: 12 }}
            aria-pressed={auto}
            onClick={() => setAuto((a) => !a)}
          >
            {auto ? "Auto-suggest on" : "Auto-suggest off"}
          </button>
          <button className="btn-end" onClick={end} disabled={comprehension.ending}>
            {comprehension.ending ? "Closing the record…" : "End session"}
          </button>
        </span>
      </div>

      {(micAlert || camAlert) && (
        <div role="status" className="notice" style={{ flex: "none" }}>
          {[micAlert, camAlert].filter(Boolean).join(" ")}
        </div>
      )}

      <div className="c-top">
        <Faces media={media} />
        <div className="c-meta">
          <div className="strip-h">Where they lost the thread</div>
          {/* Real ledger transitions: taller and darker where a concept was only agreed to, or
              where the customer said something the clauses contradict. */}
          <div className="bars">
            {bars.map((n, i) => (
              <span
                key={i}
                className={n >= 2 ? "hi" : n === 1 ? "mid" : ""}
                style={{ height: `${Math.min(92, 16 + n * 34)}%` }}
              />
            ))}
          </div>
          <div className="strip-legend">
            <span>00:00</span>
            <span>
              <b>{openCount} open</b>
            </span>
            <span>now</span>
          </div>
        </div>
      </div>

      {/* COMPREHENSION — evidence about the customer, never a verdict, and never blocking.
          It sits above the line because it changes what the rep should say next. */}
      {agent.alert && (
        <div className={`comp comp-${agent.alert.kind} pru-enter`} role="status">
          <div className="comp-h">
            <span className="cat">{ALERT_CAT[agent.alert.kind]}</span>
            <span className="conf">{agent.alert.label}</span>
          </div>
          <div className="comp-head">{agent.alert.headline}</div>
          <div className="comp-detail">
            {agent.alert.quote && <span className="comp-quote">“{agent.alert.quote}”</span>}
            {agent.alert.detail}
          </div>
          <div className="say-wrap">
            <div className="say">
              <span className="q">“</span>
              {agent.alert.teachBack}
              <span className="q">”</span>
            </div>
            <div className="cite">
              <b>Grounded in</b>
              {agent.alert.citations.map((s, i) => (
                <span key={i}>{s}</span>
              ))}
            </div>
          </div>
          <div className="say-actions">
            <button className="said" onClick={() => comprehension.act("teach-back-asked")}>
              Asked it
            </button>
            <button className="ghost" onClick={comprehension.copyTeachBack}>
              {comprehension.askedCopied ? "✓ Copied" : "Copy question"}
            </button>
            <button className="ghost" onClick={() => comprehension.act("dismiss")}>
              Not now
            </button>
          </div>
        </div>
      )}

      {agent.unavailable && (
        <div className="notice bad" style={{ flex: "none" }}>
          Comprehension tracking is unavailable — the shared session store isn’t reachable, so
          nothing is being recorded. Pointers and the call are unaffected.
        </div>
      )}

      {/* THE LINE — the one thing the rep reads mid-conversation. */}
      <div className="line-block">
        {pointers.loading && !result ? (
          <>
            <div className="pru-skeleton" style={{ height: 12, width: "30%", marginBottom: 12 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "92%", marginBottom: 8 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "64%" }} />
          </>
        ) : !result ? (
          <>
            <div className="lb-head">
              <span className="cat">Listening</span>
              {agent.prepared && <span className="ready">Answer ready</span>}
            </div>
            <div className="concern">
              {pointers.note ??
                "When the customer asks something, the line to say appears here — grounded in the policy documents, with the page it came from."}
            </div>
            {/* Speculative work, made visible. The background pass has already written and
                grounding-checked the answer to the question this customer is most likely to ask
                next, so if it lands there is no model call to wait for. */}
            {agent.prepared && !pointers.note && (
              <div className="ahead">
                <span className="k">Prepared for</span>
                <span className="v">
                  “{agent.prepared.question}”
                  <span className="on"> · {agent.prepared.label}</span>
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="pru-enter">
            <div className="lb-head">
              <span className="cat">Detected confusion</span>
              {/* A prepared answer is announced, not slipped in: the rep is reading something
                  written before the question was asked, and should know it. */}
              {result.cached && <span className="ready">Prepared · verified</span>}
              <span className="conf">
                {result.sources.length} cited
                {pointers.latencyMs !== null && ` · ${pointers.latencyMs} ms`}
              </span>
            </div>
            {result.concern && <div className="concern">{result.concern}</div>}
            <div className="say-wrap">
              <div className="say">
                <span className="q">“</span>
                {result.suggestedLine}
                <span className="q">”</span>
              </div>
              <div className="cite">
                <b>Grounded in</b>
                {result.sources.length ? (
                  result.sources.map((s, i) => <span key={i}>{s.source}</span>)
                ) : (
                  <span>no source returned</span>
                )}
                {/* Grounding self-check. It labels rather than blocks — the rep decides what to
                    say, and a hypothetical figure in a question is legitimate. */}
                {result.unsupportedFigures.length > 0 && (
                  <span className="cite-warn">Not on these pages: {result.unsupportedFigures.join(", ")}</span>
                )}
              </div>
            </div>
            <div className="say-actions">
              <button
                className="said"
                onClick={() => pointers.markUsed("line")}
                disabled={pointers.used.has("line")}
              >
                {pointers.used.has("line") ? "✓ Said it" : "Said it"}
              </button>
              <button className="ghost" onClick={() => pointers.ask({ rephrase: true })} disabled={pointers.loading}>
                Say it simpler
              </button>
              <button className="ghost" onClick={pointers.dismiss}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="c-bot">
        <div className="pane sup">
          <div className="deck-h">If you need more</div>
          <div className="sup-body pru-scroll">
            {support.length === 0 ? (
              <p className="pru-muted" style={{ fontSize: 12 }}>
                Supporting material appears with the next pointer.
              </p>
            ) : (
              support.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`sup-row ${pointers.openKey === r.key ? "open" : ""}`}
                  aria-expanded={pointers.openKey === r.key}
                  onClick={() => pointers.setOpenKey((k) => (k === r.key ? null : r.key))}
                >
                  <span className="k">{r.label}</span>
                  <span className="v">{r.text}</span>
                  <span className="x">{pointers.openKey === r.key ? "−" : "+"}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="pane tr">
          <div className="deck-h">
            Transcript{media.mic === "off" ? " · paused" : consent ? "" : " · awaiting consent"}
          </div>
          <div ref={feedRef} className="tr-body">
            {lines.length === 0 && Object.values(visibleInterim).every((v) => !v) && (
              <p className="pru-muted" style={{ fontSize: 12 }}>
                Appears here as you and the customer speak.
              </p>
            )}
            {lines.slice(-12).map((l) => (
              <div key={l.id} className={`tr-line ${l.speaker === repName ? "" : "cust"}`}>
                <span className="who">{l.speaker === repName ? "YOU" : l.speaker.toUpperCase()}</span>
                {l.flag ? <span className="mark">{l.text}</span> : l.text}
              </div>
            ))}
            {Object.entries(visibleInterim).map(([sp, txt]) =>
              txt ? (
                <div key={"i-" + sp} className="tr-line now">
                  <span className="who">{sp === repName ? "YOU · LIVE" : sp.toUpperCase()}</span>
                  {txt}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The eyebrow above each alert. Named for what was observed, not for a judgement about the person.
const ALERT_CAT: Record<Alert["kind"], string> = {
  "false-assent": "Agreed, not demonstrated",
  misunderstood: "Contradicts the policy",
  divergence: "Qualifier dropped",
  "re-ask": "Asked again",
  "explain-back": "Teach-back graded",
};
