/**
 * Live check of the open-weight auditor (Muse Spark Open). Prints no secrets; both calls are
 * logged to .data/llm-calls.jsonl so `spend` sees them.
 *   1. a tiny smoke call: status, latency, tokens, where the reasoning arrived
 *   2. one real audit through openWeightAudit() on fixture crops cut from the printed serial-label
 *      sheet (labels/preview.png) for RMA-20419's complete kit. These are label crops, not
 *      camera frames, and the run passes no clipId, so nothing is saved as a clip recording.
 *
 *   npx tsx --env-file=.env.local scripts/check-openweight.ts
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import OpenAI from "openai";
import { ORDERS, POLICY, RMAS } from "../data/fixtures";
import { logLlmCall } from "../lib/obs/llm-log";
import { openWeightAudit, openWeightConfig } from "../lib/openweights/auditor";
import { firstJsonObject, splitReasoning } from "../lib/openweights/reasoning";
import type { ReaderEvidence } from "../lib/meta/readers";

const SHEET = path.join(process.cwd(), "labels/preview.png");
// Label cells on the 860×1100 preview (x, y, w, h): Set A, the complete kit.
const CELLS = {
  camera_body: [37, 64, 384, 192],
  lens: [439, 64, 384, 192],
  battery: [37, 257, 384, 191],
} as const;

function cropJpeg([x, y, w, h]: readonly number[]): string {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", SHEET, "-vf", `crop=${w}:${h}:${x}:${y}`, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"]);
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

async function smoke() {
  const cfg = openWeightConfig();
  if (!cfg.provider || !cfg.apiKey || !cfg.baseURL) throw new Error(`open-weight provider not ready: ${cfg.reason}`);
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 60_000, maxRetries: 0 });
  const t0 = Date.now();
  const { data, response } = await client.chat.completions
    .create({ model: cfg.model, messages: [{ role: "user", content: 'Reply with JSON only: {"ok": true, "n": 2+2}' }], max_tokens: 800 })
    .withResponse();
  const latencyMs = Date.now() - t0;
  const split = splitReasoning(data.choices[0]?.message as Parameters<typeof splitReasoning>[0]);
  const usage = data.usage as (typeof data.usage & { completion_tokens_details?: { reasoning_tokens?: number } }) | undefined;
  const parsed = firstJsonObject(split.answer);
  logLlmCall({ provider: cfg.provider, model: cfg.model, purpose: "open_weight_smoke", mode: "live", ok: parsed != null, latencyMs, inputTokens: usage?.prompt_tokens ?? null, outputTokens: usage?.completion_tokens ?? null, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null, reasoningSource: split.source, costUsd: null, costMicroCents: null, input: "smoke: JSON 2+2", output: split.answer, reasoning: split.reasoning });
  console.log(`smoke: HTTP ${response.status} · ${latencyMs} ms · in ${usage?.prompt_tokens} / out ${usage?.completion_tokens} (reasoning ${usage?.completion_tokens_details?.reasoning_tokens ?? "?"}) · reasoning via ${split.source} (${split.reasoning.length} chars) · answer ${JSON.stringify(split.answer)} → ${JSON.stringify(parsed)}`);
}

async function audit() {
  const rma = RMAS[1];
  const order = ORDERS[1];
  const ev: ReaderEvidence = {
    rma,
    slip: order.slip,
    policy: POLICY,
    count: { clipId: "label-sheet-check", counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 0, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } },
    images: Object.entries(CELLS).map(([key, cell]) => ({ caption: `crop of the counted ${key} (printed serial label, read any serial exactly)`, dataUrl: cropJpeg(cell) })),
    caseId: "check-openweight",
  };
  const r = await openWeightAudit(ev);
  console.log(`audit: ${r.error ? `ERROR ${r.error}` : "ok"} · ${r.latencyMs} ms · ${r.model}`);
  if (r.extras) console.log(JSON.stringify(r.extras, null, 2));
  if (r.output) for (const l of r.output.lines) console.log(`  ${l.itemKey}: ${l.status}${l.reasons.length ? ` (${l.reasons.map((x) => x.code).join(", ")})` : ""}`);
}

(async () => {
  await smoke();
  await audit();
})().catch((e) => {
  console.error("open-weight check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
