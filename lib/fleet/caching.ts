/**
 * Prompt-cache hits across the fleet's recorded live calls, for /dashboard/agents. Meta serves a repeated prompt prefix
 * from cache and bills those input tokens at the cached rate (dev.meta.ai/docs/prompt-caching, pricing-rate-limits).
 * Arithmetic on what the recordings say; recordings from before cached tokens were stored count as 0 cached.
 */
import { PRICES } from "@/lib/obs/llm-log";
import type { RecordedFleet } from "./types";

export interface CachingSummary {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  /** cachedTokens / inputTokens (0 when no input). */
  hitRate: number;
  /** What the cached tokens would have cost at the full input rate, less what they cost at the cached rate. */
  savedUsd: number;
}

export function summarizeCaching(recorded: RecordedFleet): CachingSummary {
  let calls = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let savedUsd = 0;
  for (const roles of Object.values(recorded)) {
    for (const rec of Object.values(roles ?? {})) {
      if (!rec || rec.usage.inputTokens == null) continue;
      calls++;
      const cached = Math.max(0, Math.min(rec.usage.cachedTokens ?? 0, rec.usage.inputTokens));
      inputTokens += rec.usage.inputTokens;
      cachedTokens += cached;
      const p = (PRICES as Record<string, { in: number; cachedIn: number } | number>)[rec.model];
      if (p && typeof p !== "number") savedUsd += (cached * (p.in - p.cachedIn)) / 1_000_000;
    }
  }
  return { calls, inputTokens, cachedTokens, hitRate: inputTokens ? cachedTokens / inputTokens : 0, savedUsd: Math.round(savedUsd * 1e6) / 1e6 };
}
