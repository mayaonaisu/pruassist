"use client";

import { useEffect, useState } from "react";

// The customer's consent, polled. Nothing is transcribed on their side until they accept on their
// own device, so the console shows "awaiting customer" until this returns a name.

const POLL_MS = 4000;

export type Consent = { name: string; consentedAt: string } | null;

export function useConsent(roomId: string): Consent {
  const [consent, setConsent] = useState<Consent>(null);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/consent?room=${encodeURIComponent(roomId)}`);
        const data = await res.json();
        if (active) setConsent(data.consent);
      } catch {
        /* ignore — the next tick tries again */
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [roomId]);

  return consent;
}
