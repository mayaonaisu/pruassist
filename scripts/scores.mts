/**
 * Threshold tuning aid. Prints the raw similarity of one utterance against a concept's canonical
 * statement and each of its misconceptions, in whichever mode is available.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/scores.mts <concept-id> "utterance"
 *
 * The floors in signals.ts are the only thing standing between the rep and a stream of false
 * alarms, so they are set from numbers printed here rather than from intuition.
 */

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const [id, utterance] = process.argv.slice(2);
if (!id || !utterance) {
  console.error('usage: scores.mts <concept-id> "utterance"');
  process.exit(1);
}

const { conceptById } = await import("../src/lib/concepts.ts");
const { cosine, embedForSimilarity, lexicalSimilarity } = await import("../src/lib/retrieval.ts");

const c = conceptById(id);
if (!c) {
  console.error(`no concept "${id}"`);
  process.exit(1);
}

const targets = [c.canonical, ...c.misconceptions];
const texts = [utterance, ...targets];
// Mode is decided by what actually came back, exactly as signals.ts decides it.
const vecs = await embedForSimilarity(texts);
const vectorMode = vecs.every(Boolean);
let score: (a: string, b: string) => number = lexicalSimilarity;

if (vectorMode) {
  const byText = new Map(texts.map((t, i) => [t, vecs[i]]));
  score = (a, b) => {
    const va = byText.get(a);
    const vb = byText.get(b);
    return va && vb ? cosine(va, vb) : lexicalSimilarity(a, b);
  };
}

console.log(`${vectorMode ? "cosine" : "jaccard"} · ${c.label}\n"${utterance}"\n`);
const rows = targets.map((t, i) => ({ kind: i === 0 ? "CANONICAL" : `misconception ${i}`, t, s: score(utterance, t) }));
for (const r of rows.sort((a, b) => b.s - a.s)) {
  console.log(`  ${r.s.toFixed(4)}  ${r.kind.padEnd(16)} ${r.t.slice(0, 78)}`);
}
const top = rows[0];
const second = rows[1];
console.log(`\n  margin ${(top.s - second.s).toFixed(4)} · winner ${top.kind}`);
