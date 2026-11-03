import type { Metadata } from "next";
import Link from "next/link";
import { FixtureLabel } from "@/components/ModeBadge";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { STRIPE_TEST_LABEL } from "@/data/fixtures";
import { formatCents, formatCentsExact } from "@/lib/format";
import measuredJson from "@/data/measured-calls.json";
import type { MeasuredCalls } from "@/lib/scale/measured";

const MEASURED = measuredJson as MeasuredCalls;
const measuredUsd = (model: string) => MEASURED.models.find((m) => m.model === model && m.ok > 0)?.costUsd.p50 ?? null;
const SPARK_USD = measuredUsd("muse-spark-1.3");
const WONDER_USD = measuredUsd("muse-wonder-1.0");

export const metadata: Metadata = {
  title: "Pricing · ReturnWitness",
  description: "Proposed pricing: $2.00 per high-risk return inspected, with the model-cost arithmetic shown line by line.",
};

const FEE_CENTS = 200;
const CLIP_SECONDS = 15;
const FPS = 5;
const FRAMES = CLIP_SECONDS * FPS; // 75
const CONCEPTS = KIT.items.length + 3; // 3 items + hand + kraft paper + box = 6
const FRAME_CONCEPTS = FRAMES * CONCEPTS; // 450
const SAM_PER_1K = 0.2;
const SAM_COST = (FRAME_CONCEPTS / 1000) * SAM_PER_1K; // 0.09
const MISSING = KIT.items[1]; // the lens in the example return
// A hold only protects money if the part really is missing and the refund would otherwise have gone out in full.
const INSPECTIONS_PER_CATCH = Math.floor(MISSING.unitPriceCents / FEE_CENTS); // 54

