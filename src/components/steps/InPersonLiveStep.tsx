"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Elapsed, TranscriptPane, Prompter, ContextChat } from "@/components/ConsolePanes";
import InPersonConsentCard from "./InPersonConsentCard";
import { useComprehension } from "@/lib/useComprehension";
import { useConsent } from "@/lib/useConsent";
import { usePointers } from "@/lib/usePointers";
import { useTranscript } from "@/lib/useTranscript";
import { useInPersonSpeech } from "@/lib/useInPersonSpeech";
import { useWakeLock } from "@/lib/useWakeLock";
import { unlockAudio } from "@/lib/useDiarizedSpeech";
import { resolveHotkey } from "@/lib/hotkeys";
import { transcriptText } from "@/lib/transcript";
import type { Comprehension, SessionInfo, Stats } from "@/lib/console-types";

const ZERO_STATS: Stats = { surfaced: 0, used: 0, flags: 0, docs: 0 };

type Phase = "consent" | "handback" | "live";

/**
 * In-person mode: one shared iPad, one microphone, no LiveKit. A three-phase machine gates the live
 * console — and IS the consent guarantee: the STT hooks only mount in the `live` phase, which is only
 * reachable after the customer accepts on this device.
 */
export default function InPersonLiveStep({
  repName,
  session,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number, comprehension: Comprehension) => void;
}) {
  const [phase, setPhase] = useState<Phase>("consent");
  const [customerName, setCustomerName] = useState("");
  const [declined, setDeclined] = useState(false);

  if (declined) {
    return (
      <div className="pru-container" style={{ maxWidth: 640 }}>
        <h1 className="doc-title">No problem</h1>
        <p className="pru-muted" style={{ marginBottom: 20 }}>
          The session can’t continue without consent to record.
        </p>
        <button
          className="pru-btn pru-btn-primary"
          style={{ minHeight: 44 }}
          onClick={() => onEnd("", ZERO_STATS, 1, { record: [], customerName: "" })}
        >
          End session
        </button>
      </div>
    );
  }

  if (phase === "consent") {
    return (
      <InPersonConsentCard
        roomId={session.roomId}
        repName={repName}
        productArea={session.productArea}
        onConsented={(name) => {
          setCustomerName(name);
          setPhase("handback");
        }}
        onDeclined={() => setDeclined(true)}
      />
    );
  }

  if (phase === "handback") {
    return (
      <div className="pru-container" style={{ maxWidth: 640, textAlign: "center" }}>
        <h1 className="doc-title">Take the iPad back</h1>
        <p className="pru-muted" style={{ marginBottom: 22 }}>
          {customerName} has consented. Tap Begin when you’re ready to start the session.
        </p>
        <button
          className="pru-btn pru-btn-primary"
          style={{ minHeight: 52, fontSize: 16, padding: "0 30px" }}
          onClick={() => {
            unlockAudio(); // resume the AudioContext while this tap's user-gesture is active (Safari)
            setPhase("live");
          }}
        >
          Begin session
        </button>
      </div>
    );
  }

  return <InPersonConsole repName={repName} session={session} customerName={customerName} onEnd={onEnd} />;
}

function InPersonConsole({
  repName,
  session,
  customerName,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  customerName: string;
  onEnd: (transcript: string, stats: Stats, durationMin: number, comprehension: Comprehension) => void;
}) {
  const speech = useInPersonSpeech(repName, customerName, true);
  const { lines, interim, latest, editLine } = useTranscript(undefined, speech);
  const consent = useConsent(session.roomId);
  useWakeLock(true);

  const [auto, setAuto] = useState(true);
  const pointers = usePointers({ roomId: session.roomId, repName, lines, latest, auto });
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest, lines });
  const { agent } = comprehension;

  const [startedAt, setStartedAt] = useState(0);
  const startRef = useRef(0);
  const pointersRef = useRef(pointers);
  useEffect(() => {
    pointersRef.current = pointers;
  });

  useEffect(() => {
    startRef.current = Date.now();
    setStartedAt(startRef.current);
  }, []);

  // In the Web-Speech degradation path there is no diarizer, so the toggle must have a default owner —
  // seed it to the rep so their opening words attribute correctly until they hand the floor over.
  const { engine, override, setOverride } = speech;
  useEffect(() => {
    if (engine === "browser" && override === null) setOverride("rep");
  }, [engine, override, setOverride]);

  // Same line-reading shortcuts as the online console: Enter = said, R = simpler, Esc = not now.
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
    onEnd(transcriptText(latest()), pointers.stats(), dur, { record, customerName: consent?.name ?? customerName });
  }, [comprehension, consent?.name, customerName, latest, onEnd, pointers]);

  const displayName = consent?.name || customerName || "Customer";

  const banner = speech.micPaused
    ? "Recording paused — the microphone is in use by another app, or the screen locked. It resumes automatically."
    : speech.engine === "browser"
      ? "Per-speaker AI attribution is unavailable here — tap who’s speaking below so the record stays accurate."
      : speech.status === "denied"
        ? "Microphone access is blocked, so nothing is being transcribed. Allow the microphone for this site, then reload."
        : null;

  return (
    <div className="pru-live">
      <div className="c-rail">
        <span className="rec">
          <span className="pru-rec-dot" />
          REC
        </span>
        <span className="c-t">{startedAt ? <Elapsed startedAt={startedAt} /> : "00:00"}</span>
        <span className="c-ctx">
          {session.productArea} · <b>{displayName}</b>
        </span>
        {agent.degraded && (
          <span
            className="degraded-tag"
            title="Embeddings are unavailable, so the assistant is matching on keywords only — detection is less precise this session."
          >
            Reduced accuracy · keyword matching
          </span>
        )}
        <span className="c-r">
          {/* Attribution control — the always-wins manual override. Auto lets the diarizer decide;
              You / customer force the current speech onto one person. */}
          <div className="turn-seg" role="group" aria-label="Who is speaking now">
            {speech.engine === "deepgram" && (
              <button
                type="button"
                className={`turn-opt ${speech.override === null ? "on" : ""}`}
                aria-pressed={speech.override === null}
                onClick={() => speech.setOverride(null)}
              >
                Auto
              </button>
            )}
            <button
              type="button"
              className={`turn-opt ${speech.override === "rep" ? "on" : ""}`}
              aria-pressed={speech.override === "rep"}
              onClick={() => speech.setOverride("rep")}
            >
              You
            </button>
            <button
              type="button"
              className={`turn-opt ${speech.override === "customer" ? "on" : ""}`}
              aria-pressed={speech.override === "customer"}
              onClick={() => speech.setOverride("customer")}
            >
              {displayName}
            </button>
          </div>
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

      {banner && (
        <div role="status" className="notice" style={{ flex: "none" }}>
          {banner}
        </div>
      )}

      <div className="console">
        <div className="call-rail">
          <TranscriptPane
            lines={lines}
            interim={interim}
            repName={repName}
            onEdit={editLine}
            onSwapSpeaker={speech.swapSpeaker}
            headerSuffix={speech.micPaused ? " · paused" : ""}
            emptyHint="Appears here as you and the customer speak. Double-click to correct wording; tap ⇄ if a speaker is wrong."
          />
          <ContextChat clarify={pointers.clarify} onSend={pointers.provideContext} />
        </div>

        <Prompter pointers={pointers} comprehension={comprehension} />
      </div>
    </div>
  );
}
