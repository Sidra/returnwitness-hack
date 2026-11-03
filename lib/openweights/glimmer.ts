/**
 * Muse Glimmer label reading, shared by every place Glimmer runs (Fireworks serverless in
 * fireworks.ts, my own Modal GPU in glimmer-modal.ts) and by the fine-tune dataset builder.
 * One prompt, one output schema, one reads → holds mapping, one call path, so a read on Modal and a
 * read on Fireworks are judged by exactly the same rules and the training rows match inference.
 *
 * The reader looks only at the settled-item crops and transcribes each printed serial / SKU label.
 * It returns the shared reconciliation schema and is merged by crossCheck, so it can only RAISE
 * holds: an illegible or low-confidence label on a serial-required line, a serial that differs from
 * the slip, a SKU that contradicts the slip. Wire it with readsSerials: true so its serialRead is
 * compared and an unread serial holds the line.
 *
 * The model is never shown the slip's serials or SKUs: it transcribes what is printed, and app code
 * compares. A reader that knows the expected value tends to "read" it.
 */
import type OpenAI from "openai";
import { z } from "zod";
import type { LineStatus, ModeLabel, ModelReconciliationOutput } from "@/lib/domain/schemas";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { logLlmCall, usdToMicroCents, type LlmCallRecord } from "@/lib/obs/llm-log";
import { loadRecording, saveRecording } from "@/lib/meta/recordings";
import { moreRestrictive, reconcile } from "@/lib/engine/reconcile";
import { saveCrops } from "@/lib/learning/corrections";
import { strictJsonSchema } from "@/lib/meta/json-schema";
import { firstJsonObject, splitReasoning } from "./reasoning";

/** Below this self-reported confidence a read counts as unreadable (it holds a serial line, never clears one). */
export const LABEL_CONFIDENCE_FLOOR = 0.7;
/** It is the fast reader: fail fast and let the line hold rather than wait. */
export const GLIMMER_TIMEOUT_MS = 15_000;
/** Recording kind for label reads (the file layout needs only the string). */
export const LABELS_KIND = "labels";
export const LABEL_READER_NO_RECORDING = "[Label reader · not run — no recorded label read for this clip]";

export const GlimmerItem = z.object({
  itemKey: z.string(),
  serialRead: z.string().nullable().default(null),
  skuRead: z.string().nullable().default(null),
  legible: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type GlimmerItem = z.infer<typeof GlimmerItem>;
export const GlimmerOutput = z.object({ items: z.array(GlimmerItem) });
export type GlimmerOutput = z.infer<typeof GlimmerOutput>;

/**
 * Strict json_schema, not json_object: in JSON mode Muse Glimmer 30B (served by vLLM 0.32.0, first live read)
 * wrapped its thinking and its answer in one object, {"self": "<reasoning>", "user": {items…}},
 * which JSON mode allows. A schema makes the server's guided decoding emit exactly this shape.
 */
export const GLIMMER_RESPONSE_FORMAT = { type: "json_schema" as const, json_schema: { name: "label_reads", schema: strictJsonSchema(GlimmerOutput), strict: true } };

/** {"self": reasoning, "user": answer}: the channel envelope Glimmer used in JSON mode. Returns null if it isn't one. */
export function unwrapChannelEnvelope(value: unknown): { answer: unknown; reasoning: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!("user" in o) || keys.some((k) => k !== "self" && k !== "user")) return null;
  const answer = typeof o.user === "string" ? firstJsonObject(o.user) : o.user;
  return answer && typeof answer === "object" ? { answer, reasoning: typeof o.self === "string" ? o.self : "" } : null;
}

/** What the reader card and the correction form show per item. */
export interface GlimmerExtras {
  items: Array<GlimmerItem & { cropCaption: string | null }>;
  confidenceFloor: number;
  /** The served LoRA adapter, when a fine-tuned adapter answered (Modal only). */
  adapter?: string | null;
  /** Wall-clock seconds the endpoint held the GPU for this call, when it reports it (Modal only; not a bill). */
  gpuSeconds?: number | null;
}

export const GLIMMER_SYSTEM = `You transcribe printed labels on returned items at an inspection bench.
Each image is a crop of ONE item. For each crop, copy the serial number exactly as printed (or null if there is
none or you cannot read every character), the SKU / part number if one is printed (or null), whether the label is
fully legible, and your confidence 0..1 that the transcription is exact. Never guess a character: if any character
is unclear, set legible false and lower the confidence. Return JSON
{"items":[{"itemKey","serialRead","skuRead","legible","confidence"}]} with one entry per crop, using the itemKey given.`;

export const isCrop = (caption: string) => caption.startsWith("crop");

/** The slip item a crop shows: the longest slip key named in its caption ("crop of the counted lens as it…"). */
export function cropItemKey(caption: string, keys: string[]): string | null {
  const hits = keys.filter((k) => new RegExp(`(^|[^a-z0-9_])${k.replace(/[^a-z0-9_]/gi, "\\$&")}([^a-z0-9_]|$)`, "i").test(caption));
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** The user turn, shared with the fine-tune dataset so training and inference prompts never drift. */
export function glimmerUserContent(crops: Array<{ caption: string; dataUrl: string; itemKey: string | null }>, slipLines: ReaderEvidence["slip"]["lines"]): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
  // Item names only; expected serials/SKUs stay out of the prompt (see header).
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: `Items in this kit: ${JSON.stringify(slipLines.map((l) => ({ itemKey: l.itemKey, description: l.description, serialLabel: l.requiresSerial })))}` }];
  crops.forEach((c, i) => content.push({ type: "text", text: `Crop ${i + 1} · itemKey=${c.itemKey ?? "unknown"} · ${c.caption}` }, { type: "image_url", image_url: { url: c.dataUrl } }));
  return content;
}

