"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import "@livekit/components-styles";
import { CAM_LABEL, Faces, isBroken } from "@/components/Faces";
import { useComprehension } from "@/lib/useComprehension";
import { useConsent } from "@/lib/useConsent";
import { useLocalMedia } from "@/lib/useLocalMedia";
import { usePointers, type Clarify } from "@/lib/usePointers";
import { useTranscript } from "@/lib/useTranscript";
import { resolveHotkey } from "@/lib/hotkeys";
import { groupCitations, transcriptText, type Line } from "@/lib/transcript";
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

  const { lines, interim, speech, latest, editLine } = useTranscript(room, repName, media.mic === "on");
  const consent = useConsent(session.roomId);

  const [auto, setAuto] = useState(true);
  const pointers = usePointers({ roomId: session.roomId, repName, lines, latest, auto });
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest, lines });
  const { agent } = comprehension;

  const [copied, setCopied] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const startRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  // The key handler subscribes once; read the freshest pointers through a ref rather than
  // re-binding the listener on every interim-transcript re-render.
  const pointersRef = useRef(pointers);
  useEffect(() => {
    pointersRef.current = pointers;
  });

  useEffect(() => {
    startRef.current = Date.now();
    setStartedAt(startRef.current);
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [lines, interim]);

  // Keyboard shortcuts for the line the rep reads aloud: Enter = said, R = simpler, Esc = not now.
  // Only while a line is showing; resolveHotkey ignores modifier combos and any keypress landing in a
  // field or on a control, so typing in the clarify box and clicking buttons stay untouched.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const p = pointersRef.current;
      if (!p.result) return;
      const t = e.target as HTMLElement | null;
      const inControl = !!t && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName) || t.isContentEditable);
      const action = resolveHotkey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, inControl });
      if (!action) return;
      e.preventDefault();
      if (action === "said") {
        if (!p.used.has("line")) p.markUsed("line");
      } else if (action === "simpler") {
        if (!p.loading) p.ask({ rephrase: true });
      } else {
        p.dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        {/* Honesty about the mode: when embeddings are unavailable the detectors fall back to keyword
            overlap, which is less precise. CONTEXT.md promises the console says so. */}
        {agent.degraded && (
          <span
            className="degraded-tag"
            title="Embeddings are unavailable, so the assistant is matching on keywords only — detection is less precise this session."
          >
            Reduced accuracy · keyword matching
          </span>
        )}
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

      <div className="console">
        {/* THE CALL — everything about the live conversation: the faces, the transcript that is the
            record, and the context chat between the rep and the assistant. */}
        <div className="call-rail">
          <Faces media={media} />

          <div className="pane tr">
            <div className="deck-h">
              Transcript{media.mic === "off" ? " · paused" : consent ? "" : " · awaiting consent"}
            </div>
            <div ref={feedRef} className="tr-body">
              {lines.length === 0 && Object.values(visibleInterim).every((v) => !v) && (
                <p className="pru-muted" style={{ fontSize: 12 }}>
                  Appears here as you and the customer speak. Double-click a line to correct a mis-hearing.
                </p>
              )}
              {lines.slice(-12).map((l) => (
                <TranscriptLine key={l.id} line={l} isRep={l.speaker === repName} onEdit={editLine} />
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

          <ContextChat clarify={pointers.clarify} onSend={pointers.provideContext} />
        </div>

        {/* THE PROMPTER — what changes the advice (the alert), the line to say, and the backup. */}
        <div className="prompter">
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
              <Citations sources={agent.alert.citations} />
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

      {/* THE LINE — the one thing the rep reads mid-conversation. A polite live region so a
          screen-reader rep is announced the line to say when it arrives, not left to find it. */}
      <div className="line-block" aria-live="polite">
        {pointers.loading && !result ? (
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
                  <Citations sources={result.sources.map((s) => s.source)} />
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
        </div>
      </div>
    </div>
  );
}

// Citations for the line, collapsed to one row per document (pages merged) so the sidebar stops
// repeating the full brochure name on every page reference.
function Citations({ sources }: { sources: string[] }) {
  return (
    <>
      {groupCitations(sources).map((g, i) => (
        <span key={i}>
          {g.doc}
          {g.pages ? <span className="cite-pp"> · {g.pages}</span> : null}
        </span>
      ))}
    </>
  );
}

// One transcript line the rep can correct in place. The browser mishears brand terms and names;
// double-click to edit, Enter saves, Esc cancels — the fix flows to the record and downstream readers.
function TranscriptLine({ line, isRep, onEdit }: { line: Line; isRep: boolean; onEdit: (id: string, text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== line.text) onEdit(line.id, draft);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(line.text);
  };

  if (editing) {
    return (
      <div className={`tr-line ${isRep ? "" : "cust"} editing`}>
        <span className="who">{isRep ? "YOU" : line.speaker.toUpperCase()}</span>
        <textarea
          ref={inputRef}
          className="tr-edit"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          aria-label="Correct this transcript line"
        />
      </div>
    );
  }

  return (
    <div
      className={`tr-line ${isRep ? "" : "cust"}`}
      onDoubleClick={() => {
        setDraft(line.text);
        setEditing(true);
      }}
      title="Double-click to correct a mis-hearing"
    >
      <span className="who">{isRep ? "YOU" : line.speaker.toUpperCase()}</span>
      {line.flag ? <span className="mark">{line.text}</span> : line.text}
    </div>
  );
}

// The eyebrow over a routed result, by orchestrator mode.
const RESULT_CAT: Record<string, string> = {
  policy_guidance: "Detected confusion",
  comparison: "Comparison",
  guider: "Suggested move",
};

function IconChat() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  );
}

// The context chat: the assistant asks the rep for context it can't hear, and the rep can volunteer
// it any time. A floating panel so it never crowds the line the rep is reading — it pulls attention
// with a dot and auto-opens when the assistant raises a question. Private to the rep, like everything
// on this console.
function ContextChat({ clarify, onSend }: { clarify: Clarify | null; onSend: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: "ai" | "rep"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const lastAsk = useRef<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // A new clarification joins the thread and opens the panel. The attention dot is derived from the
  // pending question (clarify && !open), so nothing needs to be tracked here.
  useEffect(() => {
    const q = clarify?.question ?? null;
    if (q && q !== lastAsk.current) {
      lastAsk.current = q;
      setMessages((m) => [...m, { role: "ai", text: clarify!.prompt }]);
      setOpen(true);
    }
    if (!q) lastAsk.current = null;
  }, [clarify]);

  useEffect(() => {
    if (open) feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [open, messages]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: "rep", text }]);
    setDraft("");
    onSend(text);
  };

  return (
    <div className="ctx-dock">
      {open && (
        <div className="ctx-panel pru-enter" role="dialog" aria-label="Assistant context chat">
          <div className="ctx-head">
            <span className="ctx-title">Context · private to you</span>
            <button className="ctx-x" onClick={() => setOpen(false)} aria-label="Close context chat">
              ×
            </button>
          </div>
          <div ref={feedRef} className="ctx-feed">
            {messages.length === 0 ? (
              <p className="ctx-empty">
                Tell the assistant what it can’t hear — which options you’re comparing, the customer’s
                situation, what you’re about to explain. It sharpens the next suggestion, and it asks
                here when it needs to.
              </p>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`ctx-msg ctx-${m.role}`}>
                  {m.text}
                </div>
              ))
            )}
          </div>
          <form className="ctx-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input
              className="ctx-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add context, e.g. comparing Premier with Plus"
              aria-label="Message the assistant"
            />
            <button className="ctx-send" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
      <button
        className={`ctx-bar ${clarify ? "asking" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Hide context chat" : "Open context chat"}
        title="Context chat — tell the assistant what it can’t hear"
      >
        <IconChat />
        <span className="ctx-bar-t">Context{clarify ? " · needed" : ""}</span>
        {clarify && !open && <span className="ctx-dot" aria-hidden="true" />}
        <span className="ctx-caret" aria-hidden="true">{open ? "▾" : "▴"}</span>
      </button>
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
