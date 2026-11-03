import type { ModeLabel, SegmentationResult } from "@/lib/domain/schemas";

export interface SegmentInput {
  clipId: string;
  /** Local path to the clip (live mode). Fixture segmenters ignore it. */
  videoPath?: string;
  /** Text concepts to segment and track (item concepts + hand + packing). */
  concepts: string[];
  fps: number;
  caseId?: string;
  signal?: AbortSignal;
}

/** Per-frame masks + track IDs in; the tray counter turns them into arrivals. */
export interface Segmenter {
  readonly name: string;
  readonly mode: ModeLabel;
  segment(input: SegmentInput): Promise<SegmentationResult>;
}
