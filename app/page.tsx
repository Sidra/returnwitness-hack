import type { Metadata } from "next";
import Link from "next/link";
import { HeldBoundary } from "@/components/marketing/HeldBoundary";
import { HeldResultCard } from "@/components/marketing/HeldResultCard";
import { HomeAnswers, HomeHeroPicture } from "@/components/marketing/HomeHero";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { MERCHANT } from "@/data/fixtures";
import { formatCents } from "@/lib/format";
import { KNOWN_MISREADS } from "@/data/known-misreads";
import { LossNotes } from "@/components/dash/LossNotes";

export const metadata: Metadata = {
  title: "ReturnWitness: the refund waits for what's actually in the box",
  description:
    "An overhead camera counts every item of a returned kit as it settles in the tray, reconciles it with the packing slip and the return policy, and holds the refund until a person approves.",
};

const lens = KIT.items.find((i) => i.key === "lens");

const STEPS = [
  {
    n: "1",
    t: "Film and segment",
    d: "The overhead camera films the unboxing. SAM 3.1 segments each item and keeps following it from frame to frame.",
  },
  {
    n: "2",
    t: "Count in code",
    d: "An item counts once, when it settles in the inspected tray. That rule lives in app code, built not to add a count for hands, kraft paper or re-issued track IDs; it passes the synthetic stress sweep, and in the reported run it counted every item right (g1 with a merged-mask hold); the registered gate is incomplete, g2–g8 not filmed.",
  },
  {
    n: "3",
    t: "Reconcile and hold",
    d: "App code reconciles the counts against the packing slip and the policy. When enabled, Muse Spark 1.3 reads the same evidence and can only add a hold, never clear one.",
  },
  {
    n: "4",
    t: "Draft, approve, refund",
    d: "Muse Wonder 1.0 drafts the decision and cites the policy clause. A person approves. Then a Stripe test-mode refund runs.",
  },
];

