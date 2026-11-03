import { describe, expect, it } from "vitest";
import { KIT } from "@/data/kit.config";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { countClip, holdingFlagsByItem } from "@/lib/vision/tray-counter";
import { placeItem, synthFrames, type TrackSpec } from "@/lib/vision/synth";
import type { Frame } from "@/lib/domain/schemas";

// Synthetic scene sizes (bigger than the real kit so the geometry is easy to read).
const TEST_AREAS: Record<string, number> = { camera_body: 0.036, lens: 0.0182, battery: 0.0121 };
const cfg = counterConfigForKit({ ...KIT, items: KIT.items.map((i) => ({ ...i, expectedAreaFrac: TEST_AREAS[i.key] })) });
const N = 80;

const CAM = { concept: "mint green object", w: 0.18, h: 0.2 };
const LENS = { concept: "camera lens", w: 0.13, h: 0.14 };
const BATT = { concept: "battery", w: 0.11, h: 0.11 };
const okLabel = { text: "NL-XX-00001", confidence: 0.93 };

function cleanKit(until = N - 1): TrackSpec[] {
  return [
    ...placeItem({ ...CAM, trackId: 1, handId: "h1", pickF: 4, tx: 0.7, ty: 0.3, until, label: okLabel }),
    ...placeItem({ ...LENS, trackId: 2, handId: "h2", pickF: 18, tx: 0.88, ty: 0.3, until, label: okLabel }),
    ...placeItem({ ...BATT, trackId: 3, handId: "h3", pickF: 32, tx: 0.78, ty: 0.72, until }),
  ];
}

const run = (tracks: TrackSpec[], frames = N) => countClip("t", synthFrames({ frames, fps: 5, tracks }), cfg);
const holds = (r: ReturnType<typeof run>) => [...holdingFlagsByItem(r).keys()].sort();

