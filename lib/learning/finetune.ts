/**
 * Reviewer corrections → a supervised fine-tune of the label reader on Fireworks. The same rows (plus
 * each row's truth/expected meta) also feed the QLoRA run on my own Modal GPU: lib/learning/glimmer-eval.ts.
 *   buildDataset(cases)  one chat-format row per corrected item: the crop the reader saw, the same
 *                        prompt it gets at inference, and the PERSON's value as the answer.
 *   quoteFineTune(rows)  training tokens × the price per 1M tokens set from Fireworks' pricing page
 *                        on the day (FIREWORKS_SFT_USD_PER_MTOK). No price → no quote → no submit.
 *   submitFineTune(...)  dataset create → upload → SFT job, only with confirmSpend AND a priced quote.
 *
 * What the dataset can contain: ReturnCase does not persist crop images, so a row's image comes from
 * the local crop archive the label reader writes per case (corrections.ts `saveCrops`). A correction
 * whose case has no archived crop (replayed fixtures, serverless runs, cases from before the reader)
 * is dropped and counted as `droppedNoImage`, never sent without its image.
 *
 * The Fireworks control-plane calls below follow Fireworks' REST docs as best known; each URL/body
 * lives in ONE builder so it can be checked against the docs on key day (see VERIFY notes).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type OpenAI from "openai";
import type { ReturnCase } from "@/lib/domain/case";
import type { PackingSlipLine } from "@/lib/domain/schemas";
import { orderFor } from "@/data/fixtures";
import { logLlmCall } from "@/lib/obs/llm-log";
import { GLIMMER_SYSTEM, glimmerUserContent, type FireworksConfig, type GlimmerExtras, type GlimmerItem } from "@/lib/openweights/fireworks";
import { loadCrops, UNREADABLE, type ArchivedCrop, type ReviewerCorrection } from "./corrections";

/**
 * Estimated tokens per crop image. Vision tokenizers bill a ~1024 px image at roughly 1-2k tokens
 * depending on the model's tiling; 1,600 is a deliberately high-side estimate so the quote errs
 * toward over- rather than under-stating spend. Replace with Fireworks' own count once a dataset
 * has been validated on their side.
 */
export const IMAGE_TOKEN_ESTIMATE = 1600;
/** Text tokens ≈ characters / 4 (a standard rough rule for English + JSON). */
export const CHARS_PER_TOKEN = 4;

export interface DatasetRow {
  messages: [
    { role: "system"; content: string },
    { role: "user"; content: OpenAI.Chat.Completions.ChatCompletionContentPart[] },
    { role: "assistant"; content: string; reasoning_content?: string },
  ];
}

/**
 * What the held-out evaluation needs to judge a read, kept BESIDE the row (never in the prompt):
 * the person's values (truth) and the packing slip's (expected), so a read that would let a
 * stand-in pass can be counted. rows[i] ↔ meta[i].
 */
export interface DatasetRowMeta {
  rowId: string;
  caseId: string;
  itemKey: string;
  truth: { serial: string | null; sku: string | null; serialUnreadable: boolean };
  expected: { serial: string | null; sku: string | null; requiresSerial: boolean };
  /**
   * Where the row's truth comes from. "correction": a person corrected a live read (this file).
   * "sheet" / "render" / "bench": the bench label set, truth from the printed label design
   * (lib/learning/label-set.ts). Absent on rows written before the label set existed = "correction".
   */
  source?: RowSource;
  /** The physical or rendered label: its serial (canonical BW-XX-#####), or charger-<n> / correction:<case>:<item>. The split groups on it. */
  labelId?: string;
  /** The seeded augmentation the image went through (label set only); null = none. */
  augment?: Record<string, unknown> | null;
  /** The slip's serial was deliberately set to a near-miss of the printed one (a stand-in); a read equal to the slip is then a false clear. */
  standIn?: boolean;
  /** Image file under .data/label-set/ (label set only). */
  image?: string;
}

export type RowSource = "correction" | "sheet" | "render" | "bench";
export const ROW_SOURCES: RowSource[] = ["correction", "sheet", "render", "bench"];

