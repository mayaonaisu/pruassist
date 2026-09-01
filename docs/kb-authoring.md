# Adding a product document to the knowledge base

PRUAssist only ever cites clauses that exist in `src/lib/knowledge.ts`. There is no PDF ingestion at
runtime and no vector database of raw documents — every fact the assistant can say is a hand-authored
clause with a page citation. Adding a new product (for example a brochure from Nikole) means turning
that brochure into clause entries. This is the repeatable workflow.

## 1. Extract the text with page numbers

```bash
pdftotext -layout brochure.pdf brochure.txt
```

- `-layout` preserves columns and tables, which matters for figures.
- The output is split by form-feed characters (`\f`), one per page. Splitting on `\f` gives you
  page 1, page 2, and so on **in order**, which is how you get accurate `p.N` citations.
- Do not rely on `WebFetch` for these brochures — it returns the binary and cannot parse them.
- `pdftoppm` (PDF → image, for OCR or visual checks) is **not installed** on this machine, so there
  is no image/OCR fallback. The text layer from `pdftotext` is the source of truth.

## 2. Author the clauses

Each clause is a `Clause = { id, source, text }` in the `KNOWLEDGE` array:

- **`id`** — a stable kebab-case anchor (e.g. `pruextra-deductible-coverage`). Concepts and decisions
  reference clauses by this id, so once one is in use, do not rename it casually.
- **`source`** — the format is load-bearing. Use `"<Document Name> · p.N"` (or `· p.N, p.M`). Two
  functions parse it: `knowledgeDocuments()` splits on `" · "` to get the document name, and
  `knowledgeIndex()` harvests every `p.<number>` to compute the page span shown in the UI. A wrong
  separator hides the document from the console.
- **`text`** — self-contained, with figures written exactly as printed in the brochure. The
  deterministic grounding check compares figures in the generated line against the clause text, so a
  paraphrased number will get flagged as unsupported.

## 3. Register the document's advisory area

The document-name prefix in `source` must match a key in `DOCUMENT_AREA` (top of `knowledge.ts`), or
the product never appears in `productAreas()` and the rep cannot pick it. These names are already
registered, so matching them exactly means **no code change beyond the clauses**:

- `PRUActive Protect Brochure` → Critical Illness
- `PRUPersonal Accident Brochure` → Personal Accident
- `PRUActive Term Brochure` → Term Life
- `PRUActive Retirement II Brochure` → Retirement

For a genuinely new area, add a `DOCUMENT_AREA` entry too.

## 4. (Optional) Author concepts and decisions

To get comprehension tracking and comparisons for the new product, add:

- `Concept` entries in `src/lib/concepts.ts`, anchored to the new clause ids (`clauseIds`).
- `Decision` entries in `src/lib/decisions.ts`, whose options' `clauseIds` and whose
  `prerequisites`/`differentiators` reference real clauses and concepts.

Both files fail loudly at import if they cite an id that does not exist
(`concepts.ts` and `decisions.ts` each throw on a dangling reference), so a typo surfaces immediately
rather than at runtime.

## 5. Add the spoken forms to the term-correction map

The browser transcriber mangles product names it has never heard. When you add a product, add its
mis-heard spellings to `CANONICAL` in `src/lib/terms.ts` (e.g. `"pru active protect"` →
`"PRUActive Protect"`), so the transcript and everything downstream see the canonical name.

## 6. Verify

```bash
npm run check          # integrity + unit checks (throws if a citation is dangling)
npm run replay:all     # only needed if you added or changed concepts
```

The `DocumentsInScope` component lists every document automatically from `knowledgeIndex()` — the new
brochure, its clause count, and its page span appear on the Intro and Consent steps with no UI change.
