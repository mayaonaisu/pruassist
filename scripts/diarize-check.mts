/**
 * In-person diarization contract check — no microphone, no iPad, no browser.
 *
 *   npm run diarize:check
 *
 * De-risks the whole in-person capture path against the REAL Deepgram streaming API before any UI is
 * built. It synthesises a two-voice dialogue with the built-in Windows TTS (two System.Speech voices),
 * runs each turn's WAV through the SAME production code the browser will use — `createResampler` +
 * `floatTo16BitPCM` from src/lib/pcm.ts — and streams the resulting linear16 frames to Deepgram over a
 * WebSocket with the exact production query string (nova-3 + keyterms + linear16 + `DIARIZE_PARAMS`).
 * Each `is_final` result is attributed with the production `splitRuns` + `attributeFinal`, and the
 * mapped dialogue is printed.
 *
 * This validates, with nothing but Node: the WS URL params, the `token, <key>` subprotocol auth, the
 * linear16 framing, the per-word `speaker` field shape, and our splitter/mapper against real output.
 * Capture its `Results` frames to seed canned fixtures for the offline unit checks.
 *
 * Windows-only (System.Speech for TTS). Needs DEEPGRAM_API_KEY in .env.local. Exits non-zero if the
 * diarizer never distinguished two speakers (the failure the whole design hinges on).
 */
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANONICAL_TERMS } from "../src/lib/terms.ts";
import { createResampler, floatTo16BitPCM } from "../src/lib/pcm.ts";
import { splitRuns, attributeFinal, emptySpeakerMap, DIARIZE_PARAMS, type SpeakerMap } from "../src/lib/diarize.ts";

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) {
  console.error("DEEPGRAM_API_KEY not set. Add it to .env.local (npm run diarize:check loads it).");
  process.exit(1);
}

// Node 22 ships a global WHATWG WebSocket. On anything older, skip rather than fail — the same
// graceful-degrade convention the model-dependent checks use.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  console.log("Global WebSocket unavailable (Node < 22). Skipping diarize:check.");
  process.exit(0);
}

const KEYTERMS = CANONICAL_TERMS.map((t) => `keyterm=${encodeURIComponent(t)}`).join("&");
// The EXACT production streaming URL that src/lib/useDiarizedSpeech.ts will build (WS_BASE + linear16
// + diarization). Kept here so a param drift shows up as a diarize:check failure.
const WS_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&interim_results=true" +
  "&endpointing=400&utterance_end_ms=1200&" + KEYTERMS +
  "&encoding=linear16&sample_rate=16000&channels=1&" + DIARIZE_PARAMS;

// Two distinct built-in voices so the diarizer has two timbres to separate. Apostrophe-free so each
// line survives the PowerShell single-quoted string. The rep speaks first here only as fixture order:
// attribution is now evidence-based (voiceprint + text cues), and with no evidence supplied
// no-evidence attribution with engineReady: false still defaults rep-first, so this contract is unchanged. Voiceprint end-to-end
// is covered separately by `npm run voice:check`.
const DIALOGUE: { voice: string; who: string; text: string }[] = [
  { voice: "Microsoft David Desktop", who: "rep", text: "Thanks for coming in today. I want to walk you through how the PRUShield deductible works before we compare plans." },
  { voice: "Microsoft Zira Desktop", who: "customer", text: "Okay, so does that mean I pay the first part of every hospital bill myself?" },
  { voice: "Microsoft David Desktop", who: "rep", text: "Exactly right. The deductible is the amount you pay each policy year before PRUShield starts to pay." },
  { voice: "Microsoft Zira Desktop", who: "customer", text: "And how is the co-insurance different from that deductible?" },
];

const dir = mkdtempSync(join(tmpdir(), "diarcheck-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function synth(text: string, voice: string, wav: string) {
  const ps =
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `try { $s.SelectVoice('${voice}') } catch {}; $s.Rate = -1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${text}'); $s.Dispose()`;
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
}

// Minimal PCM-WAV reader: find the fmt and data chunks, return mono Float32 at the file's sample rate.
function wavToFloat32(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let off = 12;
  let sampleRate = 0, channels = 1, bits = 16, dataStart = 0, dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataStart = body;
      dataSize = size;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (bits !== 16) throw new Error(`expected 16-bit PCM, got ${bits}-bit`);
  const frames = Math.floor(dataSize / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * channels * 2) / 32768; // channel 0 only
  }
  return { samples, sampleRate };
}

// Build one 16 kHz mono stream: each turn resampled through the production resampler, joined with a
// short silence so the diarizer sees turn boundaries.
function buildStream(): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < DIALOGUE.length; i++) {
    const wav = join(dir, `t${i}.wav`);
    synth(DIALOGUE[i].text, DIALOGUE[i].voice, wav);
    const { samples, sampleRate } = wavToFloat32(readFileSync(wav));
    const rs = createResampler(sampleRate, 16000);
    parts.push(rs.push(samples));
    parts.push(new Float32Array(16000 * 0.4)); // 400 ms silence between turns
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function main() {
  console.log("Synthesising a two-voice dialogue and streaming it to Deepgram (linear16, diarized)…\n");
  const pcmStream = buildStream();

  const seenSpeakers = new Set<number>();
  let map: SpeakerMap = emptySpeakerMap();
  const REP = "Advisor", CUST = "Customer";

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, ["token", KEY!]);

    ws.onopen = async () => {
      // Stream ~100 ms linear16 frames (1600 samples) at real-time pace.
      const FRAME = 1600;
      for (let i = 0; i < pcmStream.length; i += FRAME) {
        const slice = pcmStream.subarray(i, Math.min(i + FRAME, pcmStream.length));
        ws.send(floatTo16BitPCM(slice));
        await sleep(100);
      }
      ws.send(JSON.stringify({ type: "CloseStream" }));
    };

    ws.onmessage = (ev) => {
      let msg: {
        type?: string;
        is_final?: boolean;
        channel?: { alternatives?: { transcript?: string; words?: { word: string; punctuated_word?: string; speaker?: number; start: number; end: number }[] }[] };
      };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type !== "Results" || !msg.is_final) return;
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;
      const runs = splitRuns(alt.words);
      for (const r of runs) seenSpeakers.add(r.speakerIndex);
      const res = attributeFinal(map, runs, null);
      map = res.map;
      for (const line of res.lines) {
        console.log(`  ${line.role === "rep" ? REP : CUST}: ${line.text}`);
      }
    };

    ws.onerror = () => reject(new Error("WebSocket error — check DEEPGRAM_API_KEY and the URL params"));
    ws.onclose = () => resolve();
  });

  console.log(`\nDistinct speaker indices observed: ${[...seenSpeakers].sort().join(", ") || "(none)"}`);
  if (seenSpeakers.size < 2) {
    console.error("FAIL: diarizer did not separate two speakers on this clip.");
    process.exit(1);
  }
  console.log("PASS: two speakers separated and attributed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
