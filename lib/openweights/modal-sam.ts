/**
 * SAM 3.1 OPEN WEIGHTS (`facebook/sam3.1`) on my own Modal GPU endpoint, behind the Segmenter
 * interface. It is the FAILOVER for Meta's hosted SAM 3.1 (lib/meta/sam.ts), never the primary:
 *   RETURNWITNESS_SAM_FAILOVER=modal  + MODAL_SAM_URL + MODAL_SAM_TOKEN  → on
 *   anything else                                                       → off, with a plain reason
 *
 * Deployed on Modal credits (modal/sam31_app.py); the smoke test passed and its run of the late-bag
 * clip matched Meta's hosted SAM 3.1 frame for frame. Off on the public site. tests/modal-sam.test.ts covers the
 * behaviour below against mocks.
 *
 * We define the endpoint, so we define its contract (frame-major, pixel boxes):
 *   {frames:[{frame_index, objects:[{track_id, concept, box:[x0,y0,x1,y1], score, area?}]}],
 *    width, height, model, gpu_seconds?, peak_gpu_mb?, request_id?}
 * Parsing still goes through the shared `parseSamOutput` + `mergeConceptFrames`, so a Modal run and a
 * Meta run come out as the same Frame[] the tray counter already trusts.
 * Results are labelled LIVE_OPEN_WEIGHTS ("LIVE · Meta open weights on a partner GPU"), never LIVE_META.
 */
import fs from "node:fs";
import { z } from "zod";
import type { Frame, SegmentationResult } from "@/lib/domain/schemas";
import type { SegmentInput, Segmenter } from "@/lib/vision/segmenter";
import { FailoverSegmenter } from "@/lib/vision/failover-segmenter";
import { logLlmCall } from "@/lib/obs/llm-log";
import { assertNotContributor } from "@/lib/meta/config";
import { saveRecording } from "@/lib/meta/recordings";
import { mergeConceptFrames, parseSamOutput, SamParseError } from "@/lib/meta/sam";

export const MODAL_SAM_DEFAULT_MODEL = "facebook/sam3.1";
export const DEFAULT_PRIMARY_TIMEOUT_MS = 60_000;
/** A cold GPU container has to boot and load ~3 GB of weights before the first frame: give it room. */
export const DEFAULT_MODAL_REQUEST_TIMEOUT_MS = 180_000;
/** A prepared clip (5 fps / 720p / H.264) is a few MB; anything this big wasn't prepared, and base64 adds a third. */
export const MAX_CLIP_BYTES = 25 * 1024 * 1024;

export interface ModalSamConfig {
  enabled: boolean;
  url: string | null;
  token: string | null;
  model: string;
  /** Used by the failover wrapper as the PRIMARY's (Meta's) time budget before Modal takes over. */
  timeoutMs: number;
  /** Why it is off, in plain words. Empty when on. */
  reason: string;
}

export function modalSamConfig(env: NodeJS.ProcessEnv = process.env): ModalSamConfig {
  const flag = (env.RETURNWITNESS_SAM_FAILOVER ?? "").trim().toLowerCase();
  const rawUrl = env.MODAL_SAM_URL?.trim() || null;
  const token = env.MODAL_SAM_TOKEN?.trim() || null;
  const model = env.MODAL_SAM_MODEL?.trim() || MODAL_SAM_DEFAULT_MODEL;
  const t = Number(env.RETURNWITNESS_SAM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.round(t) : DEFAULT_PRIMARY_TIMEOUT_MS;
  let url: string | null = null;
  let badUrl = "";
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) badUrl = `MODAL_SAM_URL must be https (got ${u.protocol})`;
      else url = rawUrl.replace(/\/+$/, "");
    } catch {
      badUrl = "MODAL_SAM_URL is not a valid URL";
    }
  }
  const missing = [!url && !badUrl ? "MODAL_SAM_URL" : "", !token ? "MODAL_SAM_TOKEN" : ""].filter(Boolean);
  const reason =
    flag !== "modal"
      ? `failover segmentation is off: RETURNWITNESS_SAM_FAILOVER is ${flag ? `"${flag}"` : "not set"} (set it to "modal" once the Modal endpoint is deployed)`
      : badUrl
        ? `failover segmentation is off: ${badUrl}`
        : missing.length
          ? `failover segmentation is off: ${missing.join(" and ")} not set (deploy modal/sam31_app.py first, see modal/README.md)`
          : "";
  return { enabled: reason === "", url, token, model, timeoutMs, reason };
}