/** Canonical serial for grouping: uppercase, punctuation-insensitive, re-hyphenated when it has the BW-XX-##### shape. */
export function canonicalSerial(s: string): string {
  const c = s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const m = /^BW(CB|LN)(\d{5})$/.exec(c);
  return m ? `BW-${m[1]}-${m[2]}` : c;
}

/** One supervised row: the live reader's system prompt + user turn (one crop) + the truth as the answer. Shared by corrections and the label set. */
export function datasetRow(crop: { caption: string; dataUrl: string; itemKey: string }, lines: PackingSlipLine[], answer: { serialRead: string | null; skuRead: string | null; legible: boolean; confidence: number }): DatasetRow {
  const content = JSON.stringify({ items: [{ itemKey: crop.itemKey, ...answer }] });
  return { messages: [{ role: "system", content: GLIMMER_SYSTEM }, { role: "user", content: glimmerUserContent([crop], lines) }, { role: "assistant", content }] };
}

export interface DatasetReport {
  cases: number;
  corrections: number;
  labelCorrections: number;
  /** present/damage corrections train other readers, not the label reader. */
  skippedNonLabel: number;
  /** Corrected items with no archived crop: the row would have no image, so it is not built. */
  droppedNoImage: number;
  duplicates: number;
  rows: number;
}

const isLabelReader = (reader: string) => /glimmer/i.test(reader);

/** The packing-slip lines for a case: the merchant order when known, else what the reconciliation kept. */
function slipLines(c: ReturnCase): PackingSlipLine[] {
  const slip = orderFor(c.orderId)?.slip.lines;
  if (slip) return slip;
  return (c.reconciliation?.lines ?? []).map((l) => ({ itemKey: l.itemKey, sku: l.sku, description: l.description, qty: Math.max(1, l.expectedQty), unitPriceCents: l.unitPriceCents, requiresSerial: false }));
}

