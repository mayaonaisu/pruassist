"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "@/lib/useComprehension";
import { conceptCard, sourceCard, conceptsInPlay, type BoardEvent, type BoardFocus, type BoardState } from "@/lib/board";
import PdfPage from "./PdfPage";
import ExcerptCard from "./ExcerptCard";
import InkLayer, { type InkHandle, type InkTool } from "./InkLayer";

// The customer-facing whiteboard: an explainer card for the concept in play, the actual brochure page it
// is grounded in (with the cited figures highlighted), and an ink layer the rep draws over. Everything it
// shows is projected by board.ts, which only ever emits customer-safe text (see the grounding constraint).

// Concrete colours for the canvas (CSS vars don't resolve in a 2D context). Yellow is the highlighter's
// default; red is the pen's.
const COLORS = [
  { name: "Red", value: "#ed1b2e" },
  { name: "Black", value: "#171a21" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Green", value: "#15803d" },
  { name: "Orange", value: "#ea580c" },
  { name: "Yellow", value: "#e8b317" },
] as const;

const WIDTHS = [
  { label: "S", value: 2.5 },
  { label: "M", value: 4 },
  { label: "L", value: 7 },
] as const;

type PageRef = { file: string; page: number };
type Excerpt = { eyebrow: string; text: string };
type View =
  | { idle: true; product: string }
  | {
      idle: false;
      eyebrow: string;
      headline: string;
      canonical?: string;
      excerpts: Excerpt[];
      pages: PageRef[];
      highlights: string[];
      fallback: { doc: string; pages?: number[]; url?: string; excerpts: { text: string }[] };
    };

// "PRUShield Product Brochure (Apr 2026)" → "PRUShield"; "PRUActive Protect Brochure" → "PRUActive Protect".
function shortName(doc: string): string {
  return doc.replace(/\s+(Product\s+)?Brochure.*$/i, "").trim() || doc;
}

function focusKey(f: BoardFocus): string {
  if (f.kind === "idle") return "idle";
  if (f.kind === "concept") return `concept:${f.conceptId}`;
  return `source:${f.source}:${f.clauseId ?? ""}`;
}

function deriveView(focus: BoardFocus, productArea: string): View {
  if (focus.kind === "concept") {
    const card = conceptCard(focus.conceptId);
    if (!card) return { idle: true, product: productArea };
    const fullDoc = card.excerpts[0]?.doc ?? "";
    return {
      idle: false,
      eyebrow: fullDoc ? `${shortName(fullDoc)} · ${card.label}` : card.label,
      headline: card.label,
      canonical: card.canonical,
      excerpts: card.excerpts.map((e) => ({
        eyebrow: `${shortName(e.doc)} · ${e.pages.map((p) => `p.${p}`).join(", ")}`,
        text: e.text,
      })),
      pages: card.pages,
      highlights: card.highlights,
      fallback: { doc: fullDoc, pages: [...new Set(card.pages.map((p) => p.page))], excerpts: card.excerpts.map((e) => ({ text: e.text })) },
    };
  }
  if (focus.kind === "source") {
    const sc = sourceCard(focus);
    const short = shortName(sc.doc);
    if (sc.kind === "pdf" && sc.file && sc.pages.length) {
      const pageEyebrow = `${short} · ${sc.pages.map((p) => `p.${p}`).join(", ")}`;
      return {
        idle: false,
        eyebrow: short,
        headline: short,
        excerpts: sc.excerpts.map((e) => ({ eyebrow: pageEyebrow, text: e.text })),
        pages: sc.pages.map((p) => ({ file: sc.file!, page: p })),
        highlights: sc.highlights,
        fallback: { doc: sc.doc, pages: sc.pages, excerpts: sc.excerpts.map((e) => ({ text: e.text })) },
      };
    }
    // Web or custom-KB clause: no page to render, an excerpt card instead.
    return {
      idle: false,
      eyebrow: short,
      headline: short,
      excerpts: sc.excerpts.map((e) => ({ eyebrow: sc.doc, text: e.text })),
      pages: [],
      highlights: sc.highlights,
      fallback: { doc: sc.doc, pages: sc.pages, url: sc.kind === "web" ? sc.url : undefined, excerpts: sc.excerpts.map((e) => ({ text: e.text })) },
    };
  }
  return { idle: true, product: productArea };
}

type Props = { agent: AgentView; productArea: string; state: BoardState; dispatch: (ev: BoardEvent) => void };

export default function Whiteboard({ agent, productArea, state, dispatch }: Props) {
  // Follow each poll: re-derive the focus whenever the ledger revision changes (unless pinned).
  useEffect(() => {
    dispatch({ type: "agent", agent: { alert: agent.alert, record: agent.record, readiness: agent.readiness } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.rev]);

  const chips = conceptsInPlay({ alert: agent.alert, record: agent.record, readiness: agent.readiness }, productArea);
  const view = useMemo(() => deriveView(state.focus, productArea), [state.focus, productArea]);
  const key = focusKey(state.focus);

  // Which brochure page is shown, reset on every focus change. Adjusted during render (the sanctioned
  // "reset state when a prop changes" pattern, tracking the previous key in state) rather than in an
  // effect, which would cascade a render.
  const [pageIdx, setPageIdx] = useState(0);
  const [pdfError, setPdfError] = useState(false);
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setPageIdx(0);
    setPdfError(false);
  }

  const pages = view.idle ? [] : view.pages;
  const safeIdx = Math.min(pageIdx, Math.max(0, pages.length - 1));
  const cur = pages[safeIdx] ?? null;

  // Ink toolbar state.
  const [drawOn, setDrawOn] = useState(false);
  const [tool, setTool] = useState<InkTool>("pen");
  const [penColor, setPenColor] = useState<string>(COLORS[0].value);
  const [markerColor, setMarkerColor] = useState<string>(COLORS[5].value);
  const [width, setWidth] = useState<number>(WIDTHS[1].value);
  const [hist, setHist] = useState({ canUndo: false, canRedo: false });
  const inkRef = useRef<InkHandle>(null);

  // Draggable split between the card and the brochure page (percent given to the card). The value is
  // fed to both the toolbar grid and the body grid as CSS variables so they stay column-aligned; the
  // portrait media query ignores the variables and stacks instead.
  const [split, setSplit] = useState(55);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const onDividerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !bodyRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplit(Math.max(28, Math.min(72, pct)));
  };
  const onDividerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  const splitStyle = { ["--split" as string]: `${split}fr`, ["--page-split" as string]: `${100 - split}fr` } as React.CSSProperties;

  const activeColor = tool === "marker" ? markerColor : penColor;
  const setActiveColor = (c: string) => (tool === "marker" ? setMarkerColor(c) : setPenColor(c));
  const pickTool = (t: InkTool) => {
    setTool(t);
    setDrawOn(true);
  };

  const clearKey = `${key}:${cur?.file ?? ""}:${cur?.page ?? ""}`;
  const showPdf = !view.idle && view.pages.length > 0 && cur && !pdfError;

  return (
    <div className="board">
      <div className="board-head" style={splitStyle}>
        <div className="board-head-card">
        <div className="board-chips">
          {chips.map((c) => (
            <button
              key={c.conceptId}
              type="button"
              className={`board-chip ${c.active ? "active" : ""}`}
              onClick={() => dispatch({ type: "pick", focus: { kind: "concept", conceptId: c.conceptId } })}
            >
              {c.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`board-follow ${state.pinned ? "pinned" : ""}`}
          onClick={() => dispatch({ type: "follow" })}
          disabled={!state.pinned}
          title={state.pinned ? "Pinned to your pick — tap to follow the conversation again" : "Following the conversation"}
        >
          {state.pinned ? "Pinned · Follow conversation" : "Following conversation"}
        </button>
        </div>

        <div className="board-head-gap" aria-hidden />

        <div className="ink-tools" role="group" aria-label="Drawing tools">
          <button type="button" className={`tool-btn ${drawOn ? "on" : ""}`} onClick={() => setDrawOn((v) => !v)}>
            {drawOn ? "Draw on" : "Draw off"}
          </button>
          <button type="button" className={`tool-btn ${drawOn && tool === "pen" ? "on" : ""}`} onClick={() => pickTool("pen")}>
            Pen
          </button>
          <button type="button" className={`tool-btn ${drawOn && tool === "marker" ? "on" : ""}`} onClick={() => pickTool("marker")}>
            Marker
          </button>
          <button type="button" className={`tool-btn ${drawOn && tool === "eraser" ? "on" : ""}`} onClick={() => pickTool("eraser")}>
            Eraser
          </button>
          <div className="color-row">
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                className={`color-chip ${activeColor === c.value ? "on" : ""}`}
                style={{ ["--sw" as string]: c.value }}
                onClick={() => setActiveColor(c.value)}
                aria-label={c.name}
                aria-pressed={activeColor === c.value}
              />
            ))}
          </div>
          <div className="width-row">
            {WIDTHS.map((w) => (
              <button key={w.value} type="button" className={`tool-btn ${width === w.value ? "on" : ""}`} onClick={() => setWidth(w.value)}>
                {w.label}
              </button>
            ))}
          </div>
          <button type="button" className="tool-btn" onClick={() => inkRef.current?.undo()} disabled={!hist.canUndo}>
            Undo
          </button>
          <button type="button" className="tool-btn" onClick={() => inkRef.current?.redo()} disabled={!hist.canRedo}>
            Redo
          </button>
          <button type="button" className="tool-btn" onClick={() => inkRef.current?.clear()}>
            Clear
          </button>
        </div>
      </div>

      <div className={`board-body ${view.idle ? "idle" : ""}`} ref={bodyRef} style={splitStyle}>
        {view.idle ? (
          <div className="board-card idle">
            <div className="board-eyebrow">{view.product}</div>
            <div className="board-idle">We&rsquo;ll put the important points here as we go.</div>
          </div>
        ) : (
          <>
            <div className="board-card">
              <div className="board-eyebrow">{view.eyebrow}</div>
              <div className="board-headline">{view.headline}</div>
              {view.canonical && <div className="board-say">{view.canonical}</div>}
              {view.excerpts.map((e, i) => (
                <div key={i} className="board-excerpt">
                  <div className="board-excerpt-eyebrow">{e.eyebrow}</div>
                  <p>{e.text}</p>
                </div>
              ))}
            </div>

            <div
              className="board-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the card and page"
              tabIndex={0}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setSplit((s) => Math.max(28, s - 3));
                else if (e.key === "ArrowRight") setSplit((s) => Math.min(72, s + 3));
              }}
            />

            <div className="board-page">
              {showPdf && cur ? (
                <>
                  <div className="page-pills">
                    {view.pages.length > 1 && (
                      <button type="button" className="page-arrow" disabled={safeIdx <= 0} onClick={() => setPageIdx((i) => Math.max(0, i - 1))} aria-label="Previous page">
                        ‹
                      </button>
                    )}
                    {view.pages.map((p, i) => (
                      <button key={`${p.file}:${p.page}`} type="button" className={`page-pill ${i === safeIdx ? "on" : ""}`} onClick={() => setPageIdx(i)}>
                        p.{p.page}
                      </button>
                    ))}
                    {view.pages.length > 1 && (
                      <button type="button" className="page-arrow" disabled={safeIdx >= view.pages.length - 1} onClick={() => setPageIdx((i) => Math.min(view.pages.length - 1, i + 1))} aria-label="Next page">
                        ›
                      </button>
                    )}
                  </div>
                  <PdfPage key={`${cur.file}:${cur.page}`} file={cur.file} page={cur.page} highlights={view.highlights} onError={() => setPdfError(true)} />
                </>
              ) : (
                <ExcerptCard
                  doc={view.fallback.doc}
                  pages={view.fallback.pages}
                  url={view.fallback.url}
                  excerpts={view.fallback.excerpts}
                  note={view.pages.length > 0 && pdfError ? "Page preview unavailable — brochure text below." : undefined}
                />
              )}
            </div>
          </>
        )}

        <InkLayer
          ref={inkRef}
          tool={tool}
          color={activeColor}
          width={width}
          drawEnabled={drawOn}
          clearKey={clearKey}
          onHistoryChange={setHist}
        />
      </div>
    </div>
  );
}
