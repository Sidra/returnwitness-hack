/**
 * Model readers and drafters on the Meta Model API (OpenAI-SDK compatible).
 *   - Muse Spark 1.3 reconciles: key frames + counter JSON + label crops + packing slip + policy, one call.
 *   (Muse Wonder 1.0 runs as a two-tool agent: lib/meta/wonder-agent.ts.)
 * Both return JSON validated with zod; anything invalid is treated as "no answer", which the
 * cross-check turns into a HOLD (reader) or the template draft (drafter). Every call is logged.
 */
import OpenAI from "openai";
import { z } from "zod";
import { metaResponseFormat, parseMetaReply } from "@/lib/meta/json-schema";
import {
  DecisionDraft,
  ModelReconciliationOutput,
  type CountResult,
  type ModeLabel,
  type PackingSlip,
  type Policy,
  type Reconciliation,
  type Rma,
} from "@/lib/domain/schemas";
import { cachedTokensOf, logLlmCall, promptCacheKey, tokenCostUsd, usdToMicroCents } from "@/lib/obs/llm-log";
import { policyText } from "@/data/fixtures";
import { assertNotContributor, metaConfig, type MetaConfig } from "./config";
import { loadRecording, saveRecording } from "./recordings";

export interface ReaderEvidence {
  rma: Rma;
  slip: PackingSlip;
  policy: Policy;
  count: CountResult;
  /** JPEG data URLs: a few key frames of the clip + one crop per counted item. */
  images: Array<{ caption: string; dataUrl: string }>;
  /** Meta file ID of the uploaded clip, when the API accepts video by reference. */
  clipFileId?: string;
  caseId?: string;
  clipId?: string;
  /** The returns lead's transcribed voice note (Muse Voice Transcribe), if one was recorded. */
  voiceNote?: string;
}

export interface ReaderResult {
  output: ModelReconciliationOutput | null;
  mode: ModeLabel;
  model: string;
  latencyMs: number;
  requestId?: string;
  error?: string;
  /** Reader-specific detail shown on its card (e.g. the open-weight audit's per-item checks). */
  extras?: unknown;
  provider?: string;
  /** Set when this is a replay of a real recorded call (the badge then reads RECORDED LIVE RUN). */
  recordedAt?: string;
}

const RECONCILE_SYSTEM = `You check returned e-commerce kits at an inspection bench.
You get: the packing slip (what should be in the box), the store's return policy, the output of a
deterministic tray counter (items counted when they settled in the inspected tray, plus any flags),
key frames from the overhead camera and a crop of each counted item.
For EVERY packing-slip line return observedQty, a status and reasons:
- OK only if you can see that many of the item settled in the tray and any required serial label matches.
- MISSING if fewer were observed. HELD if you cannot tell (merged items, unreadable label, unclear view).
- EXTRA if more were observed than expected.
Read any serial label you can see into serialRead exactly as printed, or null.
Never invent an item you cannot see. You do not decide refunds.`;


/**
 * The stable prefix first (prompt caching matches from the start): instructions, then the merchant's policy, which is
 * the same for every return under that policy version. The return's own evidence goes in the user turn after it.
 */
export function reconcileSystem(policy: ReaderEvidence["policy"]): string {
  return `${RECONCILE_SYSTEM}\n\nRETURN POLICY (${policy.id}, version ${policy.version}):\n${policyText(policy)}`;
}

export function evidenceText(e: ReaderEvidence) {
  return [
    `RMA ${e.rma.id} for order ${e.rma.orderId}. Customer says: "${e.rma.reason}". Requested refund: ${e.rma.requestedRefundCents} cents.`,
    `PACKING SLIP:\n${JSON.stringify(e.slip.lines.map((l) => ({ itemKey: l.itemKey, sku: l.sku, description: l.description, qty: l.qty, serial: l.serial ?? null })), null, 1)}`,
    `TRAY COUNTER (deterministic app code):\n${JSON.stringify({ counts: e.count.counts, arrivals: e.count.arrivals.map((a) => ({ itemKey: a.itemKey, t: a.t, label: a.label ?? null })), flags: e.count.flags.map((f) => ({ code: f.code, itemKeys: f.itemKeys, t: f.t, detail: f.detail })) }, null, 1)}`,
    ...(e.voiceNote ? [`RETURNS LEAD'S VOICE NOTE (transcribed by Muse Voice Transcribe; a spoken claim may justify HELD, never OK on its own):\n"${e.voiceNote}"`] : []),
  ].join("\n\n");
}