/** The label reader's own per-item read on this case, if it ran (its card extras). */
function modelReads(c: ReturnCase): GlimmerExtras["items"] {
  const run = c.readerRuns?.find((r) => isLabelReader(r.reader) && r.extras);
  const items = (run?.extras as Partial<GlimmerExtras> | undefined)?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * One row per (case, item) that a person corrected on the label reader. The latest correction of
 * each field wins; a field the person did not correct carries the model's read, which they saw on
 * the card and left standing.
 */
export function buildDataset(cases: ReturnCase[], opts: { loadCrops?: (caseId: string) => ArchivedCrop[] } = {}): { rows: DatasetRow[]; meta: DatasetRowMeta[]; report: DatasetReport } {
  const load = opts.loadCrops ?? loadCrops;
  const report: DatasetReport = { cases: cases.length, corrections: 0, labelCorrections: 0, skippedNonLabel: 0, droppedNoImage: 0, duplicates: 0, rows: 0 };
  const rows: DatasetRow[] = [];
  const meta: DatasetRowMeta[] = [];
  const seen = new Set<string>();

  for (const c of cases) {
    const all = c.corrections ?? [];
    report.corrections += all.length;
    const label = all.filter((x) => (x.field === "serial" || x.field === "sku") && isLabelReader(x.reader));
    report.skippedNonLabel += all.length - label.length;
    report.labelCorrections += label.length;
    if (!label.length) continue;

    const byItem = new Map<string, ReviewerCorrection[]>();
    for (const x of [...label].sort((a, b) => a.at.localeCompare(b.at))) byItem.set(x.itemKey, [...(byItem.get(x.itemKey) ?? []), x]);
    const crops = load(c.id);
    const reads = modelReads(c);
    const lines = slipLines(c);

    for (const [itemKey, xs] of byItem) {
      const latest = (f: "serial" | "sku") => [...xs].reverse().find((x) => x.field === f);
      const serialFix = latest("serial");
      const skuFix = latest("sku");
      const wanted = serialFix?.cropCaption ?? skuFix?.cropCaption ?? null;
      const crop = crops.find((k) => wanted && k.caption === wanted) ?? crops.find((k) => k.itemKey === itemKey);
      if (!crop) {
        report.droppedNoImage++;
        continue;
      }
      const model: Partial<GlimmerItem> = reads.find((r) => r.itemKey === itemKey) ?? {};
      const unreadable = serialFix?.humanValue.trim().toLowerCase() === UNREADABLE;
      const serialRead = serialFix ? (unreadable ? null : serialFix.humanValue.trim()) : (model.serialRead ?? null);
      const skuRead = skuFix ? (skuFix.humanValue.trim().toLowerCase() === UNREADABLE ? null : skuFix.humanValue.trim()) : (model.skuRead ?? null);
      const answer = JSON.stringify({ items: [{ itemKey, serialRead, skuRead, legible: !unreadable, confidence: unreadable ? 0 : 1 }] });
      const key = createHash("sha256").update(crop.dataUrl).update("\0").update(answer).digest("hex");
      if (seen.has(key)) {
        report.duplicates++;
        continue;
      }
      seen.add(key);
      rows.push(datasetRow({ caption: crop.caption, dataUrl: crop.dataUrl, itemKey }, lines, { serialRead, skuRead, legible: !unreadable, confidence: unreadable ? 0 : 1 }));
      const slip = lines.find((l) => l.itemKey === itemKey);
      meta.push({
        rowId: key.slice(0, 16),
        caseId: c.id,
        itemKey,
        truth: { serial: serialRead, sku: skuRead, serialUnreadable: unreadable },
        expected: { serial: slip?.serial ?? null, sku: slip?.sku ?? null, requiresSerial: Boolean(slip?.requiresSerial) },
        source: "correction",
        // A corrected serial groups with every other row of the same physical label (the bench label set uses the same id).
        labelId: serialRead ? canonicalSerial(serialRead) : `correction:${c.id}:${itemKey}`,
      });
    }
  }
  report.rows = rows.length;
  return { rows, meta, report };
}

export const toJsonl = (rows: DatasetRow[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

export function writeDataset(rows: DatasetRow[], file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toJsonl(rows));
  return file;
}

/* ---------- Quote ---------- */

export function rowTokens(r: DatasetRow): number {
  let chars = 0;
  let images = 0;
  for (const m of r.messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const p of m.content) {
        if (p.type === "text") chars += p.text.length;
        else if (p.type === "image_url") images++;
      }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE;
}

export interface FineTuneQuote {
  rows: number;
  datasetTokens: number;
  /** datasetTokens × epochs: what Fireworks bills SFT on. */
  trainingTokens: number;
  epochs: number;
  usdPerMTok: number | null;
  estUsd: number | null;
  basis: string;
}

/** The SFT price per 1M training tokens, ONLY from env (read off Fireworks' pricing page on the day). */
export function sftPriceFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = env.FIREWORKS_SFT_USD_PER_MTOK?.trim();
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
}

export function quoteFineTune(rows: DatasetRow[], opts: { epochs: number; usdPerMTok: number | null }): FineTuneQuote {
  if (!Number.isInteger(opts.epochs) || opts.epochs < 1) throw new Error("epochs must be a positive whole number");
  const datasetTokens = rows.reduce((s, r) => s + rowTokens(r), 0);
  const trainingTokens = datasetTokens * opts.epochs;
  const how = `${rows.length} rows ≈ ${datasetTokens.toLocaleString("en-US")} tokens (text chars/${CHARS_PER_TOKEN} + ${IMAGE_TOKEN_ESTIMATE} per image, an estimate) × ${opts.epochs} epoch(s)`;
  if (opts.usdPerMTok == null) return { rows: rows.length, datasetTokens, trainingTokens, epochs: opts.epochs, usdPerMTok: null, estUsd: null, basis: `${how}; price not set (FIREWORKS_SFT_USD_PER_MTOK from Fireworks' pricing page)` };
  const estUsd = Math.round((trainingTokens / 1_000_000) * opts.usdPerMTok * 100) / 100;
  return { rows: rows.length, datasetTokens, trainingTokens, epochs: opts.epochs, usdPerMTok: opts.usdPerMTok, estUsd, basis: `${how} @ $${opts.usdPerMTok}/1M training tokens` };
}

/* ---------- Fireworks control plane (VERIFY each builder against Fireworks' docs on key day) ---------- */

export const FIREWORKS_API = "https://api.fireworks.ai/v1";

export interface FwRequest {
  method: "GET" | "POST";
  url: string;
  json?: unknown;
  form?: FormData;
}

const acct = (accountId: string) => `${FIREWORKS_API}/accounts/${encodeURIComponent(accountId)}`;

/** VERIFY: POST /v1/accounts/{account}/datasets with { datasetId, dataset: { userUploaded: {}, exampleCount } }. */
export function datasetCreateRequest(accountId: string, datasetId: string, exampleCount: number): FwRequest {
  return { method: "POST", url: `${acct(accountId)}/datasets`, json: { datasetId, dataset: { displayName: datasetId, exampleCount: String(exampleCount), userUploaded: {} } } };
}

/** VERIFY: POST /v1/accounts/{account}/datasets/{id}:upload, multipart field "file" (large files may need the signed-URL upload instead). */
export function datasetUploadRequest(accountId: string, datasetId: string, jsonl: string): FwRequest {
  const form = new FormData();
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${datasetId}.jsonl`);
  return { method: "POST", url: `${acct(accountId)}/datasets/${encodeURIComponent(datasetId)}:upload`, form };
}

/** VERIFY: POST /v1/accounts/{account}/supervisedFineTuningJobs with dataset/baseModel/epochs/outputModel resource names. */
export function sftJobRequest(accountId: string, o: { datasetId: string; baseModel: string; epochs: number; outputModelId: string; displayName: string }): FwRequest {
  return {
    method: "POST",
    url: `${acct(accountId)}/supervisedFineTuningJobs`,
    json: { displayName: o.displayName, dataset: `accounts/${accountId}/datasets/${o.datasetId}`, baseModel: o.baseModel, epochs: o.epochs, outputModel: `accounts/${accountId}/models/${o.outputModelId}` },
  };
}

/** VERIFY: GET /v1/accounts/{account}/supervisedFineTuningJobs/{jobId}; `name` comes back as accounts/{a}/supervisedFineTuningJobs/{id}. */
export function sftJobStatusRequest(accountId: string, jobIdOrName: string): FwRequest {
  const id = jobIdOrName.split("/").pop()!;
  return { method: "GET", url: `${acct(accountId)}/supervisedFineTuningJobs/${encodeURIComponent(id)}` };
}

/** Terminal states as Fireworks names them (VERIFY the exact enum). */
export const TERMINAL_JOB_STATES = new Set(["JOB_STATE_COMPLETED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);

export async function fwCall<T = Record<string, unknown>>(req: FwRequest, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  if (req.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetchImpl(req.url, { method: req.method, headers, body: req.form ?? (req.json !== undefined ? JSON.stringify(req.json) : undefined), signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Fireworks ${req.method} ${new URL(req.url).pathname} → ${res.status}: ${raw.slice(0, 300)}`);
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new Error(`Fireworks ${req.method} ${new URL(req.url).pathname} returned non-JSON`);
  }
}

