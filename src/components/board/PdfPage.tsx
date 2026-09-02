"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getPdf } from "@/lib/pdf-cache";

type Props = { file: string; page: number; highlights?: string[]; onError?: (e: unknown) => void };

// Safari caps a single canvas at 16,777,216 px; clamp the device-pixel-ratio so width×height×dpr²
// stays under that, or the whole render silently fails on an iPad.
const MAX_CANVAS_PX = 16_000_000;

const digits = (s: string) => s.replace(/\D+/g, "");

type Rect = { left: number; top: number; width: number; height: number };

// One brochure page, rendered to a canvas at the wrapper's width, with the cited S$ figures boxed.
export default function PdfPage({ file, page, highlights, onError }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rects, setRects] = useState<Rect[]>([]);

  // Highlights change together with the page, so they are read fresh inside the render effect rather
  // than being a dependency of it (which would re-render the page on every parent re-render). Synced
  // through a ref in an effect — assigning a ref during render is disallowed.
  const highlightsRef = useRef<string[]>([]);
  useEffect(() => {
    highlightsRef.current = highlights ?? [];
  });

  // Follow the wrapper width; the render effect is keyed on it. Measure synchronously on mount rather
  // than waiting for ResizeObserver's first callback — that callback can be deferred indefinitely for
  // an element that isn't being painted (a backgrounded tab), which would leave the page stuck loading.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    let task: RenderTask | null = null;
    let pg: PDFPageProxy | null = null;
    let cancelled = false;
    // `loading`/`rects` are reset by remounting on a page change (the parent keys PdfPage by file:page),
    // so they are not reset synchronously here; setLoading(false)/setRects run after the async render.

    (async () => {
      try {
        const doc = await getPdf(file);
        if (cancelled) return;
        pg = await doc.getPage(page);
        if (cancelled) return;

        const scale = width / pg.getViewport({ scale: 1 }).width;
        const viewport = pg.getViewport({ scale });
        const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PX / (viewport.width * viewport.height)));

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        task = pg.render({ canvas, canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
        await task.promise;
        if (cancelled) return;
        setLoading(false);

        // Box the requested figures: compare digit strings (3+ digits) so "S$3,500" matches the page's
        // "3,500" regardless of currency glyph or spacing.
        const wanted = highlightsRef.current.map(digits).filter((d) => d.length >= 3);
        if (wanted.length) {
          const tc = await pg.getTextContent();
          if (cancelled) return;
          const found: Rect[] = [];
          for (const item of tc.items) {
            if (!("str" in item)) continue;
            const d = digits(item.str);
            if (d.length < 3 || !wanted.some((w) => d.includes(w))) continue;
            // pdfjs 6 dropped convertToViewportRectangle; convert the two corners instead.
            const [x1, y1] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const [x2, y2] = viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5] + item.height);
            found.push({ left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
          }
          if (!cancelled) setRects(found);
        }
      } catch (e) {
        if (cancelled) return;
        if ((e as { name?: string })?.name === "RenderingCancelledException") return;
        onError?.(e);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
      pg?.cleanup();
    };
    // highlights intentionally excluded — see highlightsRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, page, width]);

  return (
    <div ref={wrapRef} className="pdf-wrap" style={{ position: "relative" }}>
      {loading && (
        <div className="pdf-skeleton" aria-hidden>
          <div className="pru-skeleton" />
          <div className="pru-skeleton" />
          <div className="pru-skeleton" />
        </div>
      )}
      <canvas ref={canvasRef} className="pdf-canvas" />
      {rects.map((r, i) => (
        <div
          key={i}
          className="pdf-hl"
          style={{ position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height, pointerEvents: "none" }}
        />
      ))}
    </div>
  );
}
