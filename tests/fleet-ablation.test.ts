/**
 * Frozen-output ablation. One run freezes every model role's output; each role is then removed and the shift replayed on
 * the frozen outputs without re-running any other model role. Effects are compared per box and by type; a role with no
 * decision effect (hold, amount, claim, route) is flagged for cutting; a role already cut is re-checked by adding it back.
 */
import { describe, expect, it } from "vitest";
import { KIT_TOTAL_CENTS } from "@/data/kit.config";
import { SEEDED_SHIFT } from "@/data/shift";
import { classifyEffects, effectsOf, runAblation } from "@/lib/fleet/ablation";
import { buildRoster, CUT_ROLES, rolesOf, runShift } from "@/lib/fleet/coordinator";
import type { RecordedFleet, RoleId } from "@/lib/fleet/types";

const report = runAblation(SEEDED_SHIFT);
const role = (r: string) => report.roles.find((x) => x.role === r)!;

describe("ablation invariant", () => {
  it("covers every role in the shipped roster, and the roster has at least 30 agents", () => {
    expect(report.method).toBe("frozen-output");
    expect(report.roles.map((r) => r.role).sort()).toEqual(rolesOf(buildRoster(SEEDED_SHIFT)).sort());
    expect(report.agents).toBeGreaterThanOrEqual(30);
  });
  it("every shipped role still changes at least one box in some way", () => {
    expect(report.roles.filter((r) => r.returnsChanged === 0)).toEqual([]);
    expect(report.noEffect).toEqual([]);
  });
  it("flags only roles whose removal changes nothing; the restock grader, the drafter and the cost agent stay, labelled artifact/fees only", () => {
    expect(report.flagged).toEqual([]);
    for (const r of report.roles) expect(r.flaggedForCut).toBe(r.returnsChanged === 0);
    expect([...report.artifactOrFeesOnly].sort()).toEqual(["cost-agent", "customer-message-drafter", "restock-grader"]);
    expect(role("restock-grader").effectClass).toBe("artifact_only");
    expect(role("customer-message-drafter").effectClass).toBe("artifact_only");
    expect(role("cost-agent").effectClass).toBe("cost_only");
    for (const r of report.roles.filter((x) => !report.artifactOrFeesOnly.includes(x.role))) expect(r.effectClass).toBe("decision");
  });
  it("the cut role still has no decision effect when added back (the cut holds on this shift); its only effect is the inventory work item", () => {
    expect(report.cutRoles.map((c) => c.role)).toEqual(CUT_ROLES.map((c) => c.spec.role));
    for (const c of report.cutRoles) {
      expect(c.usefulBoxesWhenAdded).toBe(0);
      expect(["none", "artifact_only"]).toContain(c.effectClassWhenAdded);
    }
  });
  it("every inspector changes exactly its own return", () => {
    for (const i of report.inspectorInstances) expect(i).toMatchObject({ returnsChanged: 1, onlyOwnReturn: true });
  });
});

