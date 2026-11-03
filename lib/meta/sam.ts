/**
 * SAM 3.1 on the Meta Model API, behind the Segmenter interface.
 *
 * `MetaSamSegmenter` follows Meta's SAM docs: upload with `POST /v1/files`
 * (purpose user_data), then one streamed `POST /v1/responses` per concept with the clip's file_id;
 * the answer is special-token text, parsed by Meta's own `@meta-sam/parser` in `./sam-tokens`.
 * One concept per request ("Name one concept per request"), all fired in parallel (spec §3 hole 6).
 *
 * `parseSamOutput` below is the tolerant JSON parser kept for MY Modal endpoint's contract
 * (lib/openweights/modal-sam.ts), which returns JSON because we wrote it; Meta's API never does.
 */
import fs from "node:fs";
import { saveRecording } from "./recordings";
import OpenAI, { toFile } from "openai";
import type { BBox, Frame, Mask, SegmentationResult } from "@/lib/domain/schemas";
import type { SegmentInput, Segmenter } from "@/lib/vision/segmenter";
import { probe } from "@/lib/vision/prepare-clip";
import { parseSamTokenStream, samVideoRequest } from "./sam-tokens";
import { logLlmCall, PRICES, usdToMicroCents } from "@/lib/obs/llm-log";
import { assertNotContributor, metaConfig, type MetaConfig } from "./config";

export class SamParseError extends Error {}

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: Json): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const first = (o: Record<string, Json>, keys: string[]): Json => keys.map((k) => o[k]).find((v) => v !== undefined);

/** Accepts [x0,y0,x1,y1], [x,y,w,h] (when `xywh`), or {x,y,w,h} / {x0,y0,x1,y1}. Normalises to [x,y,w,h] in 0..1. */
export function toBBox(raw: Json, width: number, height: number, xywh = false): BBox | null {
  let x: number, y: number, w: number, h: number;
  if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === "number")) {
    const [a, b, c, d] = raw as number[];
    if (xywh) [x, y, w, h] = [a, b, c, d];
    else [x, y, w, h] = [a, b, c - a, d - b];
  } else if (isObj(raw)) {
    const o = raw;
    if (num(o.x0) != null && num(o.x1) != null) [x, y, w, h] = [o.x0 as number, o.y0 as number, (o.x1 as number) - (o.x0 as number), (o.y1 as number) - (o.y0 as number)];
    else if (num(o.x) != null && num(o.w ?? o.width) != null) [x, y, w, h] = [o.x as number, o.y as number, (o.w ?? o.width) as number, (o.h ?? o.height) as number];
    else return null;
  } else return null;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const pixel = Math.max(x + w, y + h) > 1.5;
  return pixel ? [x / width, y / height, w / width, h / height] : [x, y, w, h];
}

interface ParseOpts {
  concept: string;
  fps: number;
  width: number;
  height: number;
}

/** Find the first value under any of these keys, searching nested objects breadth-first. */
function findKey(root: Json, keys: string[], depth = 6): Json {
  const q: Array<[Json, number]> = [[root, 0]];
  while (q.length) {
    const [v, d] = q.shift()!;
    if (isObj(v)) {
      for (const k of keys) if (v[k] !== undefined) return v[k];
      if (d < depth) for (const c of Object.values(v)) q.push([c, d + 1]);
    } else if (Array.isArray(v) && d < depth) for (const c of v) q.push([c, d + 1]);
  }
  return undefined;
}

function maskFrom(o: Record<string, Json>, trackId: string | number, opts: ParseOpts): Mask | null {
  const xywh = o.box_format === "xywh" || o.bbox_format === "xywh";
  const bbox = toBBox(first(o, ["box", "bbox", "bounding_box", "boundingBox"]), opts.width, opts.height, xywh);
  if (!bbox) return null;
  const areaRaw = num(first(o, ["area", "mask_area"]));
  const area = areaRaw == null ? bbox[2] * bbox[3] : areaRaw > 1 ? areaRaw / (opts.width * opts.height) : areaRaw;
  const score = num(first(o, ["score", "confidence", "probability"])) ?? 1;
  return { trackId, concept: opts.concept, bbox, area: Math.min(1, Math.max(0, area)), score: Math.min(1, Math.max(0, score)) };
}

