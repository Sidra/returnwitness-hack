import { describe, expect, it } from "vitest";
import { KIT } from "@/data/kit.config";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { countClip, holdingFlagsByItem } from "@/lib/vision/tray-counter";
import { synthFrames } from "@/lib/vision/synth";
import { judgeClip, runSyntheticGate, SYNTHETIC_GATE } from "@/lib/evals/suite";
import { formatStressTable, isCompleteKit, mulberry32, PERTURBATIONS, perturbFrames, runStressSweep, scoreRun, seedFor, STRESS_LABEL, VIDEO_PERTURBATIONS } from "@/lib/evals/stress";
import type { CountResult } from "@/lib/domain/schemas";

const cfg = counterConfigForKit(KIT);
const base = SYNTHETIC_GATE.map((s) => ({ s, frames: synthFrames({ frames: s.frames, fps: 5, tracks: s.tracks }) }));

describe("seeded randomness", () => {
  it("mulberry32 is reproducible and seed-sensitive", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(mulberry32(43)()).not.toBe(xs[0]);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it("seedFor separates (clip, perturbation, level, seed)", () => {
    expect(seedFor("g1", "box_jitter", 0.1, 0)).toBe(seedFor("g1", "box_jitter", 0.1, 0));
    expect(new Set([seedFor("g1", "box_jitter", 0.1, 0), seedFor("g1", "box_jitter", 0.1, 1), seedFor("g2", "box_jitter", 0.1, 0), seedFor("g1", "score_noise", 0.1, 0)]).size).toBe(4);
  });
});

describe("perturbations", () => {
  it("every perturbation has 2–3 severity levels and a description", () => {
    for (const p of PERTURBATIONS) {
      expect(p.levels.length).toBeGreaterThanOrEqual(2);
      expect(p.levels.length).toBeLessThanOrEqual(3);
      expect(p.describe(p.levels[0].param).length).toBeGreaterThan(5);
    }
    expect(PERTURBATIONS.map((p) => p.key).sort()).toEqual(["box_jitter", "dropped_frames", "hand_occlusion", "merged_masks", "missed_detection", "score_noise", "track_id_switch"]);
  });

  it("zero severity is the identity: same frames, same gate verdicts as the unperturbed run", () => {
    const gate = runSyntheticGate(cfg);
    for (const p of PERTURBATIONS) {
      for (const { s, frames } of base) {
        const out = p.apply(frames, 0, mulberry32(1), { cfg });
        expect(out).toEqual(frames);
        const v = judgeClip(s.clip, countClip(s.clip.id, out, cfg));
        const g = gate.find((x) => x.clipId === s.clip.id)!;
        expect([v.pass, v.holdCodes, v.perItem]).toEqual([g.pass, g.holdCodes, g.perItem]);
      }
    }
    const zero = runStressSweep({ cfg, seeds: 2, levels: [{ severity: "zero", param: 0 }] });
    for (const r of zero.rows) expect(r.pass).toBe(r.runs);
  });

  it("never mutates the input frames", () => {
    const { frames } = base[1];
    const snapshot = JSON.stringify(frames);
    for (const p of PERTURBATIONS) p.apply(frames, p.levels.at(-1)!.param, mulberry32(7), { cfg });
    expect(JSON.stringify(frames)).toBe(snapshot);
  });

  it("dropped frames removes frames from the stream (indices skip, order kept)", () => {
    const out = perturbFrames(base[1].frames, "dropped_frames", 0.3, 9, cfg);
    expect(out.length).toBeLessThan(base[1].frames.length);
    expect(out.every((f, i) => i === 0 || f.index > out[i - 1].index)).toBe(true);
  });

  it("track-ID switches change IDs but the counter still counts each item once (identity comes from the tray slot)", () => {
    const g1 = base.find((b) => b.s.clip.id === "g1")!;
    const out = perturbFrames(g1.frames, "track_id_switch", 1, 3, cfg);
    expect(out.flatMap((f) => f.masks).some((m) => String(m.trackId).endsWith("~switched"))).toBe(true);
    const r = countClip("g1", out, cfg);
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(Math.max(...Object.values(r.diagnostics.rawTrackIdsPerItem))).toBeGreaterThan(1);
  });

  it("hand occlusion adds a hand over a tray item and hides what it covers", () => {
    const g1 = base.find((b) => b.s.clip.id === "g1")!;
    const out = perturbFrames(g1.frames, "hand_occlusion", 10, 5, cfg);
    const handFrames = out.filter((f) => f.masks.some((m) => m.trackId === "stress-hand"));
    expect(handFrames.length).toBeGreaterThan(0);
    expect(handFrames.length).toBeLessThanOrEqual(10);
  });

  it("clips with nothing to merge or occlude are left alone (g0, empty mat)", () => {
    const g0 = base.find((b) => b.s.clip.id === "g0")!;
    expect(perturbFrames(g0.frames, "merged_masks", 10, 1, cfg)).toEqual(g0.frames);
    expect(perturbFrames(g0.frames, "hand_occlusion", 10, 1, cfg)).toEqual(g0.frames);
  });

  it("merged masks: a lasting merge is either HELD or resolved by both items reappearing on their own; a merge to the end is always HELD; no count ever changes silently", () => {
    const p = PERTURBATIONS.find((x) => x.key === "merged_masks")!;
    let lasting = 0;
    let neverSplit = 0;
    for (const lvl of p.levels)
      for (const { s, frames } of base.filter((b) => Object.values(b.s.clip.expected).filter(Boolean).length >= 2))
        for (let k = 0; k < 3; k++) {
          const out = p.apply(frames, lvl.param, mulberry32(seedFor(s.clip.id, p.key, lvl.param, k)), { cfg });
          const changedAt = out.map((f, i) => (JSON.stringify(f) !== JSON.stringify(frames[i]) ? i : -1)).filter((i) => i >= 0);
          const changed = changedAt.length;
          const r = countClip(s.clip.id, out, cfg);
          const held = holdingFlagsByItem(r).size > 0;
          // A merge visible for longer than settle + lift grace is noticed: held, or resolved after a clean split.
          if (changed > cfg.settleFrames + cfg.liftGraceFrames) {
            lasting++;
            const codes = r.flags.map((f) => f.code);
            expect(codes.includes("merged_mask") || codes.includes("merge_resolved")).toBe(true);
            if (!codes.includes("merged_mask")) expect(r.counts).toEqual(s.clip.expected);
            // Never split (still merged on the last frame): the evidence can't separate the items, so it holds.
            if (changedAt[changedAt.length - 1] === out.length - 1) {
              neverSplit++;
              expect(held).toBe(true);
            }
          }
          // Shorter merges (end of clip, item still moving) may go unflagged, but then the count is right.
          if (!held) expect(r.counts).toEqual(s.clip.expected);
        }
    expect(lasting).toBeGreaterThan(30);
    expect(neverSplit).toBeGreaterThan(5);
  });
});

describe("scoring", () => {
  const res = (counts: Record<string, number>, flags: CountResult["flags"] = []): CountResult => ({ clipId: "x", counts, arrivals: [], flags, diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } });
  const kit = { id: "g1", expected: { a: 1, b: 1 }, acceptHold: [] };
  it("a silent short count is a missed item; a held one is not", () => {
    expect(scoreRun(kit, res({ a: 1, b: 0 }))).toMatchObject({ missedItems: 1, wrongCount: true, falseHold: false });
    expect(scoreRun(kit, res({ a: 1, b: 0 }, [{ code: "seen_not_placed", itemKeys: ["b"], t: 0, frameIndex: 0, detail: "" }]))).toMatchObject({ missedItems: 0, wrongCount: true, falseHold: true });
  });
  it("a hold on a complete, correctly counted kit is a false hold, unless the clip accepts that hold", () => {
    const flag = [{ code: "left_tray" as const, itemKeys: ["a"], t: 0, frameIndex: 0, detail: "" }];
    expect(scoreRun(kit, res({ a: 1, b: 1 }, flag))).toMatchObject({ falseHold: true, wrongCount: false, pass: true });
    expect(scoreRun({ ...kit, acceptHold: ["left_tray"] }, res({ a: 1, b: 1 }, flag)).falseHold).toBe(false);
  });
  it("an incomplete kit is never a false hold; a silent over-count is counted", () => {
    const g5 = { id: "g5", expected: { a: 1, lens: 0 }, acceptHold: [], mustHold: ["lens"] };
    expect(scoreRun(g5, res({ a: 1, lens: 0 }, [{ code: "merged_mask", itemKeys: ["a"], t: 0, frameIndex: 0, detail: "" }])).falseHold).toBe(false);
    expect(scoreRun(g5, res({ a: 1, lens: 1 }))).toMatchObject({ overCounts: 1, pass: false });
  });
});

