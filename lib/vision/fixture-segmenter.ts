/**
 * Replays segmentation without calling Meta: a real SAM 3.1 recording from
 * data/recordings/<clipId>.sam.json when one exists, otherwise the synthetic scene.
 * Always labelled RECORDED FIXTURE · synthetic scene, not a live Meta call, with its provenance.
 */
import { SegmentationResult } from "@/lib/domain/schemas";
import { SCENES } from "@/data/scenes";
import { loadRecording } from "@/lib/meta/recordings";
import type { SegmentInput, Segmenter } from "./segmenter";

export class FixtureSegmenter implements Segmenter {
  readonly name = "recorded fixture";
  readonly mode = "RECORDED_FIXTURE" as const;

  async segment(input: SegmentInput): Promise<SegmentationResult> {
    const rec = loadRecording<unknown>(input.clipId, "sam");
    if (rec) {
      const seg = SegmentationResult.parse(rec.data);
      return { ...seg, source: { ...seg.source, mode: "RECORDED_FIXTURE", provenance: `replay of ${seg.source.provenance}` } };
    }
    const scene = SCENES[input.clipId];
    if (!scene) throw new Error(`no recording or scene for clip ${input.clipId}`);
    return scene();
  }
}
