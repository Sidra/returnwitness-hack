import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT } from "@/data/kit.config";
import kitCalibrationJson from "@/data/kit-calibration.json";
import type { Frame } from "@/lib/domain/schemas";
import { SYNTHETIC_GATE } from "@/lib/evals/suite";
import { CALIBRATION_CLIP, CALIBRATION_RULE, calibrateItems, isCalibrated, KitCalibration, median, withCalibration } from "@/lib/vision/calibration";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { synthFrames } from "@/lib/vision/synth";
import { countClip } from "@/lib/vision/tray-counter";

const cfg = counterConfigForKit(KIT, { checkLabels: false });
const g1 = SYNTHETIC_GATE.find((s) => s.clip.id === "g1")!;
const g1Frames = synthFrames({ frames: g1.frames, fps: 5, tracks: g1.tracks });
const itemConcepts = new Set(KIT.items.map((i) => i.samConcept.toLowerCase()));
/** A higher or lower camera: every item mask's area scales, positions don't. */
const scaled = (frames: Frame[], k: number): Frame[] => frames.map((f) => ({ ...f, masks: f.masks.map((m) => (itemConcepts.has(m.concept.toLowerCase()) ? { ...m, area: Math.min(1, m.area * k) } : m)) }));
const calibrate = (frames: Frame[]) => calibrateItems(frames, countClip("g1", frames, cfg), cfg);

const prereg = fs.readFileSync(path.join(__dirname, "..", "evals", "CALIBRATION-PREREG.md"), "utf8");

describe("item-size calibration from g1 (pre-registered rule)", () => {
  it("the pre-registration names the clip, the statistic and the numbers the code uses", () => {
    expect(CALIBRATION_CLIP).toBe("gate-g1");
    expect(prereg).toMatch(/g1 only/);
    expect(prereg).toMatch(/median/);
    expect(prereg).toContain(`at least ${CALIBRATION_RULE.minFrames}`);
    expect(prereg).toContain(`${CALIBRATION_RULE.maxRatio}×`);
    expect(prereg).toContain(`${CALIBRATION_RULE.sigDigits} significant digits`);
  });

  it("median: odd, even, empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("same camera as the estimates: every item measured at its estimate and applied", () => {
    const r = calibrate(g1Frames);
    for (const i of KIT.items) {
      expect(r[i.key].applied, i.key).toBe(true);
      expect(r[i.key].frames).toBeGreaterThanOrEqual(CALIBRATION_RULE.minFrames);
      expect(r[i.key].measured! / i.expectedAreaFrac).toBeCloseTo(1, 2);
    }
  });

  it("a camera that makes items look 1.6× bigger: measured 1.6×, applied", () => {
    const r = calibrate(scaled(g1Frames, 1.6));
    for (const i of KIT.items) {
      expect(r[i.key].applied).toBe(true);
      expect(r[i.key].measured! / i.expectedAreaFrac).toBeCloseTo(1.6, 2);
    }
  });

  it("outside the 4× band: measured and reported, estimate kept", () => {
    const r = calibrate(scaled(g1Frames, 5));
    for (const i of KIT.items) expect(r[i.key]).toMatchObject({ applied: false, estimate: i.expectedAreaFrac });
    expect(r.lens.reason).toMatch(/outside/);
    expect(r.lens.measured).not.toBeNull();
  });

  it("an item never counted in g1: estimate kept, says why", () => {
    const lens = KIT.items.find((i) => i.key === "lens")!.samConcept.toLowerCase();
    const r = calibrate(g1Frames.map((f) => ({ ...f, masks: f.masks.filter((m) => m.concept.toLowerCase() !== lens) })));
    expect(r.lens).toMatchObject({ applied: false, measured: null, frames: 0 });
    expect(r.lens.reason).toMatch(/0 counted arrivals/);
    expect(r.camera_body.applied).toBe(true);
  });

  it("frames where a hand overlaps the item are dropped; too few left keeps the estimate", () => {
    const battery = KIT.items.find((i) => i.key === "battery")!.samConcept.toLowerCase();
    const withHand = g1Frames.map((f) => {
      const b = f.masks.find((m) => m.concept.toLowerCase() === battery);
      return b ? { ...f, masks: [...f.masks, { trackId: "h", concept: KIT.handConcept, bbox: b.bbox, area: 0.02, score: 1 }] } : f;
    });
    const r = calibrateItems(withHand, countClip("g1", g1Frames, cfg), cfg);
    expect(r.battery).toMatchObject({ applied: false, frames: 0 });
    expect(r.battery.reason).toMatch(/qualifying frames/);
  });
});

describe("applying the calibration", () => {
  const base = { version: "kit-calibration/1", kitId: "ck-16-starter", clipId: "gate-g1", recordedAt: null, calibratedAt: null, gitHash: null, note: "t" } as const;

  it("only applied items change, only when the file says calibrated", () => {
    const items = calibrate(scaled(g1Frames, 1.6));
    items.battery = { ...items.battery, applied: false, reason: "kept" };
    const cal = KitCalibration.parse({ ...base, status: "calibrated", items });
    const out = withCalibration(cfg, cal);
    expect(out.items.find((i) => i.key === "lens")!.expectedAreaFrac).toBe(items.lens.measured);
    expect(out.items.find((i) => i.key === "battery")!.expectedAreaFrac).toBe(KIT.items.find((i) => i.key === "battery")!.expectedAreaFrac);
    expect(withCalibration(cfg, { ...cal, status: "estimates" })).toBe(cfg);
    expect(withCalibration(cfg, null)).toBe(cfg);
    expect(isCalibrated(cal)).toBe(true);
  });

  it("the committed file parses and, before the live run, is still the estimates", () => {
    const cal = KitCalibration.parse(kitCalibrationJson);
    expect(cal.kitId).toBe("ck-16-starter");
    if (cal.status === "estimates") expect(isCalibrated(cal)).toBe(false);
  });
});