/* ---------- The response contract my Modal app returns ---------- */

const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const ModalSamResponse = z.object({
  frames: z
    .array(
      z.object({
        frame_index: z.number().int().nonnegative(),
        objects: z.array(
          z.object({
            track_id: z.union([z.number(), z.string()]),
            concept: z.string(),
            box: Box,
            score: z.number(),
            /** Mask pixel count, when the app sends it. Without it the area is the box's. */
            area: z.number().nonnegative().optional(),
          }),
        ),
      }),
    )
    .min(1, "response listed no frames"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  model: z.string(),
  gpu_seconds: z.number().nonnegative().optional(),
  peak_gpu_mb: z.number().nonnegative().optional(),
  request_id: z.string().optional(),
});
export type ModalSamResponse = z.infer<typeof ModalSamResponse>;

export class ModalSamHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Modal SAM endpoint returned HTTP ${status}${body ? `: ${body}` : ""}`);
  }
}

/**
 * Contract → Frame[]. Boxes are normalised HERE (pixels / frame size) before the shared parser sees
 * them: its pixel-vs-normalised guess would misread a tiny pixel box near the origin as normalised.
 */
export function modalResponseToFrames(res: ModalSamResponse, concepts: string[], fps: number): { frames: Frame[]; dropped: number } {
  const { width: W, height: H } = res;
  const clamp = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const wanted = new Set(concepts);
  const dropped = res.frames.reduce((s, f) => s + f.objects.filter((o) => !wanted.has(o.concept)).length, 0);
  const perConcept = concepts.map((concept) => {
    const raw = {
      frames: res.frames.map((f) => ({
        frame_index: f.frame_index,
        objects: f.objects
          .filter((o) => o.concept === concept)
          .map((o) => ({
            track_id: o.track_id,
            box: [clamp(o.box[0], W) / W, clamp(o.box[1], H) / H, clamp(o.box[2], W) / W, clamp(o.box[3], H) / H],
            score: o.score,
            ...(o.area != null ? { area: Math.min(1, o.area / (W * H)) } : {}),
          })),
      })),
    };
    return { concept, frames: parseSamOutput(raw, { concept, fps, width: W, height: H }) };
  });
  const total = Math.max(...res.frames.map((f) => f.frame_index)) + 1;
  return { frames: mergeConceptFrames(perConcept, total, fps), dropped };
}

export interface ModalSamOptions {
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxClipBytes?: number;
}

export class ModalSamSegmenter implements Segmenter {
  readonly name = "sam-3.1 open weights (Modal GPU)";
  readonly mode = "LIVE_OPEN_WEIGHTS" as const;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxClipBytes: number;

  constructor(
    private readonly cfg: ModalSamConfig = modalSamConfig(),
    opts: ModalSamOptions = {},
  ) {
    if (!cfg.url || !cfg.token) throw new Error(`Modal SAM endpoint not configured: ${cfg.reason || "MODAL_SAM_URL / MODAL_SAM_TOKEN not set"}`);
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_MODAL_REQUEST_TIMEOUT_MS;
    this.maxClipBytes = opts.maxClipBytes ?? MAX_CLIP_BYTES;
  }

  async segment(input: SegmentInput): Promise<SegmentationResult> {
    const t0 = Date.now();
    const model = this.cfg.model;
    // Summary only: the base64 video never goes into the log.
    const summary: Record<string, unknown> = { endpoint: `${new URL(this.cfg.url!).host}/segment`, clipId: input.clipId, fps: input.fps, concepts: input.concepts };
    try {
      if (!input.videoPath) throw new Error("live segmentation needs a prepared clip (5 fps / 720p)");
      if (!input.concepts.length) throw new Error("no concepts to segment");
      assertNotContributor(model);
      const size = fs.statSync(input.videoPath).size;
      summary.videoBytes = size;
      if (size > this.maxClipBytes) throw new Error(`clip is ${(size / 1048576).toFixed(1)} MB; the Modal segmenter takes at most ${(this.maxClipBytes / 1048576).toFixed(0)} MB (prepare it to 5 fps / 720p first)`);
      const video_b64 = fs.readFileSync(input.videoPath).toString("base64");

      const res = await this.post({ clipId: input.clipId, fps: input.fps, concepts: input.concepts, video_b64 }, input.signal);
      const parsed = ModalSamResponse.safeParse(res);
      if (!parsed.success) throw new SamParseError(`Modal SAM response doesn't match the contract: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      const data = parsed.data;
      if (data.model !== model) assertNotContributor(data.model);
      const { frames, dropped } = modalResponseToFrames(data, input.concepts, input.fps);
      const latencyMs = Date.now() - t0;
      const objects = data.frames.reduce((s, f) => s + f.objects.length, 0);
      logLlmCall({ provider: "modal", model, purpose: "segment", mode: "live", ok: true, latencyMs, inputTokens: null, outputTokens: null, ...(data.gpu_seconds != null ? { units: { kind: "gpu_seconds", count: data.gpu_seconds } } : {}), costUsd: null, costMicroCents: null, caseId: input.caseId, input: summary, output: { frames: data.frames.length, objects, droppedUnrequested: dropped, width: data.width, height: data.height, model: data.model, gpu_seconds: data.gpu_seconds ?? null, peak_gpu_mb: data.peak_gpu_mb ?? null } });
      const extra = [data.model !== model ? `endpoint reports ${data.model}` : "", dropped ? `${dropped} objects for unrequested concepts dropped` : ""].filter(Boolean).join("; ");
      const result: SegmentationResult = {
        clipId: input.clipId,
        fps: input.fps,
        width: data.width,
        height: data.height,
        durationS: frames.length / input.fps,
        frames,
        source: {
          mode: "LIVE_OPEN_WEIGHTS",
          model,
          provenance: `SAM 3.1 open weights on Modal (failover), ${input.concepts.length} concepts, ${latencyMs} ms${extra ? ` (${extra})` : ""}`,
          recordedAt: new Date().toISOString(),
          requestIds: data.request_id ? [data.request_id] : [],
        },
      };
      saveRecording(input.clipId, "sam-modal", result);
      return result;
    } catch (e) {
      logLlmCall({ provider: "modal", model, purpose: "segment", mode: "live", ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: input.caseId, input: summary, output: "", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  /** POST with my own timeout, linked to the caller's signal; a hung endpoint can never hang a case. */
  private async post(body: unknown, outer?: AbortSignal): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`Modal SAM request timed out after ${this.requestTimeoutMs} ms`)), this.requestTimeoutMs);
    const onOuter = () => ctl.abort(new Error(`Modal SAM request aborted by caller${outer?.reason instanceof Error ? ` (${outer.reason.message})` : ""}`));
    if (outer?.aborted) onOuter();
    outer?.addEventListener("abort", onOuter, { once: true });
    // Rejects as soon as we abort, even if an injected fetch ignores the signal.
    const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }));
    aborted.catch(() => {});
    try {
      if (ctl.signal.aborted) throw ctl.signal.reason;
      const run = async () => {
        const res = await this.fetchFn(`${this.cfg.url}/segment`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new ModalSamHttpError(res.status, text.replace(/\s+/g, " ").trim().slice(0, 200));
        }
        const text = await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new SamParseError(`Modal SAM response is not JSON: ${text.slice(0, 120)}`);
        }
      };
      return await Promise.race([run(), aborted]);
    } catch (e) {
      throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    }
  }
}

/**
 * Wrap a primary segmenter with the Modal failover when it is configured; otherwise return the
 * primary untouched. The runtime decides WHETHER to call this (live segmentation only).
 */
export function withModalFailover(primary: Segmenter, env: NodeJS.ProcessEnv = process.env, opts: ModalSamOptions = {}): Segmenter {
  const cfg = modalSamConfig(env);
  if (!cfg.enabled) return primary;
  return new FailoverSegmenter(primary, new ModalSamSegmenter(cfg, opts), { timeoutMs: cfg.timeoutMs });
}
