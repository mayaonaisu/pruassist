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
    ];
  },
};

export default nextConfig;
