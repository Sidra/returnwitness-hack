/**
 * The bench label set (truth from the printed label design, lib/learning/label-set.ts) plus reviewer
 * corrections → a QLoRA fine-tune of Muse Glimmer on my Modal GPU → a held-out test that decides
 * whether the fine-tuned adapter is ever used.
 *
 *   buildGlimmerSplit(cases)  the correction rows (lib/learning/finetune.ts buildDataset: the crop, the
 *   unionTrainingLines(sets)  live prompt, the PERSON's value) and the label-set rows, split by LABEL ID
 *                             with a fixed seed, so no serial is ever in both splits; the four serials and
 *                             two charger labels of the real printed sheet are always held out. Held-out rows
 *                             are never trained on: the Modal job (modal/glimmer_finetune.py) recomputes the
 *                             same split and refuses on a mismatch.
 *   evaluateReads(meta, reads) exact-serial match, SKU match and FALSE CLEARS (a read that would let a
 *                             wrong or stand-in serial/SKU pass the slip check) on the held-out rows.
 *   decideSwitch(base, adapter) the switch rule (below). Pure, tested.
 *
 * The switch rule. The adapter is used only if ALL hold:
 *   1. both were read on the same held-out rows, and there are at least MIN_HELDOUT_ROWS of them
 *      (and at least MIN_TRAIN_ROWS were trained on, when that count is known);
 *   2. it beats the base on exact-serial match by at least SWITCH_MARGIN (5 percentage points) AND by at
 *      least MIN_EXTRA_CORRECT rows, so on a small set one lucky row can't carry it;
 *   3. it has no more false clears than the base (adapter.falseClears.total <= base.falseClears.total).
 * Otherwise the base stays, and the decision says which condition failed. A tie keeps the base.
 *
 * Which reads decide: the served configuration (FP8 base on vLLM, with and without the LoRA), read
 * through the endpoint by scripts/glimmer-eval.ts --live. The Modal job's own in-process numbers (NF4
 * base) go into metrics.json for information; the adapter was trained on an NF4 base and will be served
 * on an FP8 base, so only a read through the served stack is a fair test of what would ship.
 */
import { createHash } from "node:crypto";
import type { ReturnCase } from "@/lib/domain/case";
import type { GlimmerItem } from "@/lib/openweights/glimmer";
import { GlimmerItem as GlimmerItemSchema, isTrustedRead, LABEL_CONFIDENCE_FLOOR, normCode } from "@/lib/openweights/glimmer";
import type { ReadRecord } from "@/lib/openweights/glimmer-modal";
import { buildDataset, ROW_SOURCES, type DatasetReport, type DatasetRow, type DatasetRowMeta, type RowSource } from "./finetune";
import type { ArchivedCrop } from "./corrections";

/**
 * Below this many TRAINING rows the job refuses to start. A rank-16 LoRA on Glimmer's 52 language
 * layers has ~96M trainable parameters; on a few dozen crops it memorises them instead of learning
 * the label fonts, and the run costs GPU time to produce an adapter the switch rule would reject.
 * 50 corrected crops is also roughly a week of corrections at a bench that corrects ~10 reads a day.
 */
export const MIN_TRAIN_ROWS = 50;
/** Below this many held-out rows one row is more than 5 points, so the margin would be noise. */
export const MIN_HELDOUT_ROWS = 20;
export const HELDOUT_FRACTION = 0.2;
export const SPLIT_SEED = 1729;
/** The adapter must beat the base on exact-serial match by this much (a rate, 0.05 = 5 points)... */
export const SWITCH_MARGIN = 0.05;
/** ...and by at least this many rows. */
export const MIN_EXTRA_CORRECT = 2;

export type Split = "train" | "heldout";

/** sha256(`${seed}:${caseId}`) → first 32 bits / 2^32 < fraction ⇒ held out. Same formula in modal/glimmer_finetune.py. */
export function splitScore(caseId: string, seed = SPLIT_SEED): number {
  return parseInt(createHash("sha256").update(`${seed}:${caseId}`).digest("hex").slice(0, 8), 16) / 2 ** 32;
}
export const splitOf = (caseId: string, seed = SPLIT_SEED, fraction = HELDOUT_FRACTION): Split => (splitScore(caseId, seed) < fraction ? "heldout" : "train");

export interface TrainingLine extends DatasetRow {
  meta: DatasetRowMeta & { split: Split; seed: number; fraction: number };
}

export interface SplitReport extends DatasetReport {
  train: number;
  heldout: number;
  seed: number;
  fraction: number;
  /** Empty when the floors are met; otherwise why the fine-tune would refuse. */
  floorProblems: string[];
}

export function floorProblems(train: number, heldout: number): string[] {
  return [
    train < MIN_TRAIN_ROWS ? `${train} training rows; the fine-tune needs at least ${MIN_TRAIN_ROWS}` : "",
    heldout < MIN_HELDOUT_ROWS ? `${heldout} held-out rows; the switch test needs at least ${MIN_HELDOUT_ROWS}` : "",
  ].filter(Boolean);
}