/** Same normalisation reconcile.ts uses for serials: case and punctuation never decide a match. */
export const normCode = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();
/** A read the app acts on: legible, at or above the floor. Anything else is "unreadable" and holds a serial line. */
export const isTrustedRead = (r: Pick<GlimmerItem, "legible" | "confidence">, floor = LABEL_CONFIDENCE_FLOOR) => r.legible && r.confidence >= floor;
const PREFIX = "label reader";

/**
 * Reads → reconciliation lines that can only add holds. Each line starts from the counter's own
 * status (so silence is never a disagreement) and becomes HELD only for what the labels show.
 */
export function labelReadToReconciliation(read: GlimmerOutput, e: ReaderEvidence, floor = LABEL_CONFIDENCE_FLOOR): ModelReconciliationOutput {
  const det = reconcile(e.rma, e.slip, e.count);
  const cropped = new Set(e.images.filter((i) => isCrop(i.caption)).map((i) => cropItemKey(i.caption, e.slip.lines.map((l) => l.itemKey))).filter(Boolean));
  return {
    lines: det.lines.map((l) => {
      const slip = e.slip.lines.find((s) => s.itemKey === l.itemKey);
      const reads = read.items.filter((r) => r.itemKey === l.itemKey);
      const trusted = reads.filter((r) => isTrustedRead(r, floor));
      const reasons: ModelReconciliationOutput["lines"][number]["reasons"] = [];
      if (slip?.requiresSerial && l.observedQty > 0) {
        const weak = reads.find((r) => !r.legible || r.confidence < floor || !r.serialRead?.trim());
        if (!reads.length) {
          if (cropped.has(l.itemKey)) reasons.push({ code: "label_unreadable", detail: `${PREFIX}: no read returned for this item's label` });
        } else if (weak) {
          const what = !weak.legible ? "label not legible" : !weak.serialRead?.trim() ? "no serial read from the label" : `serial read as "${weak.serialRead}" only`;
          reasons.push({ code: "label_unreadable", detail: `${PREFIX}: ${what} at confidence ${weak.confidence.toFixed(2)} (floor ${floor})` });
        }
        const wrong = slip.serial ? trusted.find((r) => r.serialRead && normCode(r.serialRead) !== normCode(slip.serial!)) : undefined;
        if (wrong) reasons.push({ code: "serial_mismatch", detail: `${PREFIX}: label reads "${wrong.serialRead}", packing slip says "${slip.serial}"` });
      }
      const sku = slip ? trusted.find((r) => r.skuRead && normCode(r.skuRead) !== normCode(slip.sku)) : undefined;
      if (sku && slip) reasons.push({ code: "concept_conflict", detail: `${PREFIX}: label shows SKU "${sku.skuRead}", packing slip says "${slip.sku}"` });
      const status: LineStatus = reasons.length ? moreRestrictive(l.status, "HELD") : l.status;
      // Only a trusted read is reported, so crossCheck compares real transcriptions and holds on the rest.
      const serialRead = trusted.find((r) => r.serialRead?.trim())?.serialRead ?? null;
      return { itemKey: l.itemKey, observedQty: l.observedQty, status, reasons, serialRead };
    }),
    notes: "label reads of the settled-item crops",
  };
}

