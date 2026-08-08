"use client";

import { useCallback, useState } from "react";
import Chrome from "./Chrome";
import IntroStep from "./steps/IntroStep";
import ConsentStep from "./steps/ConsentStep";
import LiveStep from "./steps/LiveStep";
import SummaryStep from "./steps/SummaryStep";
import type { SessionInfo, Stats, SummaryData } from "@/lib/console-types";

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
      let data = { concerns: [], talkingPoints: [], followUps: [], notes: "" } as Omit<
        SummaryData,
        "stats" | "durationMin"
      >;
      try {
        const res = await fetch("/api/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: transcriptText }),
        });
        data = await res.json();
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
          {step === 3 && summary && <SummaryStep summary={summary} onNewSession={reset} />}
        </div>
      </main>
    </div>
  );
}
