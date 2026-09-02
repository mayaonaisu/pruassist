"use client";

// The page-side fallback when there is no brochure page to render: a web-sourced clause (prudential.com.sg
// cannot be iframed, so we link out), a custom knowledge-base clause, or a brochure page that failed to
// render. Shows only customer-safe text — document name, pages, and the clause text(s).

type Props = {
  doc: string;
  pages?: number[];
  url?: string;
  excerpts: { text: string }[];
  note?: string;
};

export default function ExcerptCard({ doc, pages, url, excerpts, note }: Props) {
  return (
    <div className="excerpt-card">
      <div className="excerpt-eyebrow">
        {doc}
        {pages && pages.length ? ` · ${pages.map((p) => `p.${p}`).join(", ")}` : ""}
      </div>
      {note && <div className="excerpt-note">{note}</div>}
      {excerpts.map((e, i) => (
        <p key={i} className="excerpt-text">
          {e.text}
        </p>
      ))}
      {url && (
        <a className="excerpt-link" href={url} target="_blank" rel="noopener noreferrer">
          Open on prudential.com.sg ↗
        </a>
      )}
    </div>
  );
}
