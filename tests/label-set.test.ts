import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import committedSwitchJson from "@/data/glimmer-switch.json";
import { describe, expect, it } from "vitest";
import type { CountResult, SegmentationResult } from "@/lib/domain/schemas";
import { canonicalSerial, type DatasetRowMeta } from "@/lib/learning/finetune";
import { FORCED_HELDOUT_LABELS, leakedLabels, MIN_HELDOUT_ROWS, MIN_TRAIN_ROWS, splitKey, unionTrainingLines, type TrainingLine } from "@/lib/learning/glimmer-eval";
import {
  augmentationFor,
  benchLabelRows,
  findClipIn,
  IDENTITY,
  LABEL_SET_NAME,
  LABEL_SET_SEED,
  labelPageHtml,
  labelSetRow,
  labelTruth,
  MAX_ANGLE,
  MAX_OCCLUSION,
  occludedFraction,
  parseLabelSerial,
  REAL_SHEET_SERIALS,
  renderSerials,
  renderSpecs,
  SHEET_BOXES,
  sheetCss,
  sheetSpecs,
  splitLabelSet,
  standInSerial,
  summarizeLabelSet,
  rngFor,
  type LabelBoxes,
  type LabelSetLine,
  type LabelSpec,
} from "@/lib/learning/label-set";
import { countLabelCorrections, labelLearningView, NOT_RUN_YET, readLabelSetManifest, readLastSwitchDecision, SWITCH_RULE_LINE } from "@/lib/learning/learning-status";
import committed from "@/data/label-set.manifest.json";

const RENDER_BOXES: LabelBoxes = { W: 384, H: 192, serial: [15, 50, 300, 62], sku: [125, 22, 120, 16] };
const fakeImage = (k: string) => ({ dataUrl: `data:image/jpeg;base64,${Buffer.from(k).toString("base64")}`, file: `images/${k}.jpg` });

/** The same jobs scripts/build-label-set.ts runs (defaults), with fake images instead of Chrome screenshots. */
function defaultSet(): LabelSetLine[] {
  const rows: LabelSetLine[] = [];
  for (const spec of sheetSpecs()) for (let v = 0; v < 4; v++) rows.push(labelSetRow(spec, v === 0 ? IDENTITY(0) : augmentationFor(LABEL_SET_SEED, spec.key, v), SHEET_BOXES(spec), fakeImage(`${spec.key}-${v}`)));
  for (const spec of renderSpecs(LABEL_SET_SEED, { perKind: 30, chargers: 6 })) for (let v = 1; v <= (spec.serial ? 3 : 2); v++) rows.push(labelSetRow(spec, augmentationFor(LABEL_SET_SEED, spec.key, v), RENDER_BOXES, fakeImage(`${spec.key}-${v}`)));
  return rows;
}

describe("truth parsing", () => {
  it("reads item and SKU from the serial format; anything else is not a serial", () => {
    expect(parseLabelSerial("BW-CB-55120")).toEqual({ serial: "BW-CB-55120", itemKey: "camera_body", sku: "CK-BODY-01" });
    expect(parseLabelSerial("bw ln 80311")).toEqual({ serial: "BW-LN-80311", itemKey: "lens", sku: "CK-LENS-24105" });
    expect(parseLabelSerial("BW-XX-12345")).toBeNull();
    expect(parseLabelSerial("BW-CB-5512")).toBeNull();
    expect(parseLabelSerial("no serial")).toBeNull();
    expect(canonicalSerial("bw-cb 55120")).toBe("BW-CB-55120");
  });

  it("the sheet: 10 labels in print order, 4 distinct serials, 2 chargers, cells on the 860×1100 preview", () => {
    const s = sheetSpecs();
    expect(s).toHaveLength(10);
    expect(new Set(s.filter((x) => x.serial).map((x) => x.serial))).toEqual(new Set(REAL_SHEET_SERIALS));
    expect(s.filter((x) => !x.serial).map((x) => x.labelId)).toEqual(["charger-1", "charger-2"]);
    expect(s[0]).toMatchObject({ labelId: "BW-CB-55120", itemKey: "camera_body", sku: "CK-BODY-01", cell: [37, 64, 384, 192] });
    expect(s[9]).toMatchObject({ labelId: "BW-LN-80311", sku: "CK-LENS-24105", cell: [439, 833, 384, 192] });
    expect(s[2]).toMatchObject({ itemKey: "battery", sku: "CK-BATT-CHG", serial: null });
  });

  it("the page uses the sheet's own CSS and label markup; the sheet source shows the real preview crop", () => {
    const css = sheetCss(fs.readFileSync(path.join(process.cwd(), "labels/label-sheet.html"), "utf8"));
    expect(css).toContain(".sn { font-family: Menlo");
    const render = renderSpecs(1, { perKind: 1, chargers: 0 })[0];
    const html = labelPageHtml(render, augmentationFor(1, render.key, 1), css);
    expect(html).toContain(`<span class="pre">${render.serial!.slice(0, 6)}</span>${render.serial!.slice(6)}`);
    expect(html).toContain('<span class="store">BRINDLEWOOD</span>');
    const sheet = sheetSpecs()[3];
    const sh = labelPageHtml(sheet, IDENTITY(0), css, "data:image/png;base64,AAAA");
    expect(sh).toContain("-439px -257px / 860px 1100px");
    expect(sh).not.toContain("BW-CB-55107"); // the sheet row's pixels come from the real print, not re-typed text
    expect(() => sheetCss("<html></html>")).toThrow(/no <style>/);
  });
});

