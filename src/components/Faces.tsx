"use client";

import { ParticipantTile, useRemoteParticipants, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import type { DeviceStatus, useLocalMedia } from "@/lib/useLocalMedia";

// The two faces in one row. Customer first; the rep's own tile carries the device controls.
// Kept apart from the console because it is the one part of that screen with no AI in it.

export function Faces({ media }: { media: ReturnType<typeof useLocalMedia> }) {
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const local = tracks.find((t) => t.participant.isLocal);
  const remotes = tracks.filter((t) => !t.participant.isLocal);
  // Presence separate from video: a customer who is in the room with their camera off should read
  // as "connected", not "waiting" — otherwise a camera-off customer looks like no customer at all.
  const remotePeople = useRemoteParticipants();

  return (
    <div className="cams" data-lk-theme="default">
      {remotes.length === 0 ? (
        <div className="cam">
          <div className="cam-face">
            {remotePeople.length > 0 ? "customer connected — camera off" : "waiting for the customer…"}
          </div>
          <span className="cam-tag">CUSTOMER</span>
        </div>
      ) : (
        remotes.map((t) => (
          <div className="cam" key={t.participant.sid}>
            <ParticipantTile trackRef={t} />
            <span className="cam-tag">CUSTOMER</span>
            <span className="cam-nm">
              <span className="sp" />
              {t.participant.name || t.participant.identity}
            </span>
          </div>
        ))
      )}

      <div className="cam me">
        {local ? <ParticipantTile trackRef={local} /> : <div className="cam-face">camera off</div>}
        <span className="cam-tag">YOU</span>
        {/* A failed camera must not read as one the rep chose to turn off. */}
        {isBroken(media.cam) && <span className="cam-bad">{CAM_LABEL[media.cam].text.toUpperCase()}</span>}
        <span className="cam-ctl">
          <button
            type="button"
            className={deviceClass(media.mic)}
            onClick={media.toggleMic}
            title={MIC_LABEL[media.mic].hint}
            aria-label={MIC_LABEL[media.mic].hint}
          >
            <IconMic off={media.mic !== "on"} />
          </button>
          <button
            type="button"
            className={deviceClass(media.cam)}
            onClick={media.toggleCam}
            title={CAM_LABEL[media.cam].hint}
            aria-label={CAM_LABEL[media.cam].hint}
          >
            <IconCam off={media.cam !== "on"} />
          </button>
        </span>
      </div>
    </div>
  );
}

function IconMic({ off }: { off?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

function IconCam({ off }: { off?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="m15 10 6-3.5v11L15 14" />
      {off && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

export const isBroken = (s: DeviceStatus) => s === "missing" || s === "blocked";
const deviceClass = (s: DeviceStatus) => (isBroken(s) ? "bad" : s === "off" ? "off" : "");

export const MIC_LABEL: Record<DeviceStatus, { text: string; hint: string }> = {
  on: { text: "Mic", hint: "Mute microphone" },
  off: { text: "Muted", hint: "Unmute microphone" },
  missing: { text: "No microphone", hint: "No microphone detected. Check your OS sound settings, then click to retry." },
  blocked: { text: "Mic blocked", hint: "The browser is blocking the microphone. Allow it for this site in the address bar, then reload." },
};

export const CAM_LABEL: Record<DeviceStatus, { text: string; hint: string }> = {
  on: { text: "Camera", hint: "Turn camera off" },
  off: { text: "Camera off", hint: "Turn camera on" },
  missing: { text: "No camera", hint: "No camera detected. Check your OS settings, then click to retry." },
  blocked: { text: "Camera blocked", hint: "The browser is blocking the camera. Allow it for this site in the address bar, then reload." },
};
