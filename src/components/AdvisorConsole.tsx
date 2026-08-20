"use client";

import { useCallback, useState } from "react";
import Chrome from "./Chrome";
import IntroStep from "./steps/IntroStep";
import ConsentStep from "./steps/ConsentStep";
import LiveStep, { type Comprehension } from "./steps/LiveStep";
import SummaryStep from "./steps/SummaryStep";
import type { SessionInfo, Stats, SummaryData } from "@/lib/console-types";

type Narrative = Pick<SummaryData, "concerns" | "talkingPoints" | "followUps" | "notes">;

function toSummary(raw: unknown): Narrative {
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
    async (transcriptText: string, stats: Stats, durationMin: number, comprehension: Comprehension) => {
      if (session) {
        fetch("/api/session/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId: session.roomId }),
        }).catch(() => {});
      }
      let data: Narrative = { concerns: [], talkingPoints: [], followUps: [], notes: "" };
      try {
        const res = await fetch("/api/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: transcriptText }),
        });
        // The summary screen maps over these arrays, so a bad shape would white-screen the console.
        if (res.ok) data = toSummary(await res.json());
      } catch {
        /* keep empty summary */
      }
      // The record is the rep's own signed artifact, so it is signed with the consent signature
      // they typed at the start of this session — not with a name the server assumed.
      setSummary({ ...data, ...comprehension, stats, durationMin, signedBy: repName });
      setStep(3);
    },
    [session, repName],
  );

  const reset = useCallback(() => {
    setSession(null);
    setSummary(null);
    setStep(0);
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "var(--brochure)" }}>
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
