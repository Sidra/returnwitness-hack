import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReturnCase, ReviewerCorrection } from "@/lib/domain/case";
import type { ArchivedCrop } from "@/lib/learning/corrections";
import type { DatasetRowMeta } from "@/lib/learning/finetune";
import {
  buildGlimmerSplit,
  decideSwitch,
  decideSwitchV2,
  V2_MIN_ERROR_REDUCTION,
  decisionLogEntry,
  evaluateReads,
  floorProblems,
  judgeRow,
  leakedLabels,
  MIN_EXTRA_CORRECT,
  MIN_HELDOUT_ROWS,
  MIN_TRAIN_ROWS,
  parseGlimmerEvalArgs,
  parseReadsFile,
  parseTrainingJsonl,
  quoteColdInspection,
  quoteLearningPlan,
  quoteGlimmerFineTune,
  quoteLiveEval,
  splitOf,
  splitScore,
  SWITCH_MARGIN,
  toModalJsonl,
  type EvalMetrics,
} from "@/lib/learning/glimmer-eval";
import type { ReadRecord } from "@/lib/openweights/glimmer-modal";
import type { GlimmerItem } from "@/lib/openweights/glimmer";

/* ---------- fixtures ---------- */

const read = (serialRead: string | null, o: Partial<GlimmerItem> = {}): GlimmerItem => ({ itemKey: "lens", serialRead, skuRead: null, legible: true, confidence: 0.95, ...o });
const meta = (rowId: string, o: { truth?: Partial<DatasetRowMeta["truth"]>; expected?: Partial<DatasetRowMeta["expected"]> } = {}): DatasetRowMeta => ({
  rowId,
  caseId: `case_${rowId}`,
  itemKey: "lens",
  truth: { serial: "BW-LN-80311", sku: null, serialUnreadable: false, ...o.truth },
  expected: { serial: "BW-LN-80311", sku: "CK-LENS", requiresSerial: true, ...o.expected },
});

/** n held-out rows where the truth matches the slip; `correct` of them read exactly, the rest abstain. */
function scenario(n: number, correct: number, opts: { falseClears?: number } = {}): { metas: DatasetRowMeta[]; reads: ReadRecord[] } {
  const metas: DatasetRowMeta[] = [];
  const reads: ReadRecord[] = [];
  for (let i = 0; i < n; i++) {
    const id = `r${String(i).padStart(3, "0")}`;
    const isFc = i >= n - (opts.falseClears ?? 0);
    // A false-clear row: the person read a stand-in's serial; the model "reads" the slip's.
    metas.push(meta(id, isFc ? { truth: { serial: "BW-LN-99999" } } : {}));
    reads.push({ rowId: id, read: isFc ? read("BW-LN-80311") : i < correct ? read("BW-LN-80311") : read(null, { legible: false, confidence: 0.2 }) });
  }
  return { metas, reads };
}

const evalOf = (n: number, correct: number, fc = 0): EvalMetrics => {
  const s = scenario(n, correct, { falseClears: fc });
  return evaluateReads(s.metas, s.reads);
};

/* ---------- split ---------- */

