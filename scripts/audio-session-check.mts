/**
 * Audio -> transcription -> suggestion, end to end against a running server (self-contained: inlines
 * the PCM conversion so it runs on any branch).
 *
 *   BASE=https://pruassist.vercel.app node --env-file-if-exists=.env.local ./node_modules/tsx/dist/cli.mjs scripts/audio-session-check.mts
 *
 * Signs in, opens a session, synthesises spoken lines with Windows TTS (two voices), streams each to
 * Deepgram exactly as the app does (nova-3, keyterms, linear16), prints SAID vs HEARD, feeds the
 * transcribed turns to /api/agent/state (comprehension) and the transcribed question to /api/assist
 * (suggestion). Needs DEEPGRAM_API_KEY, REP_USERNAME, REP_PASSWORD. Windows-only for the TTS step.
 */
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_TERMS } from "../src/lib/terms.ts";

const BASE = (process.env.BASE ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) { console.error("DEEPGRAM_API_KEY not set."); process.exit(1); }
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") { console.log("Global WebSocket unavailable (Node < 22)."); process.exit(0); }

const KEYTERMS = CANONICAL_TERMS.map((t) => `keyterm=${encodeURIComponent(t)}`).join("&");
const WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&interim_results=true" +
  "&endpointing=400&utterance_end_ms=1200&" + KEYTERMS + "&encoding=linear16&sample_rate=16000&channels=1";

const dir = mkdtempSync(join(tmpdir(), "audiochk-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- inlined PCM (mirrors src/lib/pcm.ts) ---
function resampleTo16k(samples: Float32Array, inRate: number): Float32Array {
  if (inRate === 16000) return samples;
  const ratio = inRate / 16000;
  const out: number[] = [];
  for (let pos = 0; Math.floor(pos) + 1 < samples.length; pos += ratio) {
    const i = Math.floor(pos), frac = pos - i;
    out.push(samples[i] + (samples[i + 1] - samples[i]) * frac);
  }
  return Float32Array.from(out);
}
function floatTo16BitPCM(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function synth(text: string, voice: string, wav: string) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('${voice}') } catch {}; $s.Rate = -1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${text}'); $s.Dispose()`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
}
function wavToFloat32(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  let off = 12, sampleRate = 0, channels = 1, bits = 16, dataStart = 0, dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") { channels = buf.readUInt16LE(body + 2); sampleRate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    else if (id === "data") { dataStart = body; dataSize = size; }
    off = body + size + (size & 1);
  }
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}`);
  const frames = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768;
  return { samples, sampleRate };
}
async function transcribe(text: string, voice: string): Promise<string> {
  const wav = join(dir, `${Date.now()}.wav`);
  synth(text, voice, wav);
  const { samples, sampleRate } = wavToFloat32(readFileSync(wav));
  const pcm = resampleTo16k(samples, sampleRate);
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, ["token", KEY!]);
    ws.onopen = async () => {
      const FRAME = 1600;
      for (let i = 0; i < pcm.length; i += FRAME) { ws.send(floatTo16BitPCM(pcm.subarray(i, Math.min(i + FRAME, pcm.length)))); await wait(60); }
      ws.send(JSON.stringify({ type: "CloseStream" }));
    };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data as string); if (m.type === "Results" && m.is_final) { const t = m.channel?.alternatives?.[0]?.transcript ?? ""; if (t) out += (out ? " " : "") + t; } } catch { /* ignore */ } };
    ws.onerror = () => reject(new Error("Deepgram WS error"));
    ws.onclose = () => resolve();
  });
  return out.trim();
}

const DIALOGUE = [
  { role: "rep", voice: "Microsoft David Desktop", text: "With PRUShield, you pay a fixed yearly deductible on your hospital bill before the plan starts to pay anything." },
  { role: "customer", voice: "Microsoft Zira Desktop", text: "Okay, yeah, that makes sense." },
] as const;
const QUESTION = { voice: "Microsoft Zira Desktop", text: "Do I still need PRUShield if I already have MediShield Life?" };

async function main() {
  const login = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: process.env.REP_USERNAME, password: process.env.REP_PASSWORD }) });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) { console.error(`Could not sign in at ${BASE} (status ${login.status}).`); process.exit(1); }
  const H = { "Content-Type": "application/json", cookie };
  const created = await (await fetch(`${BASE}/api/session`, { method: "POST", headers: H, body: JSON.stringify({ repName: "Bryan Eng", productArea: "Health Protection", focus: ["Hospital cover"] }) })).json();
  const roomId = created.roomId as string;
  console.log(`Session ${roomId} on ${BASE}\n`);

  console.log("── Transcription (synthesised speech → Deepgram) ──");
  const now = Date.now();
  const turns: { at: number; role: string; speaker: string; text: string }[] = [];
  for (let i = 0; i < DIALOGUE.length; i++) {
    const d = DIALOGUE[i];
    const heard = await transcribe(d.text, d.voice);
    console.log(`  ${d.role.toUpperCase()}\n    said : ${d.text}\n    heard: ${heard || "(nothing)"}`);
    turns.push({ at: now + i * 1000, role: d.role, speaker: d.role === "rep" ? "Bryan Eng" : "Customer", text: heard || d.text });
  }

  console.log("\n── Comprehension (/api/agent/state) ──");
  await (await fetch(`${BASE}/api/agent/state`, { method: "POST", headers: H, body: JSON.stringify({ roomId, turns, final: true }) })).json();
  let state: { alert?: { headline: string; kind: string; teachBack?: string; citations?: string[] }; record?: { conceptId: string; state: string }[] } = {};
  for (const ms of [3000, 4000, 5000, 6000, 8000]) { await wait(ms); state = await (await fetch(`${BASE}/api/agent/state?roomId=${encodeURIComponent(roomId)}`, { headers: H })).json(); if (state.alert) break; }
  if (state.alert) { console.log(`  ▲ ${state.alert.headline}  (${state.alert.kind})`); if (state.alert.teachBack) console.log(`    Ask: ${state.alert.teachBack}`); if (state.alert.citations?.length) console.log(`    Cited: ${state.alert.citations.join(" · ")}`); }
  else console.log("  (no alert produced)");
  console.log(`  record: ${(state.record ?? []).filter((r) => r.state !== "unseen").map((r) => `${r.conceptId}=${r.state}`).join(", ") || "(none touched)"}`);

  console.log("\n── Suggestion (/api/assist) ──");
  const asked = await transcribe(QUESTION.text, QUESTION.voice);
  console.log(`  question said : ${QUESTION.text}\n  question heard: ${asked || "(nothing)"}`);
  const s = await (await fetch(`${BASE}/api/assist`, { method: "POST", headers: H, body: JSON.stringify({ roomId, transcript: `Bryan Eng: Let me help with that.\nCustomer: ${asked}`, asked }) })).json().catch(() => ({ note: "non-JSON" }));
  console.log(`  mode: ${s.mode ?? "(none)"}${s.cached ? " · cached" : ""}`);
  if (s.suggestedLine) console.log(`  say : "${s.suggestedLine}"`);
  if (s.note) console.log(`  note: ${s.note}`);
  if (s.unsupportedFigures?.length) console.log(`  ⚠ ungrounded figures: ${s.unsupportedFigures.join(", ")}`);
  console.log(`  grounded in: ${(s.sources ?? []).map((x: { source: string }) => x.source).join(" · ") || "(none)"}`);

  await fetch(`${BASE}/api/session/end`, { method: "POST", headers: H, body: JSON.stringify({ roomId }) });
  console.log("\nSession ended.");
}
main().catch((e) => { console.error(e); process.exit(1); });
