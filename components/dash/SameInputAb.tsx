import { LOSSES, type AbReport, type ArmTotals, type Outcome, type Truth } from "@/lib/evals/same-input-ab";
import type { StressReport } from "@/lib/evals/stress";
import { AB_RUN_NOTES, misreadsFor } from "@/data/known-misreads";

const TRUTH_TEXT: Record<Truth, string> = { must_hold: "item missing: must hold", hold_acceptable: "complete; a hold is acceptable", complete: "complete" };
const OUTCOME_TEXT: Record<Outcome, string> = {
  correct_hold: "correct hold",
  correct_refund: "correct refund",
  accepted_hold: "accepted hold",
  wrong_refund: "WRONG REFUND",
  false_hold: "false hold",
  no_answer: "no answer",
};
const outcomeClass = (o: Outcome) => (o === "wrong_refund" ? "st st-held" : LOSSES.has(o) ? "st st-warn" : "st st-ok");
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

/**
 * "Safety, and its price": the counter's silent count errors beside its false holds on complete kits (the cost of
 * caution: a customer waits for a person), from the deterministic stress sweep and, once run, the live A/B.
 */
// `ab` stays in the props for callers; the filmed clips' numbers are shown by SameInputAb, never under this badge.
export function SafetyPrice({ stress }: { stress: StressReport["summary"]; ab: AbReport | null }) {
  const silent = stress.missedItems + stress.overCounts;
  return (
    <section className="stack" style={{ gap: 8 }} id="safety-price" aria-labelledby="safety-price-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" id="safety-price-title">
          Safety, and what it costs
        </h2>
        <span className="mode mode-det">DETERMINISTIC · synthetic stress sweep, app code</span>
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
        When the counter isn&apos;t sure, the box goes to a person instead of being refunded. That caution is what keeps silent count errors at zero in the sweep below, and its price is paid by honest customers whose complete kit waits for a review. Both numbers sit side by side.
      </p>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{silent}</div>
          <div className="k">silent count errors in {stress.runs.toLocaleString("en-US")} runs: no refund drafted on a wrong count</div>
        </div>
        <div className="kpi">
          <div className="v">{stress.falseHolds.toLocaleString("en-US")}</div>
          <div className="k">
            false holds: {pct(stress.falseHolds, stress.completeKitRuns)} of {stress.completeKitRuns.toLocaleString("en-US")} complete-kit runs wait for a person
          </div>
        </div>
        <div className="kpi">
          <div className="v">{stress.worstForCustomers ? stress.worstForCustomers.falseHolds : 0}</div>
          <div className="k">{stress.worstForCustomers ? `of them from ${stress.worstForCustomers.perturbation.replace(/_/g, " ")} (${stress.worstForCustomers.severity})` : "no perturbation causes false holds"}</div>
        </div>
      </div>
      <span className="fixture-label">
        Synthetic segmentation with mask-level perturbations (scripts/stress-sweep.ts, the same rule as the gate). Silent errors count items; false holds count runs. The filmed clips&apos; numbers are the recorded A/B above, not this sweep.
      </span>
    </section>
  );
}

function TotalsRow({ name, t }: { name: string; t: ArmTotals }) {
  return (
    <tr>
      <td>
        <strong>{name}</strong>
      </td>
      <td className="num">
        <span className={t.wrongRefunds ? "st st-held" : "st st-ok"}>{t.wrongRefunds}</span>
      </td>
      <td className="num">{t.falseHolds}</td>
      <td className="num">{t.noAnswer}</td>
      <td className="num">
        {t.correct}/{t.clips}
      </td>
    </tr>
  );
}