describe("split", () => {
  it("is the same formula as modal/glimmer_finetune.py (shared vectors)", () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(process.cwd(), "modal", "glimmer_split_vectors.json"), "utf8")) as Record<string, number>;
    expect(Object.keys(vectors).length).toBeGreaterThanOrEqual(4);
    for (const [id, score] of Object.entries(vectors)) expect(splitScore(id, 1729)).toBeCloseTo(score, 12);
    expect(splitOf("case_a1", 1729, 0.2)).toBe("train"); // 0.2516 ≥ 0.2
    expect(splitOf("case_a1", 1729, 0.3)).toBe("heldout");
  });

  it("is deterministic and roughly the requested fraction", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `case_${i}`);
    const held = ids.filter((id) => splitOf(id) === "heldout").length;
    expect(held / ids.length).toBeGreaterThan(0.17);
    expect(held / ids.length).toBeLessThan(0.23);
    expect(ids.map((id) => splitOf(id))).toEqual(ids.map((id) => splitOf(id)));
    expect(splitOf("case_7", 1)).not.toBeUndefined();
  });

  it("buildGlimmerSplit splits corrections by label id (a real sheet serial is always held out), labels every line, and reports the floors", () => {
    const GL = "muse-glimmer (modal)";
    const CAP = (k: string) => `crop of the counted ${k} as it settled in the tray at 2.0 s`;
    const crops: Record<string, ArchivedCrop[]> = {};
    const cases: ReturnCase[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `case_split_${i}`;
      crops[id] = [{ itemKey: "camera_body", caption: CAP("camera_body"), dataUrl: `data:image/jpeg;base64,B${i}` }, { itemKey: "lens", caption: CAP("lens"), dataUrl: `data:image/jpeg;base64,L${i}` }];
      const cor = (itemKey: string, n: number): ReviewerCorrection => ({ id: `cor_${i}_${n}`, caseId: id, rmaId: "RMA-20419", itemKey, field: "serial", modelValue: "X", humanValue: itemKey === "lens" ? "BW-LN-80311" : "unreadable", reader: GL, cropCaption: CAP(itemKey), person: "Rita Calder", at: `2026-10-29T10:00:0${n}Z` });
      cases.push({ id, runId: "run", rmaId: "RMA-20419", orderId: "ORD-58227", createdAt: "", updatedAt: "", version: 1, state: "Held", holdReasons: [], clip: { clipId: "c", source: "upload", mode: "LIVE_META", provenance: "", durationS: 1, fps: 5 }, disagreements: [], readerRuns: [], timings: [], costs: [], audit: [], corrections: [cor("camera_body", 1), cor("lens", 2)] } as unknown as ReturnCase);
    }
    const { lines, report } = buildGlimmerSplit(cases, { loadCrops: (id) => crops[id] ?? [] });
    expect(lines).toHaveLength(60);
    expect(report.train + report.heldout).toBe(60);
    // Every lens correction names BW-LN-80311, a serial printed on the real sheet: always held out, never trained on.
    expect(lines.filter((l) => l.meta.itemKey === "lens").every((l) => l.meta.split === "heldout" && l.meta.labelId === "BW-LN-80311" && l.meta.source === "correction")).toBe(true);
    // An unreadable body has no serial to group on, so it groups on its own correction id.
    expect(lines.find((l) => l.meta.itemKey === "camera_body")!.meta.labelId).toMatch(/^correction:case_split_\d+:camera_body$/);
    expect(leakedLabels(lines)).toEqual([]);
    expect(report.floorProblems).toEqual(floorProblems(report.train, report.heldout));
    expect(report.floorProblems.length).toBeGreaterThan(0); // 60 rows can't meet both floors at a 0.2 split
    const lens = lines.find((l) => l.meta.itemKey === "lens")!;
    expect(lens.meta).toMatchObject({ truth: { serial: "BW-LN-80311", serialUnreadable: false }, expected: { serial: "BW-LN-80311", requiresSerial: true }, seed: 1729, fraction: 0.2 });
    const body = lines.find((l) => l.meta.itemKey === "camera_body")!;
    expect(body.meta.truth).toEqual({ serial: null, sku: null, serialUnreadable: true });
    // The expected serial lives in meta, never in the prompt.
    expect(JSON.stringify(lens.messages)).not.toContain("BW-LN-80311\"}"); // the answer has it; the user turn must not
    expect(JSON.stringify(lens.messages[1])).not.toContain("BW-LN-80311");
    // Round trip through the JSONL the Modal job reads.
    expect(parseTrainingJsonl(toModalJsonl(lines)).map((l) => l.meta.rowId)).toEqual(lines.map((l) => l.meta.rowId));
    expect(() => parseTrainingJsonl('{"messages":[]}')).toThrow(/not a \{messages, meta\}/);
    expect(() => buildGlimmerSplit(cases, { fraction: 1 })).toThrow(/between 0 and 1/);
  });

  it("floorProblems names both floors", () => {
    expect(floorProblems(MIN_TRAIN_ROWS, MIN_HELDOUT_ROWS)).toEqual([]);
    expect(floorProblems(MIN_TRAIN_ROWS - 1, MIN_HELDOUT_ROWS - 1)).toEqual([`${MIN_TRAIN_ROWS - 1} training rows; the fine-tune needs at least ${MIN_TRAIN_ROWS}`, `${MIN_HELDOUT_ROWS - 1} held-out rows; the switch test needs at least ${MIN_HELDOUT_ROWS}`]);
  });
});