export default function PricingPage() {
  return (
    <>
      <section className="container hero" aria-labelledby="pricing-title">
        <div className="hero-grid">
          <div className="stack" style={{ gap: 20 }}>
            <span className="eyebrow">Pricing</span>
            <h1 className="h-display" id="pricing-title">Pay when a risky return gets inspected.</h1>
            <span className="eyebrow">Proposed pricing</span>
            <p className="lead">
              {formatCentsExact(FEE_CENTS)} per high-risk return inspected (proposed; no store pays it yet). The merchant chooses which RMAs route to the bench; clean, low-value
              returns never touch it and never cost anything.
            </p>
            <div className="row">
              <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
              <Link href="/how-it-works" className="btn">How it works</Link>
            </div>
          </div>
          <div className="numeral big-num" aria-hidden>{formatCentsExact(FEE_CENTS)}</div>
        </div>
      </section>

      <section className="container section" aria-labelledby="four-title" style={{ paddingTop: 24 }}>
        <h2 className="sr-only" id="four-title">The problem, the solution, why it matters, how it is billed</h2>
        <div className="four-q">
          <div>
            <span className="eyebrow">01 · The problem</span>
            <p style={{ margin: "8px 0 0" }}>In this scenario, a received scan releases the refund, so an incomplete kit refunds in full.</p>
          </div>
          <div>
            <span className="eyebrow">02 · The solution</span>
            <p style={{ margin: "8px 0 0" }}>An inspection at the bench counts the kit and holds the refund when something is missing.</p>
          </div>
          <div>
            <span className="eyebrow">03 · Why it matters</span>
            <p style={{ margin: "8px 0 0" }}>
              Break-even illustration: if a {formatCents(MISSING.unitPriceCents)} {MISSING.name.toLowerCase()} really is missing, catching it covers {INSPECTIONS_PER_CATCH} inspections, before other costs.
            </p>
          </div>
          <div>
            <span className="eyebrow">04 · How it&apos;s used</span>
            <p style={{ margin: "8px 0 0" }}>Route the risky RMAs to the bench. Each inspection is {formatCentsExact(FEE_CENTS)}. Clean returns skip it.</p>
          </div>
        </div>
      </section>

      {/* COST ARITHMETIC */}
      <section className="container section" aria-labelledby="cost-title" style={{ paddingTop: 24 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="stack" style={{ gap: 24 }}>
            <div className="stack">
              <span className="eyebrow">What one inspection costs to run</span>
              <h2 className="h2" id="cost-title">The arithmetic, line by line.</h2>
              <p className="lead">
                Estimate from list prices, replaced by the live run record. Until the live Meta calls are connected, the Instant Demo plays recorded
                results, so no model cost is incurred there.
              </p>
            </div>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Per-inspection cost: SAM from Meta list prices, Spark and Wonder from logged live calls</caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">List price</th>
                    <th scope="col">Quantity per inspection</th>
                    <th scope="col" className="num">Per inspection</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid var(--hair)" }}>SAM 3.1 segmentation</th>
                    <td className="mono">$0.20 per 1,000 frames</td>
                    <td className="mono">
                      {CLIP_SECONDS} s × {FPS} fps = {FRAMES} frames<br />
                      × {CONCEPTS} concepts = {FRAME_CONCEPTS} frame-concepts
                    </td>
                    <td className="num mono">${SAM_COST.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid var(--hair)" }}>Muse Spark 1.3 reconciliation</th>
                    <td className="mono">$1.25 in / $4.25 out per 1M tokens</td>
                    <td className="mono">tokens in × $1.25/1M + tokens out × $4.25/1M</td>
                    <td className="num mono">{SPARK_USD != null ? `$${SPARK_USD.toFixed(3)}` : <span className="muted">from run record</span>}</td>
                  </tr>
                  <tr>
                    <th scope="row" style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid var(--hair)" }}>Muse Wonder 1.0 decision draft</th>
                    <td className="mono">$4.00 in / $20.00 out per 1M tokens</td>
                    <td className="mono">tokens in × $4.00/1M + tokens out × $20.00/1M</td>
                    <td className="num mono">{WONDER_USD != null ? `$${WONDER_USD.toFixed(3)}` : <span className="muted">from run record</span>}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="cols-2">
              <div className="well">
                <strong>The {CONCEPTS} segmentation concepts:</strong> the {KIT.items.length} kit items ({KIT.items.map((i) => i.name.toLowerCase()).join(", ")}), a hand,
                kraft paper and the box.
              </div>
              <div className="well">
                <strong>Token counts are not guessed here.</strong> The SAM line is list-price arithmetic. The Spark and Wonder lines are the logged cost
                of real calls (median per call; {MEASURED.source}).
                {SPARK_USD != null && WONDER_USD != null
                  ? ` Together about $${(SAM_COST + SPARK_USD + WONDER_USD).toFixed(2)} of the ${formatCentsExact(FEE_CENTS)}.`
                  : ""}{" "}
                <Link href="/how-it-works#scale">At 500 returns a day</Link>.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* WHAT YOU GET BACK */}
      <section className="container section" aria-labelledby="back-title" style={{ paddingTop: 24 }}>
        <div className="rule-top" style={{ paddingTop: 24 }}>
          <div className="cols-2" style={{ alignItems: "end" }}>
            <div className="stack">
              <span className="eyebrow">Break-even illustration, before other costs</span>
              <h2 className="h2" id="back-title">One missing lens caught would cover {INSPECTIONS_PER_CATCH} inspections.</h2>
              <p className="lead">
                The example return on the landing page is a {formatCents(KIT_TOTAL_CENTS)} kit with the {MISSING.name.toLowerCase()} not observed. A hold is not a
                saving: if a person later approves the full refund, nothing was saved. The arithmetic only counts when the part really is missing and the refund
                would otherwise have gone out in full. Then the {formatCents(MISSING.unitPriceCents)} {MISSING.name.toLowerCase()} not refunded covers{" "}
                {INSPECTIONS_PER_CATCH} inspections at {formatCentsExact(FEE_CENTS)} each. This is arithmetic, not measured savings: it leaves out the bench&apos;s own costs and assumes the part is really gone.
              </p>
              <FixtureLabel>[Seeded merchant order &amp; RMA fixture]</FixtureLabel>
            </div>
            <div className="numeral big-num" aria-hidden>{INSPECTIONS_PER_CATCH}</div>
          </div>
        </div>
      </section>

      {/* STRIPE + SCOPE */}
      <section className="container section" aria-labelledby="stripe-title" style={{ paddingTop: 24 }}>
        <div className="cols-2">
          <div className="card">
            <span className="eyebrow">Payments</span>
            <h2 className="h3" id="stripe-title" style={{ margin: "6px 0 8px" }}>Stripe test mode only.</h2>
            <p style={{ margin: "0 0 12px" }}>
              The demo refunds a seeded test charge and books the {formatCentsExact(FEE_CENTS)} fee as a line on the receipt. The server refuses any key
              that is not a test key.
            </p>
            <span className="fixture-label">{STRIPE_TEST_LABEL}</span>
          </div>
          <div className="card">
            <span className="eyebrow">What this page is not</span>
            <h2 className="h3" style={{ margin: "6px 0 8px" }}>No checkout, no sign-up.</h2>
            <p style={{ margin: 0 }}>
              Billing is out of scope for now. This page states the price and shows where it comes from; nothing here collects payment details or
              creates an account.
            </p>
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="pricing-cta">
        <div className="card" style={{ padding: 32 }}>
          <div className="row" style={{ justifyContent: "space-between", gap: 24 }}>
            <div className="stack" style={{ gap: 8, maxWidth: "52ch" }}>
              <h2 className="h2" id="pricing-cta">See what an inspection returns.</h2>
              <p className="muted" style={{ margin: 0 }}>Run the held {formatCents(KIT_TOTAL_CENTS)} return, then set up a bench of your own.</p>
            </div>
            <div className="row">
              <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
              <Link href="/onboarding" className="btn">Set up a bench</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
