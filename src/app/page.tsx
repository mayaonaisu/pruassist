import Link from "next/link";
import { IconArrow, IconCheck, IconLock } from "@/components/icons";

// Three promises stated as facts, including what does NOT happen.
const SAFE = [
  {
    title: "Consent before capture",
    body: "Nothing is transcribed until both parties accept on their own device. Either side can end the session.",
  },
  {
    title: "Grounded, never invented",
    body: "Every pointer cites the brochure clause and page it came from. No citation, no pointer.",
    lock: true,
  },
  {
    title: "The private channel",
    body: "Pointers appear only on your screen. The customer sees the conversation, never the prompts.",
  },
];

export default function Home() {
  return (
    <main>
      <header className="pru-header">
        <Link href="/" className="pru-logo">
          PRU<i>Assist</i>
        </Link>
        <Link href="/login" className="pru-btn pru-btn-sm" style={{ marginLeft: "auto" }}>
          Representative sign in <IconArrow size={14} />
        </Link>
      </header>

      {/* Built from the console's own parts, so the hero previews the product rather than illustrating it. */}
      <section className="hero">
        <div>
          <div className="pru-eyebrow" style={{ marginBottom: 14 }}>
            Private co-pilot for financial representatives
          </div>
          <h1>
            The customer talks.
            <br />
            You get <em>the line</em>.
          </h1>
          <p className="lede">
            PRUAssist listens to the advisory conversation, catches the moment your customer stops following, and hands
            you one sentence to say — grounded in the policy document, with the page it came from.
          </p>
          <div className="cta">
            <Link href="/login" className="pru-btn pru-btn-primary" style={{ padding: "12px 22px" }}>
              Representative sign in <IconArrow size={16} />
            </Link>
            <a href="#safe" className="pru-btn" style={{ padding: "12px 22px" }}>
              How it stays safe
            </a>
          </div>
          <p className="fine">
            Recording starts only after both of you consent, on your own devices. Customers join through the private
            link you send them — there is no public room.
          </p>
        </div>

        <div className="moment">
          <div className="mh">
            <span className="d" />
            <span>Live · consent granted</span>
          </div>
          <div className="heard">
            <div className="lbl">Customer · heard on the call</div>
            <q>
              Why do I need this add-on if my plan already <span className="mark">covers most things</span>?
            </q>
          </div>
          <div className="out">
            <div className="lbl">Say this — private to you</div>
            <div className="say-l">
              Your plan covers the big hospital bill. The add-on covers the slice you&rsquo;d still pay yourself.
            </div>
            <div className="cite-l">PRUEXTRA p. 4 · PRUSHIELD p. 12</div>
          </div>
        </div>
      </section>

      <section id="safe" className="safe">
        <div className="safe-in">
          <h2>Designed to be safe by default</h2>
          <div className="pru-grid-3">
            {SAFE.map((s) => (
              <div className="safe-item" key={s.title}>
                <div className="t">
                  {s.lock ? <IconLock size={15} /> : <IconCheck size={15} />}
                  {s.title}
                </div>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
