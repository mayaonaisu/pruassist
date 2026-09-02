"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Stats } from "./console-types";
import type { AssistMode } from "./agent/orchestrator/types";
import { lastFromCustomer, transcriptText, type Line } from "./transcript";

// The live orchestrator path: on each substantive customer turn, ask the server what kind of help
// the rep needs (the mode) and render it — a line to say, a proactive nudge, a clarify prompt, a
// drift warning, or nothing. Also counts what was offered and used.

// Long enough to give the model context, short enough that an old topic does not colour retrieval.
const WINDOW = 12;

// A beat after the customer stops, so a sentence finishing in two fragments is not two calls.
const TRIGGER_DELAY_MS = 1400;

// Skip ultra-short acks client-side; the server's wake-gate handles the rest cheaply.
const MIN_WORDS = 3;

// `id` is the clause id; optional because lookahead answers cached before Source.id shipped lack it.
type Src = { id?: string; source: string; snippet: string };

export type Pointers = {
  concern: string;
  firstStep: string;
  suggestedLine: string;
  explainer: string;
  comparison: string;
  followUp: string;
  sources: Src[];
  // Served from the background pass, which prepared and grounding-checked this answer before the
  // question was asked. Shown, not hidden — the rep should know what they are reading.
  cached: boolean;
  prepared?: { label: string; question: string; at: number; match: number };
  // Figures in the suggested line that appear nowhere in the cited pages. A label, never a block.
  unsupportedFigures: string[];
};

export type Clarify = { question: string; prompt: string };

export type PointerConsole = {
  result: Pointers | null;
  note: string | undefined;
  // The mode the orchestrator chose for the last turn — drives how the console renders it.
  mode: AssistMode | null;
  // Set when the orchestrator needs the rep to supply context before it will answer.
  clarify: Clarify | null;
  loading: boolean;
  // Measured round trip for the last pointer. A cache hit is a real latency win, so it is measured
  // rather than asserted.
  latencyMs: number | null;
  used: Set<string>;
  openKey: string | null;
  setOpenKey: (fn: (k: string | null) => string | null) => void;
  ask: (opts?: { rephrase?: boolean; clarifyContext?: string }) => Promise<void>;
  // The rep gives the AI context (answering a clarification, or volunteering it); re-routes the turn
  // and rides the ones after it.
  provideContext: (text: string) => Promise<void>;
  markUsed: (key: string) => void;
  dismiss: () => void;
  stats: () => Stats;
};

export function usePointers({
  roomId,
  repName,
  lines,
  latest,
  auto,
}: {
  roomId: string;
  repName: string;
  lines: Line[];
  latest: () => Line[];
  auto: boolean;
}): PointerConsole {
  const [result, setResult] = useState<Pointers | null>(null);
  const [note, setNote] = useState<string>();
  const [mode, setMode] = useState<AssistMode | null>(null);
  const [clarify, setClarify] = useState<Clarify | null>(null);
  const [loading, setLoading] = useState(false);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerRef = useRef("");
  const statsRef = useRef<Stats>({ surfaced: 0, used: 0, flags: 0, docs: 0 });
  const docsRef = useRef<Set<string>>(new Set());
  // Context the rep has volunteered (or given in answer to a clarification). It rides every
  // subsequent turn, not just the one it was typed on — which two plans they are comparing stays
  // true for the rest of the conversation.
  const contextRef = useRef("");

  // `rephrase` replaces the current pointers, so it must not re-count them as new flags.
  const ask = useCallback(
    async ({ rephrase = false, clarifyContext }: { rephrase?: boolean; clarifyContext?: string } = {}) => {
      if (inFlightRef.current) return;
      const window = latest().slice(-WINDOW);
      const transcript = transcriptText(window);
      if (!transcript) {
        setNote("No transcript yet — once the conversation starts, pointers appear here.");
        return;
      }
      inFlightRef.current = true;
      setLoading(true);
      setNote(undefined);
      const startedRequest = performance.now();
      try {
        const ctx = (clarifyContext ?? contextRef.current).trim();
        const res = await fetch("/api/assist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            roomId,
            asked: lastFromCustomer(latest(), repName),
            clarifyContext: ctx || undefined,
          }),
        });
        const data = await res.json();
        setMode((data.mode as AssistMode) ?? null);

        // The orchestrator wants context from the rep before it answers.
        if (data.mode === "clarification") {
          setClarify(data.clarify ?? null);
          setResult(null);
          setNote(undefined);
          return;
        }
        setClarify(null);

        // No line to say: keep_listening (note null → idle), topic_drift (note is the warning), or
        // a no-clause note. LiveStep uses `mode` to tell a drift banner from a plain idle note.
        if (!data.suggestedLine) {
          setNote(data.note ?? undefined);
          setResult(null);
          setLatencyMs(Math.round(performance.now() - startedRequest));
          return;
        }

        const r: Pointers = {
          concern: data.concern || "",
          firstStep: data.firstStep || "",
          suggestedLine: data.suggestedLine || "",
          explainer: data.explainer || "",
          comparison: data.comparison || "",
          followUp: data.followUp || "",
          sources: Array.isArray(data.sources) ? data.sources : [],
          cached: data.cached === true,
          prepared: data.prepared,
          unsupportedFigures: Array.isArray(data.unsupportedFigures) ? data.unsupportedFigures : [],
        };
        setLatencyMs(Math.round(performance.now() - startedRequest));
        setResult(r);
        setUsed(new Set());
        setOpenKey(null);
        if (!rephrase) {
          // One pointer = one line offered; counting all six fields made the brief read "24 / 3".
          if (r.suggestedLine) statsRef.current.surfaced += 1;
          if (r.concern) statsRef.current.flags += 1;
        }
        r.sources.forEach((s) => docsRef.current.add(s.source));
      } catch {
        setNote("Could not reach the AI service.");
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [roomId, repName, latest],
  );

  // Fires on any substantive customer turn (not only questions), once per line — so the proactive
  // modes (guider, drift, clarification) can trigger too. Ultra-short acks are skipped here; the
  // server wake-gate keeps a bare "okay, that makes sense" from spending a brain call.
  useEffect(() => {
    if (!auto) return;
    const last = lines[lines.length - 1];
    if (!last || last.speaker === repName) return;
    if (lastTriggerRef.current === last.id) return;
    if (last.text.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) return;
    lastTriggerRef.current = last.id;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => ask(), TRIGGER_DELAY_MS);
  }, [lines, auto, repName, ask]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // The rep gives the AI context — either answering a clarification it raised, or volunteering it
  // unprompted from the context chat. Either way it re-routes the current turn and sticks for the
  // ones after (contextRef), and clears any pending clarification.
  const provideContext = useCallback(
    async (text: string) => {
      const ctx = text.trim();
      if (!ctx) return;
      contextRef.current = ctx;
      setClarify(null);
      await ask({ clarifyContext: ctx });
    },
    [ask],
  );

  const markUsed = useCallback(
    (key: string) => {
      if (used.has(key)) return;
      setUsed((prev) => new Set(prev).add(key));
      statsRef.current.used += 1;
    },
    [used],
  );

  const stats = useCallback(() => ({ ...statsRef.current, docs: docsRef.current.size }), []);
  const dismiss = useCallback(() => {
    setResult(null);
    setClarify(null);
    setNote(undefined);
    setMode(null);
  }, []);

  return { result, note, mode, clarify, loading, latencyMs, used, openKey, setOpenKey, ask, provideContext, markUsed, dismiss, stats };
}