describe("runStressSweep", () => {
  const a = runStressSweep({ cfg, seeds: 2 });
  it("is deterministic across runs with the same seeds", () => {
    expect(runStressSweep({ cfg, seeds: 2 })).toEqual(a);
  });
  it("has a baseline row plus one row per perturbation × severity, all labelled DETERMINISTIC", () => {
    expect(a.label).toBe(STRESS_LABEL);
    expect(a.rows[0]).toMatchObject({ perturbation: "none", runs: SYNTHETIC_GATE.length, pass: SYNTHETIC_GATE.length, falseHolds: 0, missedItems: 0 });
    expect(a.rows).toHaveLength(1 + PERTURBATIONS.reduce((s, p) => s + p.levels.length, 0));
    for (const r of a.rows.slice(1)) expect(r).toMatchObject({ mode: "DETERMINISTIC", clips: SYNTHETIC_GATE.length, runs: SYNTHETIC_GATE.length * 2 });
  });
  it("false holds are counted over complete-kit runs only (the empty box and the missing lens are not complete)", () => {
    const complete = SYNTHETIC_GATE.filter((s) => isCompleteKit(s.clip)).length;
    expect(complete).toBe(SYNTHETIC_GATE.length - 2);
    expect(a.rows[0].completeKitRuns).toBe(complete);
    expect(a.summary.completeKitRuns).toBe(a.rows.reduce((s, r) => s + r.completeKitRuns, 0));
    expect(a.summary.falseHolds).toBeLessThanOrEqual(a.summary.completeKitRuns);
  });
  it("reports false holds next to missed items, in every row and in the summary", () => {
    for (const r of a.rows) expect(r).toHaveProperty("falseHolds");
    expect(a.rows.find((r) => r.perturbation === "merged_masks")!.falseHolds).toBeGreaterThan(0);
    expect(a.summary.falseHolds).toBe(a.rows.reduce((s, r) => s + r.falseHolds, 0));
    expect(a.summary.worstForCustomers?.perturbation).toBe("merged_masks");
    const table = formatStressTable(a);
    expect(table).toContain(STRESS_LABEL);
    expect(table).toMatch(/\| missedItems \| overCounts \| falseHolds \| wrongCounts \|/);
    expect(table).toMatch(/false holds on complete kits/);
  });
  it("a different seed count changes the run count, not the verdict logic", () => {
    const b = runStressSweep({ cfg, seeds: 1, perturbations: PERTURBATIONS.filter((p) => p.key === "track_id_switch") });
    expect(b.rows.slice(1).every((r) => r.runs === SYNTHETIC_GATE.length && r.pass === r.runs)).toBe(true);
  });
});

