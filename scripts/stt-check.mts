/**
 * STT accuracy check for Prudential brand terms — no microphone needed.
 *
 *   npm run stt:check
 *
 * Synthesises test sentences with the built-in Windows TTS (System.Speech, free and offline), sends
 * each to Deepgram three ways, and reports how many brand terms survive:
 *   1. plain            — no keyterms (the accuracy floor, ~ what a generic recognizer gives)
 *   2. keyterm boosting — Deepgram nova-3 with the app's brand vocabulary boosted at decode time
 *   3. + fixTerms       — plus the correction layer, i.e. exactly what the app shows the rep
 *
 * Windows-only (uses PowerShell/System.Speech for TTS). Needs DEEPGRAM_API_KEY in .env.local.
 * A robotic TTS voice is a conservative floor — a real human voice generally does better.
 */
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_TERMS, fixTerms } from "../src/lib/terms.ts";

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) {
  console.error("DEEPGRAM_API_KEY not set. Add it to .env.local (npm run stt:check loads it).");
  process.exit(1);
}

const KEYTERM_QS = CANONICAL_TERMS.map((t) => `keyterm=${encodeURIComponent(t)}`).join("&");

// Apostrophe-free so each survives the PowerShell single-quoted string. `expect` lists the brand
// terms the transcript should contain.
const CASES = [
  { text: "I already have MediShield Life, so why do I need PRUShield on top of it?", expect: ["MediShield Life", "PRUShield"] },
  { text: "What is the difference between PRUShield Premier and PRUShield Standard?", expect: ["PRUShield Premier", "PRUShield Standard"] },
  { text: "Is PRUExtra Preferred Care worth it if I use PRUPanel Connect providers?", expect: ["PRUExtra Preferred Care", "PRUPanel Connect"] },
  { text: "Can I pay the PRUExtra premium from my MediSave account?", expect: ["PRUExtra", "MediSave"] },
  { text: "Tell me about PRUActive Retirement II and how the deductible and co-insurance work.", expect: ["PRUActive Retirement II", "deductible", "co-insurance"] },
];

const dir = mkdtempSync(join(tmpdir(), "sttcheck-"));

function synth(text: string, wav: string) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${text}'); $s.Dispose()`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
}

async function transcribe(wav: string, withKeyterms: boolean): Promise<string> {
  const url = `https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true${withKeyterms ? "&" + KEYTERM_QS : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${KEY}`, "Content-Type": "audio/wav" },
    body: readFileSync(wav),
  });
  const data = await res.json();
  if (!res.ok) return `<HTTP ${res.status}: ${JSON.stringify(data).slice(0, 120)}>`;
  return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "<no transcript>";
}

const hits = (transcript: string, expect: string[]) => expect.filter((t) => transcript.toLowerCase().includes(t.toLowerCase()));

let baseTotal = 0, boostTotal = 0, appTotal = 0, expectTotal = 0;

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const wav = join(dir, `c${i}.wav`);
  synth(c.text, wav);
  const base = await transcribe(wav, false);
  const boost = await transcribe(wav, true);
  const app = fixTerms(boost);
  const bh = hits(base, c.expect), gh = hits(boost, c.expect), ah = hits(app, c.expect);
  baseTotal += bh.length; boostTotal += gh.length; appTotal += ah.length; expectTotal += c.expect.length;

  console.log(`\n[${i + 1}] SAID:      ${c.text}`);
  console.log(`    expect:    ${c.expect.join(" | ")}`);
  console.log(`    plain:     ${base}   [${bh.length}/${c.expect.length}]`);
  console.log(`    boosted:   ${boost}   [${gh.length}/${c.expect.length}]`);
  console.log(`    +fixTerms: ${app}   [${ah.length}/${c.expect.length}]`);
}

console.log(`\n=== brand terms recognized (of ${expectTotal}) ===`);
console.log(`  plain, no keyterms:            ${baseTotal}/${expectTotal}`);
console.log(`  Deepgram keyterm boosting:     ${boostTotal}/${expectTotal}`);
console.log(`  keyterm + fixTerms (the app):  ${appTotal}/${expectTotal}`);
