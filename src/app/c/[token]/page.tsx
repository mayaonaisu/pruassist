"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  LiveKitRoom,
  PreJoin,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useTracks,
  useRoomContext,
  type LocalUserChoices,
} from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import "@livekit/components-styles";
import { useBrowserSpeech, type SpeechResult } from "@/lib/useBrowserSpeech";
import { deepgramEnabled, useDeepgramSpeech } from "@/lib/useDeepgramSpeech";
import { IconCheck, IconX } from "@/components/icons";

type Info = { active: boolean; repName: string; productArea: string };

export default function CustomerPage() {
  const params = useParams();
  const token = String(params.token ?? "");
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  const [info, setInfo] = useState<Info | null | "invalid">(null);
  const [consented, setConsented] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [choices, setChoices] = useState<LocalUserChoices>();
  const [lkToken, setLkToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/session?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          setInfo("invalid");
          return;
        }
        setInfo(await res.json());
      } catch {
        setInfo("invalid");
      }
    })();
  }, [token]);

  const giveConsent = useCallback(() => {
    setConsented(true);
    fetch("/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }, [token]);

  const join = useCallback(
    async (values: LocalUserChoices) => {
      setError(undefined);
      try {
        fetch("/api/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, name: values.username }),
        }).catch(() => {});
        const res = await fetch(`/api/token?token=${encodeURIComponent(token)}&username=${encodeURIComponent(values.username)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to join.");
        setChoices(values);
        setLkToken(data.token);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to join.");
      }
    },
    [token],
  );

  // Connected → video stage with working controls (no transcript/AI shown to the customer).
  if (lkToken && choices && serverUrl) {
    return (
      <div data-lk-theme="default" style={{ height: "100dvh" }}>
        <LiveKitRoom
          token={lkToken}
          serverUrl={serverUrl}
          connect
          video={choices.videoEnabled}
          audio={choices.audioEnabled}
          onDisconnected={() => {
            setLkToken(undefined);
            setChoices(undefined);
            setEnded(true);
          }}
          style={{ height: "100%" }}
        >
          <RoomAudioRenderer />
          <CustomerStage name={choices.username} joinToken={token} />
        </LiveKitRoom>
      </div>
    );
  }

  return (
    <Shell>
      {info === null && !ended && <p className="pru-muted">Loading your session…</p>}
      {ended && (
        <Card>
          <h1 className="doc-title">Session ended</h1>
          <p className="pru-muted">Your representative has ended the advisory session. Thank you — you can close this tab.</p>
        </Card>
      )}
      {info === "invalid" && (
        <Card>
          <h1 className="doc-title">Link not valid</h1>
          <p className="pru-muted">This session link is invalid or the session has ended. Please ask your representative for a new link.</p>
        </Card>
      )}
      {info && info !== "invalid" && !info.active && (
        <Card>
          <h1 className="doc-title">Session ended</h1>
          <p className="pru-muted">This advisory session has ended. You can close this tab.</p>
        </Card>
      )}
      {declined && (
        <Card>
          <h1 className="doc-title">No problem</h1>
          <p className="pru-muted">The session can’t continue without consent to record. You can close this tab.</p>
        </Card>
      )}
      {info && info !== "invalid" && info.active && !declined && !consented && !ended && (
        <Card>
          <div className="pru-eyebrow" style={{ marginBottom: 10 }}>Private link · PRUAssist</div>
          <h1 className="doc-title">{info.repName} has invited you to an advisory session</h1>
          <div className="doc-sub" style={{ marginBottom: 0 }}>{info.productArea}</div>
          {/* Three plain facts, including what does NOT happen. */}
          <div className="cust-card">
            <ul>
              <li>
                <IconCheck size={15} />
                <span>Your camera and voice are shared with {info.repName} only.</span>
              </li>
              <li>
                <IconCheck size={15} />
                <span>The conversation is transcribed so they can quote the policy accurately.</span>
              </li>
              <li>
                <IconCheck size={15} />
                <span>
                  Short quotes of what you say about specific policy terms are kept for 24 hours, so
                  {" " + info.repName} has a record of what was explained and what is still unclear.
                </span>
              </li>
              <li>
                <IconX size={15} />
                <span>A private assistant helps them find the right wording — it never speaks to you, and never makes the recommendation.</span>
              </li>
            </ul>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="pru-btn pru-btn-primary" onClick={giveConsent}>I agree — continue</button>
            <button className="pru-btn" onClick={() => setDeclined(true)}>Decline</button>
          </div>
          <p className="pru-muted" style={{ fontSize: 12.5, marginTop: 14, lineHeight: 1.6 }}>
            You can leave at any time. Declining ends the session for both of you.
          </p>
        </Card>
      )}
      {info && info !== "invalid" && info.active && consented && !ended && serverUrl && (
        <Card>
          <h1 className="doc-title">Set up your camera and mic</h1>
          <p className="pru-muted" style={{ marginBottom: 16, fontSize: 14 }}>Then join — your representative is waiting.</p>
          <div data-lk-theme="default">
            <PreJoin onSubmit={join} defaults={{ username: "", videoEnabled: true, audioEnabled: true }} />
          </div>
          {error && <p style={{ color: "var(--pru)", marginTop: 14 }}>{error}</p>}
        </Card>
      )}
    </Shell>
  );
}

function CustomerStage({ name, joinToken }: { name: string; joinToken: string }) {
  const room = useRoomContext();
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });

  // Re-render on media / participant changes so the controls and grid stay live.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!room) return;
    const b = () => bump((n) => n + 1);
    room
      .on(RoomEvent.LocalTrackPublished, b)
      .on(RoomEvent.LocalTrackUnpublished, b)
      .on(RoomEvent.TrackMuted, b)
      .on(RoomEvent.TrackUnmuted, b)
      .on(RoomEvent.ParticipantConnected, b)
      .on(RoomEvent.ParticipantDisconnected, b);
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, b)
        .off(RoomEvent.LocalTrackUnpublished, b)
        .off(RoomEvent.TrackMuted, b)
        .off(RoomEvent.TrackUnmuted, b)
        .off(RoomEvent.ParticipantConnected, b)
        .off(RoomEvent.ParticipantDisconnected, b);
    };
  }, [room]);

  const micOn = room?.localParticipant?.isMicrophoneEnabled ?? false;
  const camOn = room?.localParticipant?.isCameraEnabled ?? false;

  // Transcribe the customer's own speech only while their mic is on, streamed to the rep. Deepgram
  // (with brand-term boosting) when enabled and working; otherwise the browser recognizer. Both
  // hooks are always called; each no-ops unless its enabled flag is true.
  const publish = useCallback(
    ({ final, interim }: SpeechResult) => {
      if (!room) return;
      const payload = { type: "transcript", role: "Customer", name: name || "Customer", final: final || null, interim: interim || null };
      try {
        room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true });
      } catch {
        /* ignore */
      }
    },
    [room, name],
  );
  const wantDeepgram = deepgramEnabled();
  const dgStatus = useDeepgramSpeech(micOn && wantDeepgram, publish, joinToken);
  const deepgramDown = dgStatus === "unconfigured" || dgStatus === "error";
  useBrowserSpeech(micOn && (!wantDeepgram || deepgramDown), publish);

  const toggleMic = () => {
    const lp = room?.localParticipant;
    lp?.setMicrophoneEnabled(!lp.isMicrophoneEnabled).catch(() => {});
  };
  const toggleCam = () => {
    const lp = room?.localParticipant;
    lp?.setCameraEnabled(!lp.isCameraEnabled).catch(() => {});
  };
  const leave = () => {
    room?.disconnect().catch(() => {});
  };

  // The bar sits on paper, so an "on" control is dark-on-light. White-on-white hid a live mic.
  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: "12px 20px",
    minHeight: 44, // touch target — this bar is used on a phone
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    lineHeight: 1,
  };
  const on: React.CSSProperties = {
    ...pill,
    background: "transparent",
    border: "1px solid var(--rule-strong)",
    color: "var(--ink-2)",
  };
  // "Off" means not heard or seen, so it is the one loud thing on the bar.
  const off: React.CSSProperties = {
    ...pill,
    background: "var(--pru)",
    border: "1px solid var(--pru)",
    color: "#fff",
  };

  return (
    <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", background: "#0a0a10" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <GridLayout tracks={tracks} style={{ height: "100%" }}>
          <ParticipantTile />
        </GridLayout>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          padding: "14px 16px",
          paddingBottom: "max(14px, env(safe-area-inset-bottom))",
          background: "var(--brochure)",
          borderTop: "1px solid var(--rule)",
        }}
      >
        <button
          type="button"
          onClick={toggleMic}
          aria-pressed={!micOn}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          style={micOn ? on : off}
        >
          {micOn ? "Mute" : "Unmute"}
        </button>
        <button
          type="button"
          onClick={toggleCam}
          aria-pressed={!camOn}
          title={camOn ? "Turn camera off" : "Turn camera on"}
          style={camOn ? on : off}
        >
          {camOn ? "Stop video" : "Start video"}
        </button>
        <button
          type="button"
          onClick={leave}
          title="Leave the call"
          style={{ ...on, borderColor: "var(--pru-line)", color: "var(--pru)" }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--brochure)" }}>
      <header className="pru-header">
        <span className="pru-logo">
          <img className="pru-mark" src="/prudential-logo.png" alt="Prudential" />
          <i>Assist</i>
        </span>
        <span className="pru-tag">
          <span className="dot" />
          Advisory session
        </span>
      </header>
      <main className="cust-wrap">{children}</main>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
