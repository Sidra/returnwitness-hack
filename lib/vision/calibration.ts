/**
 * Item-size calibration from the clean clip g1 (pre-registered: evals/CALIBRATION-PREREG.md).
 *
 * The counter's `expectedAreaFrac` (each item's mask area as a fraction of the frame) is used only by the merge,
 * oversize and hidden-item checks. kit.config holds estimates; the real value depends on the camera's height, so it
 * is measured once from g1 and applied to real footage only. Synthetic scenes were built at the estimates and keep them.
 *
 * Rule, per kit item, on g1's recorded SAM 3.1 segmentation, counted with the estimates:
 *   1. the item must have exactly one counted arrival in g1, else it keeps its estimate (reported);
 *   2. qualifying frames: from that arrival's frame to the end of the clip, the item's concept masks whose centre is in
 *      the tray zone; per frame the mask whose centre is nearest the arrival's; frames where any hand mask overlaps it
 *      are dropped (a hand changes the mask);
 *   3. at least CALIBRATION_RULE.minFrames qualifying frames, else the estimate stays;
 *   4. measured = the median of those masks' `area` (an even count averages the middle two), 4 significant digits;
 *   5. applied only if measured / estimate is within [1/maxRatio, maxRatio], else the estimate stays (a wrong concept or
 *      a camera moved mid-run is likelier than a 4× size error).
 */
import { z } from "zod";
import type { CountResult, Frame, Mask } from "@/lib/domain/schemas";
import { centroid, dist, inZone, intersection } from "./geometry";
import type { TrayCounterConfig } from "./tray-counter";

export const CALIBRATION_VERSION = "kit-calibration/1";
export const CALIBRATION_CLIP = "gate-g1";
export const CALIBRATION_RULE = { minFrames: 5, maxRatio: 4, sigDigits: 4 } as const;

export const ItemCalibration = z
  .object({
    estimate: z.number().positive(),
    measured: z.number().nullable(),
    frames: z.number().int().nonnegative(),
    applied: z.boolean(),
    reason: z.string(),
  })
  .strict();
export type ItemCalibration = z.infer<typeof ItemCalibration>;

export const KitCalibration = z
  .object({
    version: z.literal(CALIBRATION_VERSION),
    status: z.enum(["estimates", "calibrated"]),
    kitId: z.string(),
    clipId: z.string().nullable(),
    recordedAt: z.string().nullable(),
    calibratedAt: z.string().nullable(),
    gitHash: z.string().nullable(),
    note: z.string(),
    items: z.record(z.string(), ItemCalibration),
  })
  .strict();
export type KitCalibration = z.infer<typeof KitCalibration>;


export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const sig = (n: number) => Number(n.toPrecision(CALIBRATION_RULE.sigDigits));

/** Apply the pre-registered rule to one clip's frames, counted with the estimates (`count` from countClip). */
export function calibrateItems(frames: Frame[], count: CountResult, cfg: TrayCounterConfig): Record<string, ItemCalibration> {
  const hand = cfg.handConcept.toLowerCase();
  const out: Record<string, ItemCalibration> = {};
  for (const item of cfg.items) {
    const estimate = item.expectedAreaFrac;
    const keep = (frames_: number, measured: number | null, reason: string): ItemCalibration => ({ estimate, measured, frames: frames_, applied: false, reason });
    const arrivals = count.arrivals.filter((a) => a.itemKey === item.key);
    if (arrivals.length !== 1) {
      out[item.key] = keep(0, null, `${arrivals.length} counted arrivals in the calibration clip (needs exactly 1); estimate kept`);
      continue;
    }
    const a = arrivals[0];
    const at = centroid(a.bbox);
    const areas: number[] = [];
    for (const f of frames) {
      if (f.index < a.frameIndex) continue;
      const candidates = f.masks.filter((m) => m.concept.toLowerCase() === item.concept.toLowerCase() && inZone(centroid(m.bbox), cfg.trayZone));
      if (!candidates.length) continue;
      const m = candidates.reduce<Mask>((best, x) => (dist(centroid(x.bbox), at) < dist(centroid(best.bbox), at) ? x : best), candidates[0]);
      if (f.masks.some((h) => h.concept.toLowerCase() === hand && intersection(h.bbox, m.bbox) > 0)) continue;
      areas.push(m.area);
    }
    if (areas.length < CALIBRATION_RULE.minFrames) {
      out[item.key] = keep(areas.length, null, `${areas.length} qualifying frames (needs ≥ ${CALIBRATION_RULE.minFrames}); estimate kept`);
      continue;
    }
    const measured = sig(median(areas)!);
    const ratio = measured / estimate;
    if (ratio > CALIBRATION_RULE.maxRatio || ratio < 1 / CALIBRATION_RULE.maxRatio) {
      out[item.key] = keep(areas.length, measured, `measured is ${ratio.toFixed(2)}× the estimate (outside 1/${CALIBRATION_RULE.maxRatio}–${CALIBRATION_RULE.maxRatio}×); estimate kept`);
      continue;
    }
    out[item.key] = { estimate, measured, frames: areas.length, applied: true, reason: `median of ${areas.length} settled, hand-free frames (${ratio.toFixed(2)}× the estimate)` };
  }
  return out;
}

/** The counter config with the calibrated sizes swapped in (only items whose calibration was applied). */
export function withCalibration(cfg: TrayCounterConfig, cal: KitCalibration | null | undefined): TrayCounterConfig {
  if (!cal || cal.status !== "calibrated") return cfg;
  return { ...cfg, items: cfg.items.map((i) => (cal.items[i.key]?.applied && cal.items[i.key].measured ? { ...i, expectedAreaFrac: cal.items[i.key].measured! } : i)) };
}

export const isCalibrated = (cal: KitCalibration | null | undefined) => Boolean(cal && cal.status === "calibrated" && Object.values(cal.items).some((i) => i.applied));
