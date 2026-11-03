/**
 * Selective dispatch: each optional specialist runs only when the box's evidence calls for it, and every skip carries its
 * reason. The selective-vs-always comparison is checked by hand on a three-box shift. A live answer that is malformed,
 * recorded for another box or role, or given for a box with nothing to read is rejected: the step shows the unavailable
 * state, app code stands in under an app-code label, and holds are kept.
 */
import { describe, expect, it } from "vitest";
import { POLICY } from "@/data/fixtures";
import { SEEDED_SHIFT, type SeededShift, type ShiftReturn } from "@/data/shift";
import { buildRoster, runShift, SPECIALISTS } from "@/lib/fleet/coordinator";
import { compareDispatch, compareRuns, LATENCY_P50_MS } from "@/lib/fleet/compare-dispatch";
import { decide, LABEL_REVIEW_BELOW, OPTIONAL_ROLES, triggerFor } from "@/lib/fleet/dispatch";
import { completeBoxNote, runMessageDrafter } from "@/lib/fleet/agents/message-drafter";
import { runInspector } from "@/lib/fleet/agents/inspector";
import { toReplay } from "@/lib/fleet/replay";
import type { ReturnCtx } from "@/lib/fleet/context";
import type { AgentSpec, FleetRecording, RecordedFleet, ReturnOutcome, RoleId } from "@/lib/fleet/types";

const ret = (id: string) => SEEDED_SHIFT.returns.find((r) => r.rma.id === id)!;
const variant = (id: string, newId: string, edit: (r: ShiftReturn) => void): ShiftReturn => {
  const r = structuredClone(ret(id));
  r.rma.id = newId;
  r.rma.clipId = `shift-${newId.toLowerCase()}`;
  edit(r);
  return r;
};
const shiftOf = (returns: ShiftReturn[]): SeededShift => ({ ...SEEDED_SHIFT, returns });
const full = runShift(SEEDED_SHIFT);
const out = (id: string, run = full) => run.outcomes.find((o) => o.rmaId === id)!;
const entry = (o: ReturnOutcome, role: RoleId) => o.dispatch.find((d) => d.role === role)!;
const spec = (role: RoleId) => buildRoster(SEEDED_SHIFT).find((a) => a.role === role)!;
const rec = (rmaId: string, role: RoleId, output: unknown, over: Partial<FleetRecording> = {}): FleetRecording => ({
  kind: "fleet",
  rmaId,
  role,
  mode: "LIVE_META",
  model: spec(role).model ?? "muse-spark-1.3",
  latencyMs: 1200,
  requestId: `resp_${role}`,
  recordedAt: "2026-10-29T12:00:00Z",
  ok: true,
  output,
  usage: { inputTokens: 100, outputTokens: 10 },
  costUsd: 0.002,
  ...over,
});