describe("seeded generation", () => {
  it("rendered serials: distinct, real format, never a printed one, same for the same seed", () => {
    const a = renderSerials(LABEL_SET_SEED, 30);
    expect(a).toHaveLength(60);
    expect(new Set(a).size).toBe(60);
    expect(a.every((s) => parseLabelSerial(s)?.serial === s)).toBe(true);
    expect(a.filter((s) => s.startsWith("BW-CB-"))).toHaveLength(30);
    expect(a.some((s) => (REAL_SHEET_SERIALS as readonly string[]).includes(s))).toBe(false);
    expect(renderSerials(LABEL_SET_SEED, 30)).toEqual(a);
    expect(renderSerials(LABEL_SET_SEED + 1, 30)).not.toEqual(a);
  });

  it("augmentation is deterministic by seed and stays inside its bounds (±25°, ≤30% occluded, quality 35–92)", () => {
    expect(augmentationFor(7, "k", 1)).toEqual(augmentationFor(7, "k", 1));
    expect(augmentationFor(7, "k", 1)).not.toEqual(augmentationFor(8, "k", 1));
    expect(augmentationFor(7, "k", 1)).not.toEqual(augmentationFor(7, "k", 2));
    const augs = Array.from({ length: 500 }, (_, i) => augmentationFor(LABEL_SET_SEED, `key-${i}`, 1 + (i % 3)));
    for (const a of augs) {
      for (const x of [a.rotateX, a.rotateY, a.rotateZ]) expect(Math.abs(x)).toBeLessThanOrEqual(MAX_ANGLE);
      expect(a.jpegQuality).toBeGreaterThanOrEqual(35);
      expect(a.jpegQuality).toBeLessThanOrEqual(92);
      expect(a.blurPx).toBeLessThanOrEqual(1.6);
      if (a.occluder) expect(occludedFraction(a.occluder)).toBeLessThanOrEqual(MAX_OCCLUSION + 1e-9);
    }
    expect(augs.filter((a) => a.occluder).length).toBeGreaterThan(100); // occlusion actually happens
    expect(augs.filter((a) => a.glare).length).toBeGreaterThan(150);
    expect(rngFor("x")()).toBe(rngFor("x")());
  });

  it("an occluder over the serial makes the truth 'unreadable' (abstain); elsewhere the printed serial stands", () => {
    const spec = sheetSpecs()[0];
    const base = IDENTITY(1);
    const over = labelTruth(spec, { ...base, occluder: { kind: "finger", x: 0.5, y: 0, w: 0.1, h: 0.8, angle: 0 } }, SHEET_BOXES(spec));
    expect(over).toMatchObject({ serialHidden: true, answer: { serialRead: null, legible: false, confidence: 0 }, truth: { serial: null, serialUnreadable: true } });
    const corner = labelTruth(spec, { ...base, occluder: { kind: "paper", x: 0.9, y: 0.8, w: 0.1, h: 0.2, angle: 0 } }, SHEET_BOXES(spec));
    expect(corner).toMatchObject({ serialHidden: false, skuHidden: false, answer: { serialRead: "BW-CB-55120", skuRead: "CK-BODY-01", legible: true, confidence: 1 } });
    const sku = labelTruth(spec, { ...base, occluder: { kind: "paper", x: 0.35, y: 0, w: 0.3, h: 0.15, angle: 0 } }, SHEET_BOXES(spec));
    expect(sku).toMatchObject({ serialHidden: false, skuHidden: true, answer: { serialRead: "BW-CB-55120", skuRead: null }, truth: { sku: null } });
    const charger = labelTruth(sheetSpecs()[2], { ...base, occluder: { kind: "finger", x: 0.5, y: 0.3, w: 0.1, h: 0.7, angle: 0 } }, SHEET_BOXES(sheetSpecs()[2]));
    expect(charger.truth).toEqual({ serial: null, sku: "CK-BATT-CHG", serialUnreadable: false });
  });

  it("stand-ins are near misses: one confusable digit, or the real sheet's other-set serial", () => {
    expect(standInSerial("BW-CB-55120", Math.random)).toBe("BW-CB-55107");
    expect(standInSerial("BW-LN-80298", Math.random)).toBe("BW-LN-80311");
    const s = standInSerial("BW-LN-12345", rngFor("t"));
    expect(s).toMatch(/^BW-LN-\d{5}$/);
    expect([...s].filter((c, i) => c !== "BW-LN-12345"[i])).toHaveLength(1);
  });
});

