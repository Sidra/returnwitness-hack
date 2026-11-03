/**
 * Prints the agent fleet's roster, the seeded shift's outcomes, selective dispatch vs always-run, and the frozen-output
 * per-role ablation.
 *   npx tsx scripts/fleet-ablation.ts            tables
 *   npx tsx scripts/fleet-ablation.ts --json     { ablation, dispatch } as JSON
 * No network, no keys, no spend. The shift is the [Seeded shift fixture · synthetic]; saved live Meta answers in data/recordings/fleet/ (if any) are replayed on their boxes.
 */
import { SEEDED_SHIFT } from "@/data/shift";
import { EFFECTS, runAblation } from "@/lib/fleet/ablation";
import { compareDispatch } from "@/lib/fleet/compare-dispatch";
import { buildRoster, runShift } from "@/lib/fleet/coordinator";
import { projectDaily } from "@/lib/fleet/projection";
import { fleetLiveQuote, loadFleetRecordings } from "@/lib/fleet/live";

const usd = (c: number) => `${c < 0 ? "-" : ""}${(Math.abs(c) / 100).toFixed(2)}`;

const recorded = loadFleetRecordings(SEEDED_SHIFT.returns.map((r) => r.rma.id));
const report = runAblation(SEEDED_SHIFT, { recorded });
const cmp = compareDispatch(SEEDED_SHIFT, { recorded });
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ablation: report, dispatch: cmp }, null, 2));
  process.exit(0);
}

const roster = buildRoster(SEEDED_SHIFT);
const run = runShift(SEEDED_SHIFT, { recorded });
console.log(`${SEEDED_SHIFT.label} ${SEEDED_SHIFT.shift.id}: ${roster.length} named agents, ${run.outcomes.length} returns, ${run.dispatch} dispatch\n`);

console.log("ROSTER");
for (const a of roster.filter((x) => x.role !== "inspector")) console.log(`  ${a.name.padEnd(26)} ${a.kind.padEnd(5)} ${(a.model ?? "-").padEnd(26)} ${a.costPerRunUsd.toFixed(6)} USD/run est.`);
console.log(`  inspector-rma-30101 … ${roster.filter((x) => x.role === "inspector").length} inspectors, code\n`);

console.log("OUTCOMES (shipped roster, selective dispatch)");
for (const o of run.outcomes) {
  const skipped = o.dispatch.filter((d) => d.state === "skipped").map((d) => d.agent.replace(/-agent$/, ""));
  console.log(`  ${o.rmaId}  ${o.lines.map((l) => `${l.itemKey}:${l.status}`).join(" ").padEnd(46)} propose ${usd(o.proposedRefundCents).padStart(7)}  ${o.route.queues.join("+").padEnd(30)} ${o.claim ? `claim ${usd(o.claim.claimCents)} ` : ""}skipped: ${skipped.join(", ") || "none"}`);
}
const b = report.baseline;
console.log(`\n  proposed ${usd(b.proposedRefundCents)} of ${usd(b.requestedCents)} requested; ${b.held}/${b.returns} held; ${b.claims} claim(s) ${usd(b.claimCents)}; est. recovery ${usd(b.recoveryCents)}\n`);