/** One strict-schema Meta chat call with images: contributor guard, logged with cost and request id. */
export async function metaJson<T>(args: {
  cfg: MetaConfig;
  model: string;
  purpose: string;
  system: string;
  userText: string;
  images: ReaderEvidence["images"];
  schemaName: string;
  schema: z.ZodType<T>;
  caseId?: string;
  /** Stable name of the shared prompt prefix (prompt_cache_key). */
  cacheKey?: string;
}): Promise<{ value: T | null; latencyMs: number; error?: string; requestId?: string }> {
  const client = new OpenAI({ apiKey: args.cfg.apiKey!, baseURL: args.cfg.baseURL, timeout: 60_000, maxRetries: 1 });
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: args.userText }];
  for (const im of args.images) {
    content.push({ type: "text", text: im.caption });
    content.push({ type: "image_url", image_url: { url: im.dataUrl } });
  }
  const t0 = Date.now();
  try {
    assertNotContributor(args.model);
    const res = await client.chat.completions.create({
      model: args.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content },
      ],
      response_format: metaResponseFormat(args.schemaName, args.schema),
      ...(args.cacheKey ? { prompt_cache_key: args.cacheKey } : {}),
    });
    const text = res.choices[0]?.message?.content ?? "";
    const parsed = parseMetaReply(args.schema, JSON.parse(text));
    const cached = cachedTokensOf(res.usage);
    const usd = tokenCostUsd(args.model, res.usage?.prompt_tokens ?? null, res.usage?.completion_tokens ?? null, cached);
    const requestId = typeof res.id === "string" ? res.id : undefined;
    logLlmCall({ provider: "meta", model: args.model, purpose: args.purpose, mode: "live", ok: parsed.success, latencyMs: Date.now() - t0, inputTokens: res.usage?.prompt_tokens ?? null, outputTokens: res.usage?.completion_tokens ?? null, cachedTokens: cached, costUsd: usd, costMicroCents: usdToMicroCents(usd), caseId: args.caseId, input: { system: args.system, user: args.userText, images: args.images.map((i) => i.caption) }, output: { requestId: requestId ?? null, text }, ...(parsed.success ? {} : { error: parsed.error.message }) });
    return parsed.success ? { value: parsed.data, latencyMs: Date.now() - t0, requestId } : { value: null, latencyMs: Date.now() - t0, error: "schema validation failed", requestId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLlmCall({ provider: "meta", model: args.model, purpose: args.purpose, mode: "live", ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: args.caseId, input: args.userText, output: "", error: msg });
    return { value: null, latencyMs: Date.now() - t0, error: msg };
  }
}

/** Muse Spark 1.3 reconciliation reader. */
export async function sparkReconcile(e: ReaderEvidence, cfg: MetaConfig = metaConfig()): Promise<ReaderResult> {
  if (!cfg.apiKey || cfg.publicDemo) return { output: null, mode: "RECORDED_FIXTURE", model: cfg.models.spark, latencyMs: 0, error: "no live Meta key in this profile" };
  const r = await metaJson({ cfg, model: cfg.models.spark, purpose: "reconcile", system: reconcileSystem(e.policy), cacheKey: promptCacheKey("reconcile", `${e.policy.id}@${e.policy.version}`), userText: evidenceText(e), images: e.images, schemaName: "reconciliation", schema: ModelReconciliationOutput, caseId: e.caseId });
  if (r.value && e.clipId) saveRecording(e.clipId, "spark", r.value, { model: cfg.models.spark, ...(r.requestId ? { requestId: r.requestId } : {}) });
  return { output: r.value, mode: "LIVE_META", model: cfg.models.spark, latencyMs: r.latencyMs, error: r.error, ...(r.requestId ? { requestId: r.requestId } : {}) };
}

/** Replay a recorded live Spark answer for this clip (public site, no key). */
export async function recordedSparkReconcile(e: ReaderEvidence, cfg: MetaConfig = metaConfig()): Promise<ReaderResult> {
  const rec = e.clipId ? loadRecording<unknown>(e.clipId, "spark") : null;
  const parsed = rec ? ModelReconciliationOutput.safeParse(rec.data) : null;
  return {
    output: parsed?.success ? parsed.data : null,
    mode: "RECORDED_FIXTURE",
    model: rec?.meta?.model ?? cfg.models.spark,
    latencyMs: 0,
    ...(parsed?.success ? { recordedAt: rec!.recordedAt, ...(rec!.meta?.requestId ? { requestId: rec!.meta.requestId } : {}) } : { error: "no recorded answer" }),
  };
}