describe("video-level perturbations (Modal mode, data only)", () => {
  it("cover brightness, blur, downscale and frame drop at three severities, keeping 720p and 5 fps", () => {
    const keys = [...new Set(VIDEO_PERTURBATIONS.map((v) => v.key))].sort();
    expect(keys).toEqual(["blur", "brightness", "downscale", "frame_drop"]);
    for (const k of keys) expect(VIDEO_PERTURBATIONS.filter((v) => v.key === k).map((v) => v.severity)).toEqual(["low", "mid", "high"]);
    for (const v of VIDEO_PERTURBATIONS.filter((x) => x.key === "downscale")) expect(v.vf).toMatch(/scale=-2:720$/);
  });
});

describe("regressions found by the sweep", () => {
  // Found at 5 seeds: under ±30% box jitter the g8 lens never held still long enough
  // to settle and was never outside the tray 3 frames in a row, so it was silently called missing.
  it("g8 · box_jitter high · seed 4: a lens seen in the tray that never settles is HELD, never a silent miss", () => {
    const g8 = base.find((b) => b.s.clip.id === "g8")!;
    const p = PERTURBATIONS.find((x) => x.key === "box_jitter")!;
    const lvl = p.levels.find((l) => l.severity === "high")!.param;
    const r = countClip("g8", p.apply(g8.frames, lvl, mulberry32(seedFor("g8", p.key, lvl, 4)), { cfg }), cfg);
    const sc = scoreRun(g8.s.clip, r);
    expect(sc.missedItems).toBe(0);
    if (r.counts.lens === 0) expect(holdingFlagsByItem(r).get("lens")?.map((f) => f.code)).toContain("seen_not_placed");
  });
});