/* ---------- metrics ---------- */

describe("evaluateReads / judgeRow", () => {
  it("exact serial uses the normalised, TRUSTED read; abstaining is right where the person said unreadable", () => {
    expect(judgeRow(meta("a"), read("bw ln 80311")).serialExact).toBe(true);
    expect(judgeRow(meta("a"), read("BW-LN-80311", { confidence: 0.69 })).serialExact).toBe(false); // below the floor = no read
    expect(judgeRow(meta("a", { truth: { serial: null, serialUnreadable: true } }), read(null, { legible: false, confidence: 0.1 })).serialExact).toBe(true);
    expect(judgeRow(meta("a", { truth: { serial: null, serialUnreadable: true } }), read("BW-LN-80311")).serialExact).toBe(false);
    expect(judgeRow(meta("a"), null)).toEqual({ read: false, serialExact: false, skuMatch: null, falseClear: null });
  });

  it("false clear: a trusted read that matches the SLIP when the person says the item doesn't", () => {
    // stand-in: person read a different serial, model 'reads' the expected one → would pass a line that should hold
    expect(judgeRow(meta("a", { truth: { serial: "BW-LN-99999" } }), read("BW-LN-80311")).falseClear).toBe("serial");
    // unreadable label, model confidently returns the slip's serial
    expect(judgeRow(meta("a", { truth: { serial: null, serialUnreadable: true } }), read("BW-LN-80311")).falseClear).toBe("serial");
    // same, but the model was unsure → the app holds the line: not a false clear
    expect(judgeRow(meta("a", { truth: { serial: "BW-LN-99999" } }), read("BW-LN-80311", { legible: false })).falseClear).toBeNull();
    // a WRONG read that differs from the slip raises a hold: wrong, but safe
    expect(judgeRow(meta("a", { truth: { serial: "BW-LN-99999" } }), read("BW-LN-12345")).falseClear).toBeNull();
    // the right item read right is never a false clear
    expect(judgeRow(meta("a"), read("BW-LN-80311")).falseClear).toBeNull();
    // SKU: a knock-off whose label the model reports as the slip's SKU
    expect(judgeRow(meta("a", { truth: { serial: null, sku: "XX-KNOCK" }, expected: { serial: null, requiresSerial: false, sku: "CK-BATT" } }), read(null, { skuRead: "CK-BATT" })).falseClear).toBe("sku");
  });

  it("the same vector as modal/check_glimmer_web.py gives the same numbers (the Python port agrees)", () => {
    const metas = [
      meta("a"),
      meta("b", { truth: { serial: "BW-LN-99999" } }),
      meta("c", { truth: { serial: null, serialUnreadable: true }, expected: { serial: "BW-CB-55120", sku: "CK-BODY" } }),
      meta("d", { truth: { serial: null, sku: "XX-KNOCK" }, expected: { serial: null, sku: "CK-BATT", requiresSerial: false } }),
    ];
    const reads: ReadRecord[] = [
      { rowId: "a", read: read("bw ln 80311") },
      { rowId: "b", read: read("BW-LN-80311") },
      { rowId: "c", read: read("BW-CB-55120", { confidence: 0.5 }) },
      { rowId: "d", read: read(null, { skuRead: "CK-BATT" }) },
    ];
    const m = evaluateReads(metas, reads);
    expect({ rows: m.rows, exactSerial: m.exactSerial, exactSerialRate: m.exactSerialRate, skuRows: m.skuRows, skuMatch: m.skuMatch, falseClears: { serial: m.falseClears.serial, sku: m.falseClears.sku, total: m.falseClears.total }, errors: m.errors }).toEqual({
      rows: 4,
      exactSerial: 3,
      exactSerialRate: 0.75,
      skuRows: 1,
      skuMatch: 0,
      falseClears: { serial: 1, sku: 1, total: 2 },
      errors: 0,
    });
    expect(m.falseClears.rowIds).toEqual(["b", "d"]);
  });

  it("missing, unknown and duplicate reads are counted, not silently used", () => {
    const m = evaluateReads([meta("a"), meta("b")], [{ rowId: "a", read: read("BW-LN-80311") }, { rowId: "a", read: read("WRONG") }, { rowId: "zzz", read: read("BW-LN-80311") }]);
    expect(m).toMatchObject({ rows: 2, readsReturned: 1, errors: 1, exactSerial: 1, unknownReads: 1, duplicateReads: 1 });
    expect(m.judgements.find((j) => j.rowId === "b")!.error).toBe("no read for this row");
    expect(() => evaluateReads([meta("a"), meta("a")], [])).toThrow(/duplicate row ids/);
    expect(evaluateReads([], []).exactSerialRate).toBe(0);
  });
});