export async function pollSftJob(
  cfg: { accountId: string; apiKey: string },
  jobName: string,
  o: { fetch?: typeof fetch; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; onState?: (s: string) => void } = {},
): Promise<{ state: string; job: Record<string, unknown> }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 6 * 3600_000);
  for (;;) {
    const job = await fwCall(sftJobStatusRequest(cfg.accountId, jobName), cfg.apiKey, o.fetch);
    const state = String(job.state ?? "JOB_STATE_UNSPECIFIED");
    o.onState?.(state);
    if (TERMINAL_JOB_STATES.has(state)) return { state, job };
    if (Date.now() > deadline) return { state, job };
    await sleep(o.intervalMs ?? 30_000);
  }
}

/* ---------- Submit (spend) ---------- */

export class SpendRefused extends Error {}

export interface SubmitInput {
  rows: DatasetRow[];
  quote: FineTuneQuote;
  confirmSpend: boolean;
  cfg: Pick<FireworksConfig, "apiKey" | "accountId" | "model">;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Called with the spend line BEFORE the first billable call (the script prints it). */
  announce?: (line: string) => void;
}

/** Every gate is checked before any request: confirmation, a priced quote, credentials, rows. */
export function assertCanSubmit(i: Pick<SubmitInput, "rows" | "quote" | "confirmSpend" | "cfg">): void {
  if (!i.confirmSpend) throw new SpendRefused("refusing to submit: --confirm-spend not given (a fine-tune job is spend)");
  if (i.quote.estUsd == null) throw new SpendRefused(`refusing to submit: no price for the quote (${i.quote.basis})`);
  if (!i.rows.length) throw new SpendRefused("refusing to submit: the dataset is empty");
  if (!i.cfg.apiKey) throw new SpendRefused("refusing to submit: FIREWORKS_API_KEY not set");
  if (!i.cfg.accountId) throw new SpendRefused("refusing to submit: FIREWORKS_ACCOUNT_ID not set");
  if (!i.cfg.model) throw new SpendRefused("refusing to submit: FIREWORKS_GLIMMER_MODEL (the base model) not set");
}