describe("selective dispatch: triggers and skip reasons per role", () => {
  it("records one entry per roster role on every box, and core roles run on every box", () => {
    const roster = buildRoster(SEEDED_SHIFT);
    for (const o of full.outcomes) {
      expect(o.dispatch).toHaveLength(SPECIALISTS.length + 1);
      expect(o.dispatch[0]).toMatchObject({ agent: `inspector-${o.rmaId.toLowerCase()}`, state: "ran" });
      for (const r of ["inspector", "damage-reader", "serial-matcher", "cost-agent", "coordinator"] as RoleId[]) expect(entry(o, r)).toMatchObject({ state: "ran", reason: expect.stringMatching(/^core/) });
      for (const d of o.dispatch) expect(d.reason.length).toBeGreaterThan(10);
      // An agent appears in agentsRun exactly when its entry says it ran.
      expect(o.agentsRun.filter((a) => roster.some((x) => x.name === a))).toEqual(o.dispatch.filter((d) => d.state === "ran" || d.state === "unavailable").map((d) => d.agent).sort((a, b) => o.agentsRun.indexOf(a) - o.agentsRun.indexOf(b)));
    }
  });

  it("label reader: only where a serial read is close to the bar, outside the format, or missing", () => {
    expect(entry(out("RMA-30116"), "label-reader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/lens read at 0\.64, under 0\.90/) });
    expect(entry(out("RMA-30101"), "label-reader")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/0\.90 or above and in the kit's format/) });
    // The swapped body reads confidently (0.93): the serial matcher still catches it without the label reader.
    expect(entry(out("RMA-30103"), "label-reader").state).toBe("skipped");
    expect(out("RMA-30103").holdReasons).toEqual(["camera_body:serial_mismatch"]);
    const odd = variant("RMA-30101", "RMA-T-FMT", (r) => {
      r.clip.labels.camera_body = { text: "CB 0001", confidence: 0.97 };
    });
    const unread = variant("RMA-30101", "RMA-T-NOREAD", (r) => {
      r.clip.labels.camera_body = null;
    });
    const near = variant("RMA-30101", "RMA-T-NEAR", (r) => {
      r.clip.labels.lens = { text: r.order.slip.lines.find((l) => l.itemKey === "lens")!.serial!, confidence: 0.85 };
    });
    const run = runShift(shiftOf([odd, unread, near]));
    expect(entry(run.outcomes[0], "label-reader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/outside the serial format/) });
    expect(entry(run.outcomes[1], "label-reader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/no label read on the camera body/) });
    expect(entry(run.outcomes[2], "label-reader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/0\.85, under 0\.90/) });
    expect(LABEL_REVIEW_BELOW).toBe(0.9);
  });

  it("voice-note reader: only when there is a note", () => {
    expect(entry(out("RMA-30113"), "voice-note-reader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/the lead left a note/) });
    expect(entry(out("RMA-30101"), "voice-note-reader")).toMatchObject({ state: "skipped", reason: "no voice note on this box" });
  });

  it("carrier-claim agent: only with a damaged item or transit evidence", () => {
    expect(entry(out("RMA-30107"), "carrier-claim-agent")).toMatchObject({ state: "ran", reason: expect.stringMatching(/dented camera body \+ carrier scan .*\+ outer carton crushed/) });
    expect(entry(out("RMA-30106"), "carrier-claim-agent")).toMatchObject({ state: "ran", reason: expect.stringMatching(/Rita Calder said/) });
    expect(entry(out("RMA-30101"), "carrier-claim-agent")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/no damaged item and no transit evidence/) });
  });

  it("policy agent: past or near the window, wear, or a held line; the window arithmetic still runs as code on a skipped box", () => {
    expect(entry(out("RMA-30110"), "policy-agent")).toMatchObject({ state: "ran", reason: expect.stringMatching(/43 days since delivery, past the 30-day window/) });
    expect(entry(out("RMA-30107"), "policy-agent")).toMatchObject({ state: "ran", reason: expect.stringMatching(/wear on camera body.*held/) });
    expect(entry(out("RMA-30101"), "policy-agent")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/^20 of 30 days, no wear, every line OK/) });
    const at = (days: number) =>
      variant("RMA-30101", `RMA-T-D${days}`, (r) => {
        r.order.deliveredAt = new Date(Date.parse(r.receivedAt) - days * 86_400_000 - 3_600_000).toISOString();
      });
    const run = runShift(shiftOf([at(24), at(25), at(30), at(31)]));
    expect(run.outcomes.map((o) => entry(o, "policy-agent").state)).toEqual(["skipped", "ran", "ran", "ran"]);
    expect(entry(run.outcomes[1], "policy-agent").reason).toMatch(/25 days since delivery, within 5 of the 30-day window/);
    // 31 days: the late hold is the policy agent's, and it ran because the trigger did the same arithmetic.
    expect(run.outcomes[3].holdReasons).toContain("camera_body:outside_window");
    expect(run.outcomes[2].holdReasons).toEqual([]);
  });

  it("restock grader: a complete box, or an item to divert now; a held box waits for the person", () => {
    expect(entry(out("RMA-30101"), "restock-grader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/complete box: 3 item\(s\)/) });
    expect(entry(out("RMA-30103"), "restock-grader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/divert now: camera body \(the serial doesn't tie/) });
    for (const id of ["RMA-20418", "RMA-30107", "RMA-30110", "RMA-30113", "RMA-30116"]) {
      expect(entry(out(id), "restock-grader")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/held for a person: grading waits/) });
      expect(out(id).restock).toBeNull();
    }
    const hazard = variant("RMA-30101", "RMA-T-HAZ", (r) => {
      r.voiceNote = { ...ret("RMA-30113").voiceNote!, transcript: "The battery is swollen." };
    });
    expect(entry(runShift(shiftOf([hazard])).outcomes[0], "restock-grader")).toMatchObject({ state: "ran", reason: expect.stringMatching(/divert now: battery \(the lead flagged it as a battery hazard\)/) });
  });

  it("customer-message drafter: held boxes and claims; a complete box gets the fixed app-code note, word for word the template", () => {
    expect(entry(out("RMA-30107"), "customer-message-drafter")).toMatchObject({ state: "ran", reason: expect.stringMatching(/held/) });
    const clean = out("RMA-30101");
    expect(entry(clean, "customer-message-drafter")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/complete box/) });
    expect(clean.message.by).toMatch(/app-code note for a complete box/);
    const ctx: ReturnCtx = { ret: ret("RMA-30101"), settings: SEEDED_SHIFT.settings, policy: POLICY, up: {} };
    ctx.up.inspector = runInspector(ctx).output;
    expect(clean.message.text).toBe(runMessageDrafter({ ...ctx, lines: ctx.up.inspector.lines }).output.text);
    expect(clean.message.text).toBe(completeBoxNote(ctx));
  });

  it("always-run runs every role on every box, naming what selective would have skipped", () => {
    const always = runShift(SEEDED_SHIFT, { dispatch: "always" });
    expect(always.dispatch).toBe("always");
    for (const o of always.outcomes) expect(o.dispatch.every((d) => d.state === "ran")).toBe(true);
    expect(entry(out("RMA-30101", always), "voice-note-reader").reason).toBe("always-run mode (selective skips it: no voice note on this box)");
    // The decision function says the same thing directly.
    const ctx: ReturnCtx = { ret: ret("RMA-30101"), settings: SEEDED_SHIFT.settings, policy: POLICY, up: {} };
    expect(decide("voice-note-reader", ctx, "always")).toMatchObject({ run: true, missingEvidence: "no voice note on this box" });
    expect(decide("voice-note-reader", ctx, "selective")).toMatchObject({ run: false, inputMissing: true });
    expect(decide("serial-matcher", ctx, "selective")).toMatchObject({ run: true, reason: expect.stringMatching(/^core/) });
    for (const r of OPTIONAL_ROLES) expect(typeof triggerFor(r, ctx).reason).toBe("string");
  });

  it("selective dispatch never changes a hold, an amount, a claim or a route on the seeded shift (app-code outputs)", () => {
    const always = runShift(SEEDED_SHIFT, { dispatch: "always" });
    full.outcomes.forEach((o, i) => {
      const a = always.outcomes[i];
      expect(o.holdReasons).toEqual(a.holdReasons);
      expect(o.proposedRefundCents).toBe(a.proposedRefundCents);
      expect(o.claim).toEqual(a.claim);
      expect(o.route).toEqual(a.route);
    });
  });
});

describe("selective vs always-run, computed by hand on a three-box shift", () => {
  // RMA-30101 complete · RMA-30107 transit dent (claim) · RMA-30113 lens cap the lead mentions.
  const small = shiftOf([ret("RMA-30101"), ret("RMA-30107"), ret("RMA-30113")]);
  const c = compareDispatch(small);
  const cost = (role: RoleId) => spec(role).costPerRunUsd;
  const S = LATENCY_P50_MS["muse-spark-1.3"];
  const W = LATENCY_P50_MS["muse-wonder-1.0"];
  const modelRoles = buildRoster(small).filter((a: AgentSpec) => a.kind === "model");

  it("counts runs, model calls and skips", () => {
    // 30101: inspector, damage, serial, restock, cost, coordinator (skips label, voice, claim, policy, drafter).
    // 30107: inspector, damage, serial, claim, policy, drafter, cost, coordinator (skips label, voice, restock).
    // 30113: inspector, damage, voice, serial, policy, drafter, cost, coordinator (skips label, claim, restock).
    expect(c.selective).toMatchObject({ roleRuns: 6 + 8 + 8, modelCalls: 2 + 4 + 4, skipped: 5 + 3 + 3, skippedModelCalls: 11 });
    expect(c.always).toMatchObject({ roleRuns: 3 * 11, modelCalls: 3 * 7, skipped: 0, skippedModelCalls: 0 });
  });

  it("prices each mode from the roles' token budgets", () => {
    const sel = 3 * cost("damage-reader") + cost("restock-grader") + cost("carrier-claim-agent") + 2 * cost("policy-agent") + 2 * cost("customer-message-drafter") + cost("voice-note-reader");
    expect(c.selective.costUsd).toBeCloseTo(sel, 6);
    expect(c.always.costUsd).toBeCloseTo(3 * modelRoles.reduce((s, a) => s + a.costPerRunUsd, 0), 6);
  });

  it("latency: stages in parallel within a box, in sequence across stages; model time adds every call", () => {
    // Selective critical paths: 30101 damage → restock = 2S; 30107 damage → claim → policy → drafter = S + 3W; 30113 damage‖voice → policy → drafter = S + 2W.
    expect(c.selective.latencyPerBoxMs).toBe(Math.round((2 * S + (S + 3 * W) + (S + 2 * W)) / 3));
    // Always-run: S (stage 1) + W (claim) + W (policy) + max(S, W) (restock ‖ drafter) on every box.
    expect(c.always.latencyPerBoxMs).toBe(Math.round(S + 2 * W + Math.max(S, W)));
    expect(c.selective.modelSeconds).toBeCloseTo((5 * S + 5 * W) / 1000, 1);
    expect(c.always.modelSeconds).toBeCloseTo((12 * S + 9 * W) / 1000, 1);
  });

  it("reports what selective missed: six restock grades on the two held boxes, no hold, claim or note; no added holds", () => {
    expect(c.missed.holds).toEqual([]);
    expect(c.missed.claims).toEqual([]);
    expect(c.missed.drafts.map((d) => [d.rmaId, d.kind])).toEqual([
      ["RMA-30107", "restock"],
      ["RMA-30107", "restock"],
      ["RMA-30107", "restock"],
      ["RMA-30113", "restock"],
      ["RMA-30113", "restock"],
      ["RMA-30113", "restock"],
    ]);
    expect(c.missed.drafts[0].detail).toBe("camera body C → Refurbish or parts");
    expect(c.addedFalseHolds).toEqual([]);
    expect(c.refundDeltaCents).toBe(0);
    expect(c.byRole.find((r) => r.role === "restock-grader")).toMatchObject({ ranSelective: 1, ranAlways: 3, skipped: 2 });
  });

  it("a hold only a skipped role would have found is reported as missed, never hidden", () => {
    // A live label read that sees glare on a confident (0.92) read: always-run uses it, selective never calls the label reader.
    const recorded: RecordedFleet = { "RMA-30101": { "label-reader": rec("RMA-30101", "label-reader", { reads: [{ itemKey: "camera_body", serialText: "BW-CB-56101", legible: true, why: "sharp" }, { itemKey: "lens", serialText: "BW-LN-81201", legible: false, why: "glare across the last digits" }] }) } };
    const withLive = compareDispatch(small, { recorded });
    expect(withLive.missed.holds).toEqual([{ rmaId: "RMA-30101", kind: "hold", detail: "lens · label_unreadable" }]);
    expect(withLive.selective.held).toBe(withLive.always.held - 1);
    expect(withLive.refundDeltaCents).toBeGreaterThan(0);
    // The replayed call's recorded cost replaces the estimate in always-run.
    expect(withLive.always.costUsd).toBeCloseTo(c.always.costUsd - cost("label-reader") + 0.002, 6);
  });

  it("a hold selective adds is counted as a false hold", () => {
    const sel = runShift(small);
    const always = runShift(small, { dispatch: "always" });
    const extra = { ...sel, outcomes: sel.outcomes.map((o, i) => (i === 0 ? { ...o, lines: o.lines.map((l, k) => (k === 0 ? { ...l, status: "HELD" as const, reasons: [...l.reasons, { code: "condition_review" as const, detail: "x", by: "x" }] } : l)) } : o)) };
    expect(compareRuns(extra, always).addedFalseHolds).toEqual([{ rmaId: "RMA-30101", kind: "hold", detail: "camera_body · condition_review" }]);
  });

  it("the seeded shift: selective makes fewer model calls, misses no hold or claim, and lists every missed draft", () => {
    const s = compareDispatch(SEEDED_SHIFT);
    expect(s.selective.modelCalls).toBeLessThan(s.always.modelCalls);
    expect(s.selective.costUsd).toBeLessThan(s.always.costUsd);
    expect(s.selective.latencyPerBoxMs).toBeLessThan(s.always.latencyPerBoxMs);
    expect(s.missed.holds).toEqual([]);
    expect(s.missed.claims).toEqual([]);
    expect(s.addedFalseHolds).toEqual([]);
    expect(new Set(s.missed.drafts.map((d) => d.rmaId))).toEqual(new Set(["RMA-20418", "RMA-30107", "RMA-30110", "RMA-30113", "RMA-30116"]));
    expect(s.missed.drafts.every((d) => d.kind === "restock")).toBe(true);
  });
});

describe("a live answer that can't be used shows as unavailable; app code stands in and holds are kept", () => {
  const replayStep = (run: ReturnType<typeof runShift>, id: string, agent: string) => toReplay(run, SEEDED_SHIFT).returns.find((r) => r.rmaId === id)!.steps.find((s) => s.agent === agent)!;

  it("malformed answer → unavailable (malformed), never shown as recorded live output", () => {
    const run = runShift(SEEDED_SHIFT, { recorded: { "RMA-30116": { "label-reader": rec("RMA-30116", "label-reader", { reads: "all fine" }) } } });
    const o = out("RMA-30116", run);
    expect(o.traces.find((t) => t.role === "label-reader")).toMatchObject({ source: "live_rejected", unavailable: { kind: "malformed", reason: "schema validation failed" } });
    expect(entry(o, "label-reader")).toMatchObject({ state: "unavailable", modelCall: true, reason: expect.stringMatching(/live answer unavailable \(schema validation failed\); app code stands in/) });
    expect(o.lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");
    expect(o.workItems.map((w) => w.text).join()).toMatch(/label-reader: live answer unavailable/);
    expect(replayStep(run, "RMA-30116", "label-reader")).toMatchObject({ source: "live_rejected", unavailable: { kind: "malformed" } });
    expect(toReplay(run, SEEDED_SHIFT).returns.flatMap((r) => r.steps).some((s) => s.source === "recorded_live")).toBe(false);
  });

  it("wrong case: an answer recorded for another box, or for another role, is rejected", () => {
    const good = { reads: [{ itemKey: "camera_body", serialText: "BW-CB-56116", legible: true, why: "ok" }, { itemKey: "lens", serialText: "BW-LN-81216", legible: true, why: "ok" }] };
    const otherBox = runShift(SEEDED_SHIFT, { recorded: { "RMA-30116": { "label-reader": rec("RMA-30117", "label-reader", good) } } });
    expect(out("RMA-30116", otherBox).traces.find((t) => t.role === "label-reader")!.unavailable).toEqual({ kind: "wrong_case", reason: "answer recorded for RMA-30117, not RMA-30116" });
    expect(out("RMA-30116", otherBox).holdReasons).toEqual(["lens:label_unreadable"]);
    const otherRole = runShift(SEEDED_SHIFT, { recorded: { "RMA-30116": { "label-reader": rec("RMA-30116", "damage-reader", good) } } });
    expect(out("RMA-30116", otherRole).traces.find((t) => t.role === "label-reader")!.unavailable?.kind).toBe("wrong_case");
  });

  it("missing evidence: a live claim for a box with no damage or transit evidence is rejected (always-run), and never even consulted under selective", () => {
    const recorded: RecordedFleet = { "RMA-30101": { "carrier-claim-agent": rec("RMA-30101", "carrier-claim-agent", { fileClaim: true, damagedItems: ["camera_body"], evidence: ["looks damaged"], summary: "claim it" }) } };
    const always = out("RMA-30101", runShift(SEEDED_SHIFT, { recorded, dispatch: "always" }));
    expect(always.traces.find((t) => t.role === "carrier-claim-agent")!.unavailable).toMatchObject({ kind: "missing_evidence", reason: expect.stringMatching(/missing evidence: no damaged item and no transit evidence/) });
    expect(always.claim).toBeNull();
    expect(always.route.queues).toEqual(["approve_refund"]);
    const sel = out("RMA-30101", runShift(SEEDED_SHIFT, { recorded }));
    expect(entry(sel, "carrier-claim-agent").state).toBe("skipped");
    expect(sel.claim).toBeNull();
  });

  it("a recorded timeout on an optional specialist: unavailable (timeout), the box still goes to a person with its holds", () => {
    const recorded: RecordedFleet = { "RMA-30113": { "voice-note-reader": rec("RMA-30113", "voice-note-reader", null, { ok: false, error: "timeout after 90000 ms", timedOut: true, latencyMs: 90_000, usage: { inputTokens: null, outputTokens: null }, costUsd: null, input: { transcript: ret("RMA-30113").voiceNote!.transcript } }) } };
    const run = runShift(SEEDED_SHIFT, { recorded });
    const o = out("RMA-30113", run);
    expect(o.traces.find((t) => t.role === "voice-note-reader")!.unavailable).toEqual({ kind: "timeout", reason: "timeout after 90000 ms" });
    expect(entry(o, "voice-note-reader").state).toBe("unavailable");
    expect(o.holdReasons).toEqual(["lens:spoken_claim"]);
    expect(o.route.queues).toContain("hold_review");
    expect(o.requiresPerson).toBe(true);
    expect(o.workItems.map((w) => w.text).join()).toMatch(/voice-note-reader: live answer unavailable \(timeout after 90000 ms\)/);
  });
});