describe("tray counter: the clean path", () => {
  it("counts each of three items once", () => {
    const r = run(cleanKit());
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(holds(r)).toEqual([]);
    expect(r.arrivals.map((a) => a.itemKey)).toEqual(["camera_body", "lens", "battery"]);
  });

  it("records the arrival time after the item is set down, not while it travels", () => {
    const r = run(cleanKit());
    const cam = r.arrivals.find((a) => a.itemKey === "camera_body")!;
    // set down at frame 8 (pick 4 + travel 4); settles after 3 still frames
    expect(cam.frameIndex).toBeGreaterThanOrEqual(8);
    expect(cam.frameIndex).toBeLessThanOrEqual(12);
  });

  it("tolerates small per-frame jitter in mask positions", () => {
    const tracks = cleanKit().map((t) => (t.concept === "hand" ? t : { ...t, jitter: 0.004 }));
    expect(run(tracks).counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
  });

  it("ignores an empty clip", () => {
    const r = run([]);
    expect(r.counts).toEqual({ camera_body: 0, lens: 0, battery: 0 });
    expect(r.flags).toEqual([]);
  });
});

describe("tray counter: hard cases from spec §3", () => {
  it("a hand occluding a counted item (mask gone, then a NEW track ID) does not add a count", () => {
    const tracks = cleanKit();
    const lens = tracks.find((t) => t.trackId === 2)!;
    lens.to = 40;
    lens.gaps = [[30, 38]];
    tracks.push(
      { concept: "hand", trackId: "h9", from: 29, to: 39, keys: [{ f: 29, x: 0.88, y: 0.3 }], w: 0.16, h: 0.18 },
      { ...LENS, trackId: 22, from: 41, to: N - 1, keys: [{ f: 41, x: 0.881, y: 0.302 }], label: okLabel },
    );
    const r = run(tracks);
    expect(r.counts.lens).toBe(1);
    expect(r.diagnostics.trackIdsPerSlot[r.arrivals.find((a) => a.itemKey === "lens")!.slotId]).toEqual(["2", "22"]);
    expect(r.diagnostics.rawTrackIdsPerItem.lens).toBe(2);
    expect(holds(r)).toEqual([]);
  });

  it("track ID churn with no occlusion at all is still one item", () => {
    const tracks = cleanKit();
    const cam = tracks.find((t) => t.trackId === 1)!;
    cam.to = 30;
    tracks.push({ ...CAM, trackId: 101, from: 31, to: 50, keys: [{ f: 31, x: 0.7, y: 0.3 }], label: okLabel });
    tracks.push({ ...CAM, trackId: 102, from: 51, to: N - 1, keys: [{ f: 51, x: 0.7, y: 0.3 }], label: okLabel });
    const r = run(tracks);
    expect(r.counts.camera_body).toBe(1);
    expect(r.diagnostics.rawTrackIdsPerItem.camera_body).toBe(3);
  });

  it("an item lifted out of the tray and put back elsewhere is counted once", () => {
    const tracks = cleanKit(45).filter((t) => t.trackId !== 2 && t.trackId !== "h2");
    tracks.push(
      ...placeItem({ ...LENS, trackId: 2, handId: "h2", pickF: 18, tx: 0.88, ty: 0.3, until: 30, label: okLabel }),
      // picked up, held to camera (outside the tray), then set down at a new spot with a new ID
      { concept: "hand", trackId: "h7", from: 30, to: 44, keys: [{ f: 30, x: 0.88, y: 0.3 }, { f: 34, x: 0.5, y: 0.5 }, { f: 40, x: 0.5, y: 0.5 }, { f: 44, x: 0.85, y: 0.55 }], w: 0.12, h: 0.16 },
      { ...LENS, trackId: 7, from: 31, to: N - 1, keys: [{ f: 31, x: 0.86, y: 0.32 }, { f: 34, x: 0.5, y: 0.5 }, { f: 40, x: 0.5, y: 0.5 }, { f: 44, x: 0.85, y: 0.55 }], label: okLabel },
    );
    tracks.forEach((t) => {
      if (t.concept !== "hand" && t.to === 45) t.to = N - 1;
    });
    const r = run(tracks);
    expect(r.counts.lens).toBe(1);
    expect(r.flags.some((f) => f.code === "reentry_rebound" && f.itemKeys.includes("lens"))).toBe(true);
    expect(holds(r)).toEqual([]);
  });

  it("an item that leaves the tray and never comes back is HELD (left_tray)", () => {
    const tracks = cleanKit();
    const batt = tracks.find((t) => t.trackId === 3)!;
    batt.to = 50;
    tracks.push({ concept: "hand", trackId: "h8", from: 49, to: 54, keys: [{ f: 49, x: 0.78, y: 0.72 }, { f: 54, x: 0.3, y: 0.9 }], w: 0.12, h: 0.16 });
    const r = run(tracks);
    expect(r.counts.battery).toBe(1);
    expect(holds(r)).toEqual(["battery"]);
    expect(r.flags.find((f) => f.code === "left_tray")!.itemKeys).toEqual(["battery"]);
  });

  it("kraft paper in the box and the tray is never counted", () => {
    const tracks = cleanKit();
    tracks.push(
      { concept: "kraft paper", trackId: 50, from: 0, to: N - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }], w: 0.25, h: 0.3 },
      { concept: "kraft paper", trackId: 51, from: 10, to: N - 1, keys: [{ f: 10, x: 0.22, y: 0.5 }, { f: 14, x: 0.8, y: 0.9 }], w: 0.2, h: 0.1 },
      { concept: "cardboard box", trackId: 52, from: 0, to: N - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }], w: 0.35, h: 0.5 },
    );
    const r = run(tracks);
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(r.diagnostics.ignoredMasks).toBeGreaterThan(0);
  });

  it("an unknown concept (anything SAM returns that isn't a kit item) is ignored, not counted", () => {
    const tracks = cleanKit();
    tracks.push({ concept: "coffee mug", trackId: 60, from: 0, to: N - 1, keys: [{ f: 0, x: 0.9, y: 0.9 }], w: 0.1, h: 0.1 });
    expect(run(tracks).counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
  });

  it("two items merged into one mask over two counted slots → HELD for both (merged_mask)", () => {
    const tracks = cleanKit();
    tracks.find((t) => t.trackId === 1)!.to = 50;
    tracks.find((t) => t.trackId === 2)!.to = 50;
    tracks.push({ concept: "mint green object", trackId: 77, from: 51, to: N - 1, keys: [{ f: 51, x: 0.79, y: 0.3 }], w: 0.36, h: 0.22, area: 0.055 });
    const r = run(tracks);
    const h = holdingFlagsByItem(r);
    expect(h.has("camera_body")).toBe(true);
    expect(h.has("lens")).toBe(true);
    expect(r.counts.camera_body).toBe(1);
  });

  it("battery placed touching the camera, read as ONE oversized camera mask → HELD, never a silent 2", () => {
    const tracks = cleanKit().filter((t) => t.trackId !== 3 && t.trackId !== "h3");
    const cam = tracks.find((t) => t.trackId === 1)!;
    cam.to = 36;
    tracks.push(
      { concept: "hand", trackId: "h3", from: 32, to: 37, keys: [{ f: 32, x: 0.22, y: 0.5 }, { f: 36, x: 0.75, y: 0.33 }, { f: 37, x: 0.8, y: 0.5 }], w: 0.12, h: 0.16 },
      { concept: "mint green object", trackId: 1, from: 37, to: N - 1, keys: [{ f: 37, x: 0.72, y: 0.32 }], w: 0.24, h: 0.24, area: 0.062 },
    );
    const r = run(tracks);
    expect(r.counts.battery).toBe(0);
    const h = holdingFlagsByItem(r);
    expect(h.has("battery")).toBe(true);
    expect(h.get("battery")![0].code).toBe("merged_mask");
  });

  it("two items set down together as one oversized mask → one slot + merged_mask HOLD", () => {
    const tracks: TrackSpec[] = [
      ...placeItem({ ...LENS, trackId: 2, handId: "h2", pickF: 4, tx: 0.88, ty: 0.3, until: N - 1, label: okLabel }),
      ...placeItem({ concept: "mint green object", w: 0.26, h: 0.26, area: 0.064, trackId: 1, handId: "h1", pickF: 20, tx: 0.72, ty: 0.7, until: N - 1, label: okLabel }),
    ];
    const r = run(tracks);
    expect(r.counts.camera_body).toBe(1);
    const h = holdingFlagsByItem(r);
    expect(h.has("battery")).toBe(true);
    expect(h.has("lens")).toBe(false); // lens was already counted separately
  });

  it("an unreadable label on an item that needs a serial → HELD (label_unreadable)", () => {
    const tracks = cleanKit();
    tracks.find((t) => t.trackId === 2)!.label = { text: "NL-L?-8?2", confidence: 0.31 };
    const r = run(tracks);
    expect(holds(r)).toEqual(["lens"]);
    expect(r.flags.find((f) => f.code === "label_unreadable")!.detail).toContain("0.31");
  });

  it("no label read at all on a serial item → HELD; items without serials are fine", () => {
    const tracks = cleanKit();
    delete tracks.find((t) => t.trackId === 1)!.label;
    const r = run(tracks);
    expect(holds(r)).toEqual(["camera_body"]);
  });

  it("with checkLabels off (live SAM, no text reads) the counter doesn't flag labels", () => {
    const tracks = cleanKit();
    tracks.forEach((t) => delete t.label);
    const r = countClip("t", synthFrames({ frames: N, fps: 5, tracks }), { ...cfg, checkLabels: false });
    expect(holds(r)).toEqual([]);
  });

  it("the best label read across frames wins (a blurry first read is not held)", () => {
    const tracks = cleanKit();
    const lens = tracks.find((t) => t.trackId === 2)!;
    lens.to = 30;
    lens.label = { text: "N?-LN", confidence: 0.2 };
    tracks.push({ ...LENS, trackId: 2, from: 31, to: N - 1, keys: [{ f: 31, x: 0.88, y: 0.3 }], label: { text: "BW-LN-80311", confidence: 0.95 } });
    const r = run(tracks);
    expect(holds(r)).toEqual([]);
    expect(r.arrivals.find((a) => a.itemKey === "lens")!.label?.text).toBe("BW-LN-80311");
  });

  it("a missing item is simply not counted (the reconciler turns it into MISSING)", () => {
    const tracks = cleanKit().filter((t) => t.trackId !== 2 && t.trackId !== "h2");
    const r = run(tracks);
    expect(r.counts).toEqual({ camera_body: 1, lens: 0, battery: 1 });
    expect(holds(r)).toEqual([]);
  });

  it("an item seen in the box but never placed in the tray → HELD (seen_not_placed)", () => {
    const tracks = cleanKit().filter((t) => t.trackId !== 2 && t.trackId !== "h2");
    tracks.push({ ...LENS, trackId: 2, from: 20, to: 40, keys: [{ f: 20, x: 0.2, y: 0.4 }] });
    const r = run(tracks);
    expect(r.counts.lens).toBe(0);
    expect(holds(r)).toEqual(["lens"]);
  });

  it("a counted slot re-read as a different item → HELD for both (concept_conflict)", () => {
    const tracks = cleanKit();
    tracks.find((t) => t.trackId === 3)!.to = 50;
    tracks.push({ concept: "camera lens", trackId: 90, from: 51, to: N - 1, keys: [{ f: 51, x: 0.78, y: 0.72 }], w: 0.11, h: 0.11, area: 0.0121, label: okLabel });
    const r = run(tracks);
    expect(holds(r)).toEqual(["battery", "lens"]);
  });

  it("an item held still above the tray in a hand doesn't count until it is let go", () => {
    const tracks: TrackSpec[] = [
      { ...BATT, trackId: 3, from: 0, to: N - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }, { f: 4, x: 0.78, y: 0.72 }] },
      { concept: "hand", trackId: "h", from: 0, to: 20, keys: [{ f: 0, x: 0.22, y: 0.5 }, { f: 4, x: 0.78, y: 0.72 }, { f: 19, x: 0.78, y: 0.72 }, { f: 20, x: 0.9, y: 0.95 }], w: 0.14, h: 0.14 },
    ];
    const r = run(tracks);
    expect(r.counts.battery).toBe(1);
    expect(r.arrivals[0].frameIndex).toBeGreaterThanOrEqual(21);
  });

  it("a hand resting on an item for a long time raises an informational flag, not a hold", () => {
    const tracks = cleanKit();
    tracks.find((t) => t.trackId === 1)!.gaps = [[15, 45]];
    tracks.push({ concept: "hand", trackId: "rest", from: 15, to: 45, keys: [{ f: 15, x: 0.7, y: 0.3 }], w: 0.2, h: 0.22 });
    const r = run(tracks);
    expect(r.counts.camera_body).toBe(1);
    expect(r.flags.some((f) => f.code === "occlusion_long")).toBe(true);
    expect(holds(r)).toEqual([]);
  });
});