/**
 * Parse SAM output into frames. Shapes accepted:
 *  A. frame-major: {frames:[{frame_index|index|frame, timestamp?, objects|detections|masks|instances:[{id|track_id|object_id, box|bbox, score}]}]}
 *  B. track-major: {objects|tracks|instances:[{id|track_id|object_id, frames|track|detections:[{frame_index|frame, box, score}]}]}
 * Pixel or normalised boxes. Anything else throws SamParseError (never a silent empty result).
 */
export function parseSamOutput(raw: Json, opts: ParseOpts): Frame[] {
  const byFrame = new Map<number, Mask[]>();
  const add = (fi: number, m: Mask) => byFrame.set(fi, [...(byFrame.get(fi) ?? []), m]);
  const frameIdx = (o: Record<string, Json>): number | null => {
    const fi = num(first(o, ["frame_index", "frameIndex", "frame", "index"]));
    if (fi != null) return Math.round(fi);
    const t = num(first(o, ["timestamp", "time", "t"]));
    return t != null ? Math.round(t * opts.fps) : null;
  };
  const idOf = (o: Record<string, Json>): string | number | null => {
    const v = first(o, ["track_id", "trackId", "object_id", "objectId", "id", "obj_id"]);
    return typeof v === "string" || typeof v === "number" ? v : null;
  };

  const frames = findKey(raw, ["frames"]);
  if (Array.isArray(frames) && frames.some((f) => isObj(f) && (first(f, ["objects", "detections", "masks", "instances"]) !== undefined))) {
    for (const f of frames) {
      if (!isObj(f)) continue;
      const fi = frameIdx(f);
      const objs = first(f, ["objects", "detections", "masks", "instances"]);
      if (fi == null || !Array.isArray(objs)) continue;
      for (const o of objs) {
        if (!isObj(o)) continue;
        const id = idOf(o);
        const m = id == null ? null : maskFrom(o, id, opts);
        if (m) add(fi, m);
      }
    }
  } else {
    const tracks = findKey(raw, ["objects", "tracks", "instances"]);
    if (!Array.isArray(tracks)) throw new SamParseError("SAM output has neither frame-major `frames` nor track-major `objects/tracks`");
    for (const tr of tracks) {
      if (!isObj(tr)) continue;
      const id = idOf(tr);
      const dets = first(tr, ["frames", "track", "detections", "masks"]);
      if (id == null || !Array.isArray(dets)) continue;
      for (const d of dets) {
        if (!isObj(d)) continue;
        const fi = frameIdx(d);
        const m = maskFrom(d, id, opts);
        if (fi != null && m) add(fi, m);
      }
    }
  }
  if (byFrame.size === 0 && !(Array.isArray(frames) && frames.length > 0)) {
    // An empty answer is legitimate only if the response explicitly listed frames with no objects.
    throw new SamParseError(`SAM output for "${opts.concept}" contained no parseable masks`);
  }
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([index, masks]) => ({ index, t: Number((index / opts.fps).toFixed(3)), masks }));
}

/** Merge per-concept frame lists into one frame list (track IDs are namespaced by concept). */
export function mergeConceptFrames(perConcept: Array<{ concept: string; frames: Frame[] }>, totalFrames: number, fps: number): Frame[] {
  const out: Frame[] = Array.from({ length: totalFrames }, (_, i) => ({ index: i, t: Number((i / fps).toFixed(3)), masks: [] as Mask[] }));
  for (const { concept, frames } of perConcept) {
    for (const f of frames) {
      if (f.index < 0 || f.index >= totalFrames) continue;
      out[f.index].masks.push(...f.masks.map((m) => ({ ...m, trackId: `${concept}#${m.trackId}` })));
    }
  }
  return out;
}

