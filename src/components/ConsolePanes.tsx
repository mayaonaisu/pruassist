"use client";

import { useEffect, useRef, useState } from "react";
import { groupCitations, type Line } from "@/lib/transcript";
import { usePointers, type Clarify } from "@/lib/usePointers";
import { useComprehension } from "@/lib/useComprehension";

// The parts of the live console that are pure presentation, lifted out of LiveStep so the online and
// in-person consoles render the SAME transcript, prompter and context chat — the alert/line UX is the
// product, and two copies would drift. Nothing here knows about LiveKit; the in-person console reuses
// it with `room = undefined` and an extra per-line "swap speaker" affordance.

type PointersApi = ReturnType<typeof usePointers>;
type ComprehensionApi = ReturnType<typeof useComprehension>;

// Isolated so the ticking clock re-renders a <span>, not the whole console every second.
export function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <>{`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`}</>;
}

// Citations for the line, collapsed to one row per document (pages merged) so the sidebar stops
// repeating the full brochure name on every page reference. In-person mode passes `onOpen`: each
// citation becomes a button that turns the board to that page. The reconstructed string
// (`<doc> · <pages>`) is a valid locateSource input. Without `onOpen` the markup is unchanged, so the
// online console renders byte-identically.
function Citations({ sources, onOpen }: { sources: string[]; onOpen?: (source: string) => void }) {
  return (
    <>
      {groupCitations(sources).map((g, i) => {
        const label = (
          <>
            {g.doc}
            {g.pages ? <span className="cite-pp"> · {g.pages}</span> : null}
          </>
        );
        if (!onOpen) return <span key={i}>{label}</span>;
        const source = `${g.doc}${g.pages ? " · " + g.pages : ""}`;
        return (
          <button type="button" key={i} className="cite-link" onClick={() => onOpen(source)} title="Show this page to the customer">
            {label}
          </button>
        );
      })}
    </>
  );
}

// One transcript line the rep can correct in place. The browser mishears brand terms and names;
// double-click to edit, Enter saves, Esc cancels — the fix flows to the record and downstream readers.
// In-person mode also passes onSwap: a one-tap ⇄ that reassigns the line between rep and customer when
// the diarizer got the speaker wrong.
function TranscriptLine({
  line,
  isRep,
  onEdit,
  onSwap,
}: {
  line: Line;
  isRep: boolean;
  onEdit: (id: string, text: string) => void;
  onSwap?: (id: string) => void;
}) {
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
      {onSwap && (
        <button
          type="button"
          className="tr-swap"
          title={`Wrong speaker? Tap to mark as ${isRep ? "the customer" : "you"}`}
          aria-label="Swap the speaker for this line"
          onClick={(e) => {
            e.stopPropagation();
            onSwap(line.id);
          }}
        >
          ⇄
        </button>
      )}
    </div>
  );
}

// The transcript that IS the record: the last dozen lines plus any live interim. `interim` is passed
// already filtered (a muted rep's half-phrase is blanked by the caller). `headerSuffix` carries the
// mode-specific "· paused"/"· awaiting consent" tail; `emptyHint` the mode-specific placeholder.
export function TranscriptPane({
  lines,
  interim,
  repName,
  onEdit,
  headerSuffix,
  emptyHint,
  onSwapSpeaker,
}: {
  lines: Line[];
  interim: Record<string, string>;
  repName: string;
  onEdit: (id: string, text: string) => void;
  headerSuffix: string;
  emptyHint: string;
  onSwapSpeaker?: (id: string) => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [lines, interim]);

  return (
    <div className="pane tr">
      <div className="deck-h">Transcript{headerSuffix}</div>
      <div ref={feedRef} className="tr-body">
        {lines.length === 0 && Object.values(interim).every((v) => !v) && (
          <p className="pru-muted" style={{ fontSize: 12 }}>
            {emptyHint}
          </p>
        )}
        {lines.slice(-12).map((l) => (
          <TranscriptLine key={l.id} line={l} isRep={l.speaker === repName} onEdit={onEdit} onSwap={onSwapSpeaker} />
        ))}
        {Object.entries(interim).map(([sp, txt]) =>
          txt ? (
            <div key={"i-" + sp} className="tr-line now">
              <span className="who">{sp === repName ? "YOU · LIVE" : sp.toUpperCase()}</span>
              {txt}
            </div>
          ) : null,
        )}
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

// The eyebrow above each alert. Named for what was observed, not for a judgement about the person.
const ALERT_CAT: Record<string, string> = {
  "false-assent": "Agreed, not demonstrated",
  misunderstood: "Contradicts the policy",
  divergence: "Qualifier dropped",
  "re-ask": "Asked again",
  "explain-back": "Teach-back graded",
};

/**
 * The prompter column: the comprehension alert (evidence about the customer, never a verdict), the one
 * line the rep reads mid-conversation, and the backup material. Composed from the pointers and
 * comprehension hooks so both consoles show identical advice.
 */
export function Prompter({
  pointers,
  comprehension,
  onOpenSource,
}: {
  pointers: PointersApi;
  comprehension: ComprehensionApi;
  // In-person mode only: tapping a citation turns the board to that page. LiveStep passes nothing.
  onOpenSource?: (source: string) => void;
}) {
  const { agent } = comprehension;
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
              <Citations sources={agent.alert.citations} onOpen={onOpenSource} />
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
                  <Citations sources={result.sources.map((s) => s.source)} onOpen={onOpenSource} />
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
  );
}

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
export function ContextChat({ clarify, onSend }: { clarify: Clarify | null; onSend: (text: string) => void }) {
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
