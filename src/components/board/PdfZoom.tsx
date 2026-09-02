"use client";

import { useRef, useState } from "react";

// A zoom/pan viewport for the brochure page: pinch to zoom (or trackpad ctrl-wheel), drag to pan when
// zoomed, and magnifier +/−/reset buttons. It wraps the PdfPage and transforms it with CSS, so the
// already-rendered high-res canvas just scales — crisp, and no re-rasterisation. Gestures land here
// only when the ink layer is transparent (Draw off); the buttons sit below the ink for the same reason.

const MIN = 1;
const MAX = 5;

function Magnifier({ sign }: { sign: "+" | "-" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="20" y1="20" x2="15.5" y2="15.5" />
      <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
      {sign === "+" && <line x1="10.5" y1="7.5" x2="10.5" y2="13.5" />}
    </svg>
  );
}

type Props = { children: React.ReactNode; resetKey: string };

export default function PdfZoom({ children, resetKey }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });

  // Reset zoom whenever the page/focus changes (adjust during render — the sanctioned pattern).
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setT({ s: 1, x: 0, y: 0 });
  }

  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ d: number; s: number; mx: number; my: number; tx: number; ty: number } | null>(null);

  const rect = () => boxRef.current!.getBoundingClientRect();
  const local = (e: React.PointerEvent) => {
    const r = rect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Keep the scaled page covering the viewport (or centred when smaller).
  const clamp = (s: number, x: number, y: number) => {
    s = Math.max(MIN, Math.min(MAX, s));
    const r = rect();
    const iw = innerRef.current?.offsetWidth || r.width;
    const ih = innerRef.current?.offsetHeight || r.height;
    const sw = iw * s;
    const sh = ih * s;
    x = sw <= r.width ? (r.width - sw) / 2 : Math.min(0, Math.max(r.width - sw, x));
    y = sh <= r.height ? (r.height - sh) / 2 : Math.min(0, Math.max(r.height - sh, y));
    return { s, x, y };
  };

  const zoomAround = (px: number, py: number, factor: number) =>
    setT((cur) => {
      const ns = Math.max(MIN, Math.min(MAX, cur.s * factor));
      const k = ns / cur.s;
      return clamp(ns, px - (px - cur.x) * k, py - (py - cur.y) * k);
    });

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: t.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: t.x, ty: t.y };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const np = local(e);
    pointers.current.set(e.pointerId, np);
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const g = pinch.current;
      const ns = Math.max(MIN, Math.min(MAX, (g.s * d) / g.d));
      setT(clamp(ns, mx - (g.mx - g.tx) * (ns / g.s), my - (g.my - g.ty) * (ns / g.s)));
    } else if (pointers.current.size === 1 && t.s > 1) {
      setT((cur) => clamp(cur.s, cur.x + (np.x - prev.x), cur.y + (np.y - prev.y)));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return; // trackpad pinch arrives as ctrl+wheel; leave plain scroll alone
    const r = rect();
    zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  const zoomCentre = (f: number) => {
    const r = rect();
    zoomAround(r.width / 2, r.height / 2, f);
  };

  return (
    <div
      className="pdf-zoom"
      ref={boxRef}
      style={{ touchAction: t.s > 1 ? "none" : "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div className="pdf-zoom-inner" ref={innerRef} style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: "0 0" }}>
        {children}
      </div>
      <div className="zoom-ctl" role="group" aria-label="Zoom the brochure page">
        <button type="button" className="zoom-btn" onClick={() => zoomCentre(1.5)} aria-label="Zoom in" disabled={t.s >= MAX - 0.001}>
          <Magnifier sign="+" />
        </button>
        <button type="button" className="zoom-btn" onClick={() => zoomCentre(1 / 1.5)} aria-label="Zoom out" disabled={t.s <= MIN + 0.001}>
          <Magnifier sign="-" />
        </button>
        <button type="button" className="zoom-btn zoom-reset" onClick={() => setT({ s: 1, x: 0, y: 0 })} aria-label="Reset zoom" disabled={t.s <= MIN + 0.001}>
          1:1
        </button>
      </div>
    </div>
  );
}