/* ---------- switch rule ---------- */

describe("decideSwitch", () => {
  it("uses the adapter when it beats the base by ≥5 points and ≥2 rows with no more false clears", () => {
    const d = decideSwitch(evalOf(40, 30), evalOf(40, 34), { trainRows: 160, adapterName: "rw-labels-1" });
    expect(d).toMatchObject({ useAdapter: true, failed: [], extraCorrect: 4 });
    expect(d.gainPoints).toBeCloseTo(0.1, 10);
    expect(d.summary).toMatch(/^USE rw-labels-1/);
  });

  it("a tie keeps the base", () => {
    const d = decideSwitch(evalOf(40, 30), evalOf(40, 30), { trainRows: 160 });
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/\+0\.0 points \/ \+0 rows/);
  });

  it("exactly the margin passes (5 points, 2 rows on 40); just under fails", () => {
    expect(decideSwitch(evalOf(40, 30), evalOf(40, 32), { trainRows: 160 }).useAdapter).toBe(true); // +5.0 points, +2 rows
    expect(SWITCH_MARGIN).toBe(0.05);
    expect(MIN_EXTRA_CORRECT).toBe(2);
    expect(decideSwitch(evalOf(41, 30), evalOf(41, 32), { trainRows: 160 }).useAdapter).toBe(false); // +4.9 points
  });

  it("on a small held-out set one lucky row can't carry it (≥5 points but only +1 row)", () => {
    const d = decideSwitch(evalOf(20, 15), evalOf(20, 16), { trainRows: 80 });
    expect(d.gainPoints).toBeCloseTo(0.05, 10);
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/\+1 rows/);
  });

  it("fewer held-out rows than the floor keeps the base, however good the adapter looks", () => {
    const d = decideSwitch(evalOf(MIN_HELDOUT_ROWS - 1, 5), evalOf(MIN_HELDOUT_ROWS - 1, 19), { trainRows: 200 });
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(new RegExp(`only ${MIN_HELDOUT_ROWS - 1} held-out rows`));
  });

  it("fewer training rows than the floor keeps the base", () => {
    const d = decideSwitch(evalOf(40, 20), evalOf(40, 39), { trainRows: MIN_TRAIN_ROWS - 1 });
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/trained on only/);
  });

  it("a false-clear regression blocks the switch even with a large accuracy gain", () => {
    const base = evalOf(40, 20); // 0 false clears
    const adapter = evalOf(40, 38, 1); // 38 of 39 normal rows right... and one stand-in let through
    expect(adapter.exactSerial - base.exactSerial).toBeGreaterThanOrEqual(10);
    expect(adapter.falseClears.total).toBe(1);
    const d = decideSwitch(base, adapter, { trainRows: 160, adapterName: "rw-labels-x" });
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/rw-labels-x has 1 false clear\(s\), the base 0/);
  });

  it("equal false clears are allowed ('zero more than the base'), fewer is fine", () => {
    expect(decideSwitch(evalOf(40, 25, 2), evalOf(40, 33, 2), { trainRows: 160 }).useAdapter).toBe(true);
    expect(decideSwitch(evalOf(40, 25, 2), evalOf(40, 33, 0), { trainRows: 160 }).useAdapter).toBe(true);
  });

  it("reads on different held-out rows are never compared", () => {
    const a = scenario(30, 20);
    const b = scenario(30, 28);
    const shifted = evaluateReads(b.metas.map((m) => ({ ...m, rowId: `x${m.rowId}` })), b.reads.map((r) => ({ ...r, rowId: `x${r.rowId}` })));
    const d = decideSwitch(evaluateReads(a.metas, a.reads), shifted, { trainRows: 120 });
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/not read on the same held-out rows/);
  });

  it("collects every failed condition, and the decision-log entry names the rule and the next step", () => {
    const base = evalOf(10, 5);
    const adapter = evalOf(10, 5, 1);
    const d = decideSwitch(base, adapter, { trainRows: 10, adapterName: "rw-labels-z" });
    expect(d.failed).toHaveLength(4); // rows, training rows, false clears, margin
    const entry = decisionLogEntry(d, { at: new Date("2026-11-02T18:00:00Z"), adapterName: "rw-labels-z", base, adapter, trainRows: 10, source: "files a.json / b.json", seed: 1729, fraction: 0.2 });
    expect(entry).toMatch(/^## 2026-11-02 · Glimmer adapter switch test: keep the base model/);
    expect(entry).toContain("MODAL_GLIMMER_ADAPTER stays unset");
    expect(entry).toContain("seed 1729");
    const ok = decideSwitch(evalOf(40, 30), evalOf(40, 36), { trainRows: 160, adapterName: "rw-labels-y" });
    expect(decisionLogEntry(ok, { at: new Date("2026-11-02T18:00:00Z"), adapterName: "rw-labels-y", base: evalOf(40, 30), adapter: evalOf(40, 36), source: "live" })).toContain("Set MODAL_GLIMMER_ADAPTER=rw-labels-y.");
  });
});

