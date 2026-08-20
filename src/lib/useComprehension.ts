"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert, RecordRow } from "./agent/types";
import type { Readiness } from "./agent/readiness";
import { windowToSend, type Line } from "./transcript";

// The two-speed loop, from the client's side. One request per cycle carries the transcript window
// up and brings the ledger back down — the deep pass runs after the response is flushed, so what
// the rep sees is always one cycle behind the scoring and never waits on it.

const POLL_MS = 5000;

// How long to wait for the final pass before reading the record back. The pass starts once the
// POST has responded, so there is nothing to poll — only a short wait.
const FLUSH_MS = 1600;

export type Prepared = { label: string; question: string; at: number; toolCalls: string[] };

export type AgentView = {
  rev: number;
  alert: Alert | null;
  record: RecordRow[];
  degraded: boolean;
  readiness: Readiness | null;
  prepared: Prepared | null;
  unavailable?: boolean;
};

const EMPTY: AgentView = { rev: 0, alert: null, record: [], degraded: false, readiness: null, prepared: null };

export type Comprehension = {
  agent: AgentView;
  /**
   * Act on a concept — the current alert's by default, or a named one when the readiness panel
   * asks about something the alert is not about. Clears the alert optimistically so the console
   * does not nag.
   */
  act: (type: "teach-back-asked" | "dismiss", conceptId?: string) => void;
  copyTeachBack: () => void;
  askedCopied: boolean;
  ending: boolean;
  /** Flush the last exchange through the deep pass and read the finished record back. */
  close: () => Promise<RecordRow[]>;
};

export function useComprehension({
  roomId,
  repName,
  latest,
}: {
  roomId: string;
  repName: string;
  latest: () => Line[];
}): Comprehension {
  const [agent, setAgent] = useState<AgentView>(EMPTY);
  const [askedCopied, setAskedCopied] = useState(false);
  const [ending, setEnding] = useState(false);
  const recordRef = useRef<RecordRow[]>([]);
  const sentUpToRef = useRef(0);

  const sync = useCallback(
    async (act?: { type: "teach-back-asked" | "dismiss"; conceptId: string }, final = false) => {
      const { turns, newest, fresh } = windowToSend(latest(), repName, sentUpToRef.current, final);
      try {
        const res = await fetch("/api/agent/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomId, act, final, turns }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as AgentView;
        if (fresh) sentUpToRef.current = newest;
        recordRef.current = data.record ?? [];
        setAgent(data);
      } catch {
        /* a dropped poll is recovered by the next one */
      }
    },
    [roomId, repName, latest],
  );

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (active) sync();
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [sync]);

  // A rep action is not a ledger write: it goes to its own key and the next deep pass folds it in.
  const act = useCallback(
    (type: "teach-back-asked" | "dismiss", conceptId?: string) => {
      const target = conceptId ?? agent.alert?.conceptId;
      if (!target) return;
      if (target === agent.alert?.conceptId) setAgent((a) => ({ ...a, alert: null }));
      sync({ type, conceptId: target });
    },
    [agent.alert?.conceptId, sync],
  );

  const copyTeachBack = useCallback(() => {
    if (!agent.alert) return;
    navigator.clipboard?.writeText(agent.alert.teachBack).catch(() => {});
    setAskedCopied(true);
    setTimeout(() => setAskedCopied(false), 1500);
  }, [agent.alert]);

  // The record is the deliverable, so ending flushes the last exchange through the deep pass and
  // reads it back before leaving. Without this the brief silently omits the final minute.
  const close = useCallback(async () => {
    setEnding(true);
    try {
      await sync(undefined, true);
      await new Promise((r) => setTimeout(r, FLUSH_MS));
      const res = await fetch(`/api/agent/state?roomId=${encodeURIComponent(roomId)}`);
      if (res.ok) {
        const data = (await res.json()) as AgentView;
        if (Array.isArray(data.record) && data.record.length) return data.record;
      }
    } catch {
      /* fall back to the last polled record rather than blocking the rep */
    }
    return recordRef.current;
  }, [roomId, sync]);

  return { agent, act, copyTeachBack, askedCopied, ending, close };
}