describe("frozen outputs: no other role's model output is re-run, and the result is reproducible", () => {
  it("model roles are computed once to freeze and never during the removals (counted with a spy)", () => {
    const calls: Array<[RoleId, string]> = [];
    const r = runAblation(SEEDED_SHIFT, { onModelRun: (role, rmaId) => calls.push([role, rmaId]) });
    const freezeOnly = runShift(SEEDED_SHIFT).outcomes.reduce((s, o) => s + o.dispatch.filter((d) => d.modelCall).length, 0);
    expect(r.modelRunsToFreeze).toBe(freezeOnly);
    expect(r.modelRunsDuringAblation).toBe(0);
    expect(calls).toHaveLength(freezeOnly);
    // Each (role, box) model step computed exactly once.
    expect(new Set(calls.map((c) => c.join("|"))).size).toBe(calls.length);
  });
  it("replaying a frozen set computes no model role, even with every role in the roster", () => {
    let n = 0;
    const frozen = runShift(SEEDED_SHIFT).frozen;
    runShift(SEEDED_SHIFT, { frozen, onModelRun: () => n++ });
    runShift(SEEDED_SHIFT, { frozen, remove: ["label-reader"], onModelRun: () => n++ });
    expect(n).toBe(0);
  });
  it("the frozen replay reproduces the run it was frozen from (no effect on any box)", () => {
    const run = runShift(SEEDED_SHIFT);
    const replayed = runShift(SEEDED_SHIFT, { frozen: run.frozen });
    run.outcomes.forEach((o, i) => expect(effectsOf(o, replayed.outcomes[i])).toEqual([]));
  });
  it("same inputs → the same report", () => {
    expect(runAblation(SEEDED_SHIFT)).toEqual(report);
  });
  it("a frozen live answer stays frozen: removing another role doesn't re-run or drop it", () => {
    // A recorded live damage read that sees a dent app code didn't (on a clean box).
    const recorded: RecordedFleet = {
      "RMA-30101": {
        "damage-reader": { kind: "fleet", rmaId: "RMA-30101", role: "damage-reader", mode: "LIVE_META", model: "muse-spark-1.3", latencyMs: 900, requestId: "resp_d", recordedAt: "2026-10-29T12:00:00Z", ok: true, output: { items: [{ itemKey: "lens", surface: "dented", detail: "cracked front element" }], outerBox: "intact" }, usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.01 },
      },
    };
    const r = runAblation(SEEDED_SHIFT, { recorded });
    expect(r.frozenSources.recorded_live).toBe(1);
    expect(r.modelRunsDuringAblation).toBe(0);
    // Removing the damage reader loses the live dent's hold on RMA-30101 as well as the seeded dent on RMA-30107.
    expect(r.roles.find((x) => x.role === "damage-reader")!.changedRmas).toEqual(["RMA-30101", "RMA-30107"]);
    // Removing the label reader leaves RMA-30101's frozen live hold in place.
    expect(r.roles.find((x) => x.role === "label-reader")!.changedRmas).toEqual(["RMA-30116"]);
  });
});

