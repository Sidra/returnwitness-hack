/**
 * Counter evals. The labelled set is a synthetic version of every gate clip (g1–g8 in
 * gate/CLIP-SPEC.md), scored with the same rule the real gate uses (scripts/gate/RULE.md),
 * so the rule is exercised before any real clip exists. Real gate results are added beside
 * these when the harness runs; the page labels which is which.
 */
import { KIT } from "@/data/kit.config";
import { placeItem, synthFrames, type TrackSpec } from "@/lib/vision/synth";
import { countClip, holdingFlagsByItem, type TrayCounterConfig } from "@/lib/vision/tray-counter";
import type { CountResult, Frame } from "@/lib/domain/schemas";

export interface ManifestClip {
  id: string;
  file?: string;
  expected: Record<string, number>;
  acceptHold: string[];
  mustHold?: string[];
}

export interface ClipVerdict {
  clipId: string;
  pass: boolean;
  failures: string[];
  perItem: Array<{ itemKey: string; expected: number; arrivals: number; samIds: number; held: string[] }>;
  holdCodes: string[];
}

/** The pre-registered rule (scripts/gate/RULE.md), as code. */
export function judgeClip(clip: ManifestClip, r: CountResult): ClipVerdict {
  const holds = holdingFlagsByItem(r);
  const failures: string[] = [];
  const perItem = Object.keys(clip.expected).map((k) => {
    const slots = Object.entries(r.diagnostics.trackIdsPerSlot).filter(([sid]) => r.arrivals.some((a) => a.slotId === sid && a.itemKey === k));
    const samIds = new Set(slots.flatMap(([, ids]) => ids)).size;
    return { itemKey: k, expected: clip.expected[k], arrivals: r.counts[k] ?? 0, samIds, held: (holds.get(k) ?? []).map((f) => f.code) };
  });
  for (const p of perItem) {
    if (p.arrivals > 1 && p.expected <= 1) failures.push(`rule 1: ${p.itemKey} got ${p.arrivals} counted arrivals`);
    if (p.expected >= 1 && p.arrivals === 0 && p.held.length === 0 && !(clip.mustHold ?? []).includes(p.itemKey)) failures.push(`rule 2: ${p.itemKey} silently missed`);
  }
  if (clip.id === "g6") {
    const total = perItem.reduce((s, p) => s + p.arrivals, 0);
    const merged = r.flags.some((f) => f.code === "merged_mask");
    if ((total === 2 || total === 4) && !merged) failures.push(`rule 3: ${total} arrivals with no merged_mask hold`);
  }
  // Rule 4: an item that wasn't in the box must come out MISSING (0 arrivals) or HELD, never counted.
  for (const k of clip.mustHold ?? []) {
    const p = perItem.find((x) => x.itemKey === k);
    if (p && p.arrivals > p.expected && p.held.length === 0) failures.push(`rule 4: ${k} counted ${p.arrivals} but was not in the box`);
  }
  // Unexpected holds on clips that don't accept them are reported (not a rule failure, but visible).
  const holdCodes = [...new Set([...holds.values()].flat().map((f) => f.code))];
  return { clipId: clip.id, pass: failures.length === 0, failures, perItem, holdCodes };
}

/* ---------- Synthetic gate clips ---------- */

const it = (key: string) => KIT.items.find((x) => x.key === key)!;
const DIMS: Record<string, { w: number; h: number }> = { camera_body: { w: 0.08, h: 0.083 }, lens: { w: 0.073, h: 0.107 }, battery: { w: 0.06, h: 0.071 } };
const SPOT: Record<string, { x: number; y: number }> = { camera_body: { x: 0.68, y: 0.3 }, lens: { x: 0.86, y: 0.32 }, battery: { x: 0.76, y: 0.7 } };
const lbl = (key: string) => (it(key).requiresSerial ? { text: it(key).serials.complete, confidence: 0.92 } : undefined);

function put(key: string, id: string | number, pickF: number, until: number, over: Partial<{ tx: number; ty: number; area: number; w: number; h: number; travel: number; label: { text: string; confidence: number } | undefined }> = {}) {
  return placeItem({ concept: it(key).samConcept, trackId: id, handId: `h-${key}-${id}`, pickF, tx: over.tx ?? SPOT[key].x, ty: over.ty ?? SPOT[key].y, w: over.w ?? DIMS[key].w, h: over.h ?? DIMS[key].h, area: over.area ?? it(key).expectedAreaFrac, until, travel: over.travel ?? 5, label: "label" in over ? over.label : lbl(key) });
}

const F = 80;
const hand = (id: string, from: number, to: number, keys: Array<{ f: number; x: number; y: number }>): TrackSpec => ({ concept: KIT.handConcept, trackId: id, from, to, keys, w: 0.07, h: 0.21 });

/**
 * The gate's verdict over the clips that were scored, against the clips the rule registers (RULE.md
 * addendum). Any scored FAIL is a FAIL. With every scored clip passing, the verdict is PASS only if every registered
 * clip was scored; otherwise INCOMPLETE ("not run as registered"), naming the clips that weren't.
 */
export function gateVerdict(scored: Array<Pick<ClipVerdict, "clipId" | "pass">>, registered: string[]): { verdict: "PASS" | "FAIL" | "INCOMPLETE"; notRun: string[] } {
  const ran = new Set(scored.map((v) => v.clipId));
  const notRun = registered.filter((id) => !ran.has(id));
  if (scored.some((v) => !v.pass)) return { verdict: "FAIL", notRun };
  return { verdict: notRun.length || !scored.length ? "INCOMPLETE" : "PASS", notRun };
}

