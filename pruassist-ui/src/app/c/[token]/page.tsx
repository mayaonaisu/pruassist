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
import { useBrowserSpeech } from "@/lib/useBrowserSpeech";

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
          <CustomerStage name={choices.username} />
        </LiveKitRoom>
      </div>
    );
  }

  return (
    <Shell>
      {info === null && !ended && <p className="pru-muted">Loading your session…</p>}
      {ended && (
        <Card>
          <h1 style={{ fontSize: 22, marginBottom: 6 }}>Session ended</h1>
          <p className="pru-muted">Your representative has ended the advisory session. Thank you — you can close this tab.</p>
        </Card>
      )}
      {info === "invalid" && (
        <Card>
          <h1 style={{ fontSize: 22, marginBottom: 6 }}>Link not valid</h1>
          <p className="pru-muted">This session link is invalid or the session has ended. Please ask your representative for a new link.</p>
        </Card>
      )}
      {info && info !== "invalid" && !info.active && (
        <Card>
          <h1 style={{ fontSize: 22, marginBottom: 6 }}>Session ended</h1>
          <p className="pru-muted">This advisory session has ended. You can close this tab.</p>
        </Card>
      )}
      {declined && (
        <Card>
          <h1 style={{ fontSize: 22, marginBottom: 6 }}>No problem</h1>
          <p className="pru-muted">The session can’t continue without consent to record. You can close this tab.</p>
        </Card>
      )}
      {info && info !== "invalid" && info.active && !declined && !consented && !ended && (
        <Card>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Join your advisory session</h1>
          <p className="pru-muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
            You’re joining a session with <b>{info.repName}</b> about <b>{info.productArea}</b>. This conversation will
            be <b>recorded and transcribed</b> to help your representative explain your options accurately. A private AI
            assistant supports your representative only — it never speaks to you, and your representative makes every
            recommendation.
          </p>
          <p className="pru-muted" style={{ fontSize: 13, marginTop: 10 }}>By continuing you consent to the recording and transcription of this session.</p>
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button className="pru-btn pru-btn-primary" onClick={giveConsent}>I consent — continue</button>
            <button className="pru-btn" onClick={() => setDeclined(true)}>Decline</button>
          </div>
        </Card>
      )}
      {info && info !== "invalid" && info.active && consented && !ended && serverUrl && (
        <Card wide>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>Set up your camera & mic</h1>
          <p className="pru-muted" style={{ marginBottom: 16, fontSize: 14 }}>Then join — your representative is waiting.</p>
          <div data-lk-theme="default">
            <PreJoin onSubmit={join} defaults={{ username: "", videoEnabled: true, audioEnabled: true }} />
          </div>
          {error && <p style={{ color: "var(--pru-red)", marginTop: 14 }}>{error}</p>}
        </Card>
      )}
    </Shell>
  );
}

function CustomerStage({ name }: { name: string }) {
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

  // Transcribe the customer's own speech only while their mic is on, streamed to the rep.
  useBrowserSpeech(micOn, ({ final, interim }) => {
    if (!room) return;
    const payload = { type: "transcript", role: "Customer", name: name || "Customer", final: final || null, interim: interim || null };
    try {
      room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), { reliable: true });
    } catch {
      /* ignore */
    }
  });

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

  const pill: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "11px 18px",
    borderRadius: 999,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    color: "#fff",
    lineHeight: 1,
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
          gap: 12,
          padding: "16px 20px",
          background: "rgba(8,8,12,0.92)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          backdropFilter: "blur(8px)",
        }}
      >
        <button
          type="button"
          onClick={toggleMic}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          style={{ ...pill, background: micOn ? "rgba(255,255,255,0.10)" : "#d11f2d", border: micOn ? "1px solid rgba(255,255,255,0.16)" : "1px solid #d11f2d" }}
        >
          {micOn ? "🎙 Mute" : "🔇 Unmute"}
        </button>
        <button
          type="button"
          onClick={toggleCam}
          title={camOn ? "Turn camera off" : "Turn camera on"}
          style={{ ...pill, background: camOn ? "rgba(255,255,255,0.10)" : "#d11f2d", border: camOn ? "1px solid rgba(255,255,255,0.16)" : "1px solid #d11f2d" }}
        >
          {camOn ? "📹 Stop video" : "📷 Start video"}
        </button>
        <button
          type="button"
          onClick={leave}
          title="Leave the call"
          style={{ ...pill, background: "#b3111d", border: "1px solid #b3111d", marginLeft: 8 }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)" }}>
      <header className="pru-header">
        <div className="pru-logo">
          <div className="mark">P</div>
          <div>
            <div className="name">PRUAssist</div>
            <div className="sub">Advisory Session</div>
          </div>
        </div>
      </header>
      <main style={{ display: "grid", placeItems: "center", padding: "28px 16px" }}>{children}</main>
    </div>
  );
}

function Card({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="pru-card" style={{ width: wide ? "min(560px, 100%)" : "min(480px, 100%)", marginTop: 24 }}>
      {children}
    </div>
  );
}
