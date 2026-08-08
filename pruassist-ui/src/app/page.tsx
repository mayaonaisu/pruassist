import Link from "next/link";
import { IconArrow, IconDoc, IconLock, IconShield, IconSparkle } from "@/components/icons";

// The spoken advisory line, assembled word-by-word in the hero — the product's thesis, shown working.
const SAID = "Your base plan covers the hospital stay. The add-on upgrades your ward and covers the 10% co-insurance on major treatments.".split(" ");

const MOMENT = [
  { t: "0.0s", tone: "", said: true, title: "The customer asks", body: "“Why do I need this add-on if my plan already covers most things?”" },
  { t: "+0.9s", tone: "signal", said: false, title: "PRUAssist hears the doubt", body: "It flags the question, the confusion, and what to compare — silently, on your side of the call." },
  { t: "+2.4s", tone: "private", said: false, title: "The line is on your screen", body: "A policy-grounded sentence you can say, with the page number it came from." },
];

const TRUST = [
  { icon: <IconDoc size={18} />, title: "Grounded, not generated", body: "Every line is tied to a real policy clause with a page number — never an invented figure." },
  { icon: <IconLock size={18} />, title: "Private to you", body: "It lives on your side of the call. The customer joins a normal video call and never meets the AI." },
  { icon: <IconShield size={18} />, title: "Yours to say or skip", body: "You choose every word. PRUAssist offers the line; the recommendation is always yours." },
];

const NAV = [
  { label: "The moment", href: "#moment" },
  { label: "Why it's trusted", href: "#trust" },
];

export default function Home() {
  return (
    <main>
      {/* ---------- nav ---------- */}
      <header className="pru-header">
        <Link href="/" className="pru-logo">
          <div className="mark">P</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="name">PRUAssist</span>
            <span className="pru-eyebrow" style={{ border: "1px solid var(--line)", padding: "3px 9px", borderRadius: 999 }}>Internal</span>
          </div>
        </Link>
        <nav className="pru-steps" style={{ gap: 30 }}>
          {NAV.map((n) => (
            <a key={n.href} href={n.href} style={{ fontSize: 14, color: "var(--ink-2)", fontWeight: 500 }}>{n.label}</a>
          ))}
        </nav>
        <Link href="/login" className="pru-btn pru-btn-primary pru-btn-sm">Representative sign in <IconArrow size={15} /></Link>
      </header>

      {/* ---------- hero: left thesis · right living private channel ---------- */}
      <section className="pru-container" style={{ padding: "72px 28px 56px", display: "grid", gridTemplateColumns: "1fr 1.04fr", gap: 60, alignItems: "center" }}>
        <div>
          <span className="pru-eyebrow pill"><span style={{ width: 6, height: 6, borderRadius: 6, background: "var(--pru)", display: "inline-block" }} /> Private co-pilot for financial representatives</span>
          <h1 style={{ fontSize: 64, margin: "22px 0 20px", lineHeight: 1.03, letterSpacing: "-0.02em" }}>
            Say the <span className="pru-underline" style={{ fontStyle: "italic", color: "var(--pru)" }}>right thing</span>, exactly when it matters.
          </h1>
          <p style={{ fontSize: 17.5, lineHeight: 1.6, color: "var(--ink-3)", maxWidth: 480 }}>
            A private co-pilot that turns a customer&apos;s confusion into a clear, policy-grounded line you can say — live, in the meeting, with the source attached.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
            <Link href="/login" className="pru-btn pru-btn-primary" style={{ padding: "12px 22px" }}>Representative sign in <IconArrow size={16} /></Link>
            <a href="#moment" className="pru-btn" style={{ padding: "12px 22px" }}>See the moment</a>
          </div>
        </div>

        {/* the private channel — the signature */}
        <div className="pru-hud">
          <div className="hud-bar">
            <span className="hud-live"><span className="pru-rec-dot" style={{ width: 7, height: 7, borderRadius: 7, background: "var(--pru)", display: "inline-block" }} /> Live · consent granted</span>
            <span className="hud-clock">14:32</span>
          </div>
          <div className="heard">
            <span className="who">Customer · heard on the call</span>
            <p>&ldquo;Why do I need this add-on if my plan already covers most things?&rdquo;</p>
            <span className="flag"><span className="d" /> Confusion detected</span>
          </div>
          <div className="private">
            <div className="phead">
              <span className="tag"><IconSparkle size={11} /> Say this — private to you</span>
              <span className="clock"><span>+0.0s</span><span>+1.2s</span><span>+2.4s</span></span>
            </div>
            <p className="pru-said">
              {SAID.map((w, i) => (
                <span className="w" key={i} style={{ animationDelay: `${(1.65 + i * 0.05).toFixed(2)}s` }}>{w}</span>
              ))}
            </p>
            <div className="chips">
              {[["PRUShield Brochure", "p.12"], ["PRUExtra", "p.6"]].map(([d, p], i) => (
                <span className="chip" key={d} style={{ animationDelay: `${(3.2 + i * 0.15).toFixed(2)}s` }}><IconDoc size={11} /> {d} · {p}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- the moment: how it works, told as timing ---------- */}
      <section id="moment" className="pru-container" style={{ padding: "44px 28px 30px" }}>
        <span className="pru-eyebrow" style={{ color: "var(--pru)", display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 22, height: 1, background: "var(--pru)" }} /> The moment
        </span>
        <h2 style={{ fontSize: 46, margin: "16px 0 14px", maxWidth: 620, lineHeight: 1.04 }}>The customer talks. You get the line.</h2>
        <p className="pru-muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 500 }}>
          In the few seconds a customer spends asking, PRUAssist hears the doubt and hands you the words — grounded, private, and yours to say or skip.
        </p>
        <div className="pru-timeline r-stagger">
          {MOMENT.map((m) => (
            <div key={m.t} className={`pru-tl-node ${m.tone}`}>
              <div className="t">{m.t}</div>
              <div className="dot" />
              <h3>{m.title}</h3>
              <p>{m.said ? <span className="said-mini">{m.body}</span> : m.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- trust: quiet, typographic ---------- */}
      <section id="trust" className="pru-container" style={{ padding: "40px 28px 70px" }}>
        <h2 style={{ fontSize: 44, maxWidth: 560, lineHeight: 1.04 }}>Designed to be safe by default.</h2>
        <div className="pru-trust">
          {TRUST.map((t) => (
            <div key={t.title}>
              <span className="ico">{t.icon}</span>
              <h3>{t.title}</h3>
              <p>{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- closing: step into the private channel ---------- */}
      <section className="pru-container" style={{ padding: "0 28px 90px" }}>
        <div className="pru-cta">
          <span className="pru-eyebrow" style={{ color: "var(--pru)" }}>● The private channel</span>
          <h2 style={{ fontSize: 42, margin: "14px 0 14px" }}>Give your representatives a second brain.</h2>
          <p style={{ maxWidth: 520, margin: "0 auto 26px", fontSize: 16, lineHeight: 1.6 }}>
            Private, policy-grounded guidance — live in every client conversation. It never speaks to the customer, and never makes the recommendation.
          </p>
          <Link href="/login" className="pru-btn pru-btn-primary" style={{ padding: "13px 26px", fontSize: 15 }}>Representative sign in <IconArrow size={16} /></Link>
          <p style={{ fontSize: 12.5, marginTop: 20, color: "var(--on-ink-2)" }}>Customers join only via the private link their representative sends them.</p>
        </div>
      </section>
    </main>
  );
}
