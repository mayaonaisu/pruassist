"use client";

import { useCallback, useEffect, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";

// "missing" — the machine exposes no such device.
// "blocked" — the device exists but the browser denied access, so toggling can never work
//             until the rep changes a browser/OS setting.
export type DeviceStatus = "on" | "off" | "missing" | "blocked";

export type LocalMedia = {
  mic: DeviceStatus;
  cam: DeviceStatus;
  toggleMic: () => void;
  toggleCam: () => void;
};

type Presence = { mic: boolean; cam: boolean };
type Permission = { mic: PermissionState | null; cam: PermissionState | null };

// Owns everything about the rep's own mic and camera: whether the hardware exists, whether the
// browser will let us use it, whether it is currently live, and how to toggle it. Callers get four
// members and never touch LiveKit tracks, device enumeration or the Permissions API directly.
export function useLocalMedia(room: Room | undefined): LocalMedia {
  const [presence, setPresence] = useState<Presence>({ mic: true, cam: true });
  const [permission, setPermission] = useState<Permission>({ mic: null, cam: null });
  const [live, setLive] = useState({ mic: false, cam: false });

  // Track state lives on the LiveKit room, so mirror it into state on every track event rather
  // than reading it during render (it mutates outside React and would otherwise go stale).
  useEffect(() => {
    if (!room) return;
    const sync = () => {
      const lp = room.localParticipant;
      setLive({ mic: lp?.isMicrophoneEnabled ?? false, cam: lp?.isCameraEnabled ?? false });
    };
    sync();
    room
      .on(RoomEvent.LocalTrackPublished, sync)
      .on(RoomEvent.LocalTrackUnpublished, sync)
      .on(RoomEvent.TrackMuted, sync)
      .on(RoomEvent.TrackUnmuted, sync)
      .on(RoomEvent.ConnectionStateChanged, sync);
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, sync)
        .off(RoomEvent.LocalTrackUnpublished, sync)
        .off(RoomEvent.TrackMuted, sync)
        .off(RoomEvent.TrackUnmuted, sync)
        .off(RoomEvent.ConnectionStateChanged, sync);
    };
  }, [room]);

  const scanDevices = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devs) =>
        setPresence({
          mic: devs.some((d) => d.kind === "audioinput"),
          cam: devs.some((d) => d.kind === "videoinput"),
        }),
      )
      .catch(() => setPresence({ mic: false, cam: false }));
  }, []);

  useEffect(() => {
    scanDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", scanDevices);
    return () => md?.removeEventListener?.("devicechange", scanDevices);
  }, [scanDevices]);

  // The Permissions API reports a denial the rep made in a previous visit, and fires onchange the
  // moment they fix it — so the warning clears itself without a reconnect. Unsupported in some
  // browsers (Firefox rejects these names), where we fall back to LiveKit's error events below.
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];
    (async () => {
      for (const [key, name] of [
        ["mic", "microphone"],
        ["cam", "camera"],
      ] as const) {
        try {
          const st = await navigator.permissions.query({ name: name as PermissionName });
          if (cancelled) return;
          const apply = () => setPermission((p) => ({ ...p, [key]: st.state }));
          apply();
          st.addEventListener("change", apply);
          cleanups.push(() => st.removeEventListener("change", apply));
        } catch {
          /* Permissions API unavailable for this device kind */
        }
      }
    })();
    return () => {
      cancelled = true;
      cleanups.forEach((c) => c());
    };
  }, []);

  // LiveKit enables the mic/camera itself on connect, so a denial there never reaches our toggle
  // handlers — this is the only way to learn the rep's very first prompt was rejected.
  useEffect(() => {
    if (!room) return;
    const onError = (e: Error) => {
      if (e.name === "NotAllowedError") setPermission({ mic: "denied", cam: "denied" });
      if (e.name === "NotFoundError") scanDevices();
    };
    room.on(RoomEvent.MediaDevicesError, onError);
    return () => {
      room.off(RoomEvent.MediaDevicesError, onError);
    };
  }, [room, scanDevices]);

  const toggle = useCallback(
    (key: "mic" | "cam") => {
      const lp = room?.localParticipant;
      if (!lp) return;
      const want = key === "mic" ? !lp.isMicrophoneEnabled : !lp.isCameraEnabled;
      const call = key === "mic" ? lp.setMicrophoneEnabled(want) : lp.setCameraEnabled(want);
      call
        .then(() => setPermission((p) => ({ ...p, [key]: "granted" })))
        .catch((e: unknown) => {
          const name = e instanceof Error ? e.name : "";
          if (name === "NotAllowedError") setPermission((p) => ({ ...p, [key]: "denied" }));
          else scanDevices();
        });
    },
    [room, scanDevices],
  );

  const toggleMic = useCallback(() => toggle("mic"), [toggle]);
  const toggleCam = useCallback(() => toggle("cam"), [toggle]);

  const statusOf = (key: "mic" | "cam"): DeviceStatus => {
    if (!presence[key]) return "missing";
    if (permission[key] === "denied") return "blocked";
    return live[key] ? "on" : "off";
  };

  return { mic: statusOf("mic"), cam: statusOf("cam"), toggleMic, toggleCam };
}