describe("rows and the split", () => {
  const set = splitLabelSet(defaultSet());

  it("each row: the live prompt with no serial in it, the printed truth as the answer, source + labelId + augmentation recorded", () => {
    const r = set.find((l) => l.meta.source === "render" && !l.meta.truth.serialUnreadable)!;
    expect(JSON.stringify(r.messages[1])).not.toContain(r.meta.labelId!);
    expect(JSON.parse(r.messages[2].content as string).items[0]).toMatchObject({ itemKey: r.meta.itemKey, serialRead: r.meta.labelId, legible: true });
    expect(r.meta).toMatchObject({ source: "render", caseId: expect.stringMatching(/^labelset:render-/), augment: expect.objectContaining({ jpegQuality: expect.any(Number) }) });
    expect(set.every((l) => l.meta.source === "sheet" || l.meta.source === "render")).toBe(true);
  });

  it("no label id is ever in both splits, and every printed sheet label is held out", () => {
    expect(leakedLabels(set)).toEqual([]);
    const train = new Set(set.filter((l) => l.meta.split === "train").map((l) => splitKey(l.meta)));
    for (const id of FORCED_HELDOUT_LABELS) expect(train.has(id)).toBe(false);
    const held = new Set(set.filter((l) => l.meta.split === "heldout").map((l) => l.meta.labelId));
    for (const s of REAL_SHEET_SERIALS) expect(held.has(s)).toBe(true);
    expect(set.filter((l) => l.meta.source === "sheet").every((l) => l.meta.split === "heldout")).toBe(true);
  });

  it("meets the floors honestly (≥50 train, ≥20 held out) and matches the committed manifest", () => {
    const m = summarizeLabelSet(set, { generatedAt: "t", seed: LABEL_SET_SEED, bench: { clipsFound: [], clipsMissing: [] } });
    expect(m.name).toBe(LABEL_SET_NAME);
    expect(m.rows).toBeGreaterThanOrEqual(200);
    expect(m.train).toBeGreaterThanOrEqual(MIN_TRAIN_ROWS);
    expect(m.heldout).toBeGreaterThanOrEqual(MIN_HELDOUT_ROWS);
    expect(m.floorProblems).toEqual([]);
    expect(m.distinctSerials.heldoutReal).toEqual([...REAL_SHEET_SERIALS]);
    // The committed summary was produced by the same generator: split counts can't drift from the code.
    const c = committed as unknown as typeof m;
    expect({ rows: c.rows, train: c.train, heldout: c.heldout, bySource: c.bySource, distinctSerials: c.distinctSerials, standInRows: c.standInRows }).toEqual({ rows: m.rows, train: m.train, heldout: m.heldout, bySource: m.bySource, distinctSerials: m.distinctSerials, standInRows: m.standInRows });
    expect(c.leaked).toEqual([]);
  });

  it("reviewer corrections join the same set as source 'correction' and follow the same split rule", () => {
    const corr = (labelId: string, i: number): TrainingLine => ({ messages: set[0].messages, meta: { rowId: `cor${i}`, caseId: `case_${i}`, itemKey: "lens", truth: { serial: labelId, sku: null, serialUnreadable: false }, expected: { serial: labelId, sku: null, requiresSerial: true }, source: "correction", labelId, split: "train", seed: 1729, fraction: 0.2 } as DatasetRowMeta & { split: "train"; seed: number; fraction: number } });
    const trainSerial = set.find((l) => l.meta.split === "train" && l.meta.labelId?.startsWith("BW-"))!.meta.labelId!;
    const { lines, report } = unionTrainingLines([set, [corr("BW-LN-80311", 1), corr(trainSerial, 2)]]);
    expect(report.bySource.correction).toEqual({ train: 1, heldout: 1 }); // the printed serial is held out; the other follows its label
    expect(lines.find((l) => l.meta.rowId === "cor2")!.meta.split).toBe("train");
    expect(report.leaked).toEqual([]);
    expect(unionTrainingLines([set, set]).report.duplicates).toBe(set.length);
  });
});

