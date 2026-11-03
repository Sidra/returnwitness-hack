"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type SystemStatus } from "@/lib/client/api";
import type { ReturnCase } from "@/lib/domain/case";
import { BenchStation } from "./BenchStation";
import { formatCents } from "@/lib/format";
import { KIT_TOTAL_CENTS } from "@/data/kit.config";
import { RMAS, lensItem } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { KNOWN_MISREADS } from "@/data/known-misreads";
import { ModeBadge } from "@/components/ModeBadge";
import { LossNotes } from "./LossNotes";
import styles from "./DemoFlow.module.css";

/** The d2 loss shown beside the false-hold sentence (data/known-misreads.ts). */
const D2_FALSE_HOLD = KNOWN_MISREADS.filter((m) => m.id === "d2-camera-toy");
const D1_CAMERA = KNOWN_MISREADS.filter((m) => m.id === "d1-camera-toy");

/**
 * The two outcomes, side by side, before any control: 2 of 3 counted → HELD, and 3 of 3 counted → still waits for a
 * person. On the recorded filmed run the complete kit was then held on a false stand-in flag; that loss stays beside it.
 */
function DemoOutcomes() {
  const [d1, d2] = [RMAS[0], RMAS[1]];
  const n = KIT.items.length;
  return (
    <section className={styles.outcomes} aria-labelledby="outcomes-title">
      <h2 id="outcomes-title" className="sr-only">The two outcomes</h2>
      <article className={styles.outcome} aria-labelledby="outcome-d1">
        <span className="eyebrow">
          <span className="mono">{d1.id}</span> · {d1.customer.name} · step 1
        </span>
        <h3 id="outcome-d1" className={styles.verdict}>
          <span className={styles.count}>{n - 1} of {n} counted</span>
          <span className={styles.arrow} aria-hidden>→</span>
          <span className="sticker-held">HELD</span>
        </h3>
        <p className={styles.body}>
          The {lensItem.name.toLowerCase()} never reached the tray (0/1). The whole {formatCents(d1.requestedRefundCents)} is held and waits for a person.
          A hold is not a denial.
        </p>
        <p className={styles.body}>
          On the recorded filmed run its camera line was also held, on the same false stand-in flag. Kept as a loss:
        </p>
        <LossNotes items={D1_CAMERA} />
      </article>
      <article className={styles.outcome} aria-labelledby="outcome-d2">
        <span className="eyebrow">
          <span className="mono">{d2.id}</span> · {d2.customer.name} · step 2
        </span>
        <h3 id="outcome-d2" className={styles.verdict}>
          <span className={styles.count}>{n} of {n} counted</span>
          <span className={styles.arrow} aria-hidden>→</span>
          <span className={styles.waits}>still waits for a person</span>
        </h3>
        <p className={styles.body}>
          All three items were counted into the tray. A complete kit does not refund by itself: only a person&apos;s single-use approval releases the{" "}
          {formatCents(d2.requestedRefundCents)}.
        </p>
        <div className={styles.falseHold}>
          <p className={styles.body}>
            <strong>On the recorded filmed run it was held anyway, a false hold:</strong> the open-weight auditor called the camera a toy, a false stand-in flag. Kept
            as a loss:
          </p>
          <LossNotes items={D2_FALSE_HOLD} />
        </div>
      </article>
      <div className={styles.provenance}>
        <ModeBadge mode="RECORDED_FIXTURE" realReplay />
        <span className="muted" style={{ fontSize: 14 }}>These two outcomes are from the recorded filmed runs. The steps below run each return again on its seeded order, and label every result.</span>
      </div>
    </section>
  );
}

