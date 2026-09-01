"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import "@livekit/components-styles";
import { CAM_LABEL, Faces, isBroken } from "@/components/Faces";
import { Elapsed, TranscriptPane, Prompter, ContextChat } from "@/components/ConsolePanes";
import { useComprehension } from "@/lib/useComprehension";
import { useConsent } from "@/lib/useConsent";
import { useLocalMedia } from "@/lib/useLocalMedia";
import { usePointers } from "@/lib/usePointers";
import { useLocalSpeech, useTranscript, type LocalSpeech } from "@/lib/useTranscript";
import { resolveHotkey } from "@/lib/hotkeys";
import { transcriptText } from "@/lib/transcript";
import type { Comprehension, SessionInfo, Stats } from "@/lib/console-types";

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

  // Local-mic STT lives here — above LiveKitRoom — so a room reconnect does not kill the
  // Deepgram WS mid-handshake. The hook uses getUserMedia directly, not the room's tracks.
  // micOn tracks whether the rep's mic is live (muting pauses STT so a muted rep's words
  // don't feed the AI). Defaults true; LiveConsole syncs it from the room's track state.
  const [micOn, setMicOn] = useState(true);
  const localSpeech = useLocalSpeech(repName, !!token && micOn);

  if (!serverUrl) return <div className="notice bad">NEXT_PUBLIC_LIVEKIT_URL is not set in .env.local.</div>;
  if (error) return <div className="notice bad">{error}</div>;
  if (!token) return <div className="notice">Connecting to the secure room…</div>;

  return (
    <LiveKitRoom token={token} serverUrl={serverUrl} connect audio video>
      <RoomAudioRenderer />
      <LiveConsole repName={repName} session={session} onEnd={onEnd} localSpeech={localSpeech} onMicChange={setMicOn} />
    </LiveKitRoom>
  );
}

/**
 * The rep's live console. Four concerns, four hooks — the transcript, the consent poll, the AI
 * pointers and the comprehension ledger — leaving this to compose them and lay them out. The
 * transcript, prompter and context-chat presentation live in ConsolePanes, shared with the
 * in-person console.
 */
function LiveConsole({
  repName,
  session,
  onEnd,
  localSpeech,
  onMicChange,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number, comprehension: Comprehension) => void;
  localSpeech: LocalSpeech;
  onMicChange: (on: boolean) => void;
}) {
  const room = useRoomContext();
  const media = useLocalMedia(room);

  useEffect(() => {
    onMicChange(media.mic === "on");
  }, [media.mic, onMicChange]);

  const { lines, interim, speech, latest, editLine } = useTranscript(room, localSpeech);
  const consent = useConsent(session.roomId);

  const [auto, setAuto] = useState(true);
  const pointers = usePointers({ roomId: session.roomId, repName, lines, latest, auto });
  const comprehension = useComprehension({ roomId: session.roomId, repName, latest, lines });
  const { agent } = comprehension;

  const [copied, setCopied] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const startRef = useRef(0);
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
          <TranscriptPane
            lines={lines}
            interim={visibleInterim}
            repName={repName}
            onEdit={editLine}
            headerSuffix={media.mic === "off" ? " · paused" : consent ? "" : " · awaiting consent"}
            emptyHint="Appears here as you and the customer speak. Double-click a line to correct a mis-hearing."
          />
          <ContextChat clarify={pointers.clarify} onSend={pointers.provideContext} />
        </div>

        {/* THE PROMPTER — what changes the advice (the alert), the line to say, and the backup. */}
        <Prompter pointers={pointers} comprehension={comprehension} />
      </div>
    </div>
  );
}
