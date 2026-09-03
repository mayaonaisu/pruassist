// Copy onnxruntime-web's WASM runtime files into public/ort/ so the browser can fetch them by URL.
// ORT resolves ort.env.wasm.wasmPaths ("/ort/") at RUNTIME, not through the bundler, so the .wasm/.mjs
// files have to be served as static assets. Runs on `postinstall`; the copies are regenerated, so
// public/ort/ is gitignored. Same pattern as the pdf.js worker/wasm assets under public/pdfjs/.
import { mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dest = join(root, "public", "ort");

if (!existsSync(src)) {
  console.warn("[copy-ort-wasm] onnxruntime-web not installed yet; skipping.");
  process.exit(0);
}

mkdirSync(dest, { recursive: true });

// The single-threaded SIMD build (+ its loader) is what we run: numThreads = 1, no COOP/COEP, so no
// SharedArrayBuffer. Copy the whole ort-wasm-simd-threaded.* family so ORT finds whichever variant its
// loader asks for.
const wanted = /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/;
let n = 0;
for (const f of readdirSync(src)) {
  if (wanted.test(f)) {
    copyFileSync(join(src, f), join(dest, f));
    n++;
  }
}
console.log(`[copy-ort-wasm] copied ${n} onnxruntime-web wasm file(s) to public/ort/`);