describe("bench hook", () => {
  it("with 0 clips: no rows, and it names what is missing", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rw-clips-"));
    const r = await benchLabelRows({ clipsDir: empty, loadSam: () => null });
    expect(r.lines).toEqual([]);
    expect(r.clipsFound).toEqual([]);
    expect(r.clipsMissing).toHaveLength(3);
    expect(r.clipsMissing[0]).toMatch(/^d1-rma-20418-lens-missing \(clip \+ SAM recording missing\)$/);
    expect(findClipIn(empty, "d2-rma-20419-complete")).toBeNull();
  });

  it("when a clip and its SAM recording land, it crops the body and lens at their settled frames with the slip's truth (always held out)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-clips-"));
    fs.writeFileSync(path.join(dir, "d2-rma-20419-complete.mov"), "x");
    const seg = { clipId: "d2-rma-20419-complete", frames: [] } as unknown as SegmentationResult;
    const count = (clipId: string): CountResult => ({ clipId, counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [{ itemKey: "camera_body", t: 3, bbox: [0.6, 0.3, 0.1, 0.1] }, { itemKey: "lens", t: 6, bbox: [0.7, 0.4, 0.1, 0.1] }, { itemKey: "battery", t: 8, bbox: [0.8, 0.5, 0.1, 0.1] }], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } }) as unknown as CountResult;
    const crops: Array<[string, number]> = [];
    const r = await benchLabelRows({ clipsDir: dir, loadSam: (id) => (id === "d2-rma-20419-complete" ? seg : null), count, crop: (file, t) => (crops.push([path.basename(file), t]), "data:image/jpeg;base64,QkVOQ0g=") });
    expect(r.clipsFound).toEqual(["d2-rma-20419-complete"]);
    expect(r.lines.map((l) => [l.meta.itemKey, l.meta.labelId, l.meta.truth.serial, l.meta.source])).toEqual([
      ["camera_body", "BW-CB-55120", "BW-CB-55120", "bench"],
      ["lens", "BW-LN-80311", "BW-LN-80311", "bench"],
    ]);
    expect(crops).toEqual([["d2-rma-20419-complete.mov", 3.2], ["d2-rma-20419-complete.mov", 6.2]]);
    expect(splitLabelSet(r.lines).every((l) => l.meta.split === "heldout")).toBe(true);
  });
});

const COMMITTED_SWITCH_IDS = new Set((committedSwitchJson as { v1: { scoredRowIds: string[] } }).v1.scoredRowIds);

