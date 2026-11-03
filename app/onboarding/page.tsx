import type { Metadata } from "next";
import Link from "next/link";
import { ModeBadge, FixtureLabel } from "@/components/ModeBadge";
import { CameraTest } from "@/components/marketing/CameraTest";
import { ZoneStrip } from "@/components/marketing/ZoneStrip";
import { FIXTURE_LABEL, MERCHANT, RMAS } from "@/data/fixtures";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { formatCents } from "@/lib/format";

export const metadata: Metadata = {
  title: "Set up a bench · ReturnWitness",
  description: "Four steps: connect the store, mount the camera, mark the zones, choose which returns route to the bench.",
};

function StepHead({ n, title, id }: { n: string; title: string; id: string }) {
  return (
    <div className="row" style={{ alignItems: "baseline", gap: 16 }}>
      <span className="numeral" style={{ fontSize: 56 }} aria-hidden>{n}</span>
      <h2 className="h2" id={id}>
        <span className="sr-only">Step {n}: </span>
        {title}
      </h2>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <>
      <section className="container hero" aria-labelledby="onb-title">
        <div className="stack" style={{ gap: 20 }}>
          <span className="eyebrow">Set up a bench</span>
          <h1 className="h-display" id="onb-title" style={{ maxWidth: "14ch" }}>Four steps to a bench that counts.</h1>
          <p className="lead">
            You need a Mac, an iPhone or any webcam, a matte mat and some tape. Nothing here records or uploads video; the camera test runs in
            this browser tab.
          </p>
        </div>
      </section>

      <section className="container" aria-label="Setup steps">
        {/* 1 */}
        <section className="rule-top section" style={{ paddingTop: 24, paddingBottom: 48 }} aria-labelledby="s1">
          <div className="cols-2">
            <div className="stack">
              <StepHead n="1" title="Connect your store" id="s1" />
              <p className="lead">The store connection is the seeded fixture for {MERCHANT.name}. There is no real store integration yet.</p>
              <div className="row"><ModeBadge mode="RECORDED_FIXTURE" /><FixtureLabel>{FIXTURE_LABEL}</FixtureLabel></div>
            </div>
            <div className="well">
              <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", margin: 0, fontSize: 15 }}>
                  <dt className="muted">Store</dt><dd style={{ margin: 0 }}>{MERCHANT.name}</dd>
                  <dt className="muted">Returns lead</dt><dd style={{ margin: 0 }}>{MERCHANT.returnsLead}</dd>
                  <dt className="muted">Bench</dt><dd style={{ margin: 0 }}>{MERCHANT.bench}</dd>
                  <dt className="muted">Kit</dt><dd style={{ margin: 0 }}>{KIT.kitName} · {formatCents(KIT_TOTAL_CENTS)}</dd>
                  <dt className="muted">Seeded RMAs</dt>
                  <dd style={{ margin: 0 }} className="mono">{RMAS.map((r) => r.id).join(" · ")}</dd>
              </dl>
            </div>
          </div>
        </section>

        {/* 2 */}
        <section className="rule-top section" style={{ paddingTop: 24, paddingBottom: 48 }} aria-labelledby="s2">
          <div className="cols-2" style={{ alignItems: "start" }}>
            <div className="stack">
              <StepHead n="2" title="Mount the camera" id="s2" />
              <div className="prose">
                <p>
                  Use an iPhone as the Mac&apos;s webcam through Continuity Camera. Point the <strong>rear camera straight down, 60–80 cm above a matte mat</strong>,
                  so the whole mat is in frame and nothing glares.
                </p>
                <p className="well" style={{ borderLeft: "5px solid var(--accent)" }}>
                  Turn OFF Center Stage, Portrait, Studio Light and Desk View in Control Centre → Video Effects. They crop and reframe the picture and
                  would move the zones.
                </p>
                <p>Then test it. Pick the iPhone from the list; the list shows whatever cameras your browser can see.</p>
              </div>
            </div>
            <CameraTest />
          </div>
        </section>

        {/* 3 */}
        <section className="rule-top section" style={{ paddingTop: 24, paddingBottom: 48 }} aria-labelledby="s3">
          <div className="cols-2" style={{ alignItems: "start" }}>
            <div className="stack">
              <StepHead n="3" title="Mark the zones with tape" id="s3" />
              <div className="prose">
                <p>
                  Put tape on the mat so the camera sees two zones: <strong>BOX on the left, about 45%</strong> of the width, and{" "}
                  <strong>TRAY on the right, about 45%</strong>, with a 10% gap between them.
                </p>
                <p>
                  Items come out of the box on the left and are put down in the tray on the right. An item counts when it settles in the tray, not
                  when a hand passes over it.
                </p>
              </div>
            </div>
            <ZoneStrip />
          </div>
        </section>

        {/* 4 */}
        <section className="rule-top section" style={{ paddingTop: 24, paddingBottom: 48 }} aria-labelledby="s4">
          <div className="cols-2" style={{ alignItems: "start" }}>
            <div className="stack">
              <StepHead n="4" title="Choose what routes to the bench" id="s4" />
              <div className="prose">
                <p>
                  The merchant decides which returns go to the bench. Clean, low-value returns skip it. Examples of rules you might choose:
                </p>
                <ul style={{ margin: "0 0 14px", paddingLeft: 20 }}>
                  <li>kits over $150</li>
                  <li>serialised items</li>
                </ul>
                <p>
                  In the demo, both seeded returns ({RMAS.map((r) => r.id).join(" and ")}) are already routed to the bench.
                </p>
              </div>
            </div>
            <div className="card">
              <span className="eyebrow">Run the first inspection</span>
              <h3 className="h3" style={{ margin: "6px 0 12px" }}>Open the bench and unbox one item at a time.</h3>
              <div className="row">
                <Link href="/dashboard/bench" className="btn btn-primary">Open the bench</Link>
                <Link href="/demo" className="btn btn-accent">Run the Instant Demo</Link>
              </div>
              <p className="muted" style={{ margin: "12px 0 0", fontSize: 14 }}>
                The Instant Demo plays a recorded result and does not make a live Meta call.
              </p>
            </div>
          </div>
        </section>
      </section>
    </>
  );
}
