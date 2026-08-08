"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveKitRoom,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import "@livekit/components-styles";
import { useBrowserSpeech } from "@/lib/useBrowserSpeech";
import type { SessionInfo, Stats } from "@/lib/console-types";
import { IconLayers, IconSparkle, IconWave } from "../icons";

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

  if (!serverUrl) return <div className="pru-card">NEXT_PUBLIC_LIVEKIT_URL is not set in .env.local.</div>;
  if (error) return <div className="pru-card" style={{ color: "var(--pru-red)" }}>{error}</div>;
  if (!token) return <div className="pru-card">Connecting to the secure room…</div>;

  return (
    <LiveKitRoom token={token} serverUrl={serverUrl} connect audio video>
      <RoomAudioRenderer />
      <LiveConsole repName={repName} session={session} onEnd={onEnd} />
    </LiveKitRoom>
  );
}

function VideoStrip() {
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  return (
    <div data-lk-theme="default" style={{ height: "100%", borderRadius: 12, overflow: "hidden", border: "1px solid var(--line)" }}>
      <GridLayout tracks={tracks}>
        <ParticipantTile />
      </GridLayout>
    </div>
  );
}

function IconMic({ off }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}
function IconCam({ off }: { off?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="m15 10 6-3.5v11L15 14" />
      {off && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
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
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [copied, setCopied] = useState(false);

  const idRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<Line[]>([]);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerRef = useRef("");
  const startRef = useRef(Date.now());
  const statsRef = useRef<Stats>({ surfaced: 0, used: 0, flags: 0, docs: 0 });
  const docsRef = useRef<Set<string>>(new Set());

  const addFinal = useCallback((speaker: string, text: string, flag = false) => {
    if (!text.trim()) return;
    setLines((prev) => [...prev.slice(-200), { id: `${Date.now()}-${idRef.current++}`, speaker, text: text.trim(), flag }]);
    setInterim((prev) => ({ ...prev, [speaker]: "" }));
  }, []);
  const setSpeakerInterim = useCallback((speaker: string, text: string) => {
    setInterim((prev) => ({ ...prev, [speaker]: text }));
  }, []);

  // Transcribe the rep's own speech only while their mic is live. Muting the mic must also pause
  // transcription — otherwise "Mute" silences the customer's audio but the transcript (and the AI)
  // keep capturing the rep's words. Read off the live LiveKit track, kept fresh by the track-event
  // re-render wired up further below.
  const micEnabled = room?.localParticipant?.isMicrophoneEnabled ?? false;
  useBrowserSpeech(micEnabled, ({ final, interim: itm }) => {
    if (final) addFinal(repName, final);
    if (itm) setSpeakerInterim(repName, itm);
  });

  // When muted, drop any half-captured phrase so no stale "live" text lingers in the transcript.
  useEffect(() => {
    if (!micEnabled) setInterim((prev) => (prev[repName] ? { ...prev, [repName]: "" } : prev));
  }, [micEnabled, repName]);

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

  const runSuggest = useCallback(async () => {
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
        setDismissed(new Set());
        setUsed(new Set());
        const fields = [r.concern, r.firstStep, r.suggestedLine, r.explainer, r.comparison, r.followUp].filter(Boolean).length;
        statsRef.current.surfaced += fields;
        if (r.concern) statsRef.current.flags += 1;
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

  // Rep's own mic / camera. Read straight off the live track each render (no separate state to
  // drift), re-render on track events, and NEVER disable the button — so it's always clickable.
  const [, bumpMedia] = useState(0);
  const [micPresent, setMicPresent] = useState<boolean | null>(null);
  const [camPresent, setCamPresent] = useState<boolean | null>(null);
  useEffect(() => {
    if (!room) return;
    const bump = () => bumpMedia((n) => n + 1);
    room
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump);
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, bump)
        .off(RoomEvent.LocalTrackUnpublished, bump)
        .off(RoomEvent.TrackMuted, bump)
        .off(RoomEvent.TrackUnmuted, bump);
    };
  }, [room]);

  // Does this machine actually expose a mic / camera the browser can use? On many setups there is
  // no microphone at all (camera-only webcam, mic disabled in OS privacy settings) — in that case
  // a "Muted" button that can never un-mute is just confusing, so we surface the real state.
  const checkDevices = useCallback(async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      setMicPresent(devs.some((d) => d.kind === "audioinput"));
      setCamPresent(devs.some((d) => d.kind === "videoinput"));
    } catch {
      setMicPresent(false);
      setCamPresent(false);
    }
  }, []);
  useEffect(() => {
    checkDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", checkDevices);
    return () => md?.removeEventListener?.("devicechange", checkDevices);
  }, [checkDevices]);

  const camEnabled = room?.localParticipant?.isCameraEnabled ?? false;
  const noMic = micPresent === false;
  const noCam = camPresent === false;
  const toggleMic = () => {
    // No mic detected yet — re-scan (the rep may have just plugged one in or fixed OS settings).
    if (noMic) {
      checkDevices();
      return;
    }
    const lp = room?.localParticipant;
    lp?.setMicrophoneEnabled(!lp.isMicrophoneEnabled).catch(() => checkDevices());
  };
  const toggleCam = () => {
    if (noCam) {
      checkDevices();
      return;
    }
    const lp = room?.localParticipant;
    lp?.setCameraEnabled(!lp.isCameraEnabled).catch(() => checkDevices());
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

  type PointerCard = { key: string; cat: string; cls: string; title: string; text: string; quote?: boolean };
  const allCards: PointerCard[] = result
    ? [
        { key: "concern", cat: "Detected concern", cls: "cat-concern", title: "What the customer is unsure about", text: result.concern },
        { key: "firstStep", cat: "What to do first", cls: "cat-do", title: "Confirm understanding first", text: result.firstStep },
        { key: "line", cat: "Suggested line", cls: "cat-line", title: "A line you could open with", text: result.suggestedLine, quote: true },
        { key: "explainer", cat: "Explanation you can use", cls: "cat-explain", title: "Plain-language explainer", text: result.explainer },
        { key: "comparison", cat: "Comparison pointer", cls: "cat-compare", title: "Frame the trade-off", text: result.comparison },
        { key: "followUp", cat: "Follow-up prompt", cls: "cat-follow", title: "Surface their priority", text: result.followUp, quote: true },
      ]
    : [];
  const cards = allCards.filter((c) => c.text && !dismissed.has(c.key));

  const colStyle: React.CSSProperties = { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", padding: 0 };

  return (
    <div style={{ height: "calc(100vh - 150px)", minHeight: 1000, display: "flex", flexDirection: "column", gap: 14 }}>
      {/* control bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0, flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ color: "var(--pru-red)", fontWeight: 700, display: "flex", alignItems: "center", gap: 7 }}>
            <span className="pru-rec-dot" style={{ width: 9, height: 9, borderRadius: 9, background: "var(--pru-red)", display: "inline-block" }} />
            Recording Started
          </span>
          <span className="pru-eyebrow">Session</span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>{session.roomId}</span>
          <span style={{ width: 1, height: 18, background: "var(--line)", display: "inline-block" }} />
          <button
            type="button"
            className="pru-btn pru-btn-sm"
            onClick={toggleMic}
            title={noMic ? "No microphone detected. Check your OS sound settings & mic privacy, then click to retry." : micEnabled ? "Mute microphone" : "Unmute microphone"}
            style={noMic ? { color: "var(--amber)", borderColor: "rgba(178,107,18,0.3)", background: "var(--amber-tint)" } : micEnabled ? undefined : { color: "var(--pru)", borderColor: "var(--pru-line)", background: "var(--pru-tint)" }}
          >
            <IconMic off={!micEnabled || noMic} />
            {noMic ? "No microphone" : micEnabled ? "Mic" : "Muted"}
          </button>
          <button
            type="button"
            className="pru-btn pru-btn-sm"
            onClick={toggleCam}
            title={noCam ? "No camera detected. Check your OS settings, then click to retry." : camEnabled ? "Turn camera off" : "Turn camera on"}
            style={noCam ? { color: "var(--amber)", borderColor: "rgba(178,107,18,0.3)", background: "var(--amber-tint)" } : camEnabled ? undefined : { color: "var(--pru)", borderColor: "var(--pru-line)", background: "var(--pru-tint)" }}
          >
            <IconCam off={!camEnabled || noCam} />
            {noCam ? "No camera" : camEnabled ? "Camera" : "Camera off"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="pru-btn pru-btn-sm" onClick={copy}>{copied ? "✓ Link copied" : "⧉ Copy customer link"}</button>
          <button className={`pru-chip ${auto ? "on" : ""}`} style={{ padding: "6px 11px", fontSize: 12 }} onClick={() => setAuto((a) => !a)}>
            {auto ? "● Auto-suggest on" : "○ Auto-suggest off"}
          </button>
          <button className="pru-btn pru-btn-primary pru-btn-sm" onClick={end}>End Session</button>
        </div>
      </div>

      {noMic && (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 10, padding: "9px 13px", borderRadius: 10, background: "var(--amber-tint)", border: "1px solid rgba(178,107,18,0.28)", color: "var(--amber)", fontSize: 12.5 }}>
          <IconMic off />
          <span>
            <strong>No microphone detected.</strong> Your audio isn’t being shared and your speech won’t be transcribed.
            Enable a mic in your OS sound settings (and allow mic access for the browser), then click <strong>“No microphone”</strong> to retry. The camera and customer’s audio are unaffected.
          </span>
        </div>
      )}

      <div style={{ flex: "2 1 0", minHeight: 340 }}>
        <VideoStrip />
      </div>

      <div className="pru-grid-3" style={{ flex: "1.15 1 0", minHeight: 240, alignItems: "stretch" }}>
        {/* Column 1 — transcript */}
        <div className="pru-card" style={colStyle}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pru-ico sm ink"><IconWave size={15} /></span>
            <div>
              <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                Live Transcript
                {!micEnabled && !noMic && (
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.03em", textTransform: "uppercase", color: "var(--amber)", background: "var(--amber-tint)", padding: "2px 7px", borderRadius: 999 }}>
                    Paused · muted
                  </span>
                )}
              </div>
              <div className="pru-muted" style={{ fontSize: 12 }}>Consent-based · {consent ? `customer consented ${new Date(consent.consentedAt).toLocaleTimeString()}` : "awaiting customer consent"}</div>
            </div>
          </div>
          <div ref={feedRef} className="pru-scroll" style={{ flex: 1, padding: 14 }}>
            {lines.length === 0 && Object.values(interim).every((v) => !v) && (
              <div className="pru-muted" style={{ fontSize: 13 }}>Transcript appears here as you and the customer speak. (Chrome / Edge.)</div>
            )}
            {lines.map((l) => {
              const isRep = l.speaker === repName;
              return (
                <div key={l.id} className={`pru-bubble ${isRep ? "" : "customer"}`}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span className="who">{isRep ? "Representative" : l.speaker}</span>
                  </div>
                  <div className="txt">{l.text}</div>
                  {l.flag && <div className="pru-flag">● Confusion / question detected</div>}
                </div>
              );
            })}
            {Object.entries(interim).map(([sp, txt]) =>
              txt ? (
                <div key={"i-" + sp} className={`pru-bubble ${sp === repName ? "" : "customer"}`} style={{ opacity: 0.6 }}>
                  <span className="who">{sp === repName ? "Representative" : sp}</span>
                  <div className="txt" style={{ fontStyle: "italic" }}>{txt}</div>
                </div>
              ) : null,
            )}
            {loading && <div className="pru-muted" style={{ fontSize: 12 }}>●●● analysing…</div>}
          </div>
        </div>

        {/* Column 2 — meeting context */}
        <div className="pru-card" style={colStyle}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pru-ico sm ink"><IconLayers size={15} /></span>
            <div>
              <div style={{ fontWeight: 700 }}>Active Meeting Context</div>
              <div className="pru-muted" style={{ fontSize: 12 }}>Auto-updated from transcript & documents</div>
            </div>
          </div>
          <div className="pru-scroll" style={{ flex: 1, padding: 14 }}>
            <div className="pru-grid-2" style={{ gap: 10 }}>
              <ContextBox label="Product area" value={session.productArea} />
              <ContextBox label="Current topic" value={result?.concern ? "Live concern" : "Listening…"} red />
            </div>
            <div className="pru-grid-2" style={{ gap: 10, marginTop: 10 }}>
              <ContextBox label="Focus" value={session.focus[0] ?? "Advisory support"} />
              <ContextBox label="Status" value={consent ? "Transcribing" : "Awaiting consent"} />
            </div>

            <div className="pru-eyebrow" style={{ margin: "16px 0 8px" }}>Side-by-side reference</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={refTh} />
                  <th style={refTh}>Base plan</th>
                  <th style={refTh}>Add-on</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Role", "Core protection", "Extra support"],
                  ["Cost", "Lower premium", "Additional premium"],
                  ["Support", "Basic coverage", "Improves benefits / cuts cost"],
                  ["Trade-off", "Lower regular cost", "Stronger support at claim"],
                ].map((r) => (
                  <tr key={r[0]}>
                    <td style={{ ...refTd, color: "var(--muted)", fontWeight: 600 }}>{r[0]}</td>
                    <td style={refTd}>{r[1]}</td>
                    <td style={refTd}>{r[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="pru-eyebrow" style={{ margin: "16px 0 8px" }}>Referenced documents</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(result?.sources?.length ? result.sources.map((s) => s.source) : ["Base Health Protection Plan", "Add-on / Rider Document", "Claims and FAQ Document"]).map((d, i) => (
                <div key={i} style={{ fontSize: 12, color: "var(--ink-3)" }}>· {d}</div>
              ))}
            </div>
          </div>
        </div>

        {/* Column 3 — pointers */}
        <div className="pru-card" style={colStyle}>
          <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="pru-ico sm red"><IconSparkle size={15} /></span>
              <div>
                <div style={{ fontWeight: 700 }}>PRUAssist Pointers</div>
                <div className="pru-muted" style={{ fontSize: 12 }}>Private to you</div>
              </div>
            </div>
            <span className={`pru-listen ${loading ? "thinking" : ""}`}>
              <span className="wave" />
              <span style={{ color: loading ? "var(--pru)" : "var(--sage)" }}>{loading ? "Thinking" : result ? "Live" : "Listening"}</span>
            </span>
          </div>
          <div className="pru-scroll" style={{ flex: 1, padding: 14 }}>
            {loading && !result && (
              <div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="pru-pointer" style={{ animationDelay: `${i * 0.06}s` }}>
                    <div className="pru-skeleton" style={{ height: 13, width: "42%", marginBottom: 11 }} />
                    <div className="pru-skeleton" style={{ height: 11, width: "92%", marginBottom: 7 }} />
                    <div className="pru-skeleton" style={{ height: 11, width: "70%" }} />
                  </div>
                ))}
              </div>
            )}
            {!result && !note && !loading && (
              <div className="pru-muted" style={{ fontSize: 13 }}>
                When the customer asks a question, PRUAssist surfaces private pointers here automatically — grounded in
                the policy documents, with sources.
              </div>
            )}
            {note && <div className="pru-muted" style={{ fontSize: 13 }}>{note}</div>}
            {cards.map((c, i) => (
              <div key={c.key} className={`pru-pointer ${c.key === "line" ? "say" : ""}`} style={{ animationDelay: `${i * 0.05}s` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className={`cat ${c.cls}`}>● {c.cat}</span>
                  <span className="pru-muted" style={{ fontSize: 11 }}>#{i + 1}</span>
                </div>
                <div className="title">{c.title}</div>
                <div className="body" style={c.quote ? { fontStyle: "italic" } : undefined}>{c.quote ? `“${c.text}”` : c.text}</div>
                <div className="actions">
                  <button className="pru-btn pru-btn-primary pru-btn-sm" onClick={() => markUsed(c.key)} disabled={used.has(c.key)}>
                    {used.has(c.key) ? "✓ Used" : "Use this"}
                  </button>
                  <button className="link" onClick={runSuggest}>Rephrase</button>
                  <button className="link" onClick={() => setDismissed((prev) => new Set(prev).add(c.key))}>Ignore</button>
                </div>
              </div>
            ))}
            {result && cards.length > 0 && result.sources.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11.5 }} className="pru-muted">
                Grounded in: {result.sources.map((s) => s.source).join(" · ")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextBox({ label, value, red }: { label: string; value: string; red?: boolean }) {
  return (
    <div className="pru-card" style={{ padding: 12, background: red ? "var(--pru-red-soft)" : "var(--surface-2)", borderColor: red ? "var(--pru-red-line)" : "var(--line)" }}>
      <div className="pru-eyebrow">{label}</div>
      <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 4, color: red ? "var(--pru-red-dark)" : "var(--ink)" }}>{value}</div>
    </div>
  );
}

const refTh: React.CSSProperties = { textAlign: "left", padding: "4px 6px", fontSize: 11, color: "var(--muted)", fontWeight: 700, borderBottom: "1px solid var(--line)" };
const refTd: React.CSSProperties = { padding: "5px 6px", borderBottom: "1px solid var(--line)", color: "var(--ink-2)", verticalAlign: "top" };