/** The request body for one concept. The single place to change on key day. */
/** The documented request for one concept on one uploaded clip (see ./sam-tokens). */
export function samRequestBody(model: string, fileId: string, concept: string) {
  return samVideoRequest(model, fileId, concept);
}

export class MetaSamSegmenter implements Segmenter {
  readonly name = "sam-3.1 (Meta Model API)";
  readonly mode = "LIVE_META" as const;
  private client: OpenAI;

  constructor(
    private readonly cfg: MetaConfig = metaConfig(),
    private readonly frameSize = { width: 1280, height: 720 },
  ) {
    if (!cfg.apiKey) throw new Error("META_HACK_API_KEY is not set");
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 90_000, maxRetries: 1 });
  }

  async segment(input: SegmentInput): Promise<SegmentationResult> {
    if (!input.videoPath) throw new Error("live segmentation needs a prepared clip (5 fps / 720p)");
    const model = this.cfg.models.sam;
    assertNotContributor(model);
    const clip = safeProbe(input.videoPath);
    const W = clip?.width || this.frameSize.width;
    const H = clip?.height || this.frameSize.height;
    // Meta bills video per frame of the clip, at least 50 frames per request (docs/pricing-rate-limits).
    const clipFrames = clip && clip.durationS > 0 ? Math.max(1, Math.round(clip.durationS * (clip.fps || input.fps))) : 0;
    const t0 = Date.now();
    const file = await this.client.files.create({ file: await toFile(fs.createReadStream(input.videoPath), `${input.clipId}.mp4`), purpose: "user_data" as never });
    const results = await Promise.all(
      input.concepts.map(async (concept) => {
        const started = Date.now();
        const body = samVideoRequest(model, file.id, concept);
        let requestId = "";
        try {
          const stream = (await this.client.responses.create({ ...body, stream: true } as never, { signal: input.signal })) as unknown as AsyncIterable<{ type: string; response?: { id?: string } }>;
          async function* tap() {
            for await (const ev of stream) {
              if (!requestId && ev.response?.id) requestId = ev.response.id;
              yield ev;
            }
          }
          const parsed = await parseSamTokenStream(tap(), { concept, fps: input.fps, width: W, height: H });
          const billedFrames = Math.max(50, clipFrames || parsed.frames.length);
          const usd = billedFrames * PRICES.samPerFrameUsd;
          logLlmCall({ provider: "meta", model, purpose: `segment:${concept}`, mode: "live", ok: true, latencyMs: Date.now() - started, inputTokens: null, outputTokens: null, units: { kind: "frames", count: billedFrames }, costUsd: usd, costMicroCents: usdToMicroCents(usd), caseId: input.caseId, input: body, output: { requestId, framesWithMatches: parsed.frames.length, objects: parsed.objects, rawChars: parsed.rawChars, warnings: parsed.warnings.slice(0, 5) } });
          return { concept, frames: parsed.frames, requestId };
        } catch (e) {
          logLlmCall({ provider: "meta", model, purpose: `segment:${concept}`, mode: "live", ok: false, latencyMs: Date.now() - started, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: input.caseId, input: body, output: requestId ? { requestId } : "", error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      }),
    );
    const total = Math.max(1, clipFrames, ...results.flatMap((r) => r.frames.map((f) => f.index + 1)));
    const result: SegmentationResult = {
      clipId: input.clipId,
      fps: input.fps,
      width: W,
      height: H,
      durationS: clip?.durationS || total / input.fps,
      frames: mergeConceptFrames(results, total, input.fps),
      source: {
        mode: "LIVE_META",
        model,
        provenance: `live SAM 3.1 call, ${input.concepts.length} concepts in parallel, ${Date.now() - t0} ms`,
        recordedAt: new Date().toISOString(),
        requestIds: results.map((r) => r.requestId).filter(Boolean),
      },
    };
    // Every live run becomes a recording: the replay view and the public site (fixtures only) use it.
    saveRecording(input.clipId, "sam", result);
    return result;
  }
}

function safeProbe(path: string): ReturnType<typeof probe> | null {
  try {
    return probe(path);
  } catch {
    return null;
  }
}
