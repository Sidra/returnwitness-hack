import { describe, expect, it } from "vitest";
import { CountResult } from "@/lib/domain/schemas";
import { returnWindowDays } from "@/lib/engine/reconcile";
import { formatCents } from "@/lib/format";
import { PRESETS, announce, benchFor, initialBench, runBench } from "@/lib/play/bench";
import { CAMERA, SCENARIOS, WALKER, scenarioById } from "@/lib/play/scenarios";

const walker = benchFor(WALKER);
const wPreset = (id: string) => walker.presets.find((p) => p.id === id)!.state;
const wLine = (id: string, key: string) => walker.runBench(wPreset(id)).recon.lines.find((l) => l.itemKey === key)!;
const DEPOSIT = WALKER.items.reduce((s, i) => s + i.unitPriceCents, 0);

describe("every /play setting runs the same engine", () => {
  for (const sc of Object.values(SCENARIOS)) {
    const b = benchFor(sc);
    it(`${sc.id}: every preset is a valid counter output and only the complete box is approvable`, () => {
      for (const p of b.presets) {
        expect(CountResult.safeParse(b.benchToCount(p.state)).success).toBe(true);
        expect(b.runBench(p.state).approvable).toBe(p.id === "complete");
      }
      expect(b.runBench(initialBench()).approvable).toBe(false);
    });
    it(`${sc.id}: the slip, kit and deposit/refund agree`, () => {
      expect(sc.slip.lines.map((l) => l.itemKey)).toEqual(sc.items.map((i) => i.key));
      expect(sc.rma.requestedRefundCents).toBe(sc.items.reduce((s, i) => s + i.unitPriceCents, 0));
      expect(Object.keys(sc.copy.options).sort()).toEqual(b.runBench(initialBench()).settlement.options.map((o) => o.key).sort());
    });
  }

  it("the camera setting through benchFor matches the module's own exports", () => {
    const cam = benchFor(CAMERA);
    for (const p of PRESETS) expect(JSON.stringify(cam.runBench(p.state).recon)).toBe(JSON.stringify(runBench(p.state).recon));
  });

  it("an unknown or missing kit falls back to the camera kit", () => {
    expect(scenarioById("walker").id).toBe("walker");
    for (const v of [undefined, null, "", "WALKER", "camera", "../etc"]) expect(scenarioById(v).id).toBe("camera");
  });
});

describe("walker at a loan closet (ADR-009)", () => {
  it("every part back → ready to re-lend with the full deposit; nothing partial", () => {
    const o = walker.runBench(wPreset("complete"));
    expect(o.recon.lines.every((l) => l.status === "OK")).toBe(true);
    expect(o.bounds.fullCents).toBe(DEPOSIT);
    expect(o.settlement.recommended).toBe("full_refund");
    expect(announce(o, formatCents, "deposit back")).toBe(`Every line is OK. A person can approve the full ${formatCents(DEPOSIT)} deposit back.`);
  });

  it("a rubber tip left in the box → that line MISSING, the walker held, deposit less the tip", () => {
    const tip = WALKER.items.find((i) => i.key === "tip_rear_left")!;
    expect(wLine("tip_left", "tip_rear_left")).toMatchObject({ status: "MISSING", observedQty: 0 });
    const o = walker.runBench(wPreset("tip_left"));
    expect(o.approvable).toBe(false);
    expect(o.bounds.partialCents).toBe(DEPOSIT - tip.unitPriceCents);
    expect(o.settlement.recommended).toBe("partial");
    expect(o.holdReasons.some((r) => r.startsWith("Rubber tip, rear left:"))).toBe(true);
  });

  it("another closet's walker (a different asset tag) → frame HELD on serial_mismatch", () => {
    const l = wLine("stand_in", "walker_frame");
    expect(l.status).toBe("HELD");
    expect(l.reasons.map((r) => r.code)).toContain("serial_mismatch");
    expect(walker.standInSerial(WALKER.items[0])).not.toBe(WALKER.slip.lines[0].serial);
  });

  it("an unreadable asset tag → frame HELD on label_unreadable, never cleared", () => {
    const l = wLine("unreadable", "walker_frame");
    expect(l.status).toBe("HELD");
    expect(l.reasons.map((r) => r.code)).toContain("label_unreadable");
  });

  it("has no return window: lateness can't be set, and no date ever raises a policy hold", () => {
    expect(returnWindowDays(WALKER.policy)).toBeNull();
    const s = walker.setLate(wPreset("complete"), true);
    expect(s.late).toBe(false);
    const o = walker.runBench(s);
    expect(o.window).toBeNull();
    expect(o.recon.policyHolds).toBeUndefined();
    expect(WALKER.presets.some((p) => p.late)).toBe(false);
  });

  it("states its hard limit: parts present only, never a safety judgement, and labels itself an illustration", () => {
    expect(WALKER.copy.hardLimit).toMatch(/does not judge whether equipment is safe/);
    expect(WALKER.policy.clauses.find((c) => c.id === "7.1")?.text).toBe(WALKER.copy.hardLimit);
    expect(WALKER.copy.fixtureLabel).toMatch(/Illustration/);
    expect(WALKER.copy.fixtureLabel).toMatch(/no closet, pilot or partner/);
    expect(WALKER.copy.completeLine).toMatch(/safety check still comes next/);
  });
});
