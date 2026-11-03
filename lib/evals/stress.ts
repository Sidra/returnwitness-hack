/**
 * Tray-counter stress sweep. Every synthetic gate clip (lib/evals/suite.ts) is re-run with the
 * segmentation degraded the ways a real segmenter degrades (dropped frames, jittery boxes, noisy
 * scores, track-ID switches, single-frame misses, two items read as one mask, a hand parked over the
 * tray), each at 2–3 severities and K seeds, then counted (countClip) and judged with the gate rule
 * (judgeClip).
 *
 * DETERMINISTIC · synthetic segmentation with mask-level perturbations: no camera frames, no model.
 * Every random choice comes from a seeded PRNG (never Math.random), so a row is reproducible.
 *
 * The table reports both directions of error side by side, on purpose:
 *  - falseHolds: a complete kit the counter HELD for a reason the clip doesn't accept. Costs a real
 *    customer their refund time (a person has to look).
 *  - missedItems / overCounts: the counter silently said an item was missing, or counted an item more
 *    times than it was there. Costs money (a wrong refund decision with no hold to catch it).
 * A counter tuned only to never miss would hold everything; showing both keeps that honest.
 */
import type { BBox, Frame, Mask, ModeLabel } from "@/lib/domain/schemas";
import { synthFrames } from "@/lib/vision/synth";
import { countClip, holdingFlagsByItem, type TrayCounterConfig } from "@/lib/vision/tray-counter";
import { centroid, coverage, inZone } from "@/lib/vision/geometry";
import type { CountResult } from "@/lib/domain/schemas";
import { judgeClip, SYNTHETIC_GATE, type ManifestClip } from "./suite";

export const STRESS_LABEL = "DETERMINISTIC · synthetic segmentation with mask-level perturbations";

/* ---------- Seeded randomness ---------- */