describe("evals: Label reader learning", () => {
  it("real counts from the manifest; 0 corrections shown as 0; 'not run yet' without a switch test", () => {
    const set = splitLabelSet(defaultSet());
    const m = summarizeLabelSet(set, { generatedAt: "2026-10-29T12:00:00Z", seed: LABEL_SET_SEED, bench: { clipsFound: [], clipsMissing: ["d1"] } });
    const v = labelLearningView({ manifest: m, origin: "local", corrections: 0, last: null, history: null });
    expect(v.sources.find((s) => s.source === "sheet")).toMatchObject({ train: 0, heldout: m.bySource.sheet.heldout });
    expect(v.sources.find((s) => s.source === "render")).toMatchObject({ train: m.bySource.render.train, heldout: m.bySource.render.heldout });
    expect(v.sources.find((s) => s.source === "bench")).toMatchObject({ train: 0, heldout: 0 });
    expect(v.total).toEqual({ train: m.train, heldout: m.heldout });
    expect(v.corrections).toBe(0);
    expect(v.lastResult).toBe(NOT_RUN_YET);
    expect(v.floorsMet).toBe(true);
    expect(v.rule).toBe(`v1 (used for this test): ${SWITCH_RULE_LINE}`);
    expect(v.realLabels).toBeNull();
    expect(v.benchNote).toMatch(/no filmed clip/);
    expect(v.setName).toBe(LABEL_SET_NAME);
    expect(v.setName).not.toMatch(/reviewer corrections/);
  });

  it("no set at all says so; the last switch decision is read from the decisions log", () => {
    expect(labelLearningView({ manifest: null, origin: null, corrections: null, last: null })).toMatchObject({ total: { train: 0, heldout: 0 }, floorsMet: null, corrections: null, benchNote: expect.stringMatching(/not generated yet/) });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-dec-"));
    const f = path.join(tmp, "glimmer-decisions.jsonl");
    expect(readLastSwitchDecision(f)).toBeNull();
    const rec = (useAdapter: boolean, at: string) => JSON.stringify({ at, adapter: "rw-labels-1", useAdapter, failed: useAdapter ? [] : ["gain too small"], base: { exactSerial: 50, rows: 82, falseClears: { total: 1 } }, adapterMetrics: { exactSerial: 61, rows: 82, falseClears: { total: 1 } } });
    fs.writeFileSync(f, `${rec(false, "2026-11-01T00:00:00Z")}\n${rec(true, "2026-11-02T00:00:00Z")}\n`);
    fs.appendFileSync(f, `${JSON.stringify({ at: "2026-11-03T00:00:00Z", rule: "v2", useAdapter: false, failed: ["only 0 fresh rows"], freshRows: 0 })}\n`);
    const last = readLastSwitchDecision(f)!;
    expect(last.at).toBe("2026-11-02T00:00:00Z"); // a v2 record is skipped, never read as v1-shaped
    expect(labelLearningView({ manifest: null, origin: null, corrections: 3, last }).lastResult).toBe("adapter rw-labels-1 switched in: base 50/82 exact serials, 1 false clears; adapter 61/82, 1 false clears"); // no run date on the page
  });

  it("the committed v1 record: real printed labels split into readable and covered views; v2 pre-registered, not run", () => {
    const v = labelLearningView({ manifest: null, origin: null, corrections: null, last: null });
    expect(v.lastResult).toMatch(/^kept the base \(exact-serial gain is \+3\.7 points.*base 77\/82 exact serials, 1 false clears; adapter 80\/82, 0 false clears$/);
    expect(v.realLabels).toBe(
      "32 held-out views of the 4 real printed serials. Readable (26): base 26/26, adapter 25/26 (its miss is an abstention, not a wrong read). Covered by a finger or paper (6): the base trusted 2 reads anyway (1 a false clear), the adapter abstained on 6/6.",
    );
    expect(v.ceilingFlaw).toMatch(/only a perfect 82\/82 could pass/);
    expect(v.ruleV2).toMatch(/never been scored on/);
    expect(v.ruleV2Status).toMatch(/not yet run/);
    // v2 may never be scored on the rows v1 scored.
    expect(COMMITTED_SWITCH_IDS.size).toBe(82);
  });

  it("the manifest comes from this machine's generated set when present, else the committed summary", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-ls-"));
    expect(readLabelSetManifest(tmp)).toMatchObject({ origin: "committed", manifest: { name: LABEL_SET_NAME } });
    fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify({ ...committed, rows: 1 }));
    expect(readLabelSetManifest(tmp)).toMatchObject({ origin: "local", manifest: { rows: 1 } });
  });

  it("counts only label-read corrections on a Glimmer card", () => {
    const c = (corrections: Array<{ field: string; reader: string }>) => ({ corrections }) as never;
    expect(countLabelCorrections([])).toBe(0);
    expect(countLabelCorrections([c([{ field: "serial", reader: "muse-glimmer (modal)" }, { field: "present", reader: "muse-glimmer (modal)" }, { field: "sku", reader: "muse-spark-1.3" }]), c([{ field: "sku", reader: "muse-glimmer (fireworks)" }])])).toBe(2);
  });
});

// Keep the type import used (LabelSpec documents the spec shape the tests build).
export type _Spec = LabelSpec;