export async function submitFineTune(i: SubmitInput): Promise<{ datasetId: string; jobName: string; outputModelId: string }> {
  assertCanSubmit(i);
  const { apiKey, accountId, model } = i.cfg as { apiKey: string; accountId: string; model: string };
  const now = i.now?.() ?? new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[^0-9]/g, "").slice(0, 12);
  const jsonl = toJsonl(i.rows);
  const short = createHash("sha256").update(jsonl).digest("hex").slice(0, 8);
  const datasetId = `rw-labels-${stamp}-${short}`;
  const outputModelId = `rw-glimmer-labels-${stamp}`;
  i.announce?.(`About to spend ≈ $${i.quote.estUsd!.toFixed(2)} on Fireworks SFT: ${i.quote.basis}. Base model ${model}, dataset ${datasetId}.`);
  const t0 = Date.now();
  const log = (ok: boolean, output: unknown, error?: string) =>
    logLlmCall({ provider: "fireworks", model, purpose: "finetune_submit", mode: "live", ok, latencyMs: Date.now() - t0, inputTokens: i.quote.trainingTokens, outputTokens: null, costUsd: null, costMicroCents: null, input: { datasetId, rows: i.rows.length, estimate: { usd: i.quote.estUsd, basis: i.quote.basis } }, output, ...(error ? { error } : {}) });
  try {
    await fwCall(datasetCreateRequest(accountId, datasetId, i.rows.length), apiKey, i.fetch);
    await fwCall(datasetUploadRequest(accountId, datasetId, jsonl), apiKey, i.fetch);
    const job = await fwCall<{ name?: string }>(sftJobRequest(accountId, { datasetId, baseModel: model, epochs: i.quote.epochs, outputModelId, displayName: `ReturnWitness label reader ${stamp}` }), apiKey, i.fetch);
    const jobName = job.name ?? "";
    if (!jobName) throw new Error("Fireworks accepted the job but returned no job name");
    log(true, { jobName, outputModelId });
    return { datasetId, jobName, outputModelId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(false, "", msg);
    throw e;
  }
}

/* ---------- CLI arguments (scripts/fireworks-finetune.ts) ---------- */

export interface FinetuneArgs {
  mode: "quote" | "submit";
  confirmSpend: boolean;
  epochs: number;
  out: string | null;
  poll: boolean;
}

export function parseFinetuneArgs(argv: string[]): FinetuneArgs {
  const a: FinetuneArgs = { mode: "quote", confirmSpend: false, epochs: 3, out: null, poll: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--quote") a.mode = "quote";
    else if (v === "--submit") a.mode = "submit";
    else if (v === "--confirm-spend") a.confirmSpend = true;
    else if (v === "--poll") a.poll = true;
    else if (v === "--epochs") a.epochs = Number(argv[++i]);
    else if (v === "--out") a.out = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${v}`);
  }
  if (!Number.isInteger(a.epochs) || a.epochs < 1) throw new Error("--epochs must be a positive whole number");
  return a;
}
