"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getPdf } from "@/lib/pdf-cache";

type Props = { file: string; page: number; highlights?: string[]; onError?: (e: unknown) => void };

// Safari caps a single canvas at 16,777,216 px. Render each page ONCE at a fixed high resolution and
// let CSS scale that crisp bitmap to whatever width the column happens to be — so dragging the divider
// is pure native scaling, with no re-rasterisation (which is what flickered) and no ResizeObserver loop.
const MAX_CANVAS_PX = 16_000_000;
const RENDER_W = 1500; // device-independent render width; comfortably above any iPad column width

const digits = (s: string) => s.replace(/\D+/g, "");

// Highlight rectangles are stored as fractions of the page (0..1), so they scale with the CSS-scaled
// canvas without recomputing on resize.
type Frac = { left: number; top: number; width: number; height: number };

// One brochure page. Rendered once at RENDER_W; the canvas is sized by CSS (width:100%).
export default function PdfPage({ file, page, highlights, onError }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [rects, setRects] = useState<Frac[]>([]);

  // Highlights change together with the page, but the render is keyed on file/page only; read them
  // through a ref so a new highlights array does not re-run the render.
  const highlightsRef = useRef<string[]>([]);
  useEffect(() => {
    highlightsRef.current = highlights ?? [];
  });

  useEffect(() => {
    let task: RenderTask | null = null;
    let pg: PDFPageProxy | null = null;
    let cancelled = false;

    (async () => {
      try {
        const doc = await getPdf(file);
        if (cancelled) return;
        pg = await doc.getPage(page);
        if (cancelled) return;

        const base = pg.getViewport({ scale: 1 });
        // Fixed render width, clamped so width×height stays under Safari's canvas ceiling.
        const maxW = Math.sqrt((MAX_CANVAS_PX * base.width) / base.height);
        const scale = Math.min(RENDER_W, maxW) / base.width;
        const viewport = pg.getViewport({ scale });

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        task = pg.render({ canvas, canvasContext: ctx, viewport });
        await task.promise;
        if (cancelled) return;
        setLoading(false);

        // Box the requested figures: compare digit strings (3+ digits) so "S$3,500" matches the page's
        // "3,500" regardless of currency glyph or spacing. Stored as page fractions so CSS scaling keeps
        // them aligned.
        const wanted = highlightsRef.current.map(digits).filter((d) => d.length >= 3);
        if (wanted.length) {
          const tc = await pg.getTextContent();
          if (cancelled) return;
          const found: Frac[] = [];
          for (const item of tc.items) {
            if (!("str" in item)) continue;
            const d = digits(item.str);
            if (d.length < 3 || !wanted.some((w) => d.includes(w))) continue;
            const [x1, y1] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
            const [x2, y2] = viewport.convertToViewportPoint(item.transform[4] + item.width, item.transform[5] + item.height);
            found.push({
              left: Math.min(x1, x2) / viewport.width,
              top: Math.min(y1, y2) / viewport.height,
              width: Math.abs(x2 - x1) / viewport.width,
              height: Math.abs(y2 - y1) / viewport.height,
            });
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
    };
    // highlights intentionally excluded — read via highlightsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, page]);

  return (
    <div className="pdf-wrap" style={{ position: "relative" }}>
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
          style={{
            position: "absolute",
            left: `${r.left * 100}%`,
            top: `${r.top * 100}%`,
            width: `${r.width * 100}%`,
            height: `${r.height * 100}%`,
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}
