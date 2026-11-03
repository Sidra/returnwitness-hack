/**
 * OpenWeightAuditor: an independent second read of the settled tray crops on Meta's open weights
 * (Muse Spark Open), behind one provider switch:
 *   RETURNWITNESS_OPENWEIGHT_PROVIDER=baseten  → Baseten Model APIs, model meta-models/muse-spark-open-1026
 *   RETURNWITNESS_OPENWEIGHT_PROVIDER=modal    → an OpenAI-compatible endpoint on Modal (URL + token from env)
 *   unset / no credentials                     → off; the card says "[Open-weight audit · off on this server — runs on Baseten in local runs]"
 * It checks label legibility, visible damage, and "is this the slip's item or a stand-in", returns the
 * same reconciliation schema, and is merged as a NON-required reader: it can raise a hold, never clear
 * one, and it never blocks the pipeline.
 *
 * Baseten accepts `json_schema` for Muse Spark Open but does NOT enforce it (docs.baseten.co/inference/structured-outputs).
 * So the schema is written into the prompt, every reply is validated here with zod (and must name
 * the crop's own item), and an invalid reply gets ONE corrective retry. Each settled-item crop is its own request, sent
 * in parallel. A crop with no valid answer after the retry raises a HELD line (model_unavailable) for that item; if no
 * crop gets a valid answer the reader reports "not run". It never turns a failure into OK.
 */
import OpenAI from "openai";
import { z } from "zod";
import { ModelReconciliationOutput, type ModeLabel } from "@/lib/domain/schemas";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { logLlmCall } from "@/lib/obs/llm-log";
import { loadRecording, saveRecording } from "@/lib/meta/recordings";
import { assertNotContributor } from "@/lib/meta/config";
import { firstJsonObject, splitReasoning } from "./reasoning";

export const OPEN_WEIGHT_NOT_RUN = "[Open-weight audit · off on this server — runs on Baseten in local runs]";

export const AuditItem = z.object({
  itemKey: z.string(),
  labelLegible: z.boolean(),
  visibleDamage: z.boolean(),
  standInSuspected: z.boolean(),
  note: z.string(),
});
export const AuditOutput = z.object({ items: z.array(AuditItem) });
export type AuditOutput = z.infer<typeof AuditOutput>;

export interface OpenWeightConfig {
  provider: "baseten" | "modal" | null;
  baseURL: string | null;
  apiKey: string | null;
  model: string;
  reason: string;
}

export function openWeightConfig(env: NodeJS.ProcessEnv = process.env): OpenWeightConfig {
  const p = (env.RETURNWITNESS_OPENWEIGHT_PROVIDER ?? "").trim().toLowerCase();
  if (p === "baseten") {
    const key = env.BASETEN_API_KEY?.trim() || null;
    return { provider: key ? "baseten" : null, baseURL: env.BASETEN_BASE_URL?.trim() || "https://inference.baseten.co/v1", apiKey: key, model: env.BASETEN_OPENWEIGHT_MODEL?.trim() || "meta-models/muse-spark-open-1026", reason: key ? "" : "BASETEN_API_KEY not set" };
  }
  if (p === "modal") {
    const url = env.MODAL_OPENWEIGHT_URL?.trim() || null;
    const key = env.MODAL_OPENWEIGHT_TOKEN?.trim() || null;
    return { provider: url && key ? "modal" : null, baseURL: url, apiKey: key, model: env.MODAL_OPENWEIGHT_MODEL?.trim() || "muse-spark-open", reason: url && key ? "" : "MODAL_OPENWEIGHT_URL / MODAL_OPENWEIGHT_TOKEN not set" };
  }
  return { provider: null, baseURL: null, apiKey: null, model: "meta-models/muse-spark-open-1026", reason: "no open-weight provider set on this server (RETURNWITNESS_OPENWEIGHT_PROVIDER); it runs on Baseten in local runs" };
}

// The answer is described by field and shown as a filled example, not as a raw JSON Schema: on the first real clip
// (smoke test g1) Muse Spark Open replied with the schema object itself, twice.
const ITEM_EXAMPLE = JSON.stringify({ itemKey: "lens", labelLegible: true, visibleDamage: false, standInSuspected: false, note: "label reads clearly, no damage" });

