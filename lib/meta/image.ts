/**
 * Muse Image 1.0: a "what a complete return looks like" card for the bench, drawn from the order's
 * lines. Contract from dev.meta.ai/docs/image-generation: POST /v1/images/generations,
 * OpenAI-Images compatible, {model, prompt, n, size, response_format, output_format} →
 * {created, data:[{b64_json}], output_format, usage}. $0.01 per image returned.
 *
 * Sidra's rule: never generate a real product. The prompt is built ONLY from each item's generic
 * camera concept (e.g. "film camera", "camera lens") and forbids logos, brand names and text; the card
 * is always labelled "generated illustration". `illustrationPrompt` is pure so tests pin that down.
 *
 * The same rule in the request: Muse Image is agentic and, by default, may search images ("visual references
 * such as real places, products, logos"), search the web and run a shell before it draws. On the images endpoints
 * those are the top-level `tool_enablement` switches, all true unless sent false (same page, "Control the tools
 * and reasoning on the images endpoints"). Every request turns all three off: no real product can be pulled in
 * as a reference.
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import type { ModeLabel } from "@/lib/domain/schemas";
import { logLlmCall, PRICES, usdToMicroCents } from "@/lib/obs/llm-log";
import { assertNotContributor, metaConfig, type MetaConfig } from "./config";

export const ILLUSTRATION_LABEL = "generated illustration";
// Served statically (/illustrations/<kit>.webp + .json), so the public site can show a recorded result.
const DIR = path.join(process.cwd(), "public", "illustrations");

/** Sent on every Muse Image request. Frozen so no caller can switch a tool back on. */
export const IMAGE_TOOL_ENABLEMENT = Object.freeze({ enable_image_search: false, enable_web_search: false, enable_shell: false } as const);

export interface IllustrationItem {
  /** Generic noun phrase, e.g. the kit's `samConcept`. Never a product or brand name. */
  concept: string;
  qty: number;
}

export interface Illustration {
  kitId: string;
  mode: ModeLabel;
  model: string;
  prompt: string;
  /** URL path under /illustrations, or a data URL for an unsaved result. */
  imagePath: string;
  createdAt: string;
  latencyMs: number;
  provenance: string;
  label: typeof ILLUSTRATION_LABEL;
}

// Words that would point the model at a real product line. The concepts come from our own kit file,
// so this is a guard against a future edit, not a filter on user input.
const BRANDISH = /\b(canon|nikon|sony|fuji(film)?|leica|olympus|pentax|panasonic|lumix|hasselblad|kodak|ricoh|sigma|tamron|zeiss|gopro|apple|samsung|brindlewood)\b/i;

export function illustrationPrompt(items: IllustrationItem[]): string {
  if (!items.length) throw new Error("no items to draw");
  for (const it of items) if (BRANDISH.test(it.concept)) throw new Error(`refusing a brand-like concept in an illustration prompt: "${it.concept}"`);
  const list = items.map((it) => `${it.qty > 1 ? `${it.qty} × ` : "one "}generic ${it.concept}`).join(", ");
  return [
    `Top-down flat illustration of a complete returned kit laid out on a neutral grey inspection mat: ${list}.`,
    "Each item is a simple, generic, unbranded shape, evenly spaced with clear gaps between them, soft even lighting, no shadows overlapping.",
    "No logos, no brand names, no text, no labels, no serial numbers, no people, no hands, not a photograph of any real product.",
  ].join(" ");
}

export async function generateIllustration(kitId: string, items: IllustrationItem[], cfg: MetaConfig = metaConfig(), opts: { client?: Pick<OpenAI, "images">; caseId?: string; save?: boolean } = {}): Promise<Illustration> {
  const model = cfg.models.image;
  const prompt = illustrationPrompt(items);
  const body = { model, prompt, n: 1, size: "1536x1024", response_format: "b64_json" as const, output_format: "webp", tool_enablement: { ...IMAGE_TOOL_ENABLEMENT } };
  const t0 = Date.now();
  try {
    assertNotContributor(model);
    if (!cfg.apiKey && !opts.client) throw new Error("META_HACK_API_KEY is not set");
    const client = opts.client ?? new OpenAI({ apiKey: cfg.apiKey!, baseURL: cfg.baseURL, timeout: 120_000, maxRetries: 0 });
    const res = (await client.images.generate(body as never)) as unknown as { created?: number; data?: Array<{ b64_json?: string }>; usage?: unknown };
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error("Muse Image returned no image");
    const latencyMs = Date.now() - t0;
    const usd = PRICES.imagePerImageUsd;
    logLlmCall({ provider: "meta", model, purpose: "illustration", mode: "live", ok: true, latencyMs, inputTokens: null, outputTokens: null, units: { kind: "images", count: 1 }, costUsd: usd, costMicroCents: usdToMicroCents(usd), caseId: opts.caseId, input: body, output: { created: res.created ?? null, bytes: Math.round((b64.length * 3) / 4), usage: res.usage ?? null } });
    const createdAt = new Date().toISOString();
    let imagePath = `data:image/webp;base64,${b64}`;
    if (opts.save !== false) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, `${kitId}.webp`), Buffer.from(b64, "base64"));
      imagePath = `/illustrations/${kitId}.webp`;
    }
    const out: Illustration = { kitId, mode: "LIVE_META", model, prompt, imagePath, createdAt, latencyMs, provenance: `live Muse Image call, ${latencyMs} ms`, label: ILLUSTRATION_LABEL };
    if (opts.save !== false) fs.writeFileSync(path.join(DIR, `${kitId}.json`), JSON.stringify(out, null, 2));
    return out;
  } catch (e) {
    logLlmCall({ provider: "meta", model, purpose: "illustration", mode: "live", ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: opts.caseId, input: body, output: "", error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** A saved live illustration, replayed: labelled RECORDED_FIXTURE, never LIVE. Null when none exists. */
export function loadIllustration(kitId: string): Illustration | null {
  const meta = path.join(DIR, `${kitId}.json`);
  if (!fs.existsSync(meta) || !fs.existsSync(path.join(DIR, `${kitId}.webp`))) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(meta, "utf8")) as Illustration;
    return { ...rec, mode: "RECORDED_FIXTURE", provenance: "recorded Muse Image output" };
  } catch {
    return null;
  }
}

export function illustrationBytes(kitId: string): Buffer | null {
  const f = path.join(DIR, `${kitId}.webp`);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
