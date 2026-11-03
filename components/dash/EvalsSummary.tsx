import type { AbReport } from "@/lib/evals/same-input-ab";
import type { GateRun } from "@/lib/evals/real-gate";
import { misreadsFor } from "@/data/known-misreads";
import { LossNotes } from "./LossNotes";
import styles from "./EvalsSummary.module.css";

/**
 * The first screen of /dashboard/evals: two readable beats from the filmed clips, before any table or synthetic number.
 * 1. the registered gate's verdict (INCOMPLETE stays INCOMPLETE); 2. the same-input A/B with both arms, its caveat and
 * the complete kit's false hold, with the loss beside it.
 */
export function EvalsSummary({ gate, ab }: { gate: GateRun | null; ab: AbReport | null }) {
  const clips = gate?.clips ?? [];
  const gateIds = ab?.rows.filter((r) => r.clipId.startsWith("g")).map((r) => r.clipId) ?? [];
  const falseHolds = ab?.rows.filter((r) => r.armB.outcome === "false_hold") ?? [];
  return (
    <section className={styles.summary} aria-labelledby="evals-summary-title">
      <h2 className="h2" id="evals-summary-title">
        What the filmed clips showed
      </h2>
      <div className={styles.beats}>
        <div className={styles.beat}>
          <span className="eyebrow">1 · The registered gate</span>
          <p className={styles.big}>
            <span className={gate?.verdict === "PASS" ? "st st-ok" : gate?.verdict === "FAIL" ? "st st-held" : "st st-warn"}>{gate?.verdict ?? "NOT RUN"}</span>
          </p>
          {gate ? (
            <p className={styles.line}>
              {gate.notRun?.length ? <>Not run as registered: {gate.notRun.join(", ")} not filmed. </> : null}
              {clips.map((c) => `${c.clipId} ${c.pass ? "scored correctly" : "scored wrong"}${c.holdCodes.length ? ` (${c.holdCodes.join(", ")} hold)` : ""}`).join(" · ")}
            </p>
          ) : (
            <p className={styles.line}>No filmed gate clip has been scored yet.</p>
          )}
        </div>
        <div className={styles.beat}>
          <span className="eyebrow">2 · Same frames, two answers</span>
          {ab ? (
            <>
              <p className={styles.big}>
                Muse Spark alone {ab.totals.armA.correct}/{ab.totals.armA.clips} · pipeline {ab.totals.armB.correct}/{ab.totals.armB.clips}
              </p>
              <p className={styles.line}>
                n={ab.totals.armA.clips} filmed clips · wrong refunds: {ab.totals.armA.wrongRefunds} alone, {ab.totals.armB.wrongRefunds} pipeline · false holds: {ab.totals.armA.falseHolds} alone, {ab.totals.armB.falseHolds} pipeline
              </p>
              {gateIds.length > 0 && (
                <p className={styles.caveat}>
                  The pipeline arm was not run the same way on every clip: on {gateIds.join(" and ")} it ran without the open-weight auditor and Glimmer.{gateIds.includes("g1") ? " g1 shows the same camera the auditor flagged on d2, so the pipeline's score on g1 is flattering." : ""}
                </p>
              )}
            </>
          ) : (
            <p className={styles.line}>Pre-registered; not run yet.</p>
          )}
        </div>
      </div>
      {falseHolds.map((r) => (
        <div key={r.clipId} className={styles.loss}>
          <p className={styles.lossHead}>
            {r.clipId}, the complete kit: all three counted → HELD, a false hold.
          </p>
          <LossNotes items={misreadsFor(r.clipId)} />
        </div>
      ))}
      <p className="muted" style={{ margin: 0, fontSize: 15 }}>
        Per-clip tables, the synthetic clips and the stress sweep follow below.
      </p>
    </section>
  );
}