export const SYSTEM = `You audit one returned item at an inspection bench, independently of any other system.
You get one crop of an item that settled in the inspected tray. Answer: is its serial/label legible, is there visible
damage, and does it look like a stand-in rather than the item on the packing slip (wrong shape, wrong colour, a
look-alike)? Be conservative: only flag what you can see.
Reply with ONE JSON object and nothing else, with exactly these five keys:
  "itemKey": string, the item key you are given
  "labelLegible": true or false
  "visibleDamage": true or false
  "standInSuspected": true or false
  "note": string, one short sentence on what you saw
Example of the shape (your values come from the crop): ${ITEM_EXAMPLE}
Do not return a schema, a description of the fields, or any text outside the object.`;

/** The item key a crop caption names ("crop of the counted <itemKey> …"). Null when the caption isn't a crop. */
export function cropItemKey(caption: string): string | null {
  return /^crop of the counted (\S+)/.exec(caption)?.[1] ?? null;
}

type AuditItemT = z.infer<typeof AuditItem>;

/** Validate one reply against the item schema AND the crop it was asked about. */
export function parseAuditReply(answer: string, itemKey: string): { ok: true; item: AuditItemT } | { ok: false; problem: string } {
  const json = firstJsonObject(answer);
  if (json == null) return { ok: false, problem: "no JSON object in the reply" };
  if (typeof json === "object" && json && ("$schema" in json || "properties" in json)) return { ok: false, problem: "the reply is a JSON Schema, not an answer" };
  const parsed = AuditItem.strict().safeParse(json);
  if (!parsed.success) return { ok: false, problem: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  if (parsed.data.itemKey !== itemKey) return { ok: false, problem: `itemKey is "${parsed.data.itemKey}", expected "${itemKey}"` };
  return { ok: true, item: parsed.data };
}

/** Turn the audit into the shared reconciliation schema: flags become HELD lines with reasons; nothing becomes OK that wasn't. */
export function auditToReconciliation(audit: AuditOutput, e: ReaderEvidence, unanswered: string[] = []): ModelReconciliationOutput {
  return {
    lines: e.slip.lines.map((l) => {
      const observed = e.count.counts[l.itemKey] ?? 0;
      const a = audit.items.find((x) => x.itemKey === l.itemKey);
      const reasons: ModelReconciliationOutput["lines"][number]["reasons"] = [];
      if (a?.standInSuspected) reasons.push({ code: "stand_in_suspected", detail: `open-weight audit: ${a.note || "may be a stand-in for the slip's item"}` });
      if (a?.visibleDamage) reasons.push({ code: "visible_damage", detail: `open-weight audit: ${a.note || "visible damage"}` });
      if (a && l.requiresSerial && !a.labelLegible) reasons.push({ code: "label_unreadable", detail: "open-weight audit: label not legible in the crop" });
      if (!a && unanswered.includes(l.itemKey)) reasons.push({ code: "model_unavailable", detail: "open-weight audit: no valid answer for this crop after one retry" });
      // Same counts as the counter; status says only what the audit can raise.
      const status = observed < l.qty ? "MISSING" : reasons.length ? "HELD" : "OK";
      return { itemKey: l.itemKey, observedQty: observed, status, reasons, serialRead: null };
    }),
    notes: "open-weight audit of the settled tray crops",
  };
}

type AuditClient = Pick<OpenAI, "chat">;
type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface CropAudit {
  itemKey: string;
  item: AuditItemT | null;
  attempts: number;
  latencyMs: number;
  problem?: string;
}

/** One crop: a request, validation, and at most one corrective retry. Every attempt is logged. */
async function auditCrop(client: AuditClient, cfg: OpenWeightConfig, e: ReaderEvidence, crop: { caption: string; dataUrl: string }, itemKey: string): Promise<CropAudit> {
  const line = e.slip.lines.find((l) => l.itemKey === itemKey);
  const messages: Msg[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: `Item key: ${itemKey}. Packing slip line: ${JSON.stringify(line ? { description: line.description, serialRequired: line.requiresSerial } : { description: "not on the slip" })}. ${crop.caption}` },
        { type: "image_url", image_url: { url: crop.dataUrl } },
      ],
    },
  ];
  const t0 = Date.now();
  let problem = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ta = Date.now();
    try {
      // Room for the reasoning pass, which counts against max_tokens before the answer starts.
      const res = await client.chat.completions.create({ model: cfg.model, messages, response_format: { type: "json_object" }, max_tokens: 2048 });
      const msg = res.choices[0]?.message as Parameters<typeof splitReasoning>[0];
      const { answer, reasoning, source } = splitReasoning(msg);
      const r = parseAuditReply(answer, itemKey);
      const usage = res.usage as (typeof res.usage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined;
      logLlmCall({ provider: cfg.provider!, model: cfg.model, purpose: "open_weight_audit", mode: "live", ok: r.ok, latencyMs: Date.now() - ta, inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, reasoningSource: source, costUsd: null, costMicroCents: null, caseId: e.caseId, input: { crop: crop.caption, attempt }, output: answer, reasoning, ...(r.ok ? {} : { error: r.problem }) });
      if (r.ok) return { itemKey, item: r.item, attempts: attempt, latencyMs: Date.now() - t0 };
      problem = r.problem;
      messages.push({ role: "assistant", content: answer }, { role: "user", content: `That reply was not a valid answer (${r.problem}). Reply again with only the answer object for item key ${itemKey}, with your own values, like: ${ITEM_EXAMPLE}` });
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
      logLlmCall({ provider: cfg.provider!, model: cfg.model, purpose: "open_weight_audit", mode: "live", ok: false, latencyMs: Date.now() - ta, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: e.caseId, input: { crop: crop.caption, attempt }, output: "", error: problem });
    }
  }
  return { itemKey, item: null, attempts: 2, latencyMs: Date.now() - t0, problem };
}