/**
 * The serials printed on the real label sheet (labels/label-sheet.html) and its two charger labels.
 * They are ALWAYS held out, so the baseline and the switch test are measured on the actual printed labels
 * and no fine-tune ever trains on them. Same list in modal/glimmer_finetune.py.
 */
export const FORCED_HELDOUT_LABELS: readonly string[] = ["BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298", "charger-1", "charger-2"];

/** What the split groups on: the physical/rendered label (so no serial is ever in both splits); older rows without one group by case. */
export const splitKey = (m: Pick<DatasetRowMeta, "labelId" | "caseId">) => m.labelId ?? m.caseId;

export function splitOfMeta(m: Pick<DatasetRowMeta, "labelId" | "caseId">, seed = SPLIT_SEED, fraction = HELDOUT_FRACTION): Split {
  const key = splitKey(m);
  return FORCED_HELDOUT_LABELS.includes(key) ? "heldout" : splitOf(key, seed, fraction);
}

export interface SourceSplitCounts {
  train: number;
  heldout: number;
}

function countBySource(lines: TrainingLine[]): Record<RowSource, SourceSplitCounts> {
  const out = Object.fromEntries(ROW_SOURCES.map((s) => [s, { train: 0, heldout: 0 }])) as Record<RowSource, SourceSplitCounts>;
  for (const l of lines) out[l.meta.source ?? "correction"][l.meta.split]++;
  return out;
}

/** Label ids that appear in both splits. Always empty by construction; the tests and the Modal job check it anyway. */
export function leakedLabels(lines: TrainingLine[]): string[] {
  const train = new Set(lines.filter((l) => l.meta.split === "train").map((l) => splitKey(l.meta)));
  return [...new Set(lines.filter((l) => l.meta.split === "heldout").map((l) => splitKey(l.meta)).filter((k) => train.has(k)))].sort();
}

/** (Re)assign the split for every line with one rule: by label id, the real sheet labels forced into held-out. */
export function assignSplit<T extends DatasetRow & { meta: DatasetRowMeta }>(lines: T[], seed = SPLIT_SEED, fraction = HELDOUT_FRACTION): TrainingLine[] {
  if (!(fraction > 0 && fraction < 1)) throw new Error("held-out fraction must be between 0 and 1");
  return lines.map((l) => ({ ...l, meta: { ...l.meta, split: splitOfMeta(l.meta, seed, fraction), seed, fraction } }));
}

/** Reviewer-correction rows, split by label id (see assignSplit). */
export function buildGlimmerSplit(cases: ReturnCase[], opts: { loadCrops?: (caseId: string) => ArchivedCrop[]; seed?: number; fraction?: number } = {}): { lines: TrainingLine[]; report: SplitReport } {
  const seed = opts.seed ?? SPLIT_SEED;
  const fraction = opts.fraction ?? HELDOUT_FRACTION;
  const { rows, meta, report } = buildDataset(cases, { loadCrops: opts.loadCrops });
  const lines = assignSplit(rows.map((r, i) => ({ ...r, meta: meta[i] })), seed, fraction);
  const train = lines.filter((l) => l.meta.split === "train").length;
  const heldout = lines.length - train;
  return { lines, report: { ...report, train, heldout, seed, fraction, floorProblems: floorProblems(train, heldout) } };
}

export interface UnionReport {
  rows: number;
  train: number;
  heldout: number;
  bySource: Record<RowSource, SourceSplitCounts>;
  distinctLabels: { train: number; heldout: number };
  leaked: string[];
  duplicates: number;
  floorProblems: string[];
}

/**
 * The training set the fine-tune and the eval consume: the bench label set plus any reviewer
 * corrections (source "correction"), re-split with the one rule. Duplicate row ids keep the first.
 */
export function unionTrainingLines(sets: TrainingLine[][], seed = SPLIT_SEED, fraction = HELDOUT_FRACTION): { lines: TrainingLine[]; report: UnionReport } {
  const seen = new Set<string>();
  let duplicates = 0;
  const merged: TrainingLine[] = [];
  for (const l of sets.flat()) {
    if (seen.has(l.meta.rowId)) {
      duplicates++;
      continue;
    }
    seen.add(l.meta.rowId);
    merged.push(l);
  }
  const lines = assignSplit(merged, seed, fraction);
  const train = lines.filter((l) => l.meta.split === "train");
  const held = lines.filter((l) => l.meta.split === "heldout");
  return {
    lines,
    report: {
      rows: lines.length,
      train: train.length,
      heldout: held.length,
      bySource: countBySource(lines),
      distinctLabels: { train: new Set(train.map((l) => splitKey(l.meta))).size, heldout: new Set(held.map((l) => splitKey(l.meta))).size },
      leaked: leakedLabels(lines),
      duplicates,
      floorProblems: floorProblems(train.length, held.length),
    },
  };
}