describe("what each role is responsible for (direct effects, frozen outputs)", () => {
  it("removing a hold-raising role can only raise the money proposed; removing the inspectors holds everything", () => {
    for (const r of report.roles.filter((x) => x.role !== "inspector")) expect(r.refundDeltaCents).toBeGreaterThanOrEqual(0);
    expect(role("inspector").refundDeltaCents).toBe(-report.baseline.proposedRefundCents);
  });
  it("label reader: the smudged lens label (RMA-30116) would be proposed for a full refund without it", () => {
    expect(role("label-reader").changedRmas).toEqual(["RMA-30116"]);
    expect(role("label-reader").refundDeltaCents).toBe(KIT_TOTAL_CENTS);
    expect(role("label-reader").holdsLost).toBe(1);
  });
  it("serial matcher: the swapped body (RMA-30103) would pass without it", () => {
    expect(role("serial-matcher").changedRmas).toEqual(["RMA-30103"]);
    expect(role("serial-matcher").refundDeltaCents).toBe(KIT_TOTAL_CENTS);
  });
  it("damage reader: the dented body's hold is its direct effect; the frozen claim and grades stay", () => {
    const d = role("damage-reader");
    expect(d.changedRmas).toEqual(["RMA-30107"]);
    expect(d.byEffect.hold).toBe(1);
    expect(d.byEffect.claim).toBe(0);
    expect(d.byEffect.artifact).toBe(0);
  });
  it("voice-note reader: the lens cap the counter can't see (RMA-30113) is its decision effect; its carton notes are artifacts", () => {
    const v = role("voice-note-reader");
    expect(v.byEffect.hold).toBe(1);
    expect(v.usefulBoxes).toBe(1);
    expect(v.changedRmas).toContain("RMA-30113");
  });
  it("carrier-claim agent: changes the claim (and the carrier-desk route), never a hold or the money proposed", () => {
    const c = role("carrier-claim-agent");
    expect(c.byEffect.claim).toBe(1);
    expect(c.byEffect.hold).toBe(0);
    expect(c.refundDeltaCents).toBe(0);
    expect(c.claimDeltaCents).toBe(-report.baseline.claimCents);
  });
  it("policy agent: the late return (RMA-30110)", () => {
    expect(role("policy-agent").changedRmas).toEqual(["RMA-30110"]);
  });
  it("restock grader, message drafter and cost agent change artifacts or fees, not holds, money, claims or routes", () => {
    for (const r of ["restock-grader", "customer-message-drafter", "cost-agent"]) {
      for (const e of ["hold", "amount", "claim", "route"] as const) expect(role(r).byEffect[e]).toBe(0);
      expect(role(r).refundDeltaCents).toBe(0);
    }
    // Selective dispatch: the grader ran on 19 boxes, the drafter on the 6 held ones, the cost agent on all 24.
    expect(role("restock-grader").byEffect.artifact).toBe(19);
    expect(role("customer-message-drafter").byEffect.artifact).toBe(6);
    expect(role("cost-agent").byEffect.cost).toBe(24);
  });
  it("coordinator: without it nothing fans out, so only the inspectors' counts reach the queue", () => {
    expect(role("coordinator").returnsChanged).toBe(24);
    for (const o of runShift(SEEDED_SHIFT, { remove: ["coordinator"] }).outcomes) {
      expect(o.agentsRun).toEqual([`inspector-${o.rmaId.toLowerCase()}`]);
      expect(o.route.queues).toEqual(["unsorted"]);
    }
  });
  it("a role's own runs and cost are reported beside the effects, never as one", () => {
    expect(role("label-reader").ownRuns).toBe(1);
    expect(role("damage-reader").ownRuns).toBe(24);
    expect(role("damage-reader").ownCostUsd).toBeGreaterThan(0);
    expect(role("serial-matcher").ownCostUsd).toBe(0);
  });
});

describe("the comparison itself", () => {
  const full = runShift(SEEDED_SHIFT);
  it("ignores the agents' own cost estimate, where a step came from and the dispatch record (a role's own cost line disappearing is not an effect)", () => {
    const o = full.outcomes[0];
    expect(effectsOf(o, { ...o, agentCostUsd: o.agentCostUsd + 1, agentsRun: [], traces: [], dispatch: [] })).toEqual([]);
  });
  it("sees a one-cent change in the proposed refund and a changed hold reason, each as its own effect type", () => {
    const o = full.outcomes[1];
    expect(effectsOf(o, { ...o, proposedRefundCents: o.proposedRefundCents + 1 })).toEqual(["amount"]);
    const relabelled = { ...o, lines: o.lines.map((l, i) => (i === 0 ? { ...l, reasons: [...l.reasons, { code: "spoken_claim" as const, detail: "", by: "x" }] } : l)) };
    expect(effectsOf(o, relabelled)).toEqual(["hold"]);
  });
  it("a draft disappearing is an artifact effect, and artifact-only or fees-only changes are not useful", () => {
    const o = full.outcomes[1];
    expect(effectsOf(o, { ...o, restock: null })).toEqual(["artifact"]);
    expect(effectsOf(o, { ...o, message: { text: "other", by: "x" } })).toEqual(["artifact"]);
    expect(effectsOf(o, { ...o, workItems: [{ by: "x", text: "a new task" }] })).toEqual(["artifact"]);
    expect(effectsOf(o, { ...o, cost: null })).toEqual(["cost"]);
    expect(classifyEffects(["artifact"])).toBe("artifact_only");
    expect(classifyEffects(["cost"])).toBe("cost_only");
    expect(classifyEffects(["artifact", "cost"])).toBe("artifact_only");
    expect(classifyEffects([])).toBe("none");
    expect(classifyEffects(["artifact", "route"])).toBe("decision");
    expect(classifyEffects(["claim"])).toBe("decision");
  });
});
