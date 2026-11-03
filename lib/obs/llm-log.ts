/**
 * Every model call is logged: input, output, latency, cost, model. Shape is the house
 * "StayCovered" shape so `spend` can read it: {at, provider, model, purpose, inputTokens,
 * outputTokens, ok, mode: "live"|"demo", costMicroCents} plus our own fields.
 * Fixture replays are logged with mode "demo" and cost 0 (simulated is not spend).
 */
import fs from "node:fs";
import path from "node:path";

export interface LlmCallRecord {
  at: string;
  provider: "meta" | "baseten" | "modal" | "fireworks" | "fixture";
  model: string;
  purpose: string;
  mode: "live" | "demo";
  ok: boolean;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Of inputTokens, how many the provider served from its prompt cache (billed at the cached-input rate). */
  cachedTokens?: number | null;
  /** Non-token units (SAM bills per frame). */
  units?: { kind: string; count: number };
  costMicroCents: number | null;
  costUsd: number | null;
  caseId?: string;
  runId?: string;
  input: string;
  /** The answer only. A reasoning model's scratch work goes in `reasoning`, never here. */
  output: string;
  reasoning?: string;
  reasoningTokens?: number | null;
  reasoningSource?: "field" | "think-tags" | "json-envelope" | "none";
  error?: string;
}

const MAX_TEXT = 4000;
export const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

const g = globalThis as unknown as { __rwLlmLog?: LlmCallRecord[] };

export function logLlmCall(r: Omit<LlmCallRecord, "at" | "input" | "output"> & { input: unknown; output: unknown; at?: string }): LlmCallRecord {
  const rec: LlmCallRecord = {
    ...r,
    ...(r.reasoning ? { reasoning: clip(r.reasoning, 2000) } : {}),
    at: r.at ?? new Date().toISOString(),
    input: clip(typeof r.input === "string" ? r.input : JSON.stringify(r.input)),
    output: clip(typeof r.output === "string" ? r.output : JSON.stringify(r.output)),
  };
  (g.__rwLlmLog ??= []).push(rec);
  if (g.__rwLlmLog.length > 500) g.__rwLlmLog.shift();
  try {
    const file = process.env.RETURNWITNESS_LLM_LOG || path.join(process.cwd(), ".data", "llm-calls.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  } catch {
    // read-only filesystem: kept in memory only
  }
  return rec;
}

export const recentLlmCalls = (): LlmCallRecord[] => [...(g.__rwLlmLog ?? [])].reverse();

/**
 * USD per 1M tokens (input, cached input, output) and per-unit prices, from Meta's product page;
 * cached-input rates from dev.meta.ai/docs/pricing-rate-limits.
 */
export const PRICES = {
  "muse-spark-1.3": { in: 1.25, cachedIn: 0.15, out: 4.25 },
  "muse-wonder-1.0": { in: 4.0, cachedIn: 0.2, out: 20.0 },
  samPerFrameUsd: 0.2 / 1000,
  // dev.meta.ai/docs/pricing-rate-limits: billed per whole second of audio, rounded down.
  voicePerSecondUsd: 0.18 / 3600,
  // Same page: a flat $0.01 per image successfully generated and returned.
  imagePerImageUsd: 0.01,
} as const;

/** Cost of one call. `cachedTok` is the part of `inTok` served from the prompt cache (a subset, never extra). */
export function tokenCostUsd(model: string, inTok: number | null, outTok: number | null, cachedTok = 0): number | null {
  const p = (PRICES as Record<string, { in: number; cachedIn: number; out: number } | number>)[model];
  if (!p || typeof p === "number" || inTok == null || outTok == null) return null;
  const cached = Math.max(0, Math.min(cachedTok || 0, inTok));
  return ((inTok - cached) * p.in + cached * p.cachedIn + outTok * p.out) / 1_000_000;
}

/** Meta reports cache hits at usage.prompt_tokens_details.cached_tokens (Chat Completions). 0 when absent. */
export function cachedTokensOf(usage: unknown): number {
  const n = (usage as { prompt_tokens_details?: { cached_tokens?: unknown } } | null | undefined)?.prompt_tokens_details?.cached_tokens;
  return typeof n === "number" && n > 0 ? n : 0;
}

/**
 * prompt_cache_key (dev.meta.ai/docs/prompt-caching): optional; requests sharing a key route together, so the cached
 * prefix is more likely to be on that backend. A stable name for the shared prefix, never per user or per request.
 */
export const promptCacheKey = (purpose: string, scope?: string) => `returnwitness:${purpose}${scope ? `:${scope}` : ""}`;

export const usdToMicroCents = (usd: number | null) => (usd == null ? null : Math.round(usd * 100 * 1_000_000));
