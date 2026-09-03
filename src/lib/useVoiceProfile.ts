"use client";

import { useCallback, useEffect, useState } from "react";
import { decodeProfile } from "./voice/profile-codec";
import { VOICE_MODEL } from "./voice/model-info";

// Fetch the signed-in rep's stored voiceprint once, decoded to a Float32Array. `profile` is `undefined`
// while loading, `null` when there is none (or it was saved under a different model, so it is treated as
// missing and re-enrolment is prompted), else the 192-d vector. `reload` re-fetches after enrol/delete.

export type LoadedVoiceProfile = {
  profile: Float32Array | null | undefined;
  updatedAt: number | null;
  reload: () => void;
};

export function useVoiceProfile(): LoadedVoiceProfile {
  const [profile, setProfile] = useState<Float32Array | null | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/voice");
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          if (!active) return;
          if (typeof data.profile === "string" && data.model === VOICE_MODEL) {
            try {
              const v = decodeProfile(data.profile);
              setProfile(v);
              setUpdatedAt(typeof data.updatedAt === "number" ? data.updatedAt : null);
              return;
            } catch {
              /* corrupt profile → treat as missing */
            }
          }
        }
        setProfile(null);
        setUpdatedAt(null);
      } catch {
        if (active) {
          setProfile(null);
          setUpdatedAt(null);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [nonce]);

  return { profile, updatedAt, reload };
}
