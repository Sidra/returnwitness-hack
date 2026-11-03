/**
 * Synthetic segmentation tracks: a small timeline DSL that produces per-frame masks the
 * way a video segmenter would (boxes, areas, track IDs, hands, paper). Used by the unit
 * tests for the hard cases and to build the demo fixture until real recordings exist.
 * Anything built with this is labelled synthetic in its provenance.
 */
import type { BBox, Frame, LabelRead, Mask } from "@/lib/domain/schemas";

export interface Key {
  /** Frame index. */
  f: number;
  /** Centre x, y (normalised). */
  x: number;
  y: number;
}

export interface TrackSpec {
  concept: string;
  trackId: string | number;
  /** Visible on frames [from, to] inclusive, interpolating between keys. */
  from: number;
  to: number;
  keys: Key[];
  w: number;
  h: number;
  /** Override mask area (fraction of frame); defaults to w*h. */
  area?: number;
  label?: LabelRead;
  /** Frames (inclusive ranges) where the mask is dropped (e.g. full occlusion). */
  gaps?: Array<[number, number]>;
  /** Per-frame jitter amplitude (deterministic). */
  jitter?: number;
}

export interface SynthClip {
  frames: number;
  fps: number;
  tracks: TrackSpec[];
}

function interp(keys: Key[], f: number): [number, number] {
  const ks = [...keys].sort((a, b) => a.f - b.f);
  if (f <= ks[0].f) return [ks[0].x, ks[0].y];
  const last = ks[ks.length - 1];
  if (f >= last.f) return [last.x, last.y];
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (f >= a.f && f <= b.f) {
      const u = b.f === a.f ? 0 : (f - a.f) / (b.f - a.f);
      return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
    }
  }
  return [last.x, last.y];
}

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (f: number, seed: number) => Math.sin(f * 12.9898 + seed * 78.233) % 1;

export function synthFrames(clip: SynthClip): Frame[] {
  const out: Frame[] = [];
  for (let f = 0; f < clip.frames; f++) {
    const masks: Mask[] = [];
    clip.tracks.forEach((tr, ti) => {
      if (f < tr.from || f > tr.to) return;
      if (tr.gaps?.some(([a, b]) => f >= a && f <= b)) return;
      const [cx, cy] = interp(tr.keys, f);
      const j = tr.jitter ?? 0;
      const x = cx + j * noise(f, ti + 1);
      const y = cy + j * noise(f, ti + 7);
      const bbox: BBox = [x - tr.w / 2, y - tr.h / 2, tr.w, tr.h];
      masks.push({
        trackId: tr.trackId,
        concept: tr.concept,
        bbox,
        area: tr.area ?? tr.w * tr.h,
        score: 0.9,
        ...(tr.label ? { label: tr.label } : {}),
      });
    });
    out.push({ index: f, t: Number((f / clip.fps).toFixed(3)), masks });
  }
  return out;
}

/* ---------- Helpers for building realistic unboxing scenes ---------- */

export const BOX_POINT = { x: 0.22, y: 0.5 };

/**
 * One item lifted from the box and set down in the tray at (tx, ty), with a hand that
 * carries it and leaves. Returns the item track + hand track. `pickF` = frame the hand
 * reaches the box; travel takes `travel` frames; the hand lingers `linger` frames.
 */
export function placeItem(opts: {
  concept: string;
  trackId: string | number;
  handId: string | number;
  pickF: number;
  tx: number;
  ty: number;
  w: number;
  h: number;
  area?: number;
  travel?: number;
  linger?: number;
  until: number;
  label?: LabelRead;
}): TrackSpec[] {
  const travel = opts.travel ?? 4;
  const linger = opts.linger ?? 1;
  const downF = opts.pickF + travel;
  const item: TrackSpec = {
    concept: opts.concept,
    trackId: opts.trackId,
    from: opts.pickF,
    to: opts.until,
    keys: [
      { f: opts.pickF, x: BOX_POINT.x, y: BOX_POINT.y },
      { f: downF, x: opts.tx, y: opts.ty },
    ],
    w: opts.w,
    h: opts.h,
    area: opts.area,
    label: opts.label,
  };
  const hand: TrackSpec = {
    concept: "hand",
    trackId: opts.handId,
    from: opts.pickF,
    to: downF + linger,
    keys: [
      { f: opts.pickF, x: BOX_POINT.x, y: BOX_POINT.y },
      { f: downF, x: opts.tx, y: opts.ty },
      { f: downF + linger, x: opts.tx + 0.05, y: opts.ty + 0.15 },
    ],
    w: 0.12,
    h: 0.16,
  };
  return [item, hand];
}