export default function LandingPage() {
  return (
    <>
      {/* HERO */}
      <section className="container hero" aria-labelledby="hero-title">
        <div className="hero-grid">
          <div className="stack" style={{ gap: 24 }}>
            <span className="eyebrow">Returns bench · kit completeness</span>
            <div className="row" style={{ alignItems: "center", gap: 28 }}>
              <div className="numeral big-num" role="img" aria-label={`${formatCents(KIT_TOTAL_CENTS)} held`}>
                {formatCents(KIT_TOTAL_CENTS)}
              </div>
              <span className="sticker-held lg" aria-hidden>HELD</span>
            </div>
            <h1 className="h1" id="hero-title" style={{ maxWidth: "20ch" }}>
              The refund waits for what&apos;s actually in the box.
            </h1>
            <p className="lead">
              For a returns lead at a store that ships multi-item kits, ReturnWitness counts what comes out of the box, checks it against the
              packing slip and the return policy, and holds the refund until a person approves it.
            </p>
            <div className="row">
              <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
              <Link href="/play" className="btn">Return a box yourself</Link>
              <Link href="/how-it-works" className="btn">How it works</Link>
            </div>
          </div>
          <HomeHeroPicture />
        </div>
      </section>

      {/* THE FOUR ANSWERS, one line each */}
      <section className="container" aria-label="What happens at the bench">
        <HomeAnswers />
      </section>

      {/* PROBLEM */}
      <section id="problem" className="container section" aria-labelledby="problem-title" style={{ scrollMarginTop: 72 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="cols-2">
            <div className="stack">
              <span className="eyebrow">The problem</span>
              <h2 className="h2" id="problem-title">Rita&apos;s afternoon at {MERCHANT.bench}.</h2>
              <p className="lead">
                {MERCHANT.returnsLead} runs returns at {MERCHANT.name}, an online camera store. The {KIT.kitName} is a camera body, a zoom lens and a
                battery with charger: {formatCents(KIT_TOTAL_CENTS)} together.
              </p>
              <section className="card-flat stack" style={{ gap: 8 }} aria-labelledby="workload-title">
                <h3 className="h3" id="workload-title" style={{ margin: 0 }}>Illustrative workload, not measured</h3>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 15, lineHeight: 1.5 }}>
                  <li>60–80 returned boxes on her bench each afternoon</li>
                  <li>about 40 seconds per box for the person opening it</li>
                </ul>
                <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                  A picture of the job for this scenario, not a count from a real store.
                </p>
              </section>
            </div>
            <div className="prose">
              <p>
                Picture a full bench of returned boxes every afternoon and little time for each. The customer on RMA-20418 says
                &ldquo;everything&apos;s in there.&rdquo; She lifts out the camera and the battery, a wad of kraft paper, and the box looks empty enough.
              </p>
              <p>
                In this scenario, the return system marks the RMA &ldquo;received&rdquo; on the scan, and that scan would release the {formatCents(KIT_TOTAL_CENTS)} refund on
                its own that night. The lens was never in the box. Someone finds out at a restock count a week later, and by then nobody can show whether it went missing
                at the bench or on the shelf.
              </p>
              <p>
                <strong>Why it matters.</strong> The store absorbs the {formatCents(lens?.unitPriceCents ?? 0)} lens, or the whole kit if the rest can&apos;t be resold,
                and it has no record to dispute with. The person at the bench has no time and no evidence. The gap is that the refund follows a
                scan, not the contents.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* HOW */}
      <section id="how" className="container section" aria-labelledby="how-title" style={{ scrollMarginTop: 72 }}>
        <div className="stack" style={{ gap: 24 }}>
          <div className="stack">
            <span className="eyebrow">The solution · how it&apos;s used</span>
            <h2 className="h2" id="how-title">Count, reconcile, hold, approve, refund.</h2>
            <p className="lead">
              The camera watches. Code counts. Models read and draft. A person decides. The product is the workflow around the refund, not a
              picture of a box.
            </p>
          </div>
          <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {STEPS.map((s) => (
              <li className="step" key={s.n}>
                <div className="num" aria-hidden>{s.n}</div>
                <h3 className="h3" style={{ margin: "8px 0" }}><span className="sr-only">Step {s.n}: </span>{s.t}</h3>
                <p style={{ margin: 0, fontSize: 15 }}>{s.d}</p>
              </li>
            ))}
          </ol>
          <div className="row">
            <Link href="/how-it-works" className="btn">Read the full pipeline</Link>
            <Link href="/onboarding" className="btn">Set up a bench</Link>
          </div>
        </div>
      </section>

      {/* PROOF */}
      <section id="proof" className="container section" aria-labelledby="proof-title" style={{ scrollMarginTop: 72 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="cols-2" style={{ alignItems: "start" }}>
            <div className="stack">
              <span className="eyebrow">The held return</span>
              <h2 className="h2" id="proof-title">RMA-20418: the lens was not observed.</h2>
              <p className="lead">
                The card is the packing-slip rule as a diagram: two lines seen, one missing, so the whole {formatCents(KIT_TOTAL_CENTS)} is held and the
                policy clause that applies is quoted next to it.
              </p>
              <p style={{ margin: 0, fontSize: 16 }}>
                The Instant Demo replays the recorded filmed run of this return. There the lens was not observed, and the camera line was held too, on a false
                stand-in flag:
              </p>
              <LossNotes items={KNOWN_MISREADS.filter((m) => m.id === "d1-camera-toy")} />
              <p className="muted" style={{ margin: 0, fontSize: 15 }}>
                The Instant Demo plays a recorded result. It does not make a live Meta call, and the label on the card says so. The merchant, the
                customer and the RMA are seeded data.
              </p>
            </div>
            <HeldResultCard />
          </div>
          <div style={{ marginTop: 48 }}>
            <HeldBoundary />
          </div>
        </div>
      </section>

      {/* PRICING TEASER */}
      <section id="pricing" className="container section" aria-labelledby="pricing-title" style={{ scrollMarginTop: 72 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="cols-2" style={{ alignItems: "end" }}>
            <div className="stack">
              <span className="eyebrow">Proposed pricing</span>
              <h2 className="h2" id="pricing-title">Proposed pricing: $2 per high-risk return inspected.</h2>
              <p className="lead">
                The merchant chooses which returns go to the bench. Clean, low-value returns never touch it.
              </p>
              <div className="stack" style={{ gap: 6 }}>
                <h3 className="h3" style={{ margin: 0 }}>Break-even illustration, before other costs</h3>
                <p style={{ margin: 0, fontSize: 15, maxWidth: "60ch" }}>
                  If the {formatCents(lens?.unitPriceCents ?? 0)} lens really is missing, catching it once equals the fee on{" "}
                  {Math.floor((lens?.unitPriceCents ?? 0) / 200)} inspections. This is arithmetic, not measured savings.
                </p>
              </div>
              <div className="row">
                <Link href="/pricing" className="btn">See the arithmetic</Link>
              </div>
            </div>
            <div className="card-flat stack" style={{ gap: 4 }}>
              <span className="eyebrow">Proposed, per inspection</span>
              <div className="numeral" style={{ fontSize: "clamp(40px, 5vw, 56px)" }}>$2</div>
            </div>
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="container section" aria-labelledby="cta-title">
        <div className="card" style={{ padding: 32 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 24 }}>
            <div className="stack" style={{ gap: 8, maxWidth: "52ch" }}>
              <h2 className="h2" id="cta-title">Watch a {formatCents(KIT_TOTAL_CENTS)} refund get held.</h2>
              <p className="muted" style={{ margin: 0 }}>
                One click opens RMA-20418 at the bench and walks the count, the hold and the approval. Test mode only; no real funds move.
              </p>
            </div>
            <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
          </div>
        </div>
      </section>
    </>
  );
}