describe("tray counter: hand-overlap fallback rule", () => {
  it("nothing settles while a hand is over the tray; counting resumes after it leaves", () => {
    const tracks: TrackSpec[] = [
      { ...BATT, trackId: 3, from: 0, to: N - 1, keys: [{ f: 0, x: 0.78, y: 0.72 }] },
      // a hand hovering elsewhere in the tray (not covering the battery) for frames 0–20
      { concept: "hand", trackId: "h", from: 0, to: 20, keys: [{ f: 0, x: 0.62, y: 0.2 }], w: 0.08, h: 0.12 },
    ];
    const off = countClip("t", synthFrames({ frames: N, fps: 5, tracks }), cfg);
    const on = countClip("t", synthFrames({ frames: N, fps: 5, tracks }), { ...cfg, handBlocksTray: true });
    expect(off.arrivals[0].frameIndex).toBeLessThan(5);
    expect(on.counts.battery).toBe(1);
    expect(on.arrivals[0].frameIndex).toBeGreaterThanOrEqual(21);
  });
});

describe("tray counter: contract", () => {
  it("rejects frames out of order", () => {
    const frames: Frame[] = [
      { index: 1, t: 0.2, masks: [] },
      { index: 0, t: 0, masks: [] },
    ];
    expect(() => countClip("x", frames, cfg)).toThrow(/out of order/);
  });

  it("never derives the count from the number of raw track IDs", () => {
    const tracks = cleanKit();
    // 6 different IDs for the same resting camera body
    tracks.find((t) => t.trackId === 1)!.to = 14;
    for (let k = 0; k < 6; k++) {
      tracks.push({ ...CAM, trackId: 200 + k, from: 15 + k * 10, to: 24 + k * 10, keys: [{ f: 15, x: 0.7, y: 0.3 }], label: okLabel });
    }
    const r = run(tracks);
    expect(r.diagnostics.rawTrackIdsPerItem.camera_body).toBe(7);
    expect(r.counts.camera_body).toBe(1);
  });
});