/* ---------- quotes + CLI ---------- */

describe("quotes", () => {
  it("fine-tune: load + train rows × epochs × s/row + held-out × 2 reads, at the L40S rate", () => {
    const q = quoteGlimmerFineTune({ trainRows: 160, heldoutRows: 40, epochs: 3 });
    expect(q.seconds).toBe(60 + 160 * 3 * 1.2 + 40 * 2 * 5);
    expect(q.usd).toBe(Math.round((q.seconds / 3600) * 1.95 * 100) / 100);
    expect(q.usd).toBe(0.56); // 1,036 s ≈ 0.29 GPU-hours (measured s/row)
    expect(quoteGlimmerFineTune({ trainRows: 160, heldoutRows: 40, epochs: 3, gpu: "A100-80GB" }).usd).toBe(0.72);
    expect(() => quoteGlimmerFineTune({ trainRows: 1, heldoutRows: 1, epochs: 0 })).toThrow(/epochs/);
  });

  it("live eval: cold start + 2 reads per row + scale-down idle", () => {
    const q = quoteLiveEval(40);
    expect(q.seconds).toBe(300 + 40 * 2 * 4 + 120);
    expect(q.usd).toBe(Math.round((740 / 3600) * 1.95 * 100) / 100);
  });

  it("the learning plan quotes (a) base on held-out, (b) QLoRA on train, (c) adapter on held-out, each labelled", () => {
    const p = quoteLearningPlan({ trainRows: 150, heldoutRows: 82, epochs: 3 });
    expect(p.base.seconds).toBe(300 + 82 * 4 + 120);
    expect(p.adapter.seconds).toBe(p.base.seconds);
    expect(p.finetune.seconds).toBe(60 + 150 * 3 * 1.2 + 82 * 2 * 5);
    expect(p.base.usd).toBe(0.41);
    expect(p.finetune.usd).toBe(0.77);
    expect(p.lines[0]).toMatch(/^\(a\) base Glimmer on the 82 held-out rows: ≈ \$0\.41 .*\(estimate\)$/);
    expect(p.lines[1]).toMatch(/^\(b\) QLoRA on the 150 training rows × 3 epoch\(s\): ≈ \$0\.77/);
    expect(p.lines[2]).toMatch(/^\(c\) the adapter on the same 82 held-out rows/);
    expect(parseGlimmerEvalArgs(["export", "--no-label-set"]).noLabelSet).toBe(true);
  });

  it("a lone inspection on a cold app pays the cold start and the idle window, not just the read", () => {
    const q = quoteColdInspection();
    expect(q.seconds).toBe(300 + 4 + 120);
    expect(q.usd).toBe(0.23);
  });
});

