"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import type { Alert, ConceptState } from "@/lib/agent/types";

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
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest, lines });
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
          {/* What still stands between the representative and a recommendation. This replaced a
              strip of bars derived from a handful of timestamps — real ledger state, same slot. */}
          <div className="strip-h">{agent.readiness?.question ?? "Ready to recommend"}</div>
          {!agent.readiness ? (
            <p className="ready-idle">
              Once you start comparing options, what the customer still needs to understand appears here.
            </p>
          ) : (
            <>
              <div className="ready-rows pru-scroll">
                {agent.readiness.standing.map((s) => (
                  <div key={s.conceptId} className={`ready-row ready-${s.state}`}>
                    <span className="ready-label">{s.label}</span>
                    <span className="ready-state">{READY_STATE[s.state]}</span>
                  </div>
                ))}
              </div>
              <div className="ready-foot">
                {agent.readiness.ready ? (
                  <span className="ready-go">Ready to recommend</span>
                ) : (
                  <>
                    <span className="ready-count">
                      {agent.readiness.settled} / {agent.readiness.total} settled
                    </span>
                    {agent.readiness.nextConceptId && (
                      <button
                        className="ghost"
                        title={agent.readiness.nextQuestion ?? undefined}
                        onClick={() => comprehension.act("teach-back-asked", agent.readiness!.nextConceptId!)}
                      >
                        Ask it
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
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
        {pointers.clarify ? (
          // The orchestrator needs context before it will answer — ask the rep, then re-route.
          <ClarifyPrompt prompt={pointers.clarify.prompt} onSubmit={pointers.clarifyAnswer} />
        ) : pointers.loading && !result ? (
          <>
            <div className="pru-skeleton" style={{ height: 12, width: "30%", marginBottom: 12 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "92%", marginBottom: 8 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "64%" }} />
          </>
        ) : pointers.mode === "topic_drift" && pointers.note ? (
          // Off the selected scope: warn, don't generate.
          <div className="pru-enter drift">
            <div className="lb-head">
              <span className="cat">Off topic</span>
            </div>
            <div className="concern">{pointers.note}</div>
          </div>
        ) : pointers.mode === "drift_paused" && pointers.note ? (
          // Drifted twice: paused. No model call went out for this turn; it resumes on the first
          // on-topic turn.
          <div className="pru-enter paused">
            <div className="lb-head">
              <span className="cat">Paused · off topic</span>
            </div>
            <div className="concern">{pointers.note}</div>
          </div>
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
              <span className="cat">{RESULT_CAT[pointers.mode ?? ""] ?? "Detected confusion"}</span>
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

// The eyebrow over a routed result, by orchestrator mode.
const RESULT_CAT: Record<string, string> = {
  policy_guidance: "Detected confusion",
  comparison: "Comparison",
  guider: "Suggested move",
};

// A clarification prompt: the rep types the missing context, which re-routes the turn.
function ClarifyPrompt({ prompt, onSubmit }: { prompt: string; onSubmit: (context: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="pru-enter clarify">
      <div className="lb-head">
        <span className="cat">Clarify first</span>
      </div>
      <div className="concern">{prompt}</div>
      <form
        className="clarify-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSubmit(text.trim());
        }}
      >
        <input
          className="clarify-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell PRUAssist what to assume, e.g. comparing the base plan with PRUExtra"
        />
        <button className="said" type="submit" disabled={!text.trim()}>
          Answer
        </button>
      </form>
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

// The ledger state, in words a representative reads at a glance mid-conversation.
const READY_STATE: Record<ConceptState, string> = {
  unseen: "not raised",
  raised: "explained",
  asserted: "agreed only",
  demonstrated: "shown",
  misunderstood: "wrong",
};