/** mulberry32: tiny, fast, good enough for test perturbations, and identical on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the parts: each (clip, perturbation, severity, seed) gets its own independent stream. */
export function seedFor(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

type Rng = () => number;
const uni = (rng: Rng, a: number) => (rng() * 2 - 1) * a;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/* ---------- Perturbations (mask level) ---------- */

export type PerturbationKey = "dropped_frames" | "box_jitter" | "score_noise" | "track_id_switch" | "missed_detection" | "merged_masks" | "hand_occlusion";

export interface PerturbCtx {
  cfg: TrayCounterConfig;
}

export interface Perturbation {
  key: PerturbationKey;
  /** What the parameter means, for the table. */
  describe: (param: number) => string;
  levels: Array<{ severity: "low" | "mid" | "high"; param: number }>;
  /** Pure: returns new frames, never mutates its input. A param of 0 is the identity. */
  apply: (frames: Frame[], param: number, rng: Rng, ctx: PerturbCtx) => Frame[];
}

const cloneFrames = (frames: Frame[]): Frame[] => frames.map((f) => ({ ...f, masks: f.masks.map((m) => ({ ...m, bbox: [...m.bbox] as BBox })) }));
const norm = (s: string) => s.trim().toLowerCase();
const isItem = (m: Mask, ctx: PerturbCtx) => ctx.cfg.items.some((i) => norm(i.concept) === norm(m.concept));
const inTray = (m: Mask, ctx: PerturbCtx) => inZone(centroid(m.bbox), ctx.cfg.trayZone);
const union = (a: BBox, b: BBox): BBox => {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  return [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
};
/** Pick a frame index uniformly among those that satisfy `ok` (null when none do). */
const pickFrame = (frames: Frame[], rng: Rng, ok: (f: Frame) => boolean): number | null => {
  const idx = frames.map((f, i) => (ok(f) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx[Math.floor(rng() * idx.length)] : null;
};
/** Score threshold a real segmenter applies before returning a mask; noisy scores below it vanish. */
export const DETECTION_THRESHOLD = 0.5;

export const PERTURBATIONS: Perturbation[] = [
  {
    key: "dropped_frames",
    describe: (p) => `${Math.round(p * 100)}% of frames lost`,
    levels: [
      { severity: "low", param: 0.05 },
      { severity: "mid", param: 0.15 },
      { severity: "high", param: 0.3 },
    ],
    // A lost frame is absent from the stream (indices skip), not an empty frame.
    apply: (frames, p, rng) => cloneFrames(frames).filter(() => !(p > 0 && rng() < p)),
  },
  {
    key: "box_jitter",
    describe: (p) => `boxes shift and resize by up to ±${Math.round(p * 100)}% of their size`,
    levels: [
      { severity: "low", param: 0.05 },
      { severity: "mid", param: 0.15 },
      { severity: "high", param: 0.3 },
    ],
    apply: (frames, p, rng) =>
      p <= 0
        ? cloneFrames(frames)
        : cloneFrames(frames).map((f) => ({
            ...f,
            masks: f.masks.map((m) => {
              const [x, y, w, h] = m.bbox;
              const sw = 1 + uni(rng, p / 2);
              const sh = 1 + uni(rng, p / 2);
              const cx = x + w / 2 + uni(rng, p) * w;
              const cy = y + h / 2 + uni(rng, p) * h;
              return { ...m, bbox: [cx - (w * sw) / 2, cy - (h * sh) / 2, w * sw, h * sh] as BBox, area: clamp01(m.area * sw * sh) };
            }),
          })),
  },
  {
    key: "score_noise",
    describe: (p) => `scores ±${p.toFixed(2)}, then the ${DETECTION_THRESHOLD} detection threshold`,
    levels: [
      { severity: "low", param: 0.2 },
      { severity: "mid", param: 0.45 },
      { severity: "high", param: 0.7 },
    ],
    apply: (frames, p, rng) =>
      p <= 0
        ? cloneFrames(frames)
        : cloneFrames(frames).map((f) => ({
            ...f,
            masks: f.masks.map((m) => ({ ...m, score: clamp01((m.score ?? 1) + uni(rng, p)) })).filter((m) => m.score >= DETECTION_THRESHOLD),
          })),
  },
  {
    key: "track_id_switch",
    describe: (p) => `${Math.round(p * 100)}% of item tracks get a new ID mid-clip`,
    levels: [
      { severity: "low", param: 0.25 },
      { severity: "mid", param: 0.5 },
      { severity: "high", param: 1 },
    ],
    apply: (frames, p, rng, ctx) => {
      const out = cloneFrames(frames);
      if (p <= 0) return out;
      const tracks = new Map<string, number[]>();
      out.forEach((f, i) => f.masks.filter((m) => isItem(m, ctx)).forEach((m) => tracks.set(`${m.concept}\u0000${m.trackId}`, [...(tracks.get(`${m.concept}\u0000${m.trackId}`) ?? []), i])));
      for (const [key, idx] of [...tracks.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (idx.length < 2 || rng() >= p) continue;
        const from = idx[1 + Math.floor(rng() * (idx.length - 1))];
        const [concept, id] = key.split("\u0000");
        for (const i of idx) if (i >= from) out[i].masks = out[i].masks.map((m) => (m.concept === concept && String(m.trackId) === id ? { ...m, trackId: `${id}~switched` } : m));
      }
      return out;
    },
  },
  {
    key: "missed_detection",
    describe: (p) => `each item mask missed on ${Math.round(p * 100)}% of single frames`,
    levels: [
      { severity: "low", param: 0.05 },
      { severity: "mid", param: 0.15 },
      { severity: "high", param: 0.3 },
    ],
    apply: (frames, p, rng, ctx) => (p <= 0 ? cloneFrames(frames) : cloneFrames(frames).map((f) => ({ ...f, masks: f.masks.filter((m) => !(isItem(m, ctx) && rng() < p)) }))),
  },
  {
    key: "merged_masks",
    describe: (p) => (p >= 1000 ? "two nearest tray items read as one mask to the end" : `two nearest tray items read as one mask for ${p} frames`),
    levels: [
      { severity: "low", param: 3 },
      { severity: "mid", param: 10 },
      { severity: "high", param: 1000 },
    ],
    // From a random frame where two items sit in the tray, the bigger one's mask becomes the union of
    // both (area summed) and the other one's mask disappears: what g6 looks like on camera.
    apply: (frames, p, rng, ctx) => {
      const out = cloneFrames(frames);
      if (p <= 0) return out;
      const start = pickFrame(out, rng, (f) => f.masks.filter((m) => isItem(m, ctx) && inTray(m, ctx)).length >= 2);
      if (start == null) return out;
      const tray = out[start].masks.filter((m) => isItem(m, ctx) && inTray(m, ctx));
      let pair: [Mask, Mask] = [tray[0], tray[1]];
      let best = Infinity;
      for (let i = 0; i < tray.length; i++)
        for (let j = i + 1; j < tray.length; j++) {
          const [a, b] = [centroid(tray[i].bbox), centroid(tray[j].bbox)];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (d < best) [best, pair] = [d, [tray[i], tray[j]]];
        }
      const [big, small] = pair[0].area >= pair[1].area ? pair : [pair[1], pair[0]];
      const same = (m: Mask, ref: Mask) => m.concept === ref.concept && String(m.trackId) === String(ref.trackId);
      for (let i = start; i < out.length && i < start + p; i++) {
        const a = out[i].masks.find((m) => same(m, big));
        const b = out[i].masks.find((m) => same(m, small));
        if (!a || !b) continue;
        out[i].masks = out[i].masks.filter((m) => m !== b).map((m) => (m === a ? { ...a, bbox: union(a.bbox, b.bbox), area: clamp01(a.area + b.area) } : m));
      }
      return out;
    },
  },
  {
    key: "hand_occlusion",
    describe: (p) => `a hand parked over a tray item for ${p} frames (${(p / 5).toFixed(1)} s)`,
    levels: [
      { severity: "low", param: 3 },
      { severity: "mid", param: 10 },
      { severity: "high", param: 25 },
    ],
    // A hand box over one tray item's spot; item masks it mostly covers are hidden while it stays.
    apply: (frames, p, rng, ctx) => {
      const out = cloneFrames(frames);
      if (p <= 0) return out;
      const start = pickFrame(out, rng, (f) => f.masks.some((m) => isItem(m, ctx) && inTray(m, ctx)));
      if (start == null) return out;
      const cands = out[start].masks.filter((m) => isItem(m, ctx) && inTray(m, ctx));
      const target = cands[Math.floor(rng() * cands.length)];
      const [cx, cy] = centroid(target.bbox);
      const w = Math.max(0.12, target.bbox[2] * 1.5);
      const h = Math.max(0.16, target.bbox[3] * 1.5);
      const hand: BBox = [cx - w / 2, cy - h / 2, w, h];
      for (let i = start; i < out.length && i < start + p; i++) {
        out[i].masks = [...out[i].masks.filter((m) => !(isItem(m, ctx) && coverage(m.bbox, hand) >= 0.5)), { trackId: "stress-hand", concept: ctx.cfg.handConcept, bbox: [...hand] as BBox, area: w * h, score: 0.9 }];
      }
      return out;
    },
  },
];

export function perturbFrames(frames: Frame[], key: PerturbationKey, param: number, seed: number, cfg: TrayCounterConfig): Frame[] {
  const p = PERTURBATIONS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown perturbation ${key}`);
  return p.apply(frames, param, mulberry32(seed), { cfg });
}

/* ---------- Scoring one run ---------- */

export interface RunScore {
  pass: boolean;
  /** Items present in the box that the counter counted short with no hold (silently "missing"). */
  missedItems: number;
  /** Items counted more times than they were present, with no hold. */
  overCounts: number;
  /** A complete kit held for a reason the clip doesn't accept. */
  falseHold: boolean;
  /** Any item's count differs from what was in the box (held or not). */
  wrongCount: boolean;
  /** The box held the full kit (the runs a false hold is counted over). */
  completeKit: boolean;
}

export const isCompleteKit = (clip: ManifestClip) => !clip.mustHold?.length && Object.values(clip.expected).some((n) => n > 0);

export function scoreRun(clip: ManifestClip, r: CountResult): RunScore {
  const v = judgeClip(clip, r);
  const holds = holdingFlagsByItem(r);
  let missedItems = 0;
  let overCounts = 0;
  let wrongCount = false;
  for (const [k, expected] of Object.entries(clip.expected)) {
    const got = r.counts[k] ?? 0;
    const held = (holds.get(k) ?? []).length > 0;
    if (got !== expected) wrongCount = true;
    if (got < expected && !held) missedItems += expected - got;
    if (got > expected && !held) overCounts += got - expected;
  }
  const codes = [...holds.values()].flat().map((f) => f.code);
  const falseHold = isCompleteKit(clip) && codes.some((c) => !clip.acceptHold.includes(c));
  return { pass: v.pass, missedItems, overCounts, falseHold, wrongCount, completeKit: isCompleteKit(clip) };
}

/* ---------- Rows + report ---------- */

export interface StressRow {
  mode: ModeLabel;
  perturbation: PerturbationKey | "none" | string;
  severity: string;
  detail: string;
  /** Distinct clips. */
  clips: number;
  /** Judged runs (clips × seeds). */
  runs: number;
  pass: number;
  missedItems: number;
  overCounts: number;
  falseHolds: number;
  wrongCounts: number;
  /** Runs on complete kits: the denominator for false holds. */
  completeKitRuns: number;
}

export interface StressReport {
  label: string;
  mode: ModeLabel;
  seeds: number;
  rows: StressRow[];
  summary: {
    runs: number;
    pass: number;
    missedItems: number;
    overCounts: number;
    falseHolds: number;
    wrongCounts: number;
    completeKitRuns: number;
    worstForCustomers: { perturbation: string; severity: string; falseHolds: number } | null;
    worstForMoney: { perturbation: string; severity: string; missedItems: number; overCounts: number } | null;
  };
}

export function rowFrom(mode: ModeLabel, perturbation: string, severity: string, detail: string, results: Array<{ clipId: string; score: RunScore }>): StressRow {
  return {
    mode,
    perturbation,
    severity,
    detail,
    clips: new Set(results.map((r) => r.clipId)).size,
    runs: results.length,
    pass: results.filter((r) => r.score.pass).length,
    missedItems: results.reduce((s, r) => s + r.score.missedItems, 0),
    overCounts: results.reduce((s, r) => s + r.score.overCounts, 0),
    falseHolds: results.filter((r) => r.score.falseHold).length,
    wrongCounts: results.filter((r) => r.score.wrongCount).length,
    completeKitRuns: results.filter((r) => r.score.completeKit).length,
  };
}

export function summarize(rows: StressRow[]): StressReport["summary"] {
  const perturbed = rows.filter((r) => r.perturbation !== "none");
  const sum = (k: "runs" | "pass" | "missedItems" | "overCounts" | "falseHolds" | "wrongCounts" | "completeKitRuns") => rows.reduce((s, r) => s + r[k], 0);
  const byHolds = [...perturbed].sort((a, b) => b.falseHolds - a.falseHolds)[0];
  const byMoney = [...perturbed].sort((a, b) => b.missedItems + b.overCounts - (a.missedItems + a.overCounts))[0];
  return {
    runs: sum("runs"),
    pass: sum("pass"),
    missedItems: sum("missedItems"),
    overCounts: sum("overCounts"),
    falseHolds: sum("falseHolds"),
    wrongCounts: sum("wrongCounts"),
    completeKitRuns: sum("completeKitRuns"),
    worstForCustomers: byHolds && byHolds.falseHolds > 0 ? { perturbation: byHolds.perturbation, severity: byHolds.severity, falseHolds: byHolds.falseHolds } : null,
    worstForMoney: byMoney && byMoney.missedItems + byMoney.overCounts > 0 ? { perturbation: byMoney.perturbation, severity: byMoney.severity, missedItems: byMoney.missedItems, overCounts: byMoney.overCounts } : null,
  };
}

export interface SweepOptions {
  cfg: TrayCounterConfig;
  seeds?: number;
  perturbations?: Perturbation[];
  /** Override the levels (e.g. [0] to check the identity). */
  levels?: Array<{ severity: string; param: number }>;
  clips?: typeof SYNTHETIC_GATE;
}

/** Every clip × perturbation × severity × seed, through the counter and the gate rule. */
export function runStressSweep(o: SweepOptions): StressReport {
  const seeds = Math.max(1, Math.floor(o.seeds ?? 20));
  const clips = o.clips ?? SYNTHETIC_GATE;
  const base = clips.map((s) => ({ s, frames: synthFrames({ frames: s.frames, fps: 5, tracks: s.tracks }) }));
  const rows: StressRow[] = [rowFrom("DETERMINISTIC", "none", "-", "unperturbed synthetic segmentation", base.map(({ s, frames }) => ({ clipId: s.clip.id, score: scoreRun(s.clip, countClip(s.clip.id, frames, o.cfg)) })))];
  for (const p of o.perturbations ?? PERTURBATIONS) {
    for (const lvl of o.levels ?? p.levels) {
      const results: Array<{ clipId: string; score: RunScore }> = [];
      for (const { s, frames } of base)
        for (let k = 0; k < seeds; k++) {
          const f = p.apply(frames, lvl.param, mulberry32(seedFor(s.clip.id, p.key, lvl.param, k)), { cfg: o.cfg });
          results.push({ clipId: s.clip.id, score: scoreRun(s.clip, countClip(s.clip.id, f, o.cfg)) });
        }
      rows.push(rowFrom("DETERMINISTIC", p.key, lvl.severity, p.describe(lvl.param), results));
    }
  }
  return { label: STRESS_LABEL, mode: "DETERMINISTIC", seeds, rows, summary: summarize(rows) };
}

/* ---------- Video-level perturbations (Modal mode; ffmpeg on real clips) ---------- */

export interface VideoPerturbation {
  key: "brightness" | "blur" | "downscale" | "frame_drop";
  severity: "low" | "mid" | "high";
  detail: string;
  /** ffmpeg -vf chain, applied to the prepared 5 fps / 720p clip. */
  vf: string;
}

export const VIDEO_PERTURBATIONS: VideoPerturbation[] = [
  { key: "brightness", severity: "low", detail: "darker by 0.15", vf: "eq=brightness=-0.15" },
  { key: "brightness", severity: "mid", detail: "darker by 0.30", vf: "eq=brightness=-0.30" },
  { key: "brightness", severity: "high", detail: "washed out (+0.30, contrast 0.7)", vf: "eq=brightness=0.30:contrast=0.7" },
  { key: "blur", severity: "low", detail: "gaussian blur σ=2", vf: "gblur=sigma=2" },
  { key: "blur", severity: "mid", detail: "gaussian blur σ=4", vf: "gblur=sigma=4" },
  { key: "blur", severity: "high", detail: "gaussian blur σ=8", vf: "gblur=sigma=8" },
  // Down then back up: detail is lost but the frame size (and so the box coordinates) stays 720p.
  { key: "downscale", severity: "low", detail: "through 480p", vf: "scale=-2:480,scale=-2:720" },
  { key: "downscale", severity: "mid", detail: "through 360p", vf: "scale=-2:360,scale=-2:720" },
  { key: "downscale", severity: "high", detail: "through 240p", vf: "scale=-2:240,scale=-2:720" },
  { key: "frame_drop", severity: "low", detail: "every 10th frame dropped", vf: "select='mod(n+1\\,10)',setpts=N/(5*TB)" },
  { key: "frame_drop", severity: "mid", detail: "every 5th frame dropped", vf: "select='mod(n+1\\,5)',setpts=N/(5*TB)" },
  { key: "frame_drop", severity: "high", detail: "every 3rd frame dropped", vf: "select='mod(n+1\\,3)',setpts=N/(5*TB)" },
];

export const ffmpegArgsFor = (src: string, out: string, vf: string): string[] => ["-y", "-v", "error", "-i", src, "-an", "-vf", vf, "-r", "5", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", out];

/* ---------- Output ---------- */

export function formatStressTable(report: StressReport): string {
  const head = "| mode | perturbation | severity | detail | clips | runs | pass | missedItems | overCounts | falseHolds | wrongCounts |";
  const sep = "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|";
  const lines = report.rows.map((r) => `| ${r.mode} | ${r.perturbation} | ${r.severity} | ${r.detail} | ${r.clips} | ${r.runs} | ${r.pass}/${r.runs} | ${r.missedItems} | ${r.overCounts} | ${r.falseHolds} | ${r.wrongCounts} |`);
  const s = report.summary;
  return [
    `**${report.label}** · ${report.seeds} seed(s) per perturbation`,
    "",
    head,
    sep,
    ...lines,
    "",
    `Summary: ${s.pass}/${s.runs} runs pass the gate rule · ${s.falseHolds} false holds on complete kits (a customer waits for a person) · ${s.missedItems} items silently called missing + ${s.overCounts} silently over-counted (money) · ${s.wrongCounts} runs with any count off.`,
    `Worst for customers: ${s.worstForCustomers ? `${s.worstForCustomers.perturbation} (${s.worstForCustomers.severity}), ${s.worstForCustomers.falseHolds} false holds` : "none"} · worst for money: ${s.worstForMoney ? `${s.worstForMoney.perturbation} (${s.worstForMoney.severity}), ${s.worstForMoney.missedItems} missed + ${s.worstForMoney.overCounts} over` : "none"}.`,
    "",
    "missedItems / overCounts count items with NO hold; falseHolds and wrongCounts count runs. A held miss is not a silent miss: a person reviews it.",
  ].join("\n");
}
