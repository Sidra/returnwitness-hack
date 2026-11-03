import { describe, expect, it } from "vitest";
import { CountResult } from "@/lib/domain/schemas";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { formatCents } from "@/lib/format";
import {
  PLAY_SLIP,
  PRESETS,
  announce,
  applyKey,
  benchToCount,
  initialBench,
  keyIntent,
  moveItem,
  pieceFor,
  placeOf,
  runBench,
  setLate,
  setStandIn,
  setUnreadable,
  standInSerial,
  type BenchState,
} from "@/lib/play/bench";

const preset = (id: string): BenchState => PRESETS.find((p) => p.id === id)!.state;
const line = (s: BenchState, key: string) => runBench(s).recon.lines.find((l) => l.itemKey === key)!;
const lens = KIT.items.find((i) => i.key === "lens")!;
const camera = KIT.items.find((i) => i.key === "camera_body")!;
const battery = KIT.items.find((i) => i.key === "battery")!;

describe("bench → CountResult", () => {
  it("is a valid counter output (passes the CountResult schema) in every preset", () => {
    for (const p of PRESETS) expect(CountResult.safeParse(benchToCount(p.state)).success).toBe(true);
    expect(CountResult.safeParse(benchToCount(initialBench())).success).toBe(true);
  });

  it("counts exactly what is in the tray, arrivals in the order placed", () => {
    let s = initialBench();
    s = moveItem(s, "battery");
    s = moveItem(s, "camera_body");
    const c = benchToCount(s);
    expect(c.counts).toEqual({ camera_body: 1, lens: 0, battery: 1 });
    expect(c.arrivals.map((a) => a.itemKey)).toEqual(["battery", "camera_body"]);
    expect(c.arrivals[0].t).toBeLessThan(c.arrivals[1].t);
  });

  it("a real serialised item carries the packing slip's serial on its label", () => {
    const c = benchToCount(preset("complete"));
    const a = c.arrivals.find((x) => x.itemKey === "lens")!;
    expect(a.label?.text).toBe(PLAY_SLIP.lines.find((l) => l.itemKey === "lens")!.serial);
    // The battery has no serial label, as in the kit config.
    expect(c.arrivals.find((x) => x.itemKey === "battery")!.label).toBeUndefined();
  });

  it("an item left in the box is not counted and raises no counter flag", () => {
    const c = benchToCount(preset("lens_left"));
    expect(c.counts.lens).toBe(0);
    expect(c.flags).toEqual([]);
  });

  it("an unreadable label is only flagged once the item settles in the tray (as the counter does)", () => {
    const inBox = setUnreadable(initialBench(), "lens", true);
    expect(benchToCount(inBox).flags).toEqual([]);
    const inTray = moveItem(inBox, "lens", "tray");
    const c = benchToCount(inTray);
    expect(c.flags).toMatchObject([{ code: "label_unreadable", itemKeys: ["lens"] }]);
    expect(c.arrivals.find((a) => a.itemKey === "lens")!.label).toBeUndefined();
  });
});