console.log("SELECTIVE DISPATCH vs ALWAYS-RUN (always-run is the reference)");
const row = (k: string, s: string | number, a: string | number) => console.log(`  ${k.padEnd(34)} ${String(s).padStart(12)} ${String(a).padStart(12)}`);
row("", "selective", "always-run");
row("role runs", cmp.selective.roleRuns, cmp.always.roleRuns);
row("model calls", cmp.selective.modelCalls, cmp.always.modelCalls);
row("skipped role runs (model calls)", `${cmp.selective.skipped} (${cmp.selective.skippedModelCalls})`, `${cmp.always.skipped} (${cmp.always.skippedModelCalls})`);
row("est. live model cost (USD)", cmp.selective.costUsd.toFixed(4), cmp.always.costUsd.toFixed(4));
row("model time, all calls (s)", cmp.selective.modelSeconds, cmp.always.modelSeconds);
row("latency per box, critical path (s)", (cmp.selective.latencyPerBoxMs / 1000).toFixed(1), (cmp.always.latencyPerBoxMs / 1000).toFixed(1));
row("held boxes", cmp.selective.held, cmp.always.held);
row("proposed (USD)", usd(cmp.selective.proposedRefundCents), usd(cmp.always.proposedRefundCents));
row("claims", `${cmp.selective.claims} (${usd(cmp.selective.claimCents)})`, `${cmp.always.claims} (${usd(cmp.always.claimCents)})`);
console.log(`\n  missed by selective: ${cmp.missed.holds.length} hold(s), ${cmp.missed.claims.length} claim(s), ${cmp.missed.drafts.length} draft(s); added false holds: ${cmp.addedFalseHolds.length}`);
for (const f of [...cmp.missed.holds, ...cmp.missed.claims, ...cmp.missed.drafts]) console.log(`    missed ${f.kind.padEnd(9)} ${f.rmaId}  ${f.detail}`);
for (const f of cmp.addedFalseHolds) console.log(`    added  hold      ${f.rmaId}  ${f.detail}`);
for (const r of cmp.byRole.filter((x) => x.skipped)) console.log(`  ${r.role.padEnd(26)} ran ${String(r.ranSelective).padStart(2)}/${r.ranAlways}  e.g. skipped: ${r.example}`);
console.log(`  latency basis: ${cmp.latencyBasis}\n`);

console.log(`ABLATION (frozen outputs: ${report.modelRunsToFreeze} model-role runs to freeze, ${report.modelRunsDuringAblation} during the removals; sources ${Object.entries(report.frozenSources).map(([k, v]) => `${k} ${v}`).join(", ")})`);
console.log(`  ${"role".padEnd(26)} ${"boxes".padStart(5)}  ${EFFECTS.map((e) => e.padStart(8)).join(" ")}   Δrefund   Δclaim  class`);
for (const r of report.roles) {
  console.log(`  ${r.role.padEnd(26)} ${String(r.returnsChanged).padStart(5)}  ${EFFECTS.map((e) => String(r.byEffect[e]).padStart(8)).join(" ")} ${usd(r.refundDeltaCents).padStart(9)} ${usd(r.claimDeltaCents).padStart(8)}  ${r.effectClass}${r.flaggedForCut ? "  FLAGGED FOR CUTTING" : ""}`);
}
const own = report.inspectorInstances.filter((i) => i.returnsChanged === 1 && i.onlyOwnReturn).length;
console.log(`\n  each inspector alone: ${own}/${report.inspectorInstances.length} change exactly their own return`);
console.log(report.flagged.length ? `  flagged for cutting (removal changes nothing of any type): ${report.flagged.join(", ")}` : "  every shipped role changes something; none is flagged for cutting");
if (report.artifactOrFeesOnly.length) console.log(`  stay, labelled artifact/fees only (no decision effect, but a person uses their output): ${report.artifactOrFeesOnly.join(", ")}`);
for (const c of report.cutRoles) console.log(`  cut from the roster: ${c.name}; added back it changes ${c.returnsChangedWhenAdded} box(es), ${c.usefulBoxesWhenAdded} with a useful effect (${c.effectClassWhenAdded}). ${c.why}`);
const q = fleetLiveQuote(3, roster);
console.log(
  `\nLIVE MODEL ROLES for d1–d3 (worst case; token budgets are estimates): ${q.spark.calls} Spark calls (~${q.spark.inTok.toLocaleString()} in / ${q.spark.outTok.toLocaleString()} out tokens per box) ${q.spark.usd.toFixed(3)} USD + ${q.wonder.calls} Wonder calls (~${q.wonder.inTok.toLocaleString()} in / ${q.wonder.outTok.toLocaleString()} out per box) ${q.wonder.usd.toFixed(3)} USD = ${q.totalUsd.toFixed(3)} USD`,
);

const p = projectDaily(run, roster, 500);
console.log(`\nPROJECTION at ${p.returnsPerDay} returns/day (from the seeded shift, selective dispatch): ${p.agentRunsPerDay.toLocaleString()} agent runs, ${p.namedInspectorsPerDay} inspectors, est. ${p.modelUsdPerDay.toFixed(2)} USD/day model + segmentation, ${p.usdPer30Days.toFixed(2)} USD per 30 days`);
