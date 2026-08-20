import { knowledgeIndex } from "@/lib/knowledge";

// Shared by the readiness and consent screens, which rendered identical rows.
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
