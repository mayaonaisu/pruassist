"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Elapsed, TranscriptPane, Prompter, ContextChat } from "@/components/ConsolePanes";
import InPersonConsentCard from "./InPersonConsentCard";
import { reduceBoard, initialBoardState } from "@/lib/board";
import { useComprehension } from "@/lib/useComprehension";
import { useConsent } from "@/lib/useConsent";
import { usePointers } from "@/lib/usePointers";
import { useTranscript } from "@/lib/useTranscript";
import { useInPersonSpeech } from "@/lib/useInPersonSpeech";
import { useVoiceProfile } from "@/lib/useVoiceProfile";
import { useWakeLock } from "@/lib/useWakeLock";
import { unlockAudio } from "@/lib/useDiarizedSpeech";
import { resolveHotkey } from "@/lib/hotkeys";
import { transcriptText } from "@/lib/transcript";
import type { Comprehension, SessionInfo, Stats } from "@/lib/console-types";

const ZERO_STATS: Stats = { surfaced: 0, used: 0, flags: 0, docs: 0 };

// The customer-facing whiteboard is loaded lazily and client-only, so pdfjs never enters the rep view's
// chunk or runs on the server.
const Whiteboard = dynamic(() => import("@/components/board/Whiteboard"), { ssr: false });

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
  // The rep's on-device voiceprint (if enrolled) drives attribution so they needn't speak first.
  const { profile: voiceProfile } = useVoiceProfile();
  // The live "Voice match" threshold, tunable in-console and remembered per device.
  const [voiceThreshold, setVoiceThreshold] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem("pru:voiceThreshold") ?? "");
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    } catch {
      return 0.5;
    }
  });
  const changeThreshold = useCallback((v: number) => {
    setVoiceThreshold(v);
    try {
      localStorage.setItem("pru:voiceThreshold", String(v));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
  }, []);
  const speech = useInPersonSpeech(repName, customerName, true, { profile: voiceProfile ?? null, voiceThreshold });
  const { lines, interim, latest, editLine } = useTranscript(undefined, speech);
  const consent = useConsent(session.roomId);
  useWakeLock(true);

  const [auto, setAuto] = useState(true);
  const pointers = usePointers({ roomId: session.roomId, repName, lines, latest, auto });
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest, lines });
  const { agent } = comprehension;

  // Sharing mode: the rep turns the iPad to the customer and the prompter is replaced by the whiteboard.
  // The board reducer lives here (not inside the whiteboard) so a citation tap can pick a page before the
  // board mounts. Recording and comprehension polling keep running throughout — nothing here unmounts.
  const [sharing, setSharing] = useState(false);
  const [board, boardDispatch] = useReducer(reduceBoard, initialBoardState);

  // Live voiceprint similarity for the in-console "Voice match" tuning meter — polled only while the
  // tuner is on screen (rep view, voiceprint ready). setState happens in the interval callback, never
  // synchronously in the effect.
  const [liveScore, setLiveScore] = useState<number | null>(null);
  const voiceReady = speech.engine === "deepgram" && speech.voiceStatus === "ready";
  const liveScoreFn = speech.liveScore;
  useEffect(() => {
    if (!voiceReady || sharing) return;
    const t = setInterval(() => setLiveScore(liveScoreFn()), 250);
    return () => clearInterval(t);
  }, [voiceReady, sharing, liveScoreFn]);

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

  // Tapping a citation under a suggested line turns the board to that page. The reconstructed source
  // merges the doc's pages; recover a clause id and snippet from the pointer's own sources (matched by
  // document) so the board can resolve the exact clause, then enter sharing mode.
  const openSource = useCallback(
    (source: string) => {
      const doc = source.split(" · ")[0];
      const match = pointers.result?.sources.find((s) => s.source.split(" · ")[0] === doc);
      boardDispatch({ type: "pick", focus: { kind: "source", source, clauseId: match?.id, snippet: match?.snippet } });
      unlockAudio();
      setSharing(true);
    },
    [pointers.result],
  );

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
      {!sharing ? (
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
                title={
                  speech.voiceStatus === "ready"
                    ? `Using ${repName}'s voiceprint to tell you and ${displayName} apart`
                    : "Attribution decides who's speaking automatically"
                }
              >
                {speech.voiceStatus === "ready" ? "Auto · voice" : "Auto"}
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
          <button
            type="button"
            className="pru-chip share-btn"
            onClick={() => {
              unlockAudio(); // keep the AudioContext alive within this user gesture (Safari)
              setSharing(true);
            }}
          >
            Show customer
          </button>
          <button className="btn-end" onClick={end} disabled={comprehension.ending}>
            {comprehension.ending ? "Closing the record…" : "End session"}
          </button>
        </span>
        </div>
      ) : (
        <div className="share-rail">
          <span className="c-ctx">
            {session.productArea} · <b>{displayName}</b>
          </span>
          <span className="rec share-rec">
            <span className="pru-rec-dot" />
            Recording
          </span>
          {/* In the Web-Speech fallback the manual override is the only attribution, so it stays on the
              share rail even while the board is up — hiding it would corrupt the record. */}
          {speech.engine === "browser" && (
            <div className="turn-seg" role="group" aria-label="Who is speaking now">
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
          )}
          <button
            type="button"
            className="btn-end share-back"
            onClick={() => {
              boardDispatch({ type: "reset" });
              setSharing(false);
            }}
          >
            Back to my view
          </button>
        </div>
      )}

      {/* Solo-tuning control: watch your own live similarity and set where "you" begins. Rep view only,
          and only when the voiceprint is scoring; hidden from the customer while sharing. */}
      {!sharing && voiceReady && (
        <div className="voice-tune" role="group" aria-label="Voice match sensitivity">
          <span className="voice-tune-label">Voice match</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={voiceThreshold}
            onChange={(e) => changeThreshold(parseFloat(e.target.value))}
            className="voice-slider"
            aria-label="Voice match threshold"
          />
          <span className="voice-tune-val" title="Similarity at or above this counts as you">
            ≥ {voiceThreshold.toFixed(2)} = you
          </span>
          <span
            className={`voice-meter voice-tune-meter ${
              liveScore == null
                ? ""
                : liveScore >= voiceThreshold
                  ? "voice-meter-hi"
                  : liveScore <= voiceThreshold - 0.2
                    ? "voice-meter-lo"
                    : "voice-meter-mid"
            }`}
            aria-hidden
          >
            <div className="voice-meter-fill" style={{ width: `${liveScore == null ? 0 : Math.round(((liveScore + 1) / 2) * 100)}%` }} />
          </span>
          <span className="voice-tune-live">{liveScore == null ? "listening…" : `live ${liveScore.toFixed(2)}`}</span>
        </div>
      )}

      {/* While sharing, the customer sees this rail — keep only the mic-paused honesty note, not the
          rep-facing attribution/permission hints. */}
      {banner && (!sharing || speech.micPaused) && (
        <div role="status" className="notice" style={{ flex: "none" }}>
          {banner}
        </div>
      )}

      <div className="console">
        {/* Kept mounted while sharing (ContextChat holds its thread in local state); just hidden. */}
        <div className="call-rail" hidden={sharing}>
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

        {sharing ? (
          <Whiteboard agent={agent} productArea={session.productArea} state={board} dispatch={boardDispatch} />
        ) : (
          <Prompter pointers={pointers} comprehension={comprehension} onOpenSource={openSource} />
        )}
      </div>
    </div>
  );
}
