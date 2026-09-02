"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// A dependency-free ink layer: a canvas that draws pen/highlighter strokes and erases whole strokes,
// with undo/redo/clear. Strokes are kept in refs (the canvas is imperative) and replayed on resize,
// undo, redo and erase. Nothing is ever serialised or stored — strokes live only while this is mounted.

export type InkTool = "pen" | "marker" | "eraser";
export type InkHandle = { undo: () => void; redo: () => void; clear: () => void };

type Pt = { x: number; y: number; p: number };
type Stroke = { tool: "pen" | "marker"; color: string; width: number; points: Pt[] };

type Props = {
  tool: InkTool;
  color: string;
  width: number; // base width in CSS px
  drawEnabled: boolean;
  clearKey: string; // strokes are cleared whenever this changes (a new focus or page)
  onHistoryChange?: (h: { canUndo: boolean; canRedo: boolean }) => void;
};

const PALM_MS = 1500;

// Width at a point: pen swells with pressure; the highlighter is a constant wide nib.
function widthAt(s: Stroke, p: number): number {
  return s.tool === "marker" ? s.width * 4 : s.width + s.width * 1.2 * p;
}

// Distance from point c to segment ab — for the stroke eraser's hit test.
function distToSeg(cx: number, cy: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((cx - ax) * dx + (cy - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(cx - px, cy - py);
}

const InkLayer = forwardRef<InkHandle, Props>(function InkLayer(
  { tool, color, width, drawEnabled, clearKey, onHistoryChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  const strokes = useRef<Stroke[]>([]);
  const past = useRef<Stroke[][]>([]);
  const future = useRef<Stroke[][]>([]);

  // The live gesture.
  const drawing = useRef(false);
  const activePointer = useRef<number | null>(null);
  const current = useRef<Stroke | null>(null);
  const erased = useRef<Set<Stroke>>(new Set());
  const lastPenAt = useRef(0);

  // Latest tool settings, read inside the imperative pointer handlers.
  const cfg = useRef({ tool, color, width, drawEnabled });
  cfg.current = { tool, color, width, drawEnabled };

  const notify = () => onHistoryChange?.({ canUndo: past.current.length > 0, canRedo: future.current.length > 0 });

  const ctx2d = () => canvasRef.current?.getContext("2d") ?? null;

  function clearCanvas(ctx: CanvasRenderingContext2D) {
    const { w, h } = sizeRef.current;
    ctx.clearRect(0, 0, w, h);
  }

  function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke, skipErased = true) {
    if (skipErased && erased.current.has(s)) return;
    const pts = s.points;
    if (!pts.length) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    if (s.tool === "marker") {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = "multiply";
    }
    if (pts.length === 1) {
      // A tap is a dot.
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, widthAt(s, pts[0].p) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    // Quadratic midpoint smoothing, one sub-path per segment so width can follow pressure.
    let prevMid: { x: number; y: number } = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      ctx.lineWidth = widthAt(s, p1.p);
      ctx.beginPath();
      ctx.moveTo(prevMid.x, prevMid.y);
      ctx.quadraticCurveTo(p0.x, p0.y, mid.x, mid.y);
      ctx.stroke();
      prevMid = mid;
    }
    ctx.restore();
  }

  function replay() {
    const ctx = ctx2d();
    if (!ctx) return;
    clearCanvas(ctx);
    for (const s of strokes.current) paintStroke(ctx, s);
  }

  function commit(next: Stroke[]) {
    past.current.push(strokes.current);
    strokes.current = next;
    future.current = [];
    replay();
    notify();
  }

  useImperativeHandle(ref, () => ({
    undo() {
      if (!past.current.length) return;
      future.current.push(strokes.current);
      strokes.current = past.current.pop()!;
      replay();
      notify();
    },
    redo() {
      if (!future.current.length) return;
      past.current.push(strokes.current);
      strokes.current = future.current.pop()!;
      replay();
      notify();
    },
    clear() {
      if (!strokes.current.length) return;
      commit([]);
    },
  }));

  // Size the canvas to the wrapper at the device pixel ratio and replay. Measured synchronously so it
  // works even when ResizeObserver's first callback is deferred (an unpainted tab).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const resize = () => {
      const w = Math.round(parent.clientWidth);
      const h = Math.round(parent.clientHeight);
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      replay();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new focus or page wipes the board — a circle drawn around p.17 must not linger over p.2.
  useEffect(() => {
    strokes.current = [];
    past.current = [];
    future.current = [];
    erased.current = new Set();
    current.current = null;
    replay();
    notify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearKey]);

  // --- pointer input ---

  const localPoint = (e: React.PointerEvent): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, p: e.pressure > 0 ? e.pressure : 0.5 };
  };

  const accepts = (e: React.PointerEvent): boolean => {
    if (e.pointerType === "pen") return true; // the pencil always draws
    if (!cfg.current.drawEnabled) return false; // finger/mouse only when Draw is on
    // Palm rejection: ignore touch shortly after any pen contact.
    if (e.pointerType === "touch" && Date.now() - lastPenAt.current < PALM_MS) return false;
    return true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "pen") lastPenAt.current = Date.now();
    if (activePointer.current !== null) return; // ignore a second simultaneous pointer
    if (!accepts(e)) return;
    activePointer.current = e.pointerId;
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    const pt = localPoint(e);
    if (cfg.current.tool === "eraser") {
      erased.current = new Set();
      eraseAt(pt);
    } else {
      current.current = { tool: cfg.current.tool, color: cfg.current.color, width: cfg.current.width, points: [pt] };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "pen") lastPenAt.current = Date.now();
    if (!drawing.current || e.pointerId !== activePointer.current) return;
    const pt = localPoint(e);
    if (cfg.current.tool === "eraser") {
      eraseAt(pt);
      return;
    }
    const s = current.current;
    if (!s) return;
    const prev = s.points[s.points.length - 1];
    s.points.push(pt);
    // Draw just the new segment for responsiveness; the full stroke is replayed on completion.
    const ctx = ctx2d();
    if (ctx && prev) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = s.color;
      if (s.tool === "marker") {
        ctx.globalAlpha = 0.35;
        ctx.globalCompositeOperation = "multiply";
      }
      ctx.lineWidth = widthAt(s, pt.p);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();
    }
  };

  const eraseAt = (pt: Pt) => {
    let hit = false;
    for (const s of strokes.current) {
      if (erased.current.has(s)) continue;
      const r = widthAt(s, 1) / 2 + 8;
      const pts = s.points;
      const near =
        pts.length === 1
          ? Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y) < r
          : pts.some((p, i) => i > 0 && distToSeg(pt.x, pt.y, pts[i - 1].x, pts[i - 1].y, p.x, p.y) < r);
      if (near) {
        erased.current.add(s);
        hit = true;
      }
    }
    if (hit) replay();
  };

  const endGesture = (e: React.PointerEvent) => {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    if (!drawing.current) return;
    drawing.current = false;
    if (cfg.current.tool === "eraser") {
      if (erased.current.size) {
        commit(strokes.current.filter((s) => !erased.current.has(s)));
        erased.current = new Set();
      }
    } else if (current.current && current.current.points.length) {
      commit([...strokes.current, current.current]);
      current.current = null;
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="ink"
      style={{ touchAction: cfg.current.drawEnabled ? "none" : "auto", pointerEvents: drawEnabled ? "auto" : "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    />
  );
});

export default InkLayer;