/** Two items read as ONE mask on frames [from, to]: the bigger mask becomes the union, the other disappears. */
function mergeOn(frames: Frame[], bigConcept: string, smallConcept: string, from: number, to: number): Frame[] {
  return frames.map((f) => {
    if (f.index < from || f.index > to) return f;
    const a = f.masks.find((m) => m.concept === bigConcept);
    const b = f.masks.find((m) => m.concept === smallConcept);
    if (!a || !b) return f;
    const x0 = Math.min(a.bbox[0], b.bbox[0]);
    const y0 = Math.min(a.bbox[1], b.bbox[1]);
    const x1 = Math.max(a.bbox[0] + a.bbox[2], b.bbox[0] + b.bbox[2]);
    const y1 = Math.max(a.bbox[1] + a.bbox[3], b.bbox[1] + b.bbox[3]);
    return { ...f, masks: f.masks.filter((m) => m !== b).map((m) => (m === a ? { ...a, bbox: [x0, y0, x1 - x0, y1 - y0] as [number, number, number, number], area: a.area + b.area } : m)) };
  });
}
const framesOf = (tracks: TrackSpec[]) => synthFrames({ frames: N, fps: 5, tracks });
const codes = (r: ReturnType<typeof run>) => r.flags.map((f) => f.code);