/** The settled-item crops a reader sends, each tagged with the slip item its caption names. */
export function glimmerCrops(e: ReaderEvidence) {
  const keys = e.slip.lines.map((l) => l.itemKey);
  return e.images.filter((i) => isCrop(i.caption)).map((i) => ({ ...i, itemKey: cropItemKey(i.caption, keys) }));
}

/** Parse a chat completion message into a Glimmer read (answer only; reasoning split off). */
export function parseGlimmerMessage(message: Parameters<typeof splitReasoning>[0]) {
  const split = splitReasoning(message);
  let { answer, reasoning } = split;
  let source: "field" | "think-tags" | "json-envelope" | "none" = split.source;
  let value = firstJsonObject(answer);
  const env = unwrapChannelEnvelope(value);
  if (env) {
    value = env.answer;
    answer = JSON.stringify(env.answer);
    reasoning = [reasoning, env.reasoning].filter(Boolean).join("\n\n");
    source = "json-envelope";
  }
  const parsed = GlimmerOutput.safeParse(value);
  return { answer, reasoning, source, read: parsed.success ? parsed.data : null };
}

export interface GlimmerCall {
  e: ReaderEvidence;
  client: OpenAI;
  provider: Extract<LlmCallRecord["provider"], "fireworks" | "modal">;
  /** What goes in the request's `model` field (a served LoRA name on Modal when one is configured). */
  requestModel: string;
  /** The model id for the log, the result card and the recording. */
  model: string;
  /** Shown on the card as the model (e.g. "base · LoRA name"). Defaults to `model`. */
  displayModel?: string;
  /** USD for one call from token counts, only when a real price is configured; null otherwise. */
  price?: (inTok: number, outTok: number) => number | null;
  /** Extra request fields (e.g. temperature 0 on my own endpoint). */
  extraBody?: Record<string, unknown>;
  /** Extra fields for the log's input summary (never a secret). */
  logInput?: Record<string, unknown>;
  adapter?: string | null;
}

/**
 * The one call path: crops → chat completion (strict json_schema) → schema check → holds. Every call is
 * logged; a timeout, an HTTP error or a bad answer comes back as an error card (output null), which
 * changes nothing for an optional reader and holds every line for a required one.
 */