describe("the real engine on the visitor's bench", () => {
  it("complete box → every line OK, nothing held, full refund approvable, no partial", () => {
    const o = runBench(preset("complete"));
    expect(o.recon.lines.map((l) => l.status)).toEqual(["OK", "OK", "OK"]);
    expect(o.recon.mode).toBe("DETERMINISTIC");
    expect(o.recon.summary).toMatchObject({ allClear: true, heldCents: 0 });
    expect(o.approvable).toBe(true);
    expect(o.settlement.recommended).toBe("full_refund");
    expect(o.settlement.options.find((x) => x.key === "full_refund")).toMatchObject({ refundCents: KIT_TOTAL_CENTS, requiresOverride: false });
    expect(o.settlement.options.find((x) => x.key === "partial")!.available).toBe(false);
    expect(o.holdReasons).toEqual([]);
  });

  it("lens left in the box → MISSING, the box is held, partial bound = kit less the lens", () => {
    const o = runBench(preset("lens_left"));
    const l = o.recon.lines.find((x) => x.itemKey === "lens")!;
    expect(l).toMatchObject({ status: "MISSING", observedQty: 0, missingQty: 1 });
    expect(l.reasons[0].code).toBe("not_observed");
    expect(o.approvable).toBe(false);
    expect(o.recon.summary.heldCents).toBe(KIT_TOTAL_CENTS);
    expect(o.bounds).toEqual({ fullCents: KIT_TOTAL_CENTS, partialCents: KIT_TOTAL_CENTS - lens.unitPriceCents });
    expect(o.settlement.recommended).toBe("partial");
    expect(o.settlement.options.find((x) => x.key === "full_refund")!.requiresOverride).toBe(true);
    expect(o.holdReasons).toEqual([`${lens.name}: 0 of 1 seen in the tray during this clip`]);
  });

  it("look-alike lens with another order's serial → HELD serial_mismatch, recommendation is to keep holding", () => {
    const s = preset("stand_in");
    const p = pieceFor(lens, s);
    expect(p.isStandIn).toBe(true);
    expect(p.labelText).toBe(standInSerial(lens));
    expect(p.labelText).not.toBe(PLAY_SLIP.lines.find((x) => x.itemKey === "lens")!.serial);
    const l = line(s, "lens");
    expect(l.status).toBe("HELD");
    expect(l.observedQty).toBe(1);
    expect(l.reasons.map((r) => r.code)).toContain("serial_mismatch");
    const o = runBench(s);
    expect(o.approvable).toBe(false);
    expect(o.settlement.recommended).toBe("full_hold");
    // An unclear line is excluded from the partial, like a missing one.
    expect(o.bounds.partialCents).toBe(KIT_TOTAL_CENTS - lens.unitPriceCents);
  });

  it("unreadable label → HELD label_unreadable even though the count matches", () => {
    const l = line(preset("unreadable"), "lens");
    expect(l.status).toBe("HELD");
    expect(l.observedQty).toBe(l.expectedQty);
    expect(l.reasons.map((r) => r.code)).toEqual(["label_unreadable"]);
    expect(runBench(preset("unreadable")).approvable).toBe(false);
  });

  it("late return → the lines stay as counted but the case HOLDS on clause 1.1 for a person to check delivery", () => {
    const late = runBench(preset("late"));
    const onTime = runBench(preset("complete"));
    expect(late.window).toMatchObject({ outside: true, clauseId: "1.1", limitDays: 30, checkedByEngine: true });
    expect(late.window!.daysAfterShip).toBeGreaterThan(30);
    expect(onTime.window!.outside).toBe(false);
    expect(late.recon.lines).toEqual(onTime.recon.lines);
    expect(late.recon.policyHolds?.[0]).toMatchObject({ code: "outside_return_window", clauseId: "1.1" });
    expect(onTime.recon.policyHolds).toBeUndefined();
    expect(late.approvable).toBe(false);
    expect(onTime.approvable).toBe(true);
    expect(late.settlement.recommended).toBe("full_hold");
    expect(late.settlement.options.find((o) => o.key === "full_refund")!.requiresOverride).toBe(true);
    expect(late.holdReasons.some((r) => r.startsWith("Return window (clause 1.1)"))).toBe(true);
  });

  it("every one-tap case produces a visibly different outcome (rule: a sample that changes nothing is a FAIL)", () => {
    const keys = ["complete", "lens_left", "stand_in", "unreadable", "late"] as const;
    const sig = (k: (typeof keys)[number]) => {
      const o = runBench(preset(k));
      return JSON.stringify({ lines: o.recon.lines.map((l) => [l.itemKey, l.status, l.reasons.map((r) => r.code)]), policy: o.recon.policyHolds ?? [], rec: o.settlement.recommended, approvable: o.approvable, partial: o.bounds.partialCents });
    };
    const sigs = keys.map(sig);
    expect(new Set(sigs).size).toBe(keys.length);
  });

  it("an empty tray holds every line as MISSING and offers no partial", () => {
    const o = runBench(initialBench());
    expect(o.recon.lines.map((l) => l.status)).toEqual(["MISSING", "MISSING", "MISSING"]);
    expect(o.settlement.options.find((x) => x.key === "partial")!.available).toBe(false);
    expect(o.holdReasons).toHaveLength(3);
  });

  it("two problems at once: the most restrictive reading per line, partial excludes both", () => {
    let s = setStandIn(preset("complete"), "camera_body", true);
    s = moveItem(s, "lens", "box");
    const o = runBench(s);
    expect(o.recon.lines.find((l) => l.itemKey === "camera_body")!.status).toBe("HELD");
    expect(o.recon.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(o.bounds.partialCents).toBe(battery.unitPriceCents);
    expect(o.settlement.recommended).toBe("full_hold");
  });

  it("an unreadable label wins over a look-alike's wrong serial (no label read, so no serial to compare)", () => {
    const s = setUnreadable(preset("stand_in"), "lens", true);
    expect(line(s, "lens").reasons.map((r) => r.code)).toEqual(["label_unreadable"]);
  });

  it("the live-region sentence names what holds and the partial, or the full refund when clean", () => {
    expect(announce(runBench(preset("complete")), formatCents)).toBe(`Every line is OK. A person can approve the full ${formatCents(KIT_TOTAL_CENTS)} refund.`);
    const held = announce(runBench(preset("lens_left")), formatCents);
    expect(held).toContain(`${lens.name} missing`);
    expect(held).toContain(formatCents(KIT_TOTAL_CENTS - lens.unitPriceCents));
  });
});

describe("controls", () => {
  it("look-alike and unreadable only apply to serialised items", () => {
    const s = initialBench();
    expect(setStandIn(s, "battery", true)).toBe(s);
    expect(setUnreadable(s, "battery", true)).toBe(s);
    expect(setStandIn(s, camera.key, true).standIns).toEqual([camera.key]);
    expect(setStandIn(setStandIn(s, "lens", true), "lens").standIns).toEqual([]);
  });

  it("setLate is idempotent", () => {
    const s = initialBench();
    expect(setLate(s, false)).toBe(s);
    expect(setLate(s, true).late).toBe(true);
  });

  it("moving to the place an item is already in, or an unknown item, changes nothing", () => {
    const s = initialBench();
    expect(moveItem(s, "lens", "box")).toBe(s);
    expect(moveItem(s, "tripod")).toBe(s);
    const t = moveItem(s, "lens", "tray");
    expect(moveItem(t, "lens", "tray")).toBe(t);
  });
});

describe("keyboard move logic", () => {
  it("Enter and Space toggle; arrows move to a side; other keys do nothing", () => {
    expect(keyIntent("Enter")).toBe("toggle");
    expect(keyIntent(" ")).toBe("toggle");
    expect(keyIntent("Spacebar")).toBe("toggle");
    expect(keyIntent("ArrowRight")).toBe("to_tray");
    expect(keyIntent("ArrowLeft")).toBe("to_box");
    expect(keyIntent("Tab")).toBeNull();
    expect(keyIntent("a")).toBeNull();
  });

  it("Enter moves an item from the box to the tray and back", () => {
    let s = initialBench();
    s = applyKey(s, "lens", "Enter");
    expect(placeOf(s, "lens")).toBe("tray");
    s = applyKey(s, "lens", " ");
    expect(placeOf(s, "lens")).toBe("box");
  });

  it("ArrowRight puts it in the tray and repeating it is a no-op; ArrowLeft takes it out", () => {
    let s = applyKey(initialBench(), "camera_body", "ArrowRight");
    expect(s.tray).toEqual(["camera_body"]);
    const again = applyKey(s, "camera_body", "ArrowRight");
    expect(again).toBe(s);
    s = applyKey(s, "camera_body", "ArrowLeft");
    expect(s.tray).toEqual([]);
  });

  it("keyboard alone completes the box and makes it approvable", () => {
    let s = initialBench();
    for (const i of KIT.items) s = applyKey(s, i.key, "Enter");
    expect(runBench(s).approvable).toBe(true);
    expect(applyKey(s, "lens", "Escape")).toBe(s);
  });
});
