import type { BBox } from "@/lib/domain/schemas";

export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const centroid = (b: BBox): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];

export const inZone = (p: [number, number], z: Zone): boolean =>
  p[0] >= z.x0 && p[0] <= z.x1 && p[1] >= z.y0 && p[1] <= z.y1;

export const boxArea = (b: BBox): number => Math.max(0, b[2]) * Math.max(0, b[3]);

export function intersection(a: BBox, b: BBox): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
}

export function iou(a: BBox, b: BBox): number {
  const i = intersection(a, b);
  const u = boxArea(a) + boxArea(b) - i;
  return u <= 0 ? 0 : i / u;
}

/** Fraction of `of` covered by `by`. */
export function coverage(of: BBox, by: BBox): number {
  const a = boxArea(of);
  return a <= 0 ? 0 : intersection(of, by) / a;
}

export const dist = (p: [number, number], q: [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
