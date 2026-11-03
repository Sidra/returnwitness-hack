/**
 * Synthetic demo scenes for the two seeded RMAs, built with lib/vision/synth.ts from the kit
 * file. They stand in for SAM 3.1 output until the first live recording replaces them
 * (data/recordings/<clipId>.sam.json wins when present). Each scene includes the messy parts a
 * real bench has: kraft paper, a hand resting on an item, and the segmenter re-issuing track IDs.
 */
import { KIT } from "./kit.config";
import { placeItem, synthFrames, type TrackSpec } from "@/lib/vision/synth";
import type { SegmentationResult } from "@/lib/domain/schemas";

export const SCENE_FPS = 5;

const item = (key: string) => {
  const i = KIT.items.find((x) => x.key === key)!;
  return i;
};

// Footprints in a ~150 x 84 cm frame (normalised w, h).
const DIMS: Record<string, { w: number; h: number }> = {
  camera_body: { w: 0.08, h: 0.083 },
  lens: { w: 0.073, h: 0.107 },
  battery: { w: 0.06, h: 0.071 },
};

const TRAY_SPOTS: Record<string, { x: number; y: number }> = {
  camera_body: { x: 0.68, y: 0.3 },
  lens: { x: 0.86, y: 0.32 },
  battery: { x: 0.76, y: 0.7 },
};

function base(frames: number): TrackSpec[] {
  return [
    { concept: KIT.packingConcepts[1] ?? "cardboard box", trackId: "box", from: 0, to: frames - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }], w: 0.3, h: 0.42 },
    // Kraft paper lifted out of the box and dropped beside it.
    { concept: KIT.packingConcepts[0] ?? "kraft paper", trackId: "paper", from: 0, to: frames - 1, keys: [{ f: 0, x: 0.22, y: 0.48 }, { f: 6, x: 0.22, y: 0.3 }, { f: 9, x: 0.1, y: 0.15 }], w: 0.16, h: 0.12 },
    { concept: KIT.handConcept, trackId: "hand-paper", from: 3, to: 10, keys: [{ f: 3, x: 0.22, y: 0.5 }, { f: 6, x: 0.22, y: 0.3 }, { f: 9, x: 0.1, y: 0.15 }, { f: 10, x: 0.05, y: 0.05 }], w: 0.07, h: 0.21 },
  ];
}

function place(key: string, trackId: string | number, pickF: number, until: number, serial: string | undefined) {
  const it = item(key);
  return placeItem({
    concept: it.samConcept,
    trackId,
    handId: `hand-${key}`,
    pickF,
    tx: TRAY_SPOTS[key].x,
    ty: TRAY_SPOTS[key].y,
    w: DIMS[key].w,
    h: DIMS[key].h,
    area: it.expectedAreaFrac,
    until,
    travel: 5,
    label: it.requiresSerial && serial ? { text: serial, confidence: 0.92 } : undefined,
  });
}

/** RMA-20418: the lens was never in the box. */
function lensMissing(): SegmentationResult {
  const F = 75;
  const cam = item("camera_body");
  const tracks: TrackSpec[] = [
    ...base(F),
    ...place("camera_body", 1, 12, 40, cam.serials.missingCase),
    // A hand rests on the camera while the charger goes down; the segmenter loses it and comes back with a new ID.
    { concept: KIT.handConcept, trackId: "hand-rest", from: 41, to: 47, keys: [{ f: 41, x: TRAY_SPOTS.camera_body.x, y: TRAY_SPOTS.camera_body.y }], w: 0.07, h: 0.21 },
    { concept: cam.samConcept, trackId: 4, from: 48, to: F - 1, keys: [{ f: 48, x: TRAY_SPOTS.camera_body.x + 0.003, y: TRAY_SPOTS.camera_body.y }], w: DIMS.camera_body.w, h: DIMS.camera_body.h, area: cam.expectedAreaFrac, label: { text: cam.serials.missingCase, confidence: 0.94 } },
    ...place("battery", 2, 30, F - 1, undefined),
  ];
  return wrap("d1-rma-20418-lens-missing", F, tracks, "synthetic scene: kraft paper, camera body, charger; the lens never appears. A hand covers the camera for 1.4 s and the segmenter re-issues its ID.");
}

