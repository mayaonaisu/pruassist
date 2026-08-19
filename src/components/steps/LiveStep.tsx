"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import "@livekit/components-styles";
import { useBrowserSpeech } from "@/lib/useBrowserSpeech";
import { useLocalMedia, type DeviceStatus } from "@/lib/useLocalMedia";
import type { SessionInfo, Stats } from "@/lib/console-types";

type Line = { id: string; speaker: string; text: string; flag?: boolean };
type Src = { source: string; snippet: string };
type Pointers = {
  concern: string;
  firstStep: string;
  suggestedLine: string;
  explainer: string;
  comparison: string;
  followUp: string;
  sources: Src[];
};

function looksLikeQuestion(text: string): boolean {
  const s = text.trim().toLowerCase();
  if (s.split(/\s+/).length < 3) return false;
  if (s.includes("?")) return true;
  return /\b(why|what|whats|how|when|which|who|where|do i|can i|could i|should i|is it|are there|difference|cover|covered|exclud|deductible|insurance|rider|add[- ]?on|claim|premium|expensive|cost|afford|worried|confus|not sure|understand|mean|need)\b/.test(s);
}

export default function LiveStep({
  repName,
  session,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number) => void;
}) {
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/token?room=${encodeURIComponent(session.roomId)}&username=${encodeURIComponent(repName)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to connect.");
        if (!cancelled) setToken(data.token);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.roomId, repName]);

  if (!serverUrl) return <div className="notice bad">NEXT_PUBLIC_LIVEKIT_URL is not set in .env.local.</div>;
  if (error) return <div className="notice bad">{error}</div>;
  if (!token) return <div className="notice">Connecting to the secure room…</div>;

  return (
    <LiveKitRoom token={token} serverUrl={serverUrl} connect audio video>
      <RoomAudioRenderer />
      <LiveConsole repName={repName} session={session} onEnd={onEnd} />
    </LiveKitRoom>
  );
}

/* The two faces, in one short row. Remote participants come first — the rep is looking at the
   customer, not at themselves — and the rep's own tile carries the device controls. */
function Faces({ media }: { media: ReturnType<typeof useLocalMedia> }) {
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const local = tracks.find((t) => t.participant.isLocal);
  const remotes = tracks.filter((t) => !t.participant.isLocal);

  return (
    <div className="cams" data-lk-theme="default">
      {remotes.length === 0 ? (
        <div className="cam">
          <div className="cam-face">waiting for the customer…</div>
          <span className="cam-tag">CUSTOMER</span>
        </div>
      ) : (
        remotes.map((t) => (
          <div className="cam" key={t.participant.sid}>
            <ParticipantTile trackRef={t} />
            <span className="cam-tag">CUSTOMER</span>
            <span className="cam-nm">
              <span className="sp" />
              {t.participant.name || t.participant.identity}
            </span>
          </div>
        ))
      )}

      <div className="cam me">
        {local ? <ParticipantTile trackRef={local} /> : <div className="cam-face">camera off</div>}
        <span className="cam-tag">YOU</span>
        {/* A failed camera must not read as a camera the rep chose to turn off — that was the
            whole point of surfacing device failures, so it gets its own label and colour. */}
        {isBroken(media.cam) && <span className="cam-bad">{CAM_LABEL[media.cam].text.toUpperCase()}</span>}
        <span className="cam-ctl">
          <button
            type="button"
            className={deviceClass(media.mic)}
            onClick={media.toggleMic}
            title={MIC_LABEL[media.mic].hint}
            aria-label={MIC_LABEL[media.mic].hint}
          >
            <IconMic off={media.mic !== "on"} />
          </button>
          <button
            type="button"
            className={deviceClass(media.cam)}
            onClick={media.toggleCam}
            title={CAM_LABEL[media.cam].hint}
            aria-label={CAM_LABEL[media.cam].hint}
          >
            <IconCam off={media.cam !== "on"} />
          </button>
        </span>
      </div>
    </div>
  );
}