/** The pre-registered same-input A/B: Muse Spark alone vs the full pipeline on the same clips, every loss kept. */
export function SameInputAb({ report, promptSha256 }: { report: AbReport | null; promptSha256: string }) {
  // Gate clips (g*) run the pipeline arm from the gate run's recorded SAM output, without the crop readers; bench returns (d*) live.
  const gateIds = report?.rows.filter((r) => r.clipId.startsWith("g")).map((r) => r.clipId) ?? [];
  const benchIds = report?.rows.filter((r) => r.clipId.startsWith("d")).map((r) => r.clipId) ?? [];
  return (
    <section className="stack" style={{ gap: 8 }} id="same-input-ab" aria-labelledby="same-input-ab-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" id="same-input-ab-title">
          Same frames, two answers: Muse Spark alone vs ReturnWitness
        </h2>
        <span className={report ? "mode mode-fixture" : "mode mode-det"}>{report ? "RECORDED LIVE RUN · Meta (SAM 3.1, Spark, Wonder) + open-weight auditor (Baseten) + Glimmer (Modal)" : "PRE-REGISTERED · not run yet"}</span>
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
        Would one strong model, asked &ldquo;is this kit complete? refund or hold?&rdquo;, do as well as the pipeline? Each filmed return goes to both: Muse Spark 1.3 alone with the four key frames, the packing slip and the policy, and the pipeline (SAM 3.1 on every frame, the tray counter, the Spark reader, the open-weight auditor on Baseten, the Glimmer label reader on Modal, the Wonder agent) on the same clip. The rule and the prompt were written down before either ran (evals/AB-SAME-INPUT-PREREG.md, prompt sha256 {promptSha256.slice(0, 12)}…); every loss stays on this page.
      </p>
      {report ? (
        <>
          <p style={{ margin: 0, fontSize: 17 }}>
            On n={report.totals.armA.clips} filmed clips: Muse Spark alone <strong>{report.totals.armA.correct}/{report.totals.armA.clips}</strong> correct ({report.totals.armA.wrongRefunds} wrong refunds, {report.totals.armA.falseHolds} false holds); the pipeline <strong>{report.totals.armB.correct}/{report.totals.armB.clips}</strong> ({report.totals.armB.wrongRefunds} wrong refunds, {report.totals.armB.falseHolds} false hold{report.totals.armB.falseHolds === 1 ? "" : "s"}).
          </p>
          {gateIds.length > 0 && benchIds.length > 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: "80ch" }}>
              The pipeline arm was not run the same way on every clip: on the gate clips ({gateIds.join(", ")}) it replayed the gate run&apos;s SAM output and ran without the open-weight auditor and Glimmer, which read the crops of a live bench inspection only; on {benchIds.join(" and ")} both were called{AB_RUN_NOTES[report.runId] ? ` (${AB_RUN_NOTES[report.runId]})` : ""}. {gateIds.includes("g1") ? "g1 shows the same camera the auditor flagged on d2, so the pipeline's score on g1 is flattering." : ""}
            </p>
          )}
          <div className="table-wrap">
            <table className="table" aria-label="Same-input A/B totals per arm">
              <thead>
                <tr>
                  <th>Arm</th>
                  <th className="num">Wrong refunds</th>
                  <th className="num">False holds</th>
                  <th className="num">No answer</th>
                  <th className="num">Correct</th>
                </tr>
              </thead>
              <tbody>
                <TotalsRow name="Muse Spark 1.3 alone" t={report.totals.armA} />
                <TotalsRow name="ReturnWitness pipeline" t={report.totals.armB} />
                {report.totalsWithoutCalibration && (
                  <>
                    <TotalsRow name={`Spark alone, without ${report.calibrationClip}`} t={report.totalsWithoutCalibration.armA} />
                    <TotalsRow name={`Pipeline, without ${report.calibrationClip}`} t={report.totalsWithoutCalibration.armB} />
                  </>
                )}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="table table-dense" aria-label="Same-input A/B, every clip">
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>What was in the box</th>
                  <th>Spark alone</th>
                  <th>Pipeline</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.clipId}>
                    <td>
                      {r.clipId}
                      {r.clipId === report.calibrationClip && (
                        <div style={{ fontSize: 13 }} className="muted">
                          calibration clip: the pipeline&apos;s item sizes were measured on it
                        </div>
                      )}
                    </td>
                    <td>{TRUTH_TEXT[r.truth]}</td>
                    <td>
                      <span className={outcomeClass(r.armA.outcome)}>{OUTCOME_TEXT[r.armA.outcome]}</span>
                      <div style={{ fontSize: 13 }} className="muted">
                        {r.armA.error ?? `${r.armA.decision}${r.armA.missingItemKeys.length ? ` · missing: ${r.armA.missingItemKeys.join(", ")}` : ""}${r.armA.reason ? ` · “${r.armA.reason}”` : ""}`}
                      </div>
                    </td>
                    <td>
                      <span className={outcomeClass(r.armB.outcome)}>{OUTCOME_TEXT[r.armB.outcome]}</span>
                      <div style={{ fontSize: 13 }} className="muted">
                        {r.armB.error ?? `${r.armB.state}${r.armB.holdCodes.length ? ` · ${r.armB.holdCodes.join(", ")}` : ""}`}
                      </div>
                      {misreadsFor(r.clipId).map((m) => (
                        <div key={m.id} style={{ fontSize: 13 }} className="loss-note">
                          {m.said} · <strong>{m.loss}</strong>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.notFilmed?.length ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Not filmed, so not scored: {report.notFilmed.join(", ")}. {report.rows.length} returns can show the two arms differ on these boxes; they can&apos;t give a rate.
            </p>
          ) : null}
          <span className="fixture-label">
            &ldquo;Refund&rdquo; is each arm&apos;s answer before a person: in ReturnWitness no refund moves without a typed-name, single-use signed approval. Spark alone ${report.costUsd.armA.toFixed(2)}, pipeline on the gate clips ${report.costUsd.armB.toFixed(2)}.
          </span>
        </>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label="Same-input A/B, the pre-registered scoring">
            <thead>
              <tr>
                <th>Answer</th>
                <th>Item missing</th>
                <th>Complete, a hold is acceptable</th>
                <th>Complete</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>hold</td>
                <td>correct hold</td>
                <td>accepted hold</td>
                <td>
                  <span className="st st-warn">false hold</span>
                </td>
              </tr>
              <tr>
                <td>refund</td>
                <td>
                  <span className="st st-held">wrong refund</span>
                </td>
                <td>correct refund</td>
                <td>correct refund</td>
              </tr>
              <tr>
                <td>call failed / out of schema</td>
                <td colSpan={3}>
                  <span className="st st-warn">no answer</span>: kept as a loss, never re-run
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