/** One JSON object per line: {messages, meta}. What modal/glimmer_finetune.py reads. */
export const toModalJsonl = (lines: TrainingLine[]) => lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");

export function parseTrainingJsonl(text: string): TrainingLine[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const o = JSON.parse(s) as Partial<TrainingLine>;
      if (!Array.isArray(o.messages) || !o.meta?.rowId || !o.meta.split) throw new Error(`line ${i + 1} is not a {messages, meta} training line`);
      return o as TrainingLine;
    });
}

/* ---------- Metrics ---------- */

export interface RowJudgement {
  rowId: string;
  read: boolean;
  serialExact: boolean;
  /** null when the person's SKU is unknown for this row (not counted in the SKU rate). */
  skuMatch: boolean | null;
  falseClear: "serial" | "sku" | null;
  error?: string;
}

export interface EvalMetrics {
  rows: number;
  rowIds: string[];
  readsReturned: number;
  errors: number;
  exactSerial: number;
  exactSerialRate: number;
  skuRows: number;
  skuMatch: number;
  skuMatchRate: number | null;
  falseClears: { serial: number; sku: number; total: number; rowIds: string[] };
  /** Reads for row ids that are not in the held-out set (ignored; a sign the files don't belong together). */
  unknownReads: number;
  duplicateReads: number;
  judgements: RowJudgement[];
}

const trustedSerial = (r: GlimmerItem, floor: number) => (isTrustedRead(r, floor) && r.serialRead?.trim() ? r.serialRead : null);
const same = (a: string | null | undefined, b: string | null | undefined) => a != null && b != null && normCode(a) === normCode(b) && normCode(a) !== "";

export function judgeRow(m: DatasetRowMeta, read: GlimmerItem | null, floor = LABEL_CONFIDENCE_FLOOR): Omit<RowJudgement, "rowId" | "error"> {
  if (!read) return { read: false, serialExact: false, skuMatch: m.truth.sku == null ? null : false, falseClear: null };
  const ts = trustedSerial(read, floor);
  // Exact serial: the trusted transcription equals the person's; where the person said "unreadable"
  // (or there is no serial), the right answer is to abstain.
  const serialExact = m.truth.serialUnreadable || m.truth.serial == null ? ts == null : same(ts, m.truth.serial);
  const trustedSku = isTrustedRead(read, floor) && read.skuRead?.trim() ? read.skuRead : null;
  const skuMatch = m.truth.sku == null ? null : same(trustedSku, m.truth.sku);
  // False clear: the read agrees with the SLIP although the person says the item doesn't (a stand-in,
  // a swapped unit, or a label nobody can read): the app would pass a line that should hold.
  const truthPassesSerial = !m.truth.serialUnreadable && same(m.truth.serial, m.expected.serial);
  const serialFalseClear = m.expected.requiresSerial && m.expected.serial != null && same(ts, m.expected.serial) && !truthPassesSerial;
  const skuFalseClear = m.expected.sku != null && m.truth.sku != null && !same(m.truth.sku, m.expected.sku) && same(trustedSku, m.expected.sku);
  return { read: true, serialExact, skuMatch, falseClear: serialFalseClear ? "serial" : skuFalseClear ? "sku" : null };
}

export function evaluateReads(meta: DatasetRowMeta[], reads: ReadRecord[], floor = LABEL_CONFIDENCE_FLOOR): EvalMetrics {
  const ids = new Set(meta.map((m) => m.rowId));
  if (ids.size !== meta.length) throw new Error("held-out rows have duplicate row ids");
  const byId = new Map<string, ReadRecord>();
  let unknownReads = 0;
  let duplicateReads = 0;
  for (const r of reads) {
    if (!ids.has(r.rowId)) unknownReads++;
    else if (byId.has(r.rowId)) duplicateReads++;
    else byId.set(r.rowId, r);
  }
  const judgements: RowJudgement[] = meta.map((m) => {
    const rec = byId.get(m.rowId);
    return { rowId: m.rowId, ...judgeRow(m, rec?.read ?? null, floor), ...(rec?.error ? { error: rec.error } : !rec ? { error: "no read for this row" } : {}) };
  });
  const exactSerial = judgements.filter((j) => j.serialExact).length;
  const skuJudged = judgements.filter((j) => j.skuMatch != null);
  const skuMatch = skuJudged.filter((j) => j.skuMatch).length;
  const fc = judgements.filter((j) => j.falseClear);
  return {
    rows: meta.length,
    rowIds: meta.map((m) => m.rowId).sort(),
    readsReturned: judgements.filter((j) => j.read).length,
    errors: judgements.filter((j) => !j.read).length,
    exactSerial,
    exactSerialRate: meta.length ? exactSerial / meta.length : 0,
    skuRows: skuJudged.length,
    skuMatch,
    skuMatchRate: skuJudged.length ? skuMatch / skuJudged.length : null,
    falseClears: { serial: fc.filter((j) => j.falseClear === "serial").length, sku: fc.filter((j) => j.falseClear === "sku").length, total: fc.length, rowIds: fc.map((j) => j.rowId) },
    unknownReads,
    duplicateReads,
    judgements,
  };
}

