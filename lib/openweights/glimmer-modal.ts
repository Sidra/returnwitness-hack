/**
 * Muse Glimmer (Meta's open weights, `meta-models/Muse-Glimmer-30B`) on MY Modal GPU: the label
 * reader when Fireworks has no credits. modal/glimmer_app.py serves it with vLLM 0.32.0 on one L40S
 * (FP8 at load) behind a bearer token, with an OpenAI-compatible /v1/chat/completions. Behind one switch:
 *   RETURNWITNESS_LABEL_READER=modal + MODAL_GLIMMER_URL + MODAL_GLIMMER_TOKEN → on
 *   MODAL_GLIMMER_ADAPTER (optional) → the request names that served LoRA adapter; set it ONLY after
 *     scripts/glimmer-eval.ts says the adapter beat the base on held-out corrections (lib/learning/glimmer-eval.ts)
 *   anything missing → not run; the card says why
 *
 * Deployed and called live (held-out label reads, the filmed bench crops). Every behaviour is also exercised against
 * mocks in tests/glimmer-modal.test.ts, and the endpoint's HTTP layer by modal/check_glimmer_web.py.
 *
 * Same prompt, schema and reads → holds mapping as the Fireworks reader (lib/openweights/glimmer.ts),
 * so it can only RAISE holds. Results are labelled LIVE_OPEN_WEIGHTS ("LIVE · Meta open weights on a
 * partner GPU"), never LIVE_META. GPU time is logged as a unit (gpu_seconds, measured in the app) with
 * costUsd null: Modal bills per GPU-second of container time, not per call, so a per-call price would be made up.
 */
import OpenAI from "openai";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { assertNotContributor } from "@/lib/meta/config";
import { GLIMMER_RESPONSE_FORMAT, GLIMMER_SYSTEM, GLIMMER_TIMEOUT_MS, parseGlimmerMessage, runGlimmerRead, type GlimmerItem } from "./glimmer";

export const MODAL_GLIMMER_DEFAULT_MODEL = "meta-models/Muse-Glimmer-30B";
export const GLIMMER_MODAL_READER_NAME = "muse-glimmer (modal)";
export const MODAL_GLIMMER_NOT_RUN = "[Label reader · off on this server — Muse Glimmer on Modal runs in local runs]";
/** Served LoRA names are directory names on the adapters volume (modal/glimmer_app.py validates the same pattern). */
export const ADAPTER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface ModalGlimmerConfig {
  /** RETURNWITNESS_LABEL_READER=modal */
  selected: boolean;
  enabled: boolean;
  url: string | null;
  token: string | null;
  model: string;
  adapter: string | null;
  /** Why it is off, in plain words. Empty when on. */
  reason: string;
  timeoutMs: number;
  /** 0: the 15 s budget is the whole budget; a retry would double it. */
  maxRetries: number;
}

export const labelReaderSelection = (env: NodeJS.ProcessEnv = process.env) => (env.RETURNWITNESS_LABEL_READER ?? "").trim().toLowerCase();

export function modalGlimmerConfig(env: NodeJS.ProcessEnv = process.env): ModalGlimmerConfig {
  const selected = labelReaderSelection(env) === "modal";
  const rawUrl = env.MODAL_GLIMMER_URL?.trim() || null;
  const token = env.MODAL_GLIMMER_TOKEN?.trim() || null;
  const model = env.MODAL_GLIMMER_MODEL?.trim() || MODAL_GLIMMER_DEFAULT_MODEL;
  const rawAdapter = env.MODAL_GLIMMER_ADAPTER?.trim() || null;
  let url: string | null = null;
  const problems: string[] = [];
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) problems.push(`MODAL_GLIMMER_URL must be https (got ${u.protocol})`);
      else url = rawUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    } catch {
      problems.push("MODAL_GLIMMER_URL is not a valid URL");
    }
  }
  if (rawAdapter && !ADAPTER_NAME.test(rawAdapter)) problems.push(`MODAL_GLIMMER_ADAPTER "${rawAdapter.slice(0, 80)}" is not a served adapter name (letters, digits, . _ -)`);
  const missing = [!rawUrl ? "MODAL_GLIMMER_URL" : "", !token ? "MODAL_GLIMMER_TOKEN" : ""].filter(Boolean);
  const reason = !selected
    ? `label reader on Modal not selected (RETURNWITNESS_LABEL_READER=modal)`
    : problems.length
      ? problems.join("; ")
      : missing.length
        ? `${missing.join(" and ")} not set (deploy modal/glimmer_app.py first, see modal/README.md; deploying needs Sidra's typed OK)`
        : "";
  return { selected, enabled: reason === "", url, token, model, adapter: rawAdapter && ADAPTER_NAME.test(rawAdapter) ? rawAdapter : null, reason, timeoutMs: GLIMMER_TIMEOUT_MS, maxRetries: 0 };
}

