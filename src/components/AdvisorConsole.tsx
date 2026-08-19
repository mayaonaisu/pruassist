"use client";

import { useCallback, useState } from "react";
import Chrome from "./Chrome";
import IntroStep from "./steps/IntroStep";
import ConsentStep from "./steps/ConsentStep";
import LiveStep from "./steps/LiveStep";
import SummaryStep from "./steps/SummaryStep";
import type { SessionInfo, Stats, SummaryData } from "@/lib/console-types";

function toSummary(raw: unknown): Omit<SummaryData, "stats" | "durationMin"> {
  const o = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    concerns: arr(o.concerns),
    talkingPoints: arr(o.talkingPoints),
    followUps: arr(o.followUps),
    notes: typeof o.notes === "string" ? o.notes : "",
  };
}

export default function AdvisorConsole({ repName }: { repName: string }) {
  const [step, setStep] = useState(0); // 0 intro · 1 consent · 2 live · 3 summary
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);

  const onStarted = useCallback((s: SessionInfo) => {
    setSession(s);
    setStep(2);
  }, []);

  const onEnded = useCallback(
    async (transcriptText: string, stats: Stats, durationMin: number) => {
      if (session) {
        fetch("/api/session/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: session.roomId }),
        }).catch(() => {});
      }
      let data: Omit<SummaryData, "stats" | "durationMin"> = {
        concerns: [],
        talkingPoints: [],
        followUps: [],
        notes: "",
      };
      try {
        const res = await fetch("/api/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: transcriptText }),
        });
        // Never trust the shape here: the summary screen maps over these arrays, so an error
        // envelope from a proxy or a timed-out route would white-screen the console and lose
        // the whole session right after the rep hangs up.
        if (res.ok) data = toSummary(await res.json());
      } catch {
        /* keep empty summary */
      }
      setSummary({ ...data, stats, durationMin });
      setStep(3);
    },
    [session],
  );

  const reset = useCallback(() => {
    setSession(null);
    setSummary(null);
    setStep(0);
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <Chrome step={step} />
      <main className="pru-main">
        <div key={step} className="pru-enter">
          {step === 0 && <IntroStep repName={repName} onStart={() => setStep(1)} />}
          {step === 1 && <ConsentStep repName={repName} onBack={() => setStep(0)} onStarted={onStarted} />}
          {step === 2 && session && <LiveStep repName={repName} session={session} onEnd={onEnded} />}
          {step === 3 && summary && (
            <SummaryStep summary={summary} productArea={session?.productArea ?? "Health Protection"} onNewSession={reset} />
          )}
        </div>
      </main>
    </div>
  );
}
