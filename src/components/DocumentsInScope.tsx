import { knowledgeIndex } from "@/lib/knowledge";

// One rendering of "what the retriever can actually cite", shared by the readiness screen and
// the consent screen — they showed the same rows with only the heading differing.
export default function DocumentsInScope({ title }: { title: string }) {
  return (
    <div className="srcs">
      <div className="sec-h">{title}</div>
      {knowledgeIndex().map((d) => (
        <div className="src" key={d.doc}>
          <span className="nm">{d.doc}</span>
          <span className="pg">
            {d.clauses} {d.clauses === 1 ? "clause" : "clauses"} · {d.pages}
          </span>
          <span className="st">INDEXED</span>
        </div>
      ))}
    </div>
  );
}
