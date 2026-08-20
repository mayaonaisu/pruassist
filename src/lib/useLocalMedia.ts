"use client";

import { useCallback, useEffect, useState } from "react";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";

// "missing" — no such device. "blocked" — device present but the browser denied access.
export type DeviceStatus = "on" | "off" | "missing" | "blocked";

export type LocalMedia = {
  mic: DeviceStatus;
  cam: DeviceStatus;
  toggleMic: () => void;
  toggleCam: () => void;
};

type Presence = { mic: boolean; cam: boolean };
type Permission = { mic: PermissionState | null; cam: PermissionState | null };

// Owns the rep's mic and camera: hardware presence, permission, liveness, and toggling.
export function useLocalMedia(room: Room | undefined): LocalMedia {
  const [presence, setPresence] = useState<Presence>({ mic: true, cam: true });
  const [permission, setPermission] = useState<Permission>({ mic: null, cam: null });
  const [live, setLive] = useState({ mic: false, cam: false });

  // Track state mutates outside React, so mirror it into state on every track event.
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

  // Permissions API clears the warning without a reconnect; unsupported in some browsers.
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

  // LiveKit enables devices on connect, so a first-prompt denial never reaches our toggles.
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