describe("CLI parsing", () => {
  it("parses each command and refuses incomplete or unknown arguments", () => {
    expect(parseGlimmerEvalArgs(["export"])).toMatchObject({ command: "export", epochs: 3, seed: 1729, fraction: 0.2, confirmSpend: false });
    expect(parseGlimmerEvalArgs(["decide", "--data", "d.jsonl", "--base", "b.json", "--adapter", "a.json", "--adapter-name", "rw-1", "--record"])).toMatchObject({ command: "decide", record: true, adapterName: "rw-1" });
    expect(parseGlimmerEvalArgs(["live", "--data", "d.jsonl", "--adapter-name", "rw-1", "--confirm-spend"]).confirmSpend).toBe(true);
    expect(() => parseGlimmerEvalArgs([])).toThrow(/usage/);
    expect(() => parseGlimmerEvalArgs(["decide", "--data", "d.jsonl"])).toThrow(/decide needs/);
    expect(() => parseGlimmerEvalArgs(["live", "--data", "d.jsonl"])).toThrow(/live needs/);
    expect(() => parseGlimmerEvalArgs(["export", "--fraction", "1.5"])).toThrow(/fraction/);
    expect(() => parseGlimmerEvalArgs(["export", "--epochs"])).toThrow(/needs a value/);
    expect(() => parseGlimmerEvalArgs(["export", "--wat"])).toThrow(/unknown argument/);
  });

  it("parseReadsFile accepts the array the Modal job writes and schema-checks each read", () => {
    const recs = parseReadsFile(JSON.stringify([{ rowId: "a", read: read("X") }, { rowId: "b", read: null, error: "answer didn't match the schema" }, { rowId: "c", read: { itemKey: "lens", legible: "yes", confidence: 4 } }]));
    expect(recs[0].read?.serialRead).toBe("X");
    expect(recs[1]).toEqual({ rowId: "b", read: null, error: "answer didn't match the schema" });
    expect(recs[2]).toMatchObject({ rowId: "c", read: null, error: /schema/ });
    expect(() => parseReadsFile('{"x":1}')).toThrow(/JSON array/);
    expect(() => parseReadsFile('[{"read":null}]')).toThrow(/no rowId/);
  });
});

/* ---------- switch rule v2 (pre-registered before any bench clip) ---------- */