describe("tray counter: identity through a merge and its split", () => {
  it("two counted items merge for 2 s, then split back at their spots → each counted once, merge resolved, no hold", () => {
    const r = countClip("t", mergeOn(framesOf(cleanKit()), "mint green object", "camera lens", 48, 58), cfg);
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(codes(r)).toContain("merge_resolved");
    expect(holds(r)).toEqual([]);
    expect(r.arrivals.map((a) => a.itemKey)).toEqual(["camera_body", "lens", "battery"]);
  });

  it("a merge that never splits stays a merged_mask HOLD for both items (the evidence can't tell them apart)", () => {
    const r = countClip("t", mergeOn(framesOf(cleanKit()), "mint green object", "camera lens", 48, N - 1), cfg);
    expect(r.counts.lens).toBe(1);
    expect(holds(r)).toEqual(expect.arrayContaining(["camera_body", "lens"]));
    expect(codes(r)).not.toContain("merge_resolved");
  });

  it("a merge that ends too close to the clip's end to see both items on their own stays HELD", () => {
    const r = countClip("t", mergeOn(framesOf(cleanKit()), "mint green object", "camera lens", 70, N - 2), cfg);
    expect(holds(r)).toEqual(expect.arrayContaining(["camera_body", "lens"]));
  });

  it("the lens is taken out while merged: after the split only the camera is seen → lens HELD, never resolved", () => {
    const tracks = cleanKit();
    tracks.find((t) => t.trackId === 2)!.to = 58; // gone once the merge ends
    const r = countClip("t", mergeOn(framesOf(tracks), "mint green object", "camera lens", 48, 58), cfg);
    expect(holds(r)).toContain("lens");
    expect(codes(r)).not.toContain("merge_resolved");
  });

  it("merged before the lens was ever counted, then split → lens counted once (no second slot from the big mask)", () => {
    const r = countClip("t", mergeOn(framesOf(cleanKit()), "mint green object", "camera lens", 20, 34), cfg);
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(codes(r)).not.toContain("left_tray");
    expect(holds(r)).toEqual([]);
  });

  it("a counted lens merges with the battery as it is set down, then they split → each counted once", () => {
    const r = countClip("t", mergeOn(framesOf(cleanKit()), "camera lens", "battery", 36, 50), cfg);
    expect(r.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(codes(r)).not.toContain("left_tray");
  });
});

describe("tray counter: seen but never counted", () => {
  it("an item that moves through the tray without ever holding still (and never sits outside it) is HELD, not silently missing", () => {
    const tracks = cleanKit().filter((t) => t.trackId !== 2 && t.trackId !== "h2");
    // The lens jumps around inside the tray every frame: never still for settleFrames, never outside 3 frames running.
    tracks.push({ concept: "camera lens", trackId: 2, from: 20, to: 40, keys: Array.from({ length: 21 }, (_, i) => ({ f: 20 + i, x: i % 2 ? 0.86 : 0.93, y: i % 2 ? 0.25 : 0.55 })), w: 0.13, h: 0.14 });
    const r = run(tracks);
    expect(r.counts.lens).toBe(0);
    expect(holdingFlagsByItem(r).get("lens")?.[0].code).toBe("seen_not_placed");
  });

  it("an item whose mask never appears at all is plain MISSING with no extra flag (the lens-missing case)", () => {
    const r = run(cleanKit().filter((t) => t.trackId !== 2 && t.trackId !== "h2"));
    expect(r.counts.lens).toBe(0);
    expect(r.flags.filter((f) => f.itemKeys.includes("lens"))).toEqual([]);
  });
});