export async function runGlimmerRead(c: GlimmerCall): Promise<ReaderResult> {
  const { e } = c;
  const base = { model: c.displayModel ?? c.model, provider: c.provider, mode: "LIVE_OPEN_WEIGHTS" as ModeLabel };
  const crops = glimmerCrops(e);
  if (!crops.length) return { ...base, output: null, latencyMs: 0, error: "no settled-item crops to read" };

  const t0 = Date.now();
  const logBase = { provider: c.provider, model: c.model, purpose: "label_read", mode: "live" as const, caseId: e.caseId, input: { crops: crops.map((k) => k.caption), ...(c.requestModel !== c.model ? { requestModel: c.requestModel } : {}), ...c.logInput } };
  try {
    const res = await c.client.chat.completions.create({ model: c.requestModel, messages: [{ role: "system", content: GLIMMER_SYSTEM }, { role: "user", content: glimmerUserContent(crops, e.slip.lines) }], response_format: GLIMMER_RESPONSE_FORMAT, max_tokens: 2048, ...c.extraBody });
    const { answer, reasoning, source, read } = parseGlimmerMessage(res.choices[0]?.message as Parameters<typeof splitReasoning>[0]);
    const usage = res.usage as (typeof res.usage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined;
    const inTok = usage?.prompt_tokens ?? null;
    const outTok = usage?.completion_tokens ?? null;
    const usd = c.price && inTok != null && outTok != null ? c.price(inTok, outTok) : null;
    // My Modal app adds gpu_seconds (wall clock on the GPU, measured in the app); it is a unit, not a price.
    const gs = (res as unknown as { gpu_seconds?: unknown }).gpu_seconds;
    const gpuSeconds = typeof gs === "number" && Number.isFinite(gs) && gs >= 0 ? gs : null;
    logLlmCall({ ...logBase, ok: Boolean(read), latencyMs: Date.now() - t0, inputTokens: inTok, outputTokens: outTok, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, reasoningSource: source, ...(gpuSeconds != null ? { units: { kind: "gpu_seconds", count: gpuSeconds } } : {}), costUsd: usd, costMicroCents: usdToMicroCents(usd), output: answer, reasoning, ...(read ? {} : { error: "label read didn't match the schema" }) });
    if (!read) return { ...base, output: null, latencyMs: Date.now() - t0, error: "label read didn't match the schema" };
    const extras: GlimmerExtras = {
      items: read.items.map((it) => ({ ...it, cropCaption: crops.find((k) => k.itemKey === it.itemKey)?.caption ?? null })),
      confidenceFloor: LABEL_CONFIDENCE_FLOOR,
      ...(c.adapter !== undefined ? { adapter: c.adapter } : {}),
      ...(gpuSeconds != null ? { gpuSeconds } : {}),
    };
    if (e.clipId) saveRecording(e.clipId, LABELS_KIND, { provider: c.provider, model: c.displayModel ?? c.model, read });
    // The images a reviewer's correction will be trained against (local archive; see corrections.ts).
    if (e.caseId) saveCrops(e.caseId, crops.map((k) => ({ itemKey: k.itemKey, caption: k.caption, dataUrl: k.dataUrl })));
    return { ...base, output: labelReadToReconciliation(read, e), latencyMs: Date.now() - t0, extras, ...(res.id ? { requestId: res.id } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLlmCall({ ...logBase, ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, output: "", error: msg });
    return { ...base, output: null, latencyMs: Date.now() - t0, error: msg };
  }
}

/** Replay a recorded live label read for this clip (public site). Labelled as a fixture, never as live. */
export async function recordedGlimmerLabelRead(e: ReaderEvidence, notRun = LABEL_READER_NO_RECORDING): Promise<ReaderResult> {
  const rec = e.clipId ? loadRecording<{ provider: string; model: string; read: unknown }>(e.clipId, LABELS_KIND) : null;
  const parsed = rec ? GlimmerOutput.safeParse(rec.data.read) : null;
  if (!rec || !parsed?.success) return { output: null, mode: "RECORDED_FIXTURE", model: "muse-glimmer", provider: rec?.data.provider ?? "none", latencyMs: 0, error: notRun };
  const keys = e.slip.lines.map((l) => l.itemKey);
  const captions = e.images.filter((i) => isCrop(i.caption));
  const extras: GlimmerExtras = { items: parsed.data.items.map((it) => ({ ...it, cropCaption: captions.find((k) => cropItemKey(k.caption, keys) === it.itemKey)?.caption ?? null })), confidenceFloor: LABEL_CONFIDENCE_FLOOR };
  return { output: labelReadToReconciliation(parsed.data, e), mode: "RECORDED_FIXTURE", recordedAt: rec.recordedAt, model: rec.data.model, provider: rec.data.provider, latencyMs: 0, extras };
}
