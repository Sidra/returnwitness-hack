/**
 * The bench label set · truth from the printed label design.
 *
 * The QLoRA fine-tune needs ≥50 training rows and the switch test ≥20 held-out rows; reviewer
 * corrections arrive one at a time. This set gives the label reader a ground truth that does not
 * depend on anyone correcting anything: the truth of every row is the label that was PRINTED (or
 * rendered), so it is known exactly, never inferred from a model.
 *
 *   sheet   crops of the 10 labels on the real printed sheet (labels/preview.png, the render of
 *           labels/label-sheet.html), one identity view + seeded augmentations. 4 distinct serials
 *           (BW-CB-55120, BW-LN-80311, BW-CB-55107, BW-LN-80298) + 2 charger labels.
 *   render  the same label design (the sheet's own CSS and markup) re-rendered in headless Chrome with NEW
 *           seeded serials in the real format, each with seeded augmentations done in the page.
 *   bench   crops of the camera body and lens at their settled frames in a filmed bench clip (d1–d3),
 *           when both the clip and its SAM recording exist; truth from that RMA's packing slip.
 * Reviewer corrections join the same set with source "correction" (lib/learning/finetune.ts).
 *
 * Augmentations (seeded, deterministic per row): perspective/rotation within ±25°, scale, blur ≤ 1.6 px,
 * a glare gradient, partial occlusion by a finger-like bar or packing paper covering ≤ 30% of the label,
 * JPEG quality 35–92. When the occluder's box touches the serial, the row's truth is "unreadable"
 * (serialRead null, legible false): the reader is taught to abstain, never to guess. A covered SKU is
 * null in the answer and unknown in the truth.
 *
 * Stand-ins: on about half the rows the packing slip's serial ("expected") is set to a near-miss of the
 * printed one (one confusable digit, or for the real sheet the other set's serial, which is exactly the
 * d1 stand-in). The model never sees the slip, so a read equal to the slip on such a row is a FALSE
 * CLEAR, and the eval can count them.
 *
 * Images go to .data/label-set/ (gitignored); data/label-set.manifest.json is the committed summary.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { KIT } from "@/data/kit.config";
import { orderFor, RMAS } from "@/data/fixtures";
import type { BBox, CountResult, PackingSlipLine, SegmentationResult } from "@/lib/domain/schemas";
import { loadRecording } from "@/lib/meta/recordings";
import { canonicalSerial, datasetRow, ROW_SOURCES, type DatasetRow, type DatasetRowMeta, type RowSource } from "./finetune";
import { assignSplit, floorProblems, leakedLabels, splitKey, SPLIT_SEED, HELDOUT_FRACTION, type TrainingLine } from "./glimmer-eval";

export const LABEL_SET_NAME = "bench label set · truth from the printed label design";
export const LABEL_SET_SEED = 20261029;
export const labelSetDir = (env: NodeJS.ProcessEnv = process.env) => env.RETURNWITNESS_LABEL_SET_DIR || path.join(process.cwd(), ".data", "label-set");
export const LABEL_SET_JSONL = "label-set.jsonl";

export const SKU = { camera_body: "CK-BODY-01", lens: "CK-LENS-24105", battery: "CK-BATT-CHG" } as const;
export type LabelItemKey = keyof typeof SKU;
const SERIAL_RE = /^BW-(CB|LN)-(\d{5})$/;

/** The printed serial → its item and SKU; null for anything that isn't a BW-CB-##### / BW-LN-##### serial. */
export function parseLabelSerial(raw: string): { serial: string; itemKey: "camera_body" | "lens"; sku: string } | null {
  const serial = canonicalSerial(raw);
  const m = SERIAL_RE.exec(serial);
  if (!m) return null;
  const itemKey = m[1] === "CB" ? "camera_body" : "lens";
  return { serial, itemKey, sku: SKU[itemKey] };
}

/* ---------- Seeded randomness ---------- */