export async function openWeightAudit(e: ReaderEvidence, cfg: OpenWeightConfig = openWeightConfig(), opts: { client?: AuditClient } = {}): Promise<ReaderResult> {
  const base = { model: cfg.model, provider: cfg.provider ?? "none", mode: "LIVE_OPEN_WEIGHTS" as ModeLabel };
  const crops = e.images.map((c) => ({ c, key: cropItemKey(c.caption) })).filter((x): x is { c: (typeof e.images)[number]; key: string } => x.key != null);
  if (!cfg.provider || !cfg.baseURL || !cfg.apiKey) return { ...base, output: null, latencyMs: 0, error: `${OPEN_WEIGHT_NOT_RUN}: ${cfg.reason}` };
  try {
    assertNotContributor(cfg.model);
  } catch (err) {
    return { ...base, output: null, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!crops.length) return { ...base, output: null, latencyMs: 0, error: "no settled-item crops to audit" };
  // No transport retry: the one bounded retry is the corrective one in auditCrop (at most 2 calls per crop).
  const client = opts.client ?? new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 45_000, maxRetries: 0 });
  const t0 = Date.now();
  const perCrop = await Promise.all(crops.map(({ c, key }) => auditCrop(client, cfg, e, c, key)));
  const latencyMs = Date.now() - t0;
  const answered = perCrop.filter((x) => x.item);
  const unanswered = perCrop.filter((x) => !x.item).map((x) => x.itemKey);
  const timing = { wallMs: latencyMs, perCrop: perCrop.map((x) => ({ itemKey: x.itemKey, ms: x.latencyMs, attempts: x.attempts, ok: !!x.item })) };
  if (!answered.length) return { ...base, output: null, latencyMs, error: `no valid open-weight answer for any crop after one retry each (${perCrop[0]?.problem ?? "unknown"})`, extras: { timing } };
  const audit: AuditOutput = { items: answered.map((x) => x.item!) };
  if (e.clipId) saveRecording(e.clipId, "audit", { provider: cfg.provider, model: cfg.model, audit, unanswered });
  return { ...base, output: auditToReconciliation(audit, e, unanswered), latencyMs, extras: { ...audit, unanswered, timing } };
}

/** Replay a recorded open-weight audit for this clip (public site). */
export async function recordedOpenWeightAudit(e: ReaderEvidence): Promise<ReaderResult> {
  const rec = e.clipId ? loadRecording<{ provider: string; model: string; audit: unknown; unanswered?: string[] }>(e.clipId, "audit") : null;
  const parsed = rec ? AuditOutput.safeParse(rec.data.audit) : null;
  if (!rec || !parsed?.success) return { output: null, mode: "RECORDED_FIXTURE", model: "meta-models/muse-spark-open-1026", latencyMs: 0, error: `${OPEN_WEIGHT_NOT_RUN}: no recorded audit for this clip` };
  return { output: auditToReconciliation(parsed.data, e, rec.data.unanswered ?? []), mode: "RECORDED_FIXTURE", recordedAt: rec.recordedAt, model: rec.data.model, provider: rec.data.provider, latencyMs: 0, extras: parsed.data };
}

export { ModelReconciliationOutput };
