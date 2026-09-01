"use client";

import { useEffect, useRef, useState } from "react";

// Hold a screen wake lock while `active`, so the iPad does not dim and auto-lock during an in-person
// session — a lock kills the microphone capture, and web content cannot opt out of that (see
// docs/in-person-mode-research.md §5). iOS releases the lock when the tab is hidden, so it is
// re-acquired on the next foreground. Supported in Safari from iPadOS 16.4; a silent no-op elsewhere.

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

export function useWakeLock(active: boolean): { held: boolean } {
  const [held, setHeld] = useState(false);
  const lockRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active) return;
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return; // unsupported — nothing to do

    let cancelled = false;

    const acquire = async () => {
      if (lockRef.current) return;
      try {
        const sentinel = await wl.request("screen");
        if (cancelled) {
          sentinel.release().catch(() => {});
          return;
        }
        lockRef.current = sentinel;
        setHeld(true);
        sentinel.addEventListener("release", () => {
          lockRef.current = null;
          setHeld(false);
        });
      } catch {
        setHeld(false); // e.g. not in a user-gesture context, or low battery — advisory only
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      const s = lockRef.current;
      lockRef.current = null;
      setHeld(false);
      s?.release().catch(() => {});
    };
  }, [active]);

  return { held };
}
