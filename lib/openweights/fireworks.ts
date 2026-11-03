/**
 * Muse Glimmer on Fireworks: the FAST label reader. It looks only at the settled-item crops and
 * reads each printed serial / SKU label, nothing else. Behind one switch:
 *   RETURNWITNESS_LABEL_READER=fireworks + FIREWORKS_API_KEY + FIREWORKS_GLIMMER_MODEL → live
 *   anything missing → not run; the card says why
 * FIREWORKS_GLIMMER_MODEL has no default on purpose: the exact serverless model id is confirmed
 * from Fireworks' model list on key day (scripts/check-fireworks.ts), never guessed.
 *
 * Like every reader it returns the shared reconciliation schema and is merged by crossCheck, so it
 * can only RAISE holds: an illegible or low-confidence label on a serial-required line, a serial
 * that differs from the slip, a SKU that contradicts the slip. Wire it with readsSerials: true so
 * its serialRead is compared and an unread serial holds the line.
 *
 * The model is never shown the slip's serials or SKUs: it transcribes what is printed, and app
 * code compares. A reader that knows the expected value tends to "read" it.
 */
import OpenAI from "openai";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { assertNotContributor } from "@/lib/meta/config";
import { GLIMMER_TIMEOUT_MS, recordedGlimmerLabelRead as recordedRead, runGlimmerRead } from "./glimmer";

// The prompt, schema, reads → holds mapping and call path are shared with the Modal reader (glimmer.ts);
// re-exported here so existing imports keep working.
export {
  cropItemKey,
  GLIMMER_SYSTEM,
  GLIMMER_TIMEOUT_MS,
  GlimmerItem,
  GlimmerOutput,
  glimmerUserContent,
  LABEL_CONFIDENCE_FLOOR,
  labelReadToReconciliation,
  type GlimmerExtras,
} from "./glimmer";

export const LABEL_READER_NOT_RUN = "[Label reader · not run — Fireworks credits not granted]";
export const GLIMMER_READER_NAME = "muse-glimmer (fireworks)";

export interface FireworksConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string | null;
  accountId: string | null;
  model: string | null;
  reason: string;
  /** USD per 1M tokens, only when set from Fireworks' pricing page; otherwise cost is logged as null. */
  prices: { in: number; out: number } | null;
  timeoutMs: number;
  maxRetries: number;
}

const num = (v: string | undefined) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

export function fireworksConfig(env: NodeJS.ProcessEnv = process.env): FireworksConfig {
  const selected = (env.RETURNWITNESS_LABEL_READER ?? "").trim().toLowerCase() === "fireworks";
  const apiKey = env.FIREWORKS_API_KEY?.trim() || null;
  const model = env.FIREWORKS_GLIMMER_MODEL?.trim() || null;
  const pin = num(env.FIREWORKS_GLIMMER_USD_PER_MTOK_IN);
  const pout = num(env.FIREWORKS_GLIMMER_USD_PER_MTOK_OUT);
  const missing = [
    !selected && "label reader not selected (RETURNWITNESS_LABEL_READER=fireworks)",
    !apiKey && "FIREWORKS_API_KEY not set",
    !model && "FIREWORKS_GLIMMER_MODEL not set (confirm the exact Muse Glimmer serverless model id from Fireworks' model list with scripts/check-fireworks.ts; it is not guessed)",
  ].filter((x): x is string => Boolean(x));
  return {
    enabled: missing.length === 0,
    baseURL: env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference/v1",
    apiKey,
    accountId: env.FIREWORKS_ACCOUNT_ID?.trim() || null,
    model,
    reason: missing.join("; "),
    prices: pin != null && pout != null ? { in: pin, out: pout } : null,
    timeoutMs: GLIMMER_TIMEOUT_MS,
    maxRetries: 1,
  };
}

type Deps = { fetch?: typeof fetch };

const clientFor = (cfg: FireworksConfig, deps: Deps) => new OpenAI({ apiKey: cfg.apiKey!, baseURL: cfg.baseURL, timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

export async function glimmerLabelRead(e: ReaderEvidence, cfg: FireworksConfig = fireworksConfig(), deps: Deps = {}): Promise<ReaderResult> {
  const model = cfg.model ?? "muse-glimmer (model id not set)";
  const base = { model, provider: "fireworks", mode: "LIVE_OPEN_WEIGHTS" as const };
  try {
    assertNotContributor(model);
  } catch (err) {
    return { ...base, output: null, latencyMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
  if (!cfg.enabled || !cfg.apiKey || !cfg.model) return { ...base, output: null, latencyMs: 0, error: `${LABEL_READER_NOT_RUN}: ${cfg.reason}` };
  const prices = cfg.prices;
  return runGlimmerRead({ e, client: clientFor(cfg, deps), provider: "fireworks", requestModel: cfg.model, model: cfg.model, price: prices ? (i, o) => (i * prices.in + o * prices.out) / 1_000_000 : undefined });
}

/** Replay a recorded live label read for this clip (public site). Labelled as a fixture, never as live. */
export const recordedGlimmerLabelRead = (e: ReaderEvidence): Promise<ReaderResult> => recordedRead(e, `${LABEL_READER_NOT_RUN}: no recorded label read for this clip`);

/**
 * Model ids the key can call on the OpenAI-compatible inference endpoint (GET {baseURL}/models).
 * Appearing here is how scripts/check-fireworks.ts judges "on serverless"; verify on key day that
 * Fireworks lists serverless models (and only those) on this endpoint.
 */
export async function listFireworksModels(cfg: FireworksConfig = fireworksConfig(), deps: Deps = {}): Promise<string[]> {
  if (!cfg.apiKey) throw new Error("FIREWORKS_API_KEY not set");
  const ids: string[] = [];
  for await (const m of clientFor({ ...cfg, timeoutMs: 20_000 }, deps).models.list()) ids.push(m.id);
  return ids.sort();
}
