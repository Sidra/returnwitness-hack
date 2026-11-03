/**
 * SAM 3.1's real output format on the Meta Model API (https://dev.meta.ai/docs/sam/reading-segmentation).
 * The answer is NOT JSON: the Responses `output_text` lane carries one line per frame,
 *   <Nf>ID<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0[;c=..];data=H,W,~base85|>,ID<|box…
 * Frames with no match are omitted, object ids are stable within a response but not dense, masks are
 * base85 rasters covering the box, and a confidence `c` appears only with metadata.include_confidence.
 * Meta's own parser (`@meta-sam/parser`) does the tokenising and mask decoding; this module turns its
 * records into the Frame[] the tray counter already trusts (normalised x,y,w,h boxes, mask area as a
 * fraction of the frame). An empty output_text is a legitimate "no matches" answer, not an error.
 */
import { decodeMaskToRaster, parseVideoStream, type SegmentationRecord } from "@meta-sam/parser";
import type { Frame, Mask } from "@/lib/domain/schemas";

export class SamTokenError extends Error {}

export interface SamTokenOpts {
  concept: string;
  fps: number;
  /** Source frame size in pixels (the clip's own resolution). */
  width: number;
  height: number;
}

/** The request body Meta's docs give for a video concept prompt (one concept per request). */
export function samVideoRequest(model: string, fileId: string, concept: string) {
  return {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: concept },
          { type: "input_video", file_id: fileId },
        ],
      },
    ],
    // A string, not a boolean, per the docs. Without it there is no score at all.
    metadata: { include_confidence: "true" },
  };
}

type MinimalEvent = { type: string; [k: string]: unknown };

/** Feeds already-complete output text through Meta's parser (non-streamed answers, recordings, tests). */
export async function* eventsFromText(outputText: string): AsyncIterable<MinimalEvent> {
  const lane = { item_id: "message-0", output_index: 0, content_index: 0 };
  if (outputText) yield { type: "response.output_text.delta", ...lane, delta: outputText };
  yield { type: "response.output_text.done", ...lane, text: outputText };
  yield { type: "response.completed" };
}

function maskAreaFraction(rec: Extract<SegmentationRecord, { kind: "mask" }>, width: number, height: number): number {
  const raster = decodeMaskToRaster(rec.mask);
  let on = 0;
  for (let i = 0; i < raster.length; i++) on += raster[i];
  // The raster covers the record's bounds; scale if its own grid differs from the bounds in source pixels.
  const bw = Math.max(1, rec.bounds.right - rec.bounds.left);
  const bh = Math.max(1, rec.bounds.bottom - rec.bounds.top);
  const px = on * ((bw * bh) / Math.max(1, rec.mask.width * rec.mask.height));
  return Math.min(1, px / Math.max(1, width * height));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Records from Meta's parser → per-frame masks for one concept. Pure; exported for tests. */
export function recordsToFrames(records: readonly SegmentationRecord[], opts: SamTokenOpts): Frame[] {
  const { width: W, height: H } = opts;
  if (!(W > 0 && H > 0)) throw new SamTokenError("frame size unknown: cannot normalise SAM boxes");
  type Acc = { box?: Extract<SegmentationRecord, { kind: "box" }>; mask?: Extract<SegmentationRecord, { kind: "mask" }> };
  const byFrame = new Map<number, Map<string, Acc>>();
  for (const r of records) {
    if (r.kind === "text" || r.frame == null) continue;
    const objs = byFrame.get(r.frame.frameIndex) ?? new Map<string, Acc>();
    byFrame.set(r.frame.frameIndex, objs);
    const acc = objs.get(r.objectId) ?? {};
    if (r.kind === "box") acc.box = r;
    else acc.mask = r;
    objs.set(r.objectId, acc);
  }
  return [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, objs]) => {
      const masks: Mask[] = [];
      for (const [objectId, { box, mask }] of objs) {
        const b = box ?? (mask ? { left: mask.bounds.left, top: mask.bounds.top, right: mask.bounds.right, bottom: mask.bounds.bottom } : null);
        if (!b) continue;
        const x = clamp01(b.left / W);
        const y = clamp01(b.top / H);
        const w = clamp01((b.right - b.left) / W);
        const h = clamp01((b.bottom - b.top) / H);
        // No mask (shouldn't happen, but the grammar allows a lone box): fall back to the box's area.
        const area = mask ? maskAreaFraction(mask, W, H) : w * h;
        const score = box?.confidence ?? mask?.confidence ?? 1;
        masks.push({ trackId: objectId, concept: opts.concept, bbox: [x, y, w, h], area, score });
      }
      return { index, t: Number((index / opts.fps).toFixed(3)), masks };
    });
}

export interface SamTokenParse {
  frames: Frame[];
  objects: number;
  rawChars: number;
  warnings: string[];
}

/** Parses a SAM 3.1 Responses event stream (live) or `eventsFromText(text)` (recorded/non-streamed). */
export async function parseSamTokenStream(events: AsyncIterable<MinimalEvent>, opts: SamTokenOpts): Promise<SamTokenParse> {
  const parsed = parseVideoStream(events as never);
  for await (const _snapshot of parsed) {
    // Snapshots are cumulative; only the final result matters here.
  }
  const result = await parsed.finalResult;
  if (result.outcome.status !== "completed") {
    throw new SamTokenError(`SAM response for "${opts.concept}" ended ${result.outcome.status}${"detail" in result.outcome && result.outcome.detail ? `: ${result.outcome.detail}` : ""}`);
  }
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const frames = recordsToFrames(result.records, opts);
  if (errors.length && frames.length === 0) throw new SamTokenError(`SAM output for "${opts.concept}" could not be parsed: ${errors[0].code} ${errors[0].message}`);
  return {
    frames,
    objects: new Set(result.records.flatMap((r) => (r.kind === "text" ? [] : [r.objectId]))).size,
    rawChars: result.rawOutput.length,
    warnings: result.diagnostics.map((d) => `${d.severity} ${d.code} line ${d.line}: ${d.message}`),
  };
}