export function DemoFlow() {
  const [run1, setRun1] = useState(0);
  const [run2, setRun2] = useState(0);
  const [c1, setC1] = useState<ReturnCase | null>(null);
  const [c2, setC2] = useState<ReturnCase | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  const live1 = Boolean(status?.liveSeeded?.includes("RMA-20418"));
  return (
    <div className="stack" style={{ gap: 48 }}>
      <DemoOutcomes />
      <div className="row">
        <button type="button" className="btn btn-accent" onClick={() => setRun1((k) => k + 1)}>
          {live1 ? "Inspect RMA-20418 live (Meta Model API)" : "Instant Demo: inspect RMA-20418"}
        </button>
        <span className="muted" style={{ fontSize: 15 }}>
          {live1
            ? "This server has the Meta key and the filmed clip: SAM 3.1, Muse Spark, Muse Wonder and Voice Transcribe run live, each result labelled LIVE · Meta with its model, time and request id."
            : "No camera, key or sign-in needed. Runs on the seeded order and its recorded clip, labelled on every result."}
        </span>
      </div>

      <section className="stack" style={{ gap: 16 }} aria-labelledby="s1">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Step 1 of 3</span>
          <h2 id="s1" className="h2">
            The {lensItem.name.toLowerCase()} never came back
          </h2>
          <p className="lead">
            Darius returns the {formatCents(KIT_TOTAL_CENTS)} kit and says everything is in the box. Watch the counter count what settles in the tray, then see what happens to the refund.
          </p>
        </div>
        <BenchStation guided initialRma="RMA-20418" autoRunKey={run1} onCase={setC1} />
      </section>

      <section className="stack rule-top" style={{ gap: 16, paddingTop: 24 }} aria-labelledby="s2">
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">Step 2 of 3{c1 ? "" : " · after step 1"}</span>
          <h2 id="s2" className="h2">A complete kit still waits for a person</h2>
          <p className="lead">
            Esme&apos;s return is complete: the camera, the lens and the charger all go into the tray. Ready or held, the refund waits for a person: they look, decide, and only their approval runs the refund in Stripe test mode.
          </p>
        </div>
        {c1 ? (
          <>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => setRun2((k) => k + 1)}>
                Inspect RMA-20419
              </button>
            </div>
            <BenchStation guided initialRma="RMA-20419" autoRunKey={run2} onCase={setC2} />
          </>
        ) : (
          <p className="muted">Run step 1 first.</p>
        )}
      </section>

      <section className="stack rule-top" style={{ gap: 16, paddingTop: 24 }} aria-labelledby="s3">
        <span className="eyebrow">Step 3 of 3{c2?.state === "Refunded" ? "" : " · after step 2"}</span>
        <h2 id="s3" className="h2">The person decides, once</h2>
        <p className="lead" style={{ margin: 0 }}>
          The camera and the models can only count and hold. Money moves only when a person approves, and that approval is a single-use token bound to this exact box&apos;s evidence.
        </p>
        <ol className="gate-steps">
          <li data-done={Boolean(c1)}>
            <strong>RMA-20418 · held.</strong>{" "}
            {c1 ? (c1.state === "Held" ? `${formatCents(c1.reconciliation?.summary.heldCents ?? 0)} held. Nothing refunded by itself; it waits for a person.` : c1.state) : "Not run yet."}
          </li>
          <li data-done={Boolean(c2?.approval)}>
            <strong>RMA-20419 · a person approved.</strong>{" "}
            {c2?.approval
              ? `${c2.approval.approver} approved ${formatCents(c2.approval.amountCents)}. That issued a single-use token, bound to evidence digest ${c2.approval.digest.slice(0, 12)}…, that expires ${Math.round((Date.parse(c2.approval.expiresAt) - Date.parse(c2.approval.issuedAt)) / 60000)} minutes after approval.`
              : "Waiting for a person to approve in step 2."}
          </li>
          <li data-done={c2?.state === "Refunded"}>
            <strong>The token is spent, once.</strong>{" "}
            {c2?.refund
              ? `It unlocked one refund, ${c2.refund.refundId} for ${formatCents(c2.refund.amountCents)} (Stripe test mode, no real funds moved). The same token used again is refused, and the refusal is kept on the case record.`
              : "After approval, the refund button spends the token."}
          </li>
        </ol>
        <p className="gate-close">No refund moves without a person&apos;s single-use approval.</p>
        <div className="row">
          {c2 && (
            <Link className="btn btn-primary" href={`/dashboard/cases/${c2.id}`}>
              See the approval in the decision trail
            </Link>
          )}
          {c1 && (
            <Link className="btn" href={`/dashboard/cases/${c1.id}`}>
              Open the held record
            </Link>
          )}
          <Link className="btn" href="/play">
            Return a box yourself
          </Link>
        </div>
      </section>
    </div>
  );
}