describe("decideSwitchV2", () => {
  /** n fresh rows (truth = slip = BW-LN-80311); the base misses `errB`, the adapter misses `errA` (both abstain on a miss). */
  function v2Case(n: number, errB: number, errA: number, o: { fcB?: number; fcA?: number; scored?: number } = {}) {
    const metas: DatasetRowMeta[] = [];
    const baseReads: ReadRecord[] = [];
    const adapterReads: ReadRecord[] = [];
    for (let i = 0; i < n; i++) {
      const id = `v${String(i).padStart(3, "0")}`;
      const fcRow = i < Math.max(o.fcB ?? 0, o.fcA ?? 0);
      // A false-clear row: the person read a stand-in's serial; a model that "reads" the slip clears it.
      metas.push(meta(id, fcRow ? { truth: { serial: "BW-LN-99999" } } : {}));
      const miss = (k: number) => (i >= n - k ? read(null, { legible: false, confidence: 0.1 }) : null); // the last k rows abstain
      const pick = (err: number, fc: number) => (fcRow && i < fc ? read("BW-LN-80311") : fcRow ? read(null, { legible: false, confidence: 0.1 }) : miss(err) ?? read("BW-LN-80311"));
      baseReads.push({ rowId: id, read: pick(errB, o.fcB ?? 0) });
      adapterReads.push({ rowId: id, read: pick(errA, o.fcA ?? 0) });
    }
    const scoredBefore = new Set(metas.slice(0, o.scored ?? 0).map((m) => m.rowId));
    return { metas, baseReads, adapterReads, scoredBefore };
  }

  it("passes at a 40% error reduction with strictly fewer errors and zero false clears for both", () => {
    const d = decideSwitchV2({ ...v2Case(30, 10, 6), trainRows: 150, adapterName: "rw-x" });
    expect(d.errors).toEqual({ base: 10, adapter: 6 });
    expect(d.useAdapter).toBe(true);
    expect(d.summary).toMatch(/^USE rw-x \(rule v2, 30 fresh rows\)/);
    expect(V2_MIN_ERROR_REDUCTION).toBe(0.4);
  });

  it("fails just under 40% (10 → 7 is 30%)", () => {
    const d = decideSwitchV2(v2Case(30, 10, 7));
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/errors 10 → 7 \(30% fewer; needs at least 40%/);
  });

  it("no ceiling: a base with 1 error and an adapter with 0 passes (v1 could never pass this near the top)", () => {
    expect(decideSwitchV2(v2Case(82, 1, 0)).useAdapter).toBe(true);
  });

  it("a base with 0 errors keeps the base: nothing to gain, a tie keeps the base", () => {
    const d = decideSwitchV2(v2Case(30, 0, 0));
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/nothing to gain/);
  });

  it("false clears must fall strictly, or be zero for both", () => {
    expect(decideSwitchV2(v2Case(30, 10, 4, { fcB: 1, fcA: 1 })).failed.join()).toMatch(/false clears 1 → 1/);
    expect(decideSwitchV2(v2Case(30, 10, 4, { fcB: 2, fcA: 1 })).useAdapter).toBe(true);
  });

  it("only rows the adapter was never scored on count; fewer than 20 fresh rows cannot decide", () => {
    const c = v2Case(30, 10, 4, { scored: 15 });
    const d = decideSwitchV2(c);
    expect(d.freshRows).toBe(15);
    expect(d.useAdapter).toBe(false);
    expect(d.failed.join()).toMatch(/only 15 held-out rows this adapter has never been scored on/);
  });

  it("a wrong trusted read on a readable real printed serial fails it; an abstention there does not", () => {
    for (const serial of ["BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298"]) {
      const c = v2Case(30, 10, 4);
      c.metas[29] = meta(c.metas[29].rowId, { truth: { serial }, expected: { serial } });
      c.baseReads[29] = { rowId: c.metas[29].rowId, read: read(serial) };
      c.adapterReads[29] = { rowId: c.metas[29].rowId, read: read(serial.replace(/\d$/, (x) => String((Number(x) + 1) % 10))) };
      const d = decideSwitchV2(c);
      expect(d.realWrongTrusted).toEqual([c.metas[29].rowId]);
      expect(d.useAdapter).toBe(false);
      c.adapterReads[29] = { rowId: c.metas[29].rowId, read: read(null, { legible: false, confidence: 0 }) };
      expect(decideSwitchV2(c).realWrongTrusted).toEqual([]);
    }
  });

  it("a missing read on a fresh row fails it", () => {
    const c = v2Case(30, 10, 4);
    c.adapterReads.pop();
    expect(decideSwitchV2(c).failed.join()).toMatch(/read\(s\) missing/);
  });

  it("the real-serial list mirrors the label set's", async () => {
    const { REAL_SHEET_SERIALS } = await import("@/lib/learning/label-set");
    const src = fs.readFileSync(path.join(process.cwd(), "lib/learning/glimmer-eval.ts"), "utf8");
    for (const s of REAL_SHEET_SERIALS) expect(src).toContain(`"${s}"`);
  });
});