/* ---------- The switch rule ---------- */

export interface SwitchDecision {
  useAdapter: boolean;
  /** Each condition that failed, in plain words. Empty when the adapter is used. */
  failed: string[];
  summary: string;
  gainPoints: number;
  extraCorrect: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function decideSwitch(base: EvalMetrics, adapter: EvalMetrics, ctx: { trainRows?: number; adapterName?: string } = {}): SwitchDecision {
  const name = ctx.adapterName ?? "the adapter";
  const failed: string[] = [];
  const sameRows = base.rows === adapter.rows && base.rowIds.every((id, i) => adapter.rowIds[i] === id);
  if (!sameRows) failed.push(`base and ${name} were not read on the same held-out rows (${base.rows} vs ${adapter.rows})`);
  if (base.rows < MIN_HELDOUT_ROWS) failed.push(`only ${base.rows} held-out rows (the test needs at least ${MIN_HELDOUT_ROWS})`);
  if (ctx.trainRows != null && ctx.trainRows < MIN_TRAIN_ROWS) failed.push(`trained on only ${ctx.trainRows} rows (at least ${MIN_TRAIN_ROWS})`);
  if (adapter.falseClears.total > base.falseClears.total) failed.push(`${name} has ${adapter.falseClears.total} false clear(s), the base ${base.falseClears.total}: a read that lets a stand-in pass is never traded for accuracy`);
  const gainPoints = adapter.exactSerialRate - base.exactSerialRate;
  const extraCorrect = adapter.exactSerial - base.exactSerial;
  // Compare in whole basis points so 0.05 computed from integers never loses to float rounding.
  if (Math.round(gainPoints * 10_000) < Math.round(SWITCH_MARGIN * 10_000) || extraCorrect < MIN_EXTRA_CORRECT)
    failed.push(`exact-serial gain is ${gainPoints >= 0 ? "+" : ""}${(gainPoints * 100).toFixed(1)} points / ${extraCorrect >= 0 ? "+" : ""}${extraCorrect} rows (needs at least +${SWITCH_MARGIN * 100} points and +${MIN_EXTRA_CORRECT} rows)`);
  const useAdapter = failed.length === 0;
  const line = (label: string, m: EvalMetrics) => `${label}: exact serial ${m.exactSerial}/${m.rows} (${pct(m.exactSerialRate)}), SKU ${m.skuMatch}/${m.skuRows}, false clears ${m.falseClears.total}`;
  const summary = `${useAdapter ? `USE ${name}` : "KEEP THE BASE MODEL"}. ${line("base", base)}; ${line(name, adapter)}.${useAdapter ? "" : ` Failed: ${failed.join("; ")}.`}`;
  return { useAdapter, failed, summary, gainPoints, extraCorrect };
}

/* ---------- Switch rule v2 (pre-registered, before any bench clip exists) ---------- */

/**
 * Why v2: v1's fixed margin (+5 points) can't be met near the ceiling. With the base at 77/82 (93.9%) only a
 * perfect 82/82 could pass, so v1 kept the base although the first adapter read 80/82 with 0 false clears
 * (v1's verdict stands; see ADR-007). v2 is written down before it is ever run, and is scored ONLY on held-out
 * rows this adapter has never been scored on (the d1–d3 bench crops, which carry the real printed serials on
 * real footage, plus any freshly seeded rows); the rows v1 scored are listed in data/glimmer-switch.json.
 *
 * The adapter is used only if ALL hold, on at least MIN_HELDOUT_ROWS fresh rows read by both:
 *   1. exact-serial ERRORS fall by at least V2_MIN_ERROR_REDUCTION (40%) relative to the base, and strictly;
 *      if the base has no errors on the fresh rows there is nothing to gain, and a tie keeps the base;
 *   2. false clears strictly fewer than the base, or zero for both;
 *   3. no wrong TRUSTED read on any readable row of a real printed serial (abstaining is allowed);
 *   4. at least MIN_TRAIN_ROWS rows were trained on, when that count is known.
 */
export const V2_MIN_ERROR_REDUCTION = 0.4;
export const SWITCH_RULE_V2_TEXT = `v2: on at least ${MIN_HELDOUT_ROWS} held-out rows the adapter has never been scored on, exact-serial errors down by at least ${V2_MIN_ERROR_REDUCTION * 100}% (and strictly fewer) than the base, false clears strictly fewer (or zero for both), and no wrong trusted read on any readable real printed serial.`;

export interface SwitchDecisionV2 extends SwitchDecision {
  rule: "v2";
  freshRows: number;
  errors: { base: number; adapter: number };
  falseClears: { base: number; adapter: number };
  realWrongTrusted: string[];
}

const REAL_PRINTED = new Set(["BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298"]);

export function decideSwitchV2(i: { metas: DatasetRowMeta[]; baseReads: ReadRecord[]; adapterReads: ReadRecord[]; scoredBefore: ReadonlySet<string>; trainRows?: number; adapterName?: string; floor?: number }): SwitchDecisionV2 {
  const name = i.adapterName ?? "the adapter";
  const floor = i.floor ?? LABEL_CONFIDENCE_FLOOR;
  const fresh = i.metas.filter((m) => !i.scoredBefore.has(m.rowId));
  const failed: string[] = [];
  if (fresh.length < MIN_HELDOUT_ROWS) failed.push(`only ${fresh.length} held-out rows this adapter has never been scored on (v2 needs at least ${MIN_HELDOUT_ROWS})`);
  if (i.trainRows != null && i.trainRows < MIN_TRAIN_ROWS) failed.push(`trained on only ${i.trainRows} rows (at least ${MIN_TRAIN_ROWS})`);
  const b = evaluateReads(fresh, i.baseReads, floor);
  const a = evaluateReads(fresh, i.adapterReads, floor);
  const missing = a.judgements.filter((j) => j.error === "no read for this row").length + b.judgements.filter((j) => j.error === "no read for this row").length;
  if (missing) failed.push(`${missing} fresh row read(s) missing; both must read every fresh row`);
  const errB = b.rows - b.exactSerial;
  const errA = a.rows - a.exactSerial;
  if (errB === 0) failed.push(`the base makes no exact-serial errors on the fresh rows, so there is nothing to gain (a tie keeps the base)`);
  // Integers only: errA <= errB × (1 − 0.4)  ⇔  10·errA <= 6·errB.
  else if (errA >= errB || errA * 10 > errB * Math.round((1 - V2_MIN_ERROR_REDUCTION) * 10)) failed.push(`exact-serial errors ${errB} → ${errA} (${errB ? `${Math.round(((errB - errA) / errB) * 100)}% fewer` : "n/a"}; needs at least ${V2_MIN_ERROR_REDUCTION * 100}% fewer and strictly fewer)`);
  const fcB = b.falseClears.total;
  const fcA = a.falseClears.total;
  if (!(fcA < fcB || (fcA === 0 && fcB === 0))) failed.push(`false clears ${fcB} → ${fcA} (need strictly fewer, or zero for both)`);
  const byId = new Map(i.adapterReads.map((r) => [r.rowId, r] as const));
  const realWrongTrusted = fresh
    .filter((m) => !m.truth.serialUnreadable && m.truth.serial != null && REAL_PRINTED.has(m.truth.serial))
    .filter((m) => {
      const r = byId.get(m.rowId)?.read;
      const ts = r && isTrustedRead(r, floor) && r.serialRead?.trim() ? r.serialRead : null;
      return ts != null && !same(ts, m.truth.serial);
    })
    .map((m) => m.rowId);
  if (realWrongTrusted.length) failed.push(`${realWrongTrusted.length} wrong trusted read(s) on readable real printed serials (${realWrongTrusted.join(", ")})`);
  const useAdapter = failed.length === 0;
  const summary = `${useAdapter ? `USE ${name}` : "KEEP THE BASE MODEL"} (rule v2, ${fresh.length} fresh rows). Errors ${errB} → ${errA}; false clears ${fcB} → ${fcA}.${useAdapter ? "" : ` Failed: ${failed.join("; ")}.`}`;
  return { rule: "v2", useAdapter, failed, summary, gainPoints: a.exactSerialRate - b.exactSerialRate, extraCorrect: a.exactSerial - b.exactSerial, freshRows: fresh.length, errors: { base: errB, adapter: errA }, falseClears: { base: fcB, adapter: fcA }, realWrongTrusted };
}

/** A dated DECISIONLOG.md entry, in the log's own shape. */
export function decisionLogEntry(d: SwitchDecision, ctx: { at: Date; adapterName: string; base: EvalMetrics; adapter: EvalMetrics; trainRows?: number; source: string; seed?: number; fraction?: number; sources?: string }): string {
  const m = (label: string, x: EvalMetrics) => `- ${label}: exact serial ${x.exactSerial}/${x.rows} (${pct(x.exactSerialRate)}), SKU ${x.skuMatch}/${x.skuRows}${x.skuMatchRate == null ? "" : ` (${pct(x.skuMatchRate)})`}, false clears ${x.falseClears.total} (serial ${x.falseClears.serial}, SKU ${x.falseClears.sku}), no read ${x.errors}`;
  return [
    `## ${ctx.at.toISOString().slice(0, 10)} · Glimmer adapter switch test: ${d.useAdapter ? `use ${ctx.adapterName}` : "keep the base model"}`,
    `- Held-out rows: ${ctx.base.rows}${ctx.sources ? ` (${ctx.sources})` : ""}${ctx.trainRows != null ? `, ${ctx.trainRows} trained on` : ""}${ctx.seed != null ? `, split by label id (case id when a row has none; seed ${ctx.seed}, fraction ${ctx.fraction})` : ""}. Reads: ${ctx.source}.`,
    m("Base (meta-models/Muse-Glimmer-30B)", ctx.base),
    m(`Adapter ${ctx.adapterName}`, ctx.adapter),
    `- Rule (lib/learning/glimmer-eval.ts): the adapter only if exact serial is at least +${SWITCH_MARGIN * 100} points AND +${MIN_EXTRA_CORRECT} rows over the base, with no more false clears, on at least ${MIN_HELDOUT_ROWS} shared held-out rows.`,
    d.useAdapter ? `- Decision: use it. Set MODAL_GLIMMER_ADAPTER=${ctx.adapterName}.` : `- Decision: keep the base; MODAL_GLIMMER_ADAPTER stays unset. Why: ${d.failed.join("; ")}.`,
    "",
  ].join("\n");
}

/* ---------- GPU quotes (Modal) ---------- */

/** Modal GPU list prices (USD per hour); re-read Modal's pricing page before a paid run. */
export const MODAL_GPU_USD_PER_HOUR = { L40S: 1.95, "A100-80GB": 2.5, H100: 3.95 } as const;
export type ModalGpu = keyof typeof MODAL_GPU_USD_PER_HOUR;
/**
 * Measured on the first run (rw-labels-2026-10-29, metrics.json): 1.11 s per row-epoch on one L40S
 * (NF4 QLoRA, r16, gradient checkpointing; ~1.6k-token rows) and a 26–46 s NF4 load from the cached
 * weights volume. Rounded up. (The pre-run estimates were 8 s and 360 s.)
 */
export const FT_SECONDS_PER_ROW_EPOCH = 1.2;
/** NF4 load from the cached volume (measured 26–46 s). */
export const FT_LOAD_SECONDS = 60;
/** One held-out generation (~60 JSON tokens) with HF generate on the NF4 model, base and adapter each. */
export const FT_EVAL_SECONDS_PER_GENERATION = 5;

export interface GpuQuote {
  gpu: ModalGpu;
  seconds: number;
  gpuHours: number;
  usd: number;
  basis: string;
}

export function quoteGlimmerFineTune(o: { trainRows: number; heldoutRows: number; epochs: number; gpu?: ModalGpu }): GpuQuote {
  if (!Number.isInteger(o.epochs) || o.epochs < 1) throw new Error("epochs must be a positive whole number");
  const gpu = o.gpu ?? "L40S";
  const seconds = FT_LOAD_SECONDS + o.trainRows * o.epochs * FT_SECONDS_PER_ROW_EPOCH + o.heldoutRows * 2 * FT_EVAL_SECONDS_PER_GENERATION;
  const gpuHours = seconds / 3600;
  const usd = Math.round(gpuHours * MODAL_GPU_USD_PER_HOUR[gpu] * 100) / 100;
  return { gpu, seconds, gpuHours, usd, basis: `${FT_LOAD_SECONDS} s load + ${o.trainRows} rows × ${o.epochs} epoch(s) × ${FT_SECONDS_PER_ROW_EPOCH} s + ${o.heldoutRows} held-out × 2 reads × ${FT_EVAL_SECONDS_PER_GENERATION} s = ${Math.round(seconds)} s on one ${gpu} at $${MODAL_GPU_USD_PER_HOUR[gpu]}/h (load and s/row measured on the first run; held-out reads estimated)` };
}

/** Serving: a cold start of the vLLM container (FP8 load + compile + CUDA graphs), estimated. */
export const SERVE_COLD_START_SECONDS = 300;
/** The app's scaledown_window: a warm container idles this long after the last request, billed. */
export const SERVE_SCALEDOWN_SECONDS = 120;
/** One warm label read (3–4 crops, ~100 output tokens) on an L40S, estimated. */
export const SERVE_SECONDS_PER_READ = 4;

/** One inspection on a cold app: cold start + one read + the scale-down idle window, all billed. */
export function quoteColdInspection(): GpuQuote {
  const seconds = SERVE_COLD_START_SECONDS + SERVE_SECONDS_PER_READ + SERVE_SCALEDOWN_SECONDS;
  const gpuHours = seconds / 3600;
  return { gpu: "L40S", seconds, gpuHours, usd: Math.round(gpuHours * MODAL_GPU_USD_PER_HOUR.L40S * 100) / 100, basis: `${SERVE_COLD_START_SECONDS} s cold start + ${SERVE_SECONDS_PER_READ} s read + ${SERVE_SCALEDOWN_SECONDS} s idle before scale-down on one L40S (estimates)` };
}

/** N reads through the served endpoint in one session: cold start + N reads + the idle window. */
export function quoteHeldOutRead(n: number): GpuQuote {
  const seconds = SERVE_COLD_START_SECONDS + n * SERVE_SECONDS_PER_READ + SERVE_SCALEDOWN_SECONDS;
  const gpuHours = seconds / 3600;
  return { gpu: "L40S", seconds, gpuHours, usd: Math.round(gpuHours * MODAL_GPU_USD_PER_HOUR.L40S * 100) / 100, basis: `${SERVE_COLD_START_SECONDS} s cold start + ${n} reads × ${SERVE_SECONDS_PER_READ} s + ${SERVE_SCALEDOWN_SECONDS} s idle = ${seconds} s on one L40S at $${MODAL_GPU_USD_PER_HOUR.L40S}/h` };
}

/** The three steps of a learning run, each quoted on its own (estimates until the first run measures them). */
export function quoteLearningPlan(o: { trainRows: number; heldoutRows: number; epochs: number }): { base: GpuQuote; finetune: GpuQuote; adapter: GpuQuote; lines: string[] } {
  const base = quoteHeldOutRead(o.heldoutRows);
  const finetune = quoteGlimmerFineTune(o);
  const adapter = quoteHeldOutRead(o.heldoutRows);
  const fmt = (q: GpuQuote) => `≈ $${q.usd.toFixed(2)} (${q.gpuHours.toFixed(2)} GPU-hours)`;
  return {
    base,
    finetune,
    adapter,
    lines: [
      `(a) base Glimmer on the ${o.heldoutRows} held-out rows: ${fmt(base)} · ${base.basis} (estimate)`,
      `(b) QLoRA on the ${o.trainRows} training rows × ${o.epochs} epoch(s): ${fmt(finetune)} · ${finetune.basis}`,
      `(c) the adapter on the same ${o.heldoutRows} held-out rows: ${fmt(adapter)} · ${adapter.basis} (estimate; ${SERVE_COLD_START_SECONDS + SERVE_SCALEDOWN_SECONDS} s less if run right after (a) on the warm container)`,
    ],
  };
}

export function quoteLiveEval(heldoutRows: number): GpuQuote {
  const seconds = SERVE_COLD_START_SECONDS + heldoutRows * 2 * SERVE_SECONDS_PER_READ + SERVE_SCALEDOWN_SECONDS;
  const gpuHours = seconds / 3600;
  return { gpu: "L40S", seconds, gpuHours, usd: Math.round(gpuHours * MODAL_GPU_USD_PER_HOUR.L40S * 100) / 100, basis: `${SERVE_COLD_START_SECONDS} s cold start + ${heldoutRows} rows × 2 (base, adapter) × ${SERVE_SECONDS_PER_READ} s + ${SERVE_SCALEDOWN_SECONDS} s idle before scale-down on one L40S at $${MODAL_GPU_USD_PER_HOUR.L40S}/h (estimates)` };
}

/* ---------- CLI arguments (scripts/glimmer-eval.ts) ---------- */

export interface GlimmerEvalArgs {
  command: "export" | "decide" | "live";
  /** Which pre-registered switch rule decides: v1 (ADR-007 as first written) or v2 (fresh rows only). */
  rule: "v1" | "v2";
  /** Training recipe for `export` (GLIMMER_RECIPES): v2 adds reasoning targets. */
  recipe: GlimmerRecipeId;
  data: string | null;
  out: string | null;
  base: string | null;
  adapter: string | null;
  adapterName: string | null;
  trainRows: number | null;
  epochs: number;
  seed: number;
  fraction: number;
  record: boolean;
  confirmSpend: boolean;
  noLabelSet: boolean;
}

/* ---------- Fine-tune recipes (what the adapter under test is trained with) ---------- */

export type GlimmerRecipeId = "v1" | "v2";

/**
 * v1: answer-only targets (the JSON the reader must return), as the first adapter was trained.
 * v2 (written before any v2 row is scored): Meta's post-training guide (dev.meta.ai/docs/muse-glimmer/post-training)
 * warns that fine-tuning only on final answers may suppress the chain of thought, and says to put
 * reasoning in the targets via `reasoning_content`. v2 adds a short rationale to every row, built by a fixed template
 * from that row's own truth (`reasoningTarget`), so it is honest by construction and teaches the two behaviours the
 * v1 read showed matter: abstain on a covered serial, and read the part number without the brand line.
 * Both: no sample packing (one row per optimiser step; the guide requires sample_packing false for multimodal rows);
 * no GRPO (the guide's recipe for checkable rewards; not used here).
 */
export const GLIMMER_RECIPES: Record<GlimmerRecipeId, { id: GlimmerRecipeId; name: string; reasoningTargets: boolean; samplePacking: false; grpo: false; text: string }> = {
  v1: { id: "v1", name: "answer-only", reasoningTargets: false, samplePacking: false, grpo: false, text: "targets are the reader's JSON answer only; one row per step; no packing" },
  v2: {
    id: "v2",
    name: "reasoning-targets",
    reasoningTargets: true,
    samplePacking: false,
    grpo: false,
    text: "targets are a templated rationale (reasoning_content, built from the row's truth) followed by the JSON answer; one row per step; no packing; no GRPO",
  },
};

type Answer = { serialRead: string | null; skuRead: string | null; legible: boolean; confidence: number };

/** The rationale for one answer. Deterministic, and it states only what the answer itself says. */
export function reasoningTarget(a: Answer): string {
  if (!a.legible || !a.serialRead) {
    return [
      "The serial characters on this label are covered, blurred or cut off, so I can't read them with certainty.",
      "I don't guess a serial: serialRead is null, legible is false, confidence 0.",
      a.skuRead ? `The part number line is still readable: ${a.skuRead}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    "The label is in frame and its characters are sharp.",
    `Serial, character by character: ${a.serialRead.split("").join(" ")}.`,
    a.skuRead ? `Part number line: ${a.skuRead} (the printed part number only, not the brand name above it).` : "No part number line is printed.",
    "Everything I read is legible, so confidence is high.",
  ].join(" ");
}

/** Apply a recipe to a training line. v2 adds `reasoning_content` from the line's own assistant answer. */
export function applyRecipe(line: TrainingLine, recipe: GlimmerRecipeId): TrainingLine {
  if (!GLIMMER_RECIPES[recipe].reasoningTargets) return line;
  const [sys, user, asst] = line.messages;
  const parsed = JSON.parse(asst.content) as { items?: Answer[] };
  const item = parsed.items?.[0];
  if (!item) throw new Error(`row ${line.meta.rowId}: assistant answer has no item to reason about`);
  return { ...line, messages: [sys, user, { ...asst, reasoning_content: reasoningTarget(item) }] };
}

export function parseGlimmerEvalArgs(argv: string[]): GlimmerEvalArgs {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "decide" && command !== "live") throw new Error("usage: glimmer-eval.ts export|decide|live [options] (see the script header)");
  const a: GlimmerEvalArgs = { command, rule: "v1", recipe: "v1", data: null, out: null, base: null, adapter: null, adapterName: null, trainRows: null, epochs: 3, seed: SPLIT_SEED, fraction: HELDOUT_FRACTION, record: false, confirmSpend: false, noLabelSet: false };
  const val = (i: number, flag: string) => {
    const v = rest[i];
    if (v == null || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (f === "--data") a.data = val(++i, f);
    else if (f === "--out") a.out = val(++i, f);
    else if (f === "--base") a.base = val(++i, f);
    else if (f === "--adapter") a.adapter = val(++i, f);
    else if (f === "--adapter-name") a.adapterName = val(++i, f);
    else if (f === "--train-rows") a.trainRows = Number(val(++i, f));
    else if (f === "--epochs") a.epochs = Number(val(++i, f));
    else if (f === "--seed") a.seed = Number(val(++i, f));
    else if (f === "--fraction") a.fraction = Number(val(++i, f));
    else if (f === "--record") a.record = true;
    else if (f === "--confirm-spend") a.confirmSpend = true;
    else if (f === "--no-label-set") a.noLabelSet = true;
    else if (f === "--recipe") {
      const r = val(++i, f);
      if (r !== "v1" && r !== "v2") throw new Error("--recipe must be v1 or v2");
      a.recipe = r;
    }
    else if (f === "--rule") {
      const r = val(++i, f);
      if (r !== "v1" && r !== "v2") throw new Error("--rule must be v1 or v2");
      a.rule = r;
    }
    else throw new Error(`unknown argument: ${f}`);
  }
  if (!Number.isInteger(a.epochs) || a.epochs < 1) throw new Error("--epochs must be a positive whole number");
  if (!Number.isInteger(a.seed)) throw new Error("--seed must be a whole number");
  if (!(a.fraction > 0 && a.fraction < 1)) throw new Error("--fraction must be between 0 and 1");
  if (a.trainRows != null && !(Number.isInteger(a.trainRows) && a.trainRows >= 0)) throw new Error("--train-rows must be a whole number");
  if (command === "decide" && (!a.data || !a.base || !a.adapter || !a.adapterName)) throw new Error("decide needs --data, --base, --adapter and --adapter-name");
  if (command === "live" && (!a.data || !a.adapterName)) throw new Error("live needs --data and --adapter-name");
  return a;
}

/** Read a reads file: a ReadRecord[] (what --live and the Modal job's heldout_reads.*.json write). */
export function parseReadsFile(text: string): ReadRecord[] {
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { reads?: unknown }).reads;
  if (!Array.isArray(list)) throw new Error("a reads file is a JSON array of {rowId, read, error?}");
  return list.map((r, i) => {
    const o = r as Partial<ReadRecord>;
    if (typeof o.rowId !== "string") throw new Error(`read ${i + 1} has no rowId`);
    const p = o.read == null ? null : GlimmerItemSchema.safeParse(o.read);
    if (p && !p.success) return { rowId: o.rowId, read: null, error: "read didn't match the Glimmer item schema" };
    return { rowId: o.rowId, read: p ? p.data : null, ...(o.error ? { error: String(o.error) } : {}) };
  });
}