type Deps = { fetch?: typeof fetch };

const clientFor = (cfg: ModalGlimmerConfig, deps: Deps) => new OpenAI({ apiKey: cfg.token!, baseURL: `${cfg.url}/v1`, timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

/** The card's model line: the base id, plus the LoRA adapter when one answers. */
export const modalDisplayModel = (cfg: Pick<ModalGlimmerConfig, "model" | "adapter">) => (cfg.adapter ? `${cfg.model} · LoRA ${cfg.adapter}` : cfg.model);

/** Contributor guard on the base id AND the adapter name: neither may name a contributor-mode variant. */
function guard(cfg: ModalGlimmerConfig): string | null {
  try {
    assertNotContributor(cfg.model);
    if (cfg.adapter) assertNotContributor(cfg.adapter);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function modalGlimmerLabelRead(e: ReaderEvidence, cfg: ModalGlimmerConfig = modalGlimmerConfig(), deps: Deps = {}): Promise<ReaderResult> {
  const base = { model: modalDisplayModel(cfg), provider: "modal", mode: "LIVE_OPEN_WEIGHTS" as const };
  const refused = guard(cfg);
  if (refused) return { ...base, output: null, latencyMs: 0, error: refused };
  if (!cfg.enabled || !cfg.url || !cfg.token) return { ...base, output: null, latencyMs: 0, error: `${MODAL_GLIMMER_NOT_RUN}: ${cfg.reason}` };
  return runGlimmerRead({
    e,
    client: clientFor(cfg, deps),
    provider: "modal",
    requestModel: cfg.adapter ?? cfg.model,
    model: cfg.model,
    displayModel: modalDisplayModel(cfg),
    // My own endpoint: greedy decoding, so the same crop gets the same transcription.
    extraBody: { temperature: 0 },
    logInput: { endpoint: new URL(cfg.url).host, adapter: cfg.adapter },
    adapter: cfg.adapter,
  });
}

/* ---------- Held-out evaluation calls (scripts/glimmer-eval.ts --live) ---------- */

export interface HeldOutMessages {
  rowId: string;
  itemKey: string;
  messages: Array<{ role: "system" | "user"; content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] }>;
}

export interface ReadRecord {
  rowId: string;
  read: GlimmerItem | null;
  error?: string;
  gpuSeconds?: number | null;
}

/**
 * One held-out row through the served endpoint, as base (`model` = the base id) or as the adapter
 * (`model` = the LoRA name). The row's own system + user turns are sent unchanged: they are the
 * inference prompt (the dataset builder uses glimmerUserContent), so the eval measures what serves.
 */
export async function readHeldOutRow(row: HeldOutMessages, requestModel: string, cfg: ModalGlimmerConfig, deps: Deps = {}): Promise<ReadRecord> {
  if (!cfg.url || !cfg.token) return { rowId: row.rowId, read: null, error: "MODAL_GLIMMER_URL / MODAL_GLIMMER_TOKEN not set" };
  try {
    assertNotContributor(requestModel);
    const system = row.messages.find((m) => m.role === "system");
    if (system && system.content !== GLIMMER_SYSTEM) throw new Error("held-out row's system prompt differs from the live reader's (rebuild the dataset)");
    const res = await clientFor({ ...cfg, timeoutMs: Math.max(cfg.timeoutMs, 60_000) }, deps).chat.completions.create({ model: requestModel, messages: row.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[], response_format: GLIMMER_RESPONSE_FORMAT, max_tokens: 2048, temperature: 0 });
    const { read } = parseGlimmerMessage(res.choices[0]?.message as Parameters<typeof parseGlimmerMessage>[0]);
    const gs = (res as unknown as { gpu_seconds?: unknown }).gpu_seconds;
    const gpuSeconds = typeof gs === "number" ? gs : null;
    if (!read) return { rowId: row.rowId, read: null, error: "answer didn't match the schema", gpuSeconds };
    return { rowId: row.rowId, read: read.items.find((i) => i.itemKey === row.itemKey) ?? read.items[0] ?? null, gpuSeconds };
  } catch (err) {
    return { rowId: row.rowId, read: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET /healthz (no auth). A cold app boots a GPU container to answer, which is billed. */
export async function modalGlimmerHealth(cfg: Pick<ModalGlimmerConfig, "url">, deps: Deps & { timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; body: unknown; latencyMs: number }> {
  if (!cfg.url) throw new Error("MODAL_GLIMMER_URL not set");
  const t0 = Date.now();
  const res = await (deps.fetch ?? fetch)(`${cfg.url}/healthz`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 900_000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { ok: res.ok, status: res.status, body, latencyMs: Date.now() - t0 };
}
