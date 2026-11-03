/**
 * Prompt caching (dev.meta.ai/docs/prompt-caching): stable prefix first, a stable prompt_cache_key per prompt, cached
 * input priced at the cached rate (pricing-rate-limits: Spark $0.15 vs $1.25, Wonder $0.20 vs $4.00 per 1M), and
 * usage.prompt_tokens_details.cached_tokens carried into the spend log, fleet recordings and /dashboard/agents.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import type { CountResult } from "@/lib/domain/schemas";
import { cachedTokensOf, promptCacheKey, tokenCostUsd } from "@/lib/obs/llm-log";
import { summarizeCaching } from "@/lib/fleet/caching";
import type { FleetRecording } from "@/lib/fleet/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-cache-"));
process.env.RETURNWITNESS_LLM_LOG = path.join(tmp, "llm-calls.jsonl");
process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(tmp, "recordings");

const seen: Array<Record<string, unknown>> = [];
let server: http.Server;
let base = "";
const answer = { lines: ORDERS[1].slip.lines.map((l) => ({ itemKey: l.itemKey, observedQty: 1, status: "OK", reasons: [], serialRead: null })), notes: null };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `chatcmpl-${seen.length}`, object: "chat.completion", created: 0, model: "muse-spark-1.3", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }], usage: { prompt_tokens: 4000, completion_tokens: 200, total_tokens: 4200, prompt_tokens_details: { cached_tokens: 3000 } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => server.close());

describe("cached-input pricing and usage parsing", () => {
  it("cached tokens are a subset of input, billed at the cached rate", () => {
    expect(tokenCostUsd("muse-spark-1.3", 4000, 200, 0)).toBeCloseTo((4000 * 1.25 + 200 * 4.25) / 1e6, 10);
    expect(tokenCostUsd("muse-spark-1.3", 4000, 200, 3000)).toBeCloseTo((1000 * 1.25 + 3000 * 0.15 + 200 * 4.25) / 1e6, 10);
    expect(tokenCostUsd("muse-wonder-1.0", 1000, 0, 1000)).toBeCloseTo((1000 * 0.2) / 1e6, 10);
    expect(tokenCostUsd("muse-spark-1.3", 100, 0, 5000)).toBeCloseTo((100 * 0.15) / 1e6, 10); // never more cached than input
  });

  it("cachedTokensOf reads usage.prompt_tokens_details.cached_tokens, 0 otherwise", () => {
    expect(cachedTokensOf({ prompt_tokens_details: { cached_tokens: 12 } })).toBe(12);
    for (const u of [undefined, null, {}, { prompt_tokens_details: {} }, { prompt_tokens_details: { cached_tokens: "9" } }, { prompt_tokens_details: { cached_tokens: -1 } }]) expect(cachedTokensOf(u)).toBe(0);
  });

  it("cache keys name the shared prefix, never a case or user", () => {
    expect(promptCacheKey("reconcile", "pol@2026.3")).toBe("returnwitness:reconcile:pol@2026.3");
    expect(promptCacheKey("decision-agent")).toBe("returnwitness:decision-agent");
  });
});

describe("Muse Spark reader: stable prefix first, cache key, cached tokens logged", () => {
  it("policy in the system prompt (same for every return), the return's evidence after it; key per policy version", async () => {
    const { sparkReconcile, reconcileSystem } = await import("@/lib/meta/readers");
    const { metaConfig } = await import("@/lib/meta/config");
    const cfg = metaConfig({ META_HACK_API_KEY: "k", META_BASE_URL: base } as unknown as NodeJS.ProcessEnv);
    const count: CountResult = { clipId: "cache-clip", counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } };
    const r = await sparkReconcile({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, count, images: [], caseId: "case_cache", clipId: "cache-clip" }, cfg);
    expect(r.mode).toBe("LIVE_META");
    const body = seen.at(-1)! as { prompt_cache_key: string; messages: Array<{ role: string; content: unknown }> };
    expect(body.prompt_cache_key).toBe(`returnwitness:reconcile:${POLICY.id}@${POLICY.version}`);
    expect(body.messages[0].content).toBe(reconcileSystem(POLICY));
    expect(String(body.messages[0].content)).toContain(POLICY.clauses[0].text);
    const user = JSON.stringify(body.messages[1].content);
    expect(user).not.toContain("RETURN POLICY");
    expect(user).toContain(RMAS[1].id);
    const row = fs.readFileSync(process.env.RETURNWITNESS_LLM_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    expect(row).toMatchObject({ purpose: "reconcile", inputTokens: 4000, cachedTokens: 3000 });
    expect(row.costUsd).toBeCloseTo((1000 * 1.25 + 3000 * 0.15 + 200 * 4.25) / 1e6, 10);
  });
});

describe("fleet roles and the agents-page summary", () => {
  it("fleetMetaJson sends a per-role cache key and returns cached tokens", async () => {
    const { fleetMetaJson } = await import("@/lib/fleet/live");
    const { metaConfig } = await import("@/lib/meta/config");
    const { z } = await import("zod");
    let body: Record<string, unknown> = {};
    const client = { chat: { completions: { create: async (b: Record<string, unknown>) => ((body = b), { id: "r1", choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 800, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 640 } } }) } } };
    const r = await fleetMetaJson({ client: client as never, cfg: metaConfig({ META_HACK_API_KEY: "k" } as unknown as NodeJS.ProcessEnv), model: "muse-spark-1.3", purpose: "fleet:restock", system: "s", userText: "u", images: [], schemaName: "x", schema: z.object({ ok: z.boolean() }) });
    expect(body.prompt_cache_key).toBe("returnwitness:fleet-fleet:restock");
    expect(r.cachedTokens).toBe(640);
    expect(r.costUsd).toBeCloseTo((160 * 1.25 + 640 * 0.15 + 20 * 4.25) / 1e6, 10);
  });

  it("summarizeCaching: hit rate and savings from recordings; old recordings count as 0 cached", () => {
    const rec = (role: string, model: string, inputTokens: number | null, cachedTokens?: number): FleetRecording =>
      ({ kind: "fleet", rmaId: "RMA-1", role, mode: "LIVE_META", model, latencyMs: 1, recordedAt: "2026-10-29T00:00:00Z", ok: true, output: null, usage: { inputTokens, outputTokens: 10, ...(cachedTokens != null ? { cachedTokens } : {}) }, costUsd: 0 }) as FleetRecording;
    const s = summarizeCaching({ "RMA-1": { a: rec("a", "muse-spark-1.3", 1000, 600), b: rec("b", "muse-spark-1.3", 1000) }, "RMA-2": { c: rec("c", "muse-spark-1.3", null) } } as never);
    expect(s).toMatchObject({ calls: 2, inputTokens: 2000, cachedTokens: 600 });
    expect(s.hitRate).toBeCloseTo(0.3, 6);
    expect(s.savedUsd).toBeCloseTo((600 * (1.25 - 0.15)) / 1e6, 8);
    expect(summarizeCaching({})).toMatchObject({ calls: 0, hitRate: 0, savedUsd: 0 });
  });
});
