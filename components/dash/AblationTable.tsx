import { formatCents } from "@/lib/format";
import { EFFECTS, type AblationReport, type Effect, type EffectClass } from "@/lib/fleet/ablation";

const EFFECT_TEXT: Record<Effect, string> = { hold: "Hold", amount: "Amount", claim: "Claim", route: "Route", artifact: "Artifact", cost: "Fees" };
const CLASS_TEXT: Record<EffectClass, string> = { decision: "decision", artifact_only: "artifact only", cost_only: "fees only", none: "no effect" };
const signed = (c: number) => (c === 0 ? "—" : `${c > 0 ? "+" : "−"}${formatCents(Math.abs(c))}`);

/** The frozen-output, per-role ablation of the seeded shift (lib/fleet/ablation.ts). Server-rendered; deterministic. */
export function AblationTable({ report }: { report: AblationReport }) {
  const isolated = report.inspectorInstances.filter((i) => i.onlyOwnReturn).length;
  const reach = report.inspectorInstances.filter((i) => !i.onlyOwnReturn).map((i) => i.rmaId);
  const live = report.frozenSources.recorded_live;
  return (
    <section className="stack" style={{ gap: 8 }} id="ablation" aria-labelledby="ablation-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" id="ablation-title">
          Ablation: what each agent changes, by effect
        </h2>
        <span className="mode mode-det">DETERMINISTIC · app code, no model</span>
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
        One run of the seeded shift ({report.baseline.returns} boxes, {report.agents} names, the per-box inspectors one code path, {report.dispatch} dispatch) freezes every model role&apos;s output: {report.modelRunsToFreeze} runs,{" "}
        {live ? `${live} of them recorded live Meta answers` : "all app code (no live run recorded yet)"}. Each role is then removed and the shift replayed on those frozen outputs, so no other model role is re-run ({report.modelRunsDuringAblation} model runs during the removals). Counting, serial matching, the merge, the settlement and routing are app code and do re-run. Each column counts the boxes where that kind of result changed.
      </p>
      <div className="table-wrap">
        <table className="table table-dense" aria-label="Per-role frozen-output ablation by effect type">
          <thead>
            <tr>
              <th>Role removed</th>
              {EFFECTS.map((e) => (
                <th key={e} className="num">
                  {EFFECT_TEXT[e]}
                </th>
              ))}
              <th className="num">Δ proposed</th>
              <th className="num">Δ claims</th>
              <th>Effect</th>
              <th className="num">Own runs</th>
            </tr>
          </thead>
          <tbody>
            {report.roles.map((r) => (
              <tr key={r.role}>
                <td style={{ whiteSpace: "nowrap" }}>
                  {r.role}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {r.kind === "model" ? `model · live: ${r.model}` : "code"}
                    {r.agents.length > 1 ? ` · ${r.agents.length} agents` : ""}
                  </div>
                </td>
                {EFFECTS.map((e) => (
                  <td key={e} className="num">
                    <span className={r.byEffect[e] ? "" : "muted"}>{r.byEffect[e] || "·"}</span>
                  </td>
                ))}
                <td className="num">{signed(r.refundDeltaCents)}</td>
                <td className="num">{signed(r.claimDeltaCents)}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <span className={r.flaggedForCut ? "st st-held" : r.effectClass === "decision" ? "st st-ok" : "st st-warn"}>{CLASS_TEXT[r.effectClass]}</span>
                  {r.flaggedForCut && <div className="st st-held" style={{ fontSize: 11 }}>flagged for cutting</div>}
                </td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {r.ownRuns}
                  {r.kind === "model" ? <div className="muted" style={{ fontSize: 12 }}>${r.ownCostUsd.toFixed(3)} est.</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, maxWidth: "80ch" }}>
        <li>
          Hold, amount, claim and route are decision effects: they change what a person is asked to approve or where the box goes. Artifact (restock grades, the customer note, work items) and fees changes are reported, but a draft disappearing is not money or loss prevented, and a role&apos;s own model cost disappearing is never counted as an effect (it is the last column).
        </li>
        <li>
          Δ proposed: what the settlement would propose without the role, minus what it proposes with it, summed over the shift. Positive means money a person would have been asked to release that this role held back. Removing the inspectors holds every line, so nothing is proposed.
        </li>
        <li>
          Frozen outputs measure each role&apos;s direct effect. Without the damage reader the frozen carrier claim and restock grades stay as they were; re-running those roles without it would need new model calls, so that knock-on effect is not counted here.
        </li>
        <li>
          The roster rule: a role whose removal changes nothing is cut.{" "}
          {report.flagged.length ? <strong>Flagged for cutting (no effect of any type on this shift): {report.flagged.join(", ")}. </strong> : <strong>Every shipped role changes something. </strong>}
          {report.artifactOrFeesOnly.length ? (
            <>
              {report.artifactOrFeesOnly.join(", ")} change{report.artifactOrFeesOnly.length === 1 ? "s" : ""} no decision, but removing {report.artifactOrFeesOnly.length === 1 ? "it" : "each"} removes work a person uses (a restock grade, the customer note, the fees line), so they stay, labelled &ldquo;artifact only&rdquo; or &ldquo;fees only&rdquo;.
            </>
          ) : null}
        </li>
        <li>
          Each inspector removed on its own: {isolated} of {report.inspectorInstances.length} change only their own box{reach.length ? `; removing the inspector for ${reach.join(" or ")} also changes another box` : ""}.
        </li>
        {report.cutRoles.map((c) => (
          <li key={c.role}>
            <strong>Cut: {c.name}.</strong> Added back on the frozen outputs, it changes {c.returnsChangedWhenAdded} box{c.returnsChangedWhenAdded === 1 ? "" : "es"}, {c.usefulBoxesWhenAdded} with a decision effect ({CLASS_TEXT[c.effectClassWhenAdded]}). {c.why}
          </li>
        ))}
      </ul>
      <span className="fixture-label">{report.label} · scenarios are a seeded shift, not real returns · npx tsx scripts/fleet-ablation.ts prints the same table</span>
    </section>
  );
}