export const SYNTHETIC_GATE: Array<{ clip: ManifestClip; tracks: TrackSpec[]; frames: number; note: string }> = [
  { clip: { id: "g0", expected: { camera_body: 0, lens: 0, battery: 0 }, acceptHold: [] }, tracks: [], frames: 15, note: "empty mat" },
  { clip: { id: "g1", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: [] }, frames: F, note: "clean, one at a time", tracks: [...put("camera_body", 1, 4, F - 1), ...put("lens", 2, 20, F - 1), ...put("battery", 3, 36, F - 1)] },
  {
    clip: { id: "g2", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: [] },
    frames: F,
    note: "hand rests on the lens for 2 s; SAM re-issues its ID",
    tracks: [...put("camera_body", 1, 4, F - 1), ...put("lens", 2, 18, 34), hand("rest", 35, 45, [{ f: 35, x: SPOT.lens.x, y: SPOT.lens.y }]), { concept: it("lens").samConcept, trackId: 9, from: 46, to: F - 1, keys: [{ f: 46, x: SPOT.lens.x + 0.004, y: SPOT.lens.y }], ...DIMS.lens, area: it("lens").expectedAreaFrac, label: lbl("lens") }, ...put("battery", 3, 38, F - 1)],
  },
  {
    clip: { id: "g3", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: [] },
    frames: F,
    note: "kraft paper lifted out and dropped back; one item unwrapped over the box",
    tracks: [
      { concept: KIT.packingConcepts[0], trackId: "p1", from: 0, to: F - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }, { f: 5, x: 0.6, y: 0.5 }, { f: 9, x: 0.15, y: 0.2 }], w: 0.16, h: 0.12 },
      { concept: KIT.packingConcepts[0], trackId: "p2", from: 30, to: F - 1, keys: [{ f: 30, x: 0.22, y: 0.5 }], w: 0.12, h: 0.1 },
      ...put("camera_body", 1, 12, F - 1),
      ...put("lens", 2, 28, F - 1),
      ...put("battery", 3, 44, F - 1),
    ],
  },
  {
    clip: { id: "g4", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: [] },
    frames: F,
    note: "lens picked up, shown to the camera, set down elsewhere with a new ID",
    tracks: [
      ...put("camera_body", 1, 4, F - 1),
      ...put("lens", 2, 18, 33),
      hand("lift", 33, 46, [{ f: 33, x: SPOT.lens.x, y: SPOT.lens.y }, { f: 37, x: 0.5, y: 0.45 }, { f: 41, x: 0.5, y: 0.45 }, { f: 45, x: 0.88, y: 0.5 }, { f: 46, x: 0.95, y: 0.75 }]),
      { concept: it("lens").samConcept, trackId: 8, from: 34, to: F - 1, keys: [{ f: 34, x: SPOT.lens.x, y: SPOT.lens.y + 0.01 }, { f: 37, x: 0.5, y: 0.45 }, { f: 41, x: 0.5, y: 0.45 }, { f: 45, x: 0.88, y: 0.5 }], ...DIMS.lens, area: it("lens").expectedAreaFrac, label: lbl("lens") },
      ...put("battery", 3, 50, F - 1),
    ],
  },
  { clip: { id: "g5", expected: { camera_body: 1, lens: 0, battery: 1 }, acceptHold: [], mustHold: ["lens"] }, frames: F, note: "lens left out", tracks: [...put("camera_body", 1, 4, F - 1), ...put("battery", 3, 22, F - 1)] },
  {
    clip: { id: "g6", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: ["merged_mask"] },
    frames: F,
    note: "charger set down touching the camera; read as one oversized camera mask",
    tracks: [
      ...put("camera_body", 1, 4, 37),
      ...put("lens", 2, 18, F - 1),
      hand("touch", 32, 39, [{ f: 32, x: 0.22, y: 0.5 }, { f: 37, x: 0.71, y: 0.33 }, { f: 39, x: 0.85, y: 0.6 }]),
      { concept: it("camera_body").samConcept, trackId: 1, from: 38, to: F - 1, keys: [{ f: 38, x: 0.7, y: 0.32 }], w: 0.12, h: 0.1, area: it("camera_body").expectedAreaFrac + it("battery").expectedAreaFrac },
    ],
  },
  {
    clip: { id: "g7", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: ["label_unreadable"] },
    frames: F,
    note: "lens placed label-down",
    tracks: [...put("camera_body", 1, 4, F - 1), ...put("lens", 2, 18, F - 1, { label: undefined }), ...put("battery", 3, 34, F - 1)],
  },
  { clip: { id: "g8", expected: { camera_body: 1, lens: 1, battery: 1 }, acceptHold: [] }, frames: 50, note: "all three within 8 s", tracks: [...put("camera_body", 1, 2, 49, { travel: 3 }), ...put("lens", 2, 10, 49, { travel: 3 }), ...put("battery", 3, 18, 49, { travel: 3 })] },
];

/** The gate clips' track builders, shared with the seeded shift (data/shift.ts) so its counts come from the same motions. */
export { put as gatePut, hand as gateHand, DIMS as GATE_DIMS, SPOT as GATE_SPOT, F as GATE_FRAMES };

export function runSyntheticGate(cfg: TrayCounterConfig) {
  return SYNTHETIC_GATE.map((s) => {
    const frames: Frame[] = synthFrames({ frames: s.frames, fps: 5, tracks: s.tracks });
    const r = countClip(s.clip.id, frames, cfg);
    return { ...judgeClip(s.clip, r), note: s.note, source: "synthetic" as const };
  });
}