/** RMA-20419: complete kit, the lens is picked up again to show its label. */
function complete(): SegmentationResult {
  const F = 90;
  const cam = item("camera_body");
  const lens = item("lens");
  const tracks: TrackSpec[] = [
    ...base(F),
    ...place("camera_body", 1, 12, F - 1, cam.serials.complete),
    ...place("lens", 2, 26, 44, lens.serials.complete),
    // Lens lifted, turned to the camera to show its label, set down again a little lower: new track ID.
    { concept: KIT.handConcept, trackId: "hand-lift", from: 44, to: 58, keys: [{ f: 44, x: 0.86, y: 0.32 }, { f: 48, x: 0.5, y: 0.45 }, { f: 52, x: 0.5, y: 0.45 }, { f: 56, x: 0.88, y: 0.46 }, { f: 58, x: 0.95, y: 0.7 }], w: 0.07, h: 0.21 },
    { concept: lens.samConcept, trackId: 7, from: 45, to: F - 1, keys: [{ f: 45, x: 0.86, y: 0.33 }, { f: 48, x: 0.5, y: 0.45 }, { f: 52, x: 0.5, y: 0.45 }, { f: 56, x: 0.88, y: 0.46 }], w: DIMS.lens.w, h: DIMS.lens.h, area: lens.expectedAreaFrac, label: { text: lens.serials.complete, confidence: 0.95 } },
    ...place("battery", 3, 64, F - 1, undefined),
  ];
  return wrap("d2-rma-20419-complete", F, tracks, "synthetic scene: all three items; the lens is picked up again to show its label and set down elsewhere with a new track ID.");
}

function wrap(clipId: string, frames: number, tracks: TrackSpec[], provenance: string): SegmentationResult {
  return {
    clipId,
    fps: SCENE_FPS,
    width: 1280,
    height: 720,
    durationS: frames / SCENE_FPS,
    frames: synthFrames({ frames, fps: SCENE_FPS, tracks }),
    source: { mode: "RECORDED_FIXTURE", model: "synthetic", provenance: `${provenance} Replaced by a live SAM 3.1 recording once the Meta key lands.`, requestIds: [] },
  };
}

/**
 * RMA-20420 (d3): the camera body comes out uncovered, a hand and kraft paper cover it completely,
 * it goes back into the box, then comes out again to the tray. The segmenter loses it twice and
 * re-issues IDs (1 → 5 → 9); the tray counter still counts it once.
 */
function cameraReboxed(): SegmentationResult {
  const F = 150;
  const cam = item("camera_body");
  const lens = item("lens");
  const C = { concept: cam.samConcept, ...DIMS.camera_body, area: cam.expectedAreaFrac };
  const label = { text: cam.serials.complete, confidence: 0.93 };
  const tracks: TrackSpec[] = [
    ...base(F),
    // 2-4 s: lifted out uncovered, held over the box zone.
    { ...C, trackId: 1, from: 10, to: 21, keys: [{ f: 10, x: 0.22, y: 0.5 }, { f: 14, x: 0.3, y: 0.32 }, { f: 21, x: 0.31, y: 0.3 }] },
    { concept: KIT.handConcept, trackId: "hand-lift", from: 10, to: 33, keys: [{ f: 10, x: 0.22, y: 0.5 }, { f: 14, x: 0.3, y: 0.32 }, { f: 30, x: 0.3, y: 0.34 }, { f: 33, x: 0.22, y: 0.5 }], w: 0.07, h: 0.21 },
    // 4.4-6 s: covered completely by the hand + a sheet of kraft paper (no camera mask at all).
    { concept: KIT.packingConcepts[0] ?? "kraft paper", trackId: "paper-cover", from: 22, to: 34, keys: [{ f: 22, x: 0.31, y: 0.3 }, { f: 30, x: 0.3, y: 0.33 }, { f: 34, x: 0.22, y: 0.48 }], w: 0.14, h: 0.12 },
    // 6.4-8 s: back in the box; a glimpse as it goes in, under a new ID.
    { ...C, trackId: 5, from: 34, to: 37, keys: [{ f: 34, x: 0.23, y: 0.47 }, { f: 37, x: 0.22, y: 0.5 }] },
    // 10 s: out again, straight to the tray, with yet another ID.
    { ...C, trackId: 9, from: 50, to: F - 1, keys: [{ f: 50, x: 0.22, y: 0.5 }, { f: 55, x: TRAY_SPOTS.camera_body.x, y: TRAY_SPOTS.camera_body.y }], label },
    { concept: KIT.handConcept, trackId: "hand-tray", from: 50, to: 57, keys: [{ f: 50, x: 0.22, y: 0.5 }, { f: 55, x: TRAY_SPOTS.camera_body.x, y: TRAY_SPOTS.camera_body.y }, { f: 57, x: 0.75, y: 0.5 }], w: 0.07, h: 0.21 },
    ...place("lens", 12, 75, F - 1, lens.serials.complete),
    ...place("battery", 13, 100, F - 1, undefined),
  ];
  return wrap("d3-camera-reboxed", F, tracks, "synthetic scene: the camera body comes out uncovered, is covered by a hand and kraft paper, goes back in the box and comes out to the tray; the segmenter re-issues its ID twice (1 → 5 → 9).");
}

export const SCENES: Record<string, () => SegmentationResult> = {
  "d3-camera-reboxed": cameraReboxed,
  "d1-rma-20418-lens-missing": lensMissing,
  "d2-rma-20419-complete": complete,
};