function IconMic({ off }: { off?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}
function IconCam({ off }: { off?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="m15 10 6-3.5v11L15 14" />
      {off && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

const isBroken = (s: DeviceStatus) => s === "missing" || s === "blocked";
const deviceClass = (s: DeviceStatus) => (isBroken(s) ? "bad" : s === "off" ? "off" : "");

const BUCKETS = 16;

// Isolated so the ticking clock re-renders a <span>, not the whole console every second.
function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <>{`${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`}</>;
}

function LiveConsole({
  repName,
  session,
  onEnd,
}: {
  repName: string;
  session: SessionInfo;
  onEnd: (transcript: string, stats: Stats, durationMin: number) => void;
}) {
  const room = useRoomContext();
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState<{ name: string; consentedAt: string } | null>(null);
  const [result, setResult] = useState<Pointers | null>(null);
  const [note, setNote] = useState<string>();
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [copied, setCopied] = useState(false);
  const [startedAt, setStartedAt] = useState(0);

  const idRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<Line[]>([]);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerRef = useRef("");
  const startRef = useRef(0);
  const statsRef = useRef<Stats>({ surfaced: 0, used: 0, flags: 0, docs: 0 });
  const docsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    startRef.current = Date.now();
    setStartedAt(startRef.current);
  }, []);

  const addFinal = useCallback((speaker: string, text: string, flag = false) => {
    if (!text.trim()) return;
    setLines((prev) => [...prev.slice(-200), { id: `${Date.now()}-${idRef.current++}`, speaker, text: text.trim(), flag }]);
    setInterim((prev) => ({ ...prev, [speaker]: "" }));
  }, []);
  const setSpeakerInterim = useCallback((speaker: string, text: string) => {
    setInterim((prev) => ({ ...prev, [speaker]: text }));
  }, []);

  const media = useLocalMedia(room);
  const micEnabled = media.mic === "on";

  // Transcribe the rep's own speech only while their mic is live. Muting the mic must also pause
  // transcription — otherwise "Mute" silences the customer's audio but the transcript (and the AI)
  // keep capturing the rep's words.
  const speech = useBrowserSpeech(micEnabled, ({ final, interim: itm }) => {
    if (final) addFinal(repName, final);
    if (itm) setSpeakerInterim(repName, itm);
  });

  useEffect(() => {
    if (!room) return;
    const handler = (payload: Uint8Array) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.type === "transcript") {
          const speaker = msg.name || msg.role || "Customer";
          if (msg.final) addFinal(speaker, msg.final, looksLikeQuestion(msg.final));
          else if (msg.interim != null) setSpeakerInterim(speaker, msg.interim);
        }
      } catch {
        /* ignore */
      }
    };
    room.on(RoomEvent.DataReceived, handler);
    return () => {
      room.off(RoomEvent.DataReceived, handler);
    };
  }, [room, addFinal, setSpeakerInterim]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/consent?room=${encodeURIComponent(session.roomId)}`);
        const data = await res.json();
        if (active) setConsent(data.consent);
      } catch {
        /* ignore */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [session.roomId]);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [lines, interim]);

  // `rephrase` re-runs the same question to get different wording. It replaces the current
  // pointers rather than adding new ones, so it must not count again — otherwise a rep who
  // rewords one question three times books it as three confusion flags in the session stats.
  const runSuggest = useCallback(async ({ rephrase = false }: { rephrase?: boolean } = {}) => {
    if (inFlightRef.current) return;
    const transcript = linesRef.current.slice(-12).map((l) => `${l.speaker}: ${l.text}`).join("\n");
    if (!transcript) {
      setNote("No transcript yet — once the conversation starts, pointers appear here.");
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    setNote(undefined);
    try {
      const res = await fetch("/api/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (data.note) {
        setNote(data.note);
      } else {
        const r: Pointers = {
          concern: data.concern || "",
          firstStep: data.firstStep || "",
          suggestedLine: data.suggestedLine || "",
          explainer: data.explainer || "",
          comparison: data.comparison || "",
          followUp: data.followUp || "",
          sources: Array.isArray(data.sources) ? data.sources : [],
        };
        setResult(r);
        setUsed(new Set());
        setOpenKey(null);
        if (!rephrase) {
          // One pointer = one line offered. Counting the six fields separately made the brief
          // read "surfaced 24, used 3", because only the line itself can be marked as said.
          if (r.suggestedLine) statsRef.current.surfaced += 1;
          if (r.concern) statsRef.current.flags += 1;
        }
        r.sources.forEach((s) => docsRef.current.add(s.source));
      }
    } catch {
      setNote("Could not reach the AI service.");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auto) return;
    const last = lines[lines.length - 1];
    if (!last || last.speaker === repName) return;
    if (lastTriggerRef.current === last.id || !looksLikeQuestion(last.text)) return;
    lastTriggerRef.current = last.id;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSuggest(), 1400);
  }, [lines, auto, repName, runSuggest]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const markUsed = (key: string) => {
    if (used.has(key)) return;
    setUsed((prev) => new Set(prev).add(key));
    statsRef.current.used += 1;
  };

  const end = () => {
    const transcript = linesRef.current.map((l) => `${l.speaker}: ${l.text}`).join("\n");
    const dur = Math.max(1, Math.round((Date.now() - startRef.current) / 60000));
    onEnd(transcript, { ...statsRef.current, docs: docsRef.current.size }, dur);
  };

  const joinUrl = typeof window !== "undefined" ? window.location.origin + session.joinPath : session.joinPath;
  const copy = () => {
    navigator.clipboard?.writeText(joinUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // The confusion timeline is derived from the flags already on the transcript — it never
  // invents a signal the transcript doesn't carry.
  const { bars, flagCount } = useMemo(() => {
    const out = new Array(BUCKETS).fill(0) as number[];
    let flags = 0;
    lines.forEach((l, i) => {
      if (!l.flag) return;
      flags += 1;
      out[Math.min(BUCKETS - 1, Math.floor((i / Math.max(1, lines.length)) * BUCKETS))] += 1;
    });
    return { bars: out, flagCount: flags };
  }, [lines]);

  // While the rep is muted, drop their half-captured phrase so no stale "live" text lingers.
  const visibleInterim = micEnabled ? interim : { ...interim, [repName]: "" };

  // The camera can fail the same two ways the mic can, and the rep needs telling either way —
  // the tile badge is easy to miss while they're looking at the customer.
  const camAlert = isBroken(media.cam) ? `${CAM_LABEL[media.cam].hint} The call and your audio are unaffected.` : null;

  const micAlert =
    media.mic === "missing"
      ? "No microphone detected. Your speech won’t be transcribed. Enable a mic in your OS sound settings, then click the mic button to retry."
      : media.mic === "blocked"
        ? "Your browser is blocking microphone access, so your speech won’t be transcribed. Allow the microphone for this site (padlock in the address bar), then reload."
        : speech === "unsupported"
          ? "Live transcription needs Chrome or Edge. The call works normally here, but your speech won’t appear in the transcript."
          : speech === "denied"
            ? "Speech recognition was blocked by the browser, so your side of the conversation won’t be transcribed. Allow microphone access and reload."
            : null;

  // Supporting material — everything that is not the line itself, collapsed to one row each.
  const support = result
    ? ([
        { key: "firstStep", label: "Do first", text: result.firstStep },
        { key: "explainer", label: "Explainer", text: result.explainer },
        { key: "comparison", label: "Compare", text: result.comparison },
        { key: "followUp", label: "Ask next", text: result.followUp },
      ] as const).filter((r) => r.text)
    : [];

  return (
    <div className="pru-live">
      <div className="c-rail">
        <span className="rec">
          <span className="pru-rec-dot" />
          REC
        </span>
        <span className="c-t">{startedAt ? <Elapsed startedAt={startedAt} /> : "00:00"}</span>
        <span className="c-ctx">
          {session.productArea} · <b>{consent ? consent.name : "awaiting customer"}</b>
        </span>
        <span className="c-r">
          <button className="pru-btn pru-btn-sm" onClick={copy}>
            {copied ? "✓ Link copied" : "Copy customer link"}
          </button>
          <button
            className={`pru-chip ${auto ? "on" : ""}`}
            style={{ padding: "6px 11px", fontSize: 12 }}
            aria-pressed={auto}
            onClick={() => setAuto((a) => !a)}
          >
            {auto ? "Auto-suggest on" : "Auto-suggest off"}
          </button>
          <button className="btn-end" onClick={end}>
            End session
          </button>
        </span>
      </div>

      {(micAlert || camAlert) && (
        <div role="status" className="notice" style={{ flex: "none" }}>
          {[micAlert, camAlert].filter(Boolean).join(" ")}
        </div>
      )}

      <div className="c-top">
        <Faces media={media} />
        <div className="c-meta">
          <div className="strip-h">Where they lost the thread</div>
          <div className="bars">
            {bars.map((n, i) => (
              <span
                key={i}
                className={n >= 2 ? "hi" : n === 1 ? "mid" : ""}
                style={{ height: `${Math.min(92, 16 + n * 34)}%` }}
              />
            ))}
          </div>
          <div className="strip-legend">
            <span>00:00</span>
            <span>
              <b>
                {flagCount} {flagCount === 1 ? "flag" : "flags"}
              </b>
            </span>
            <span>now</span>
          </div>
        </div>
      </div>

      {/* THE LINE — the one thing the rep reads while looking at a customer. */}
      <div className="line-block">
        {loading && !result ? (
          <>
            <div className="pru-skeleton" style={{ height: 12, width: "30%", marginBottom: 12 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "92%", marginBottom: 8 }} />
            <div className="pru-skeleton" style={{ height: 22, width: "64%" }} />
          </>
        ) : !result ? (
          <>
            <div className="lb-head">
              <span className="cat">Listening</span>
            </div>
            <div className="concern">
              {note ??
                "When the customer asks something, the line to say appears here — grounded in the policy documents, with the page it came from."}
            </div>
          </>
        ) : (
          <div className="pru-enter">
            <div className="lb-head">
              <span className="cat">Detected confusion</span>
              <span className="conf">{result.sources.length} cited</span>
            </div>
            {result.concern && <div className="concern">{result.concern}</div>}
            <div className="say-wrap">
              <div className="say">
                <span className="q">“</span>
                {result.suggestedLine}
                <span className="q">”</span>
              </div>
              <div className="cite">
                <b>Grounded in</b>
                {result.sources.length ? (
                  result.sources.map((s, i) => <span key={i}>{s.source}</span>)
                ) : (
                  <span>no source returned</span>
                )}
              </div>
            </div>
            <div className="say-actions">
              <button className="said" onClick={() => markUsed("line")} disabled={used.has("line")}>
                {used.has("line") ? "✓ Said it" : "Said it"}
              </button>
              <button className="ghost" onClick={() => runSuggest({ rephrase: true })} disabled={loading}>
                Say it simpler
              </button>
              <button className="ghost" onClick={() => setResult(null)}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="c-bot">
        <div className="pane sup">
          <div className="deck-h">If you need more</div>
          <div className="sup-body pru-scroll">
            {support.length === 0 ? (
              <p className="pru-muted" style={{ fontSize: 12 }}>
                Supporting material appears with the next pointer.
              </p>
            ) : (
              support.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`sup-row ${openKey === r.key ? "open" : ""}`}
                  aria-expanded={openKey === r.key}
                  onClick={() => setOpenKey((k) => (k === r.key ? null : r.key))}
                >
                  <span className="k">{r.label}</span>
                  <span className="v">{r.text}</span>
                  <span className="x">{openKey === r.key ? "−" : "+"}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="pane tr">
          <div className="deck-h">
            Transcript{media.mic === "off" ? " · paused" : consent ? "" : " · awaiting consent"}
          </div>
          <div ref={feedRef} className="tr-body">
            {lines.length === 0 && Object.values(visibleInterim).every((v) => !v) && (
              <p className="pru-muted" style={{ fontSize: 12 }}>
                Appears here as you and the customer speak.
              </p>
            )}
            {lines.slice(-12).map((l) => (
              <div key={l.id} className={`tr-line ${l.speaker === repName ? "" : "cust"}`}>
                <span className="who">{l.speaker === repName ? "YOU" : l.speaker.toUpperCase()}</span>
                {l.flag ? <span className="mark">{l.text}</span> : l.text}
              </div>
            ))}
            {Object.entries(visibleInterim).map(([sp, txt]) =>
              txt ? (
                <div key={"i-" + sp} className="tr-line now">
                  <span className="who">{sp === repName ? "YOU · LIVE" : sp.toUpperCase()}</span>
                  {txt}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const MIC_LABEL: Record<DeviceStatus, { text: string; hint: string }> = {
  on: { text: "Mic", hint: "Mute microphone" },
  off: { text: "Muted", hint: "Unmute microphone" },
  missing: { text: "No microphone", hint: "No microphone detected. Check your OS sound settings, then click to retry." },
  blocked: { text: "Mic blocked", hint: "The browser is blocking the microphone. Allow it for this site in the address bar, then reload." },
};

const CAM_LABEL: Record<DeviceStatus, { text: string; hint: string }> = {
  on: { text: "Camera", hint: "Turn camera off" },
  off: { text: "Camera off", hint: "Turn camera on" },
  missing: { text: "No camera", hint: "No camera detected. Check your OS settings, then click to retry." },
  blocked: { text: "Camera blocked", hint: "The browser is blocking the camera. Allow it for this site in the address bar, then reload." },
};
