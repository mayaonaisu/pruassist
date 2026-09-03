import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // The committed brochure PDFs the sharing-mode whiteboard renders. Their filenames carry the
        // edition, so a new edition ships as a new filename rather than a mutated file — a far-future
        // immutable cache is safe and keeps the iPad from re-fetching ~11 MB on every session.
        source: "/docs/:file*.pdf",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // The on-device speaker-verification model (~8 MB) and onnxruntime-web's WASM runtime
        // (~10 MB). Both are versioned by filename and never mutated in place, so cache them
        // immutably — the iPad fetches each once, not per session.
        source: "/models/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/ort/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
