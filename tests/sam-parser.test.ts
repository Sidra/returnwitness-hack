import { describe, expect, it } from "vitest";
import { mergeConceptFrames, parseSamOutput, SamParseError, samRequestBody, toBBox } from "@/lib/meta/sam";

const opts = { concept: "camera lens", fps: 5, width: 1280, height: 720 };

describe("tolerant JSON SAM parser (my Modal endpoint's contract; Meta's API answers in tokens, see sam-tokens.test.ts)", () => {
  it("frame-major, pixel xyxy boxes", () => {
    const raw = { output: [{ content: [{ frames: [{ frame_index: 0, objects: [{ track_id: 3, box: [640, 360, 768, 432], score: 0.9 }] }, { frame_index: 1, objects: [] }] }] }] };
    const f = parseSamOutput(raw, opts);
    expect(f).toHaveLength(1);
    expect(f[0].masks[0].trackId).toBe(3);
    expect(f[0].masks[0].bbox.map((v) => +v.toFixed(3))).toEqual([0.5, 0.5, 0.1, 0.1]);
    expect(f[0].masks[0].area).toBeCloseTo(0.01);
  });

  it("track-major, normalised {x,y,w,h}, timestamps instead of indices", () => {
    const raw = { objects: [{ object_id: "a", frames: [{ timestamp: 0.4, bbox: { x: 0.1, y: 0.2, w: 0.05, h: 0.05 }, confidence: 0.7 }] }] };
    const f = parseSamOutput(raw, opts);
    expect(f[0]).toMatchObject({ index: 2, t: 0.4 });
    expect(f[0].masks[0]).toMatchObject({ trackId: "a", score: 0.7 });
  });

  it("pixel mask area is normalised", () => {
    const raw = { frames: [{ index: 0, detections: [{ id: 1, bbox: [0, 0, 100, 100], area: 9216 }] }] };
    expect(parseSamOutput(raw, opts)[0].masks[0].area).toBeCloseTo(0.01);
  });

  it("an unrecognisable answer throws instead of returning an empty (fake-clean) result", () => {
    expect(() => parseSamOutput({ hello: "world" }, opts)).toThrow(SamParseError);
    expect(() => parseSamOutput({ objects: [] }, opts)).toThrow(SamParseError);
  });

  it("explicit frames with no objects is a legitimate empty result", () => {
    expect(parseSamOutput({ frames: [{ frame_index: 0, objects: [] }] }, opts)).toEqual([]);
  });

  it("drops degenerate boxes", () => {
    expect(toBBox([10, 10, 5, 5], 100, 100)).toBeNull();
    expect(toBBox("x", 100, 100)).toBeNull();
  });

  it("merges concepts into one frame list and namespaces track IDs per concept", () => {
    const a = parseSamOutput({ frames: [{ frame_index: 1, objects: [{ id: 1, box: [0.1, 0.1, 0.2, 0.2] }] }] }, opts);
    const b = parseSamOutput({ frames: [{ frame_index: 1, objects: [{ id: 1, box: [0.5, 0.5, 0.6, 0.6] }] }] }, { ...opts, concept: "hand" });
    const m = mergeConceptFrames([{ concept: "camera lens", frames: a }, { concept: "hand", frames: b }], 3, 5);
    expect(m).toHaveLength(3);
    expect(m[1].masks.map((x) => x.trackId)).toEqual(["camera lens#1", "hand#1"]);
  });

  it("builds one request per concept with the file reference", () => {
    const body = samRequestBody("sam-3.1", "file_123", "camera lens");
    expect(JSON.stringify(body)).toContain("file_123");
    expect(JSON.stringify(body)).toContain("camera lens");
  });
});
