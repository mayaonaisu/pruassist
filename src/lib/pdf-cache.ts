import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

// A tiny LRU of opened PDFs, shared across PdfPage instances so switching pages in one brochure never
// re-downloads or re-parses it. Browser-only (pdfjs touches the DOM/worker), so it is never imported
// on the server — the whiteboard is loaded with next/dynamic({ ssr: false }).

// iPadOS 17 Safari lacks Promise.withResolvers, which pdfjs 6 uses internally. Polyfill it before the
// library runs.
type WithResolvers = <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (r?: unknown) => void };
const P = Promise as unknown as { withResolvers?: WithResolvers };
if (typeof P.withResolvers !== "function") {
  P.withResolvers = function <T>() {
    let resolve!: (v: T | PromiseLike<T>) => void;
    let reject!: (r?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Next 16 / Turbopack: resolve the worker as a URL relative to this module, so its version always
// matches the installed pdfjs (a mismatch is the classic "API version does not match Worker version"
// crash). Set once at module scope.
GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();

// At most two documents decoded at once (the session brochure, plus maybe one tapped source), so the
// iPad never holds all ~11 MB of brochures in memory. The oldest is destroyed when a third opens.
const MAX = 2;
// The loading task is cached rather than the document proxy: pdfjs 6 exposes destroy() on the task
// (it also tears down the worker transport), not on the proxy.
const cache = new Map<string, PDFDocumentLoadingTask>();

export function getPdf(file: string): Promise<PDFDocumentProxy> {
  const hit = cache.get(file);
  if (hit) {
    // Touch it so it becomes the most-recently-used.
    cache.delete(file);
    cache.set(file, hit);
    return hit.promise;
  }
  // wasmUrl points at the pdfjs runtime wasm (OpenJPEG/JBIG2/QCMS) copied into public/pdfjs/wasm. The
  // brochures embed JPEG2000 images; without it those images fail to decode and the render stalls.
  const task = getDocument({ url: file, wasmUrl: "/pdfjs/wasm/" });
  cache.set(file, task);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    releasePdf(oldest);
  }
  return task.promise;
}

// Pre-open a document the board is about to need (the session's product brochure), so the first page
// renders without a download wait. Errors are swallowed — it is a hint, not a load-bearing call.
export function warmPdf(file: string): void {
  void getPdf(file).catch(() => {});
}

export function releasePdf(file: string): void {
  const task = cache.get(file);
  cache.delete(file);
  task?.destroy().catch(() => {});
}