export function rngFor(key: string): () => number {
  let a = parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/* ---------- Label specs ---------- */

export interface LabelSpec {
  /** Unique per physical/rendered label (two sheet labels can share a serial). */
  key: string;
  source: "sheet" | "render";
  labelId: string;
  itemKey: LabelItemKey;
  sku: string;
  serial: string | null;
  tag: string;
  /** Sheet only: the cell on the 860×1100 preview (x, y, w, h). */
  cell?: [number, number, number, number];
}

export const REAL_SHEET_SERIALS = ["BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298"] as const;
/** The real d1 stand-in pairs: set A's slip vs set B's label. */
const SHEET_PARTNER: Record<string, string> = { "BW-CB-55120": "BW-CB-55107", "BW-CB-55107": "BW-CB-55120", "BW-LN-80311": "BW-LN-80298", "BW-LN-80298": "BW-LN-80311" };

const CELL_W = 384;
const CELL_H = 192;
const COL_X = [37, 439];
const ROW_Y = [64, 257, 449, 641, 833];
/** The 10 printed labels in sheet order (labels/label-sheet.html), row-major. null = the charger ("no serial"). */
const SHEET_ORDER: Array<{ serial: string | null; tag: string }> = [
  { serial: "BW-CB-55120", tag: "SET A · complete · Camera body" },
  { serial: "BW-LN-80311", tag: "SET A · complete · Zoom lens" },
  { serial: null, tag: "SET A · complete · Battery + charger" },
  { serial: "BW-CB-55107", tag: "SET B · missing-lens order (d1) · Camera body" },
  { serial: "BW-LN-80298", tag: "SET B · spare, not filmed · Zoom lens" },
  { serial: "BW-CB-55120", tag: "SPARE · set A · Camera body" },
  { serial: "BW-LN-80311", tag: "SPARE · set A · Zoom lens" },
  { serial: null, tag: "SPARE · Battery + charger" },
  { serial: "BW-CB-55107", tag: "SPARE · set B · Camera body" },
  { serial: "BW-LN-80311", tag: "SPARE · set A · Zoom lens" },
];

export function sheetSpecs(): LabelSpec[] {
  let charger = 0;
  return SHEET_ORDER.map((s, i) => {
    const p = s.serial ? parseLabelSerial(s.serial)! : null;
    const cell: [number, number, number, number] = [COL_X[i % 2], ROW_Y[Math.floor(i / 2)], CELL_W, CELL_H];
    return { key: `sheet-${String(i + 1).padStart(2, "0")}`, source: "sheet" as const, labelId: p ? p.serial : `charger-${++charger}`, itemKey: p ? p.itemKey : "battery", sku: p ? p.sku : SKU.battery, serial: p ? p.serial : null, tag: s.tag, cell };
  });
}

/** Distinct new serials in the real format, never one of the printed four. */
export function renderSerials(seed: number, perKind: number): string[] {
  const r = rngFor(`serials:${seed}`);
  const out: string[] = [];
  for (const kind of ["CB", "LN"]) {
    const seen = new Set<string>(REAL_SHEET_SERIALS);
    let n = 0;
    while (n < perKind) {
      const s = `BW-${kind}-${String(10000 + Math.floor(r() * 90000))}`;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      n++;
    }
  }
  return out;
}

export function renderSpecs(seed: number, o: { perKind: number; chargers: number }): LabelSpec[] {
  const specs: LabelSpec[] = renderSerials(seed, o.perKind).map((serial, i) => {
    const p = parseLabelSerial(serial)!;
    return { key: `render-${serial}`, source: "render", labelId: serial, itemKey: p.itemKey, sku: p.sku, serial, tag: `RENDER ${String(i + 1).padStart(3, "0")} · ${p.itemKey === "lens" ? "Zoom lens" : "Camera body"}` };
  });
  // Charger ids continue after the sheet's charger-1 and charger-2.
  for (let i = 0; i < o.chargers; i++) specs.push({ key: `render-charger-${i + 3}`, source: "render", labelId: `charger-${i + 3}`, itemKey: "battery", sku: SKU.battery, serial: null, tag: `RENDER · Battery + charger` });
  return specs;
}

/* ---------- Augmentation ---------- */

export interface Occluder {
  kind: "finger" | "paper";
  /** Fractions of the label (0..1), before rotation. */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

export interface Augmentation {
  variant: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  scale: number;
  blurPx: number;
  glare: { x: number; y: number; radius: number; alpha: number } | null;
  occluder: Occluder | null;
  jpegQuality: number;
  background: string;
}

export const MAX_ANGLE = 25;
export const MAX_OCCLUSION = 0.3;
const MATS = ["#c9a46c", "#8d8f93", "#d8d4cc", "#5d6b62", "#b9b2a6"]; // kraft, grey mat, white bench, green cutting mat, linen

export const IDENTITY = (variant = 0): Augmentation => ({ variant, rotateX: 0, rotateY: 0, rotateZ: 0, scale: 1, blurPx: 0, glare: null, occluder: null, jpegQuality: 90, background: "#d8d4cc" });

/** Fraction of the label the occluder covers (its rectangle clipped to the label). */
export function occludedFraction(o: Occluder): number {
  const w = Math.max(0, Math.min(1, o.x + o.w) - Math.max(0, o.x));
  const h = Math.max(0, Math.min(1, o.y + o.h) - Math.max(0, o.y));
  return w * h;
}

/** Same seed + key + variant → the same augmentation, always. */
export function augmentationFor(seed: number, key: string, variant: number): Augmentation {
  const r = rngFor(`aug:${seed}:${key}:${variant}`);
  const angle = () => round(between(r, -MAX_ANGLE, MAX_ANGLE), 1);
  const rotateZ = angle();
  const rotateX = round(between(r, -MAX_ANGLE, MAX_ANGLE) * 0.8, 1);
  const rotateY = round(between(r, -MAX_ANGLE, MAX_ANGLE) * 0.8, 1);
  const scale = round(between(r, 0.6, 1.1), 2);
  const blurPx = r() < 0.5 ? round(between(r, 0.3, 1.6), 2) : 0;
  const glare = r() < 0.5 ? { x: round(r()), y: round(r()), radius: round(between(r, 0.25, 0.6)), alpha: round(between(r, 0.25, 0.55), 2) } : null;
  let occluder: Occluder | null = null;
  const o = r();
  if (o < 0.18) {
    // A finger: a narrow bar crossing the label from the top or bottom edge.
    const w = round(between(r, 0.07, 0.14));
    const h = round(between(r, 0.45, 0.9));
    occluder = { kind: "finger", x: round(between(r, 0, 1 - w)), y: r() < 0.5 ? 0 : round(1 - h), w, h, angle: round(between(r, -20, 20), 1) };
  } else if (o < 0.32) {
    // Packing paper over one corner.
    const w = round(between(r, 0.2, 0.45));
    const h = round(between(r, 0.3, 0.65));
    occluder = { kind: "paper", x: r() < 0.5 ? 0 : round(1 - w), y: r() < 0.5 ? 0 : round(1 - h), w, h, angle: round(between(r, -12, 12), 1) };
  }
  if (occluder && occludedFraction(occluder) > MAX_OCCLUSION) {
    // Shrink to the cap, keeping the shape.
    const k = Math.sqrt(MAX_OCCLUSION / occludedFraction(occluder)) * 0.98;
    occluder = { ...occluder, w: round(occluder.w * k), h: round(occluder.h * k) };
  }
  const jpegQuality = Math.round(between(r, 35, 92));
  const background = MATS[Math.floor(r() * MATS.length)];
  return { variant, rotateX, rotateY, rotateZ, scale, blurPx, glare, occluder, jpegQuality, background };
}

export type Rect = [number, number, number, number]; // x, y, w, h

/** Axis-aligned box of the occluder after its rotation, in label pixels (conservative: a corner that might touch counts). */
export function occluderRect(o: Occluder, W: number, H: number): Rect {
  const w = o.w * W;
  const h = o.h * H;
  const cx = o.x * W + w / 2;
  const cy = o.y * H + h / 2;
  const a = (Math.abs(o.angle) * Math.PI) / 180;
  const bw = w * Math.cos(a) + h * Math.sin(a);
  const bh = w * Math.sin(a) + h * Math.cos(a);
  return [cx - bw / 2, cy - bh / 2, bw, bh];
}

export const overlaps = (a: Rect, b: Rect) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** Where the serial and SKU sit inside a label, in label pixels. Measured in the page for renders. */
export interface LabelBoxes {
  W: number;
  H: number;
  serial: Rect | null;
  sku: Rect | null;
}

/** On the printed sheet the text sits at the same place in every cell (measured on preview.png; padded). */
export const SHEET_BOXES = (spec: LabelSpec): LabelBoxes => ({ W: CELL_W, H: CELL_H, serial: spec.serial ? [10, 44, 330, 72] : null, sku: [125, 22, 160, 22] });

/** The truth a row teaches, given what the occluder covers. */
export function labelTruth(spec: Pick<LabelSpec, "serial" | "sku">, aug: Augmentation, boxes: LabelBoxes) {
  const occ = aug.occluder ? occluderRect(aug.occluder, boxes.W, boxes.H) : null;
  const serialHidden = Boolean(spec.serial && occ && boxes.serial && overlaps(occ, boxes.serial));
  const skuHidden = Boolean(occ && boxes.sku && overlaps(occ, boxes.sku));
  const serialRead = spec.serial && !serialHidden ? spec.serial : null;
  const skuRead = skuHidden ? null : spec.sku;
  return {
    serialHidden,
    skuHidden,
    // legible tracks the serial (the field the app acts on), as in the correction rows.
    answer: { serialRead, skuRead, legible: !serialHidden, confidence: serialHidden ? 0 : 1 },
    truth: { serial: serialRead, sku: skuRead, serialUnreadable: serialHidden },
  };
}

const CONFUSABLE: Record<string, string> = { "0": "8", "1": "7", "2": "7", "3": "8", "4": "9", "5": "6", "6": "8", "7": "1", "8": "3", "9": "4" };

/** A near-miss of a serial: one digit swapped for a look-alike (or the real sheet's other-set serial). */
export function standInSerial(serial: string, r: () => number): string {
  if (SHEET_PARTNER[serial]) return SHEET_PARTNER[serial];
  const m = SERIAL_RE.exec(serial)!;
  const digits = m[2].split("");
  const i = Math.floor(r() * 5);
  digits[i] = CONFUSABLE[digits[i]];
  return `BW-${m[1]}-${digits.join("")}`;
}

/* ---------- Page (headless Chrome renders it) ---------- */

export const STAGE = { w: 560, h: 360 } as const;

/** The sheet's own CSS, from labels/label-sheet.html. */
export function sheetCss(html: string): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (!m) throw new Error("label-sheet.html has no <style> block");
  return m[1];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The label's own markup, as in the sheet (the serial wrapped in .snv so the page can measure it). */
export function labelMarkup(spec: LabelSpec): string {
  const sn = spec.serial ? `<div class="sn"><span class="snv"><span class="pre">${esc(spec.serial.slice(0, 6))}</span>${esc(spec.serial.slice(6))}</span></div>` : `<div class="sn nos">no serial</div>`;
  const where = spec.itemKey === "lens" ? `<div class="where">wrap across the TOP of the barrel, facing the camera</div>` : "";
  return `<div class="tag">${esc(spec.tag)}</div><div class="meta"><span class="store">BRINDLEWOOD</span> <span class="sku">${esc(spec.sku)}</span></div>${sn}${where}`;
}

export function labelPageHtml(spec: LabelSpec, aug: Augmentation, css: string, sheetDataUrl?: string): string {
  const pct = (x: number) => `${round(x * 100, 2)}%`;
  const occ = aug.occluder
    ? `<div class="occ" style="left:${pct(aug.occluder.x)};top:${pct(aug.occluder.y)};width:${pct(aug.occluder.w)};height:${pct(aug.occluder.h)};transform:rotate(${aug.occluder.angle}deg);${aug.occluder.kind === "finger" ? "border-radius:999px;background:linear-gradient(90deg,#b77b5f,#e2a988 45%,#c98d6f);box-shadow:0 2px 6px rgba(0,0,0,.35)" : "background:repeating-linear-gradient(12deg,#c8a06a 0 3px,#bf955f 3px 6px);box-shadow:0 1px 4px rgba(0,0,0,.3)"}"></div>`
    : "";
  const glare = aug.glare ? `<div class="glare" style="background:radial-gradient(circle at ${pct(aug.glare.x)} ${pct(aug.glare.y)},rgba(255,255,255,${aug.glare.alpha}) 0,rgba(255,255,255,0) ${pct(aug.glare.radius)})"></div>` : "";
  const sheetBg = spec.source === "sheet" && spec.cell ? `background:#fff url(${sheetDataUrl}) -${spec.cell[0]}px -${spec.cell[1]}px / 860px 1100px no-repeat;` : "background:#fff;";
  const inner = spec.source === "sheet" ? "" : labelMarkup(spec);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;padding:0;background:${aug.background};}
#stage{position:relative;width:${STAGE.w}px;height:${STAGE.h}px;overflow:hidden;background:${aug.background};}
#lab{position:absolute;left:50%;top:50%;width:${CELL_W}px;height:${CELL_H}px;outline:none!important;${sheetBg}transform:translate(-50%,-50%) perspective(900px) rotateX(${aug.rotateX}deg) rotateY(${aug.rotateY}deg) rotateZ(${aug.rotateZ}deg) scale(${aug.scale});filter:blur(${aug.blurPx}px);box-shadow:0 3px 10px rgba(0,0,0,.25);}
.snv{display:inline-block;}
.occ,.glare{position:absolute;}
.glare{inset:0;pointer-events:none;}
</style></head><body><div id="stage"><div id="lab" class="label">${inner}${glare}${occ}</div></div></body></html>`;
}

/** Runs in the page: where the serial and SKU sit inside the label (layout pixels, before transforms). */
export const MEASURE_SCRIPT = `(() => { const lab = document.getElementById("lab"); const r = (el) => (el ? [el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight] : null); return { W: lab.offsetWidth, H: lab.offsetHeight, serial: r(document.querySelector(".snv")), sku: r(document.querySelector(".sku")) }; })()`;

/* ---------- Rows ---------- */

/** The slip lines the prompt names (item names only; no serials ever reach the prompt). */
export const KIT_LINES: PackingSlipLine[] = KIT.items.map((i) => ({ itemKey: i.key, sku: i.sku, description: i.name, qty: 1, unitPriceCents: i.unitPriceCents, requiresSerial: i.requiresSerial }));

export type LabelSetLine = DatasetRow & { meta: DatasetRowMeta };

export const cropCaption = (itemKey: string) => `crop of the counted ${itemKey} (read any serial label exactly)`;

export function labelSetRow(spec: LabelSpec, aug: Augmentation, boxes: LabelBoxes, image: { dataUrl: string; file: string }, seed = LABEL_SET_SEED): LabelSetLine {
  const t = labelTruth(spec, aug, boxes);
  const r = rngFor(`standin:${seed}:${spec.key}:${aug.variant}`);
  const standIn = Boolean(spec.serial) && r() < 0.5;
  const rowId = createHash("sha256").update(`${spec.source}|${spec.key}|${aug.variant}|${seed}`).digest("hex").slice(0, 16);
  return {
    ...datasetRow({ caption: cropCaption(spec.itemKey), dataUrl: image.dataUrl, itemKey: spec.itemKey }, KIT_LINES, t.answer),
    meta: {
      rowId,
      caseId: `labelset:${spec.key}`,
      itemKey: spec.itemKey,
      truth: t.truth,
      expected: { serial: spec.serial ? (standIn ? standInSerial(spec.serial, r) : spec.serial) : null, sku: spec.sku, requiresSerial: Boolean(spec.serial) },
      source: spec.source,
      labelId: spec.labelId,
      augment: { ...aug } as unknown as Record<string, unknown>,
      standIn,
      image: image.file,
    },
  };
}

/* ---------- Bench hook (filmed clips) ---------- */

export interface BenchDeps {
  clipsDir?: string;
  loadSam?: (clipId: string) => SegmentationResult | null;
  findClip?: (clipId: string) => string | null;
  count?: (clipId: string, seg: SegmentationResult) => CountResult;
  /** Crop the settled item from the ORIGINAL clip as a JPEG data URL. */
  crop?: (clipPath: string, t: number, bbox: BBox) => string;
  writeImage?: (name: string, dataUrl: string) => string;
}

export function findClipIn(dir: string, clipId: string): string | null {
  if (!/^[a-z0-9-]+$/.test(clipId) || !fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.replace(/\.[a-z0-9]+$/i, "") === clipId);
  return f ? path.join(dir, f) : null;
}

/**
 * Rows from the filmed bench clips d1–d3: for each clip that has BOTH the video and its SAM recording,
 * the camera body and lens crops at their settled frames, with the truth from that RMA's packing slip.
 * With no clips (today) it returns no rows and says which clips are missing. These rows carry the real
 * sheet serials, so the split always holds them out: they measure, they never train.
 */
export async function benchLabelRows(deps: BenchDeps = {}): Promise<{ lines: LabelSetLine[]; clipsFound: string[]; clipsMissing: string[] }> {
  const dir = deps.clipsDir ?? (process.env.RETURNWITNESS_DEMO_CLIPS_DIR || path.join(process.cwd(), "gate", "clips"));
  const loadSam = deps.loadSam ?? ((id: string) => {
    const rec = loadRecording<SegmentationResult>(id, "sam");
    return rec && Array.isArray(rec.data?.frames) ? rec.data : null;
  });
  const findClip = deps.findClip ?? ((id: string) => findClipIn(dir, id));
  const lines: LabelSetLine[] = [];
  const clipsFound: string[] = [];
  const clipsMissing: string[] = [];
  for (const rma of RMAS) {
    const seg = loadSam(rma.clipId);
    const file = findClip(rma.clipId);
    if (!seg || !file) {
      clipsMissing.push(`${rma.clipId} (${[!file ? "clip" : "", !seg ? "SAM recording" : ""].filter(Boolean).join(" + ")} missing)`);
      continue;
    }
    clipsFound.push(rma.clipId);
    // Real implementations load lazily: the counter and ffmpeg are only needed when a clip exists.
    const count = deps.count ?? (await defaultCounter());
    const crop = deps.crop ?? (await defaultCropper());
    const slip = orderFor(rma.orderId)?.slip.lines ?? [];
    const result = count(rma.clipId, seg);
    for (const a of result.arrivals) {
      const line = slip.find((l) => l.itemKey === a.itemKey);
      if (!line?.serial || (a.itemKey !== "camera_body" && a.itemKey !== "lens")) continue;
      const serial = canonicalSerial(line.serial);
      const dataUrl = crop(file, a.t + 0.2, a.bbox);
      const rowId = createHash("sha256").update(`bench|${rma.clipId}|${a.itemKey}|${a.t.toFixed(2)}`).digest("hex").slice(0, 16);
      const file2 = deps.writeImage ? deps.writeImage(`bench-${rma.clipId}-${a.itemKey}.jpg`, dataUrl) : "";
      lines.push({
        ...datasetRow({ caption: cropCaption(a.itemKey), dataUrl, itemKey: a.itemKey }, KIT_LINES, { serialRead: serial, skuRead: line.sku, legible: true, confidence: 1 }),
        meta: { rowId, caseId: `bench:${rma.clipId}`, itemKey: a.itemKey, truth: { serial, sku: line.sku, serialUnreadable: false }, expected: { serial, sku: line.sku, requiresSerial: true }, source: "bench", labelId: serial, augment: null, standIn: false, image: file2 },
      });
    }
  }
  return { lines, clipsFound, clipsMissing };
}

async function defaultCounter() {
  const [{ countClip }, { counterConfigForKit }] = await Promise.all([import("@/lib/vision/tray-counter"), import("@/lib/vision/counter-config")]);
  const cfg = counterConfigForKit(KIT);
  return (clipId: string, seg: SegmentationResult) => countClip(clipId, seg.frames, cfg);
}

async function defaultCropper() {
  const [{ frameJpeg }, { probe }] = await Promise.all([import("@/lib/vision/frames"), import("@/lib/vision/prepare-clip")]);
  return (clipPath: string, t: number, bbox: BBox) => {
    const m = probe(clipPath);
    return frameJpeg(clipPath, t, { bbox, width: m.width, height: m.height, pad: 0.35, maxW: 1024 });
  };
}

/* ---------- Summary (committed as data/label-set.manifest.json) ---------- */

export interface LabelSetManifest {
  name: string;
  generatedAt: string;
  generator: string;
  seed: number;
  splitSeed: number;
  fraction: number;
  rows: number;
  train: number;
  heldout: number;
  bySource: Record<RowSource, { train: number; heldout: number }>;
  distinctSerials: { train: number; heldout: number; heldoutReal: string[] };
  distinctLabels: { train: number; heldout: number };
  unreadableSerialRows: number;
  standInRows: number;
  bench: { clipsFound: string[]; clipsMissing: string[] };
  leaked: string[];
  floorProblems: string[];
}

export function summarizeLabelSet(lines: TrainingLine[], o: { generatedAt: string; seed: number; bench: { clipsFound: string[]; clipsMissing: string[] } }): LabelSetManifest {
  const bySource = Object.fromEntries(ROW_SOURCES.map((s) => [s, { train: 0, heldout: 0 }])) as LabelSetManifest["bySource"];
  for (const l of lines) bySource[l.meta.source ?? "correction"][l.meta.split]++;
  const of = (split: "train" | "heldout") => lines.filter((l) => l.meta.split === split);
  const serials = (ls: TrainingLine[]) => new Set(ls.map((l) => splitKey(l.meta)).filter((k) => SERIAL_RE.test(k)));
  const heldSerials = serials(of("heldout"));
  return {
    name: LABEL_SET_NAME,
    generatedAt: o.generatedAt,
    generator: "scripts/build-label-set.ts",
    seed: o.seed,
    splitSeed: lines[0]?.meta.seed ?? SPLIT_SEED,
    fraction: lines[0]?.meta.fraction ?? HELDOUT_FRACTION,
    rows: lines.length,
    train: of("train").length,
    heldout: of("heldout").length,
    bySource,
    distinctSerials: { train: serials(of("train")).size, heldout: heldSerials.size, heldoutReal: REAL_SHEET_SERIALS.filter((s) => heldSerials.has(s)) },
    distinctLabels: { train: new Set(of("train").map((l) => splitKey(l.meta))).size, heldout: new Set(of("heldout").map((l) => splitKey(l.meta))).size },
    unreadableSerialRows: lines.filter((l) => l.meta.truth.serialUnreadable).length,
    standInRows: lines.filter((l) => l.meta.standIn).length,
    bench: o.bench,
    leaked: leakedLabels(lines),
    floorProblems: floorProblems(of("train").length, of("heldout").length),
  };
}

/** Split the label-set lines with the one rule (by label id; the real sheet labels held out). */
export const splitLabelSet = (lines: LabelSetLine[], seed = SPLIT_SEED, fraction = HELDOUT_FRACTION) => assignSplit(lines, seed, fraction);

/** The generated set, if it exists on this machine. */
export function loadLabelSetLines(file = path.join(labelSetDir(), LABEL_SET_JSONL)): TrainingLine[] | null {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as TrainingLine);
  } catch {
    return null;
  }
}
