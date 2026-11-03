import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { crossCheckReaders, reconcile } from "@/lib/engine/reconcile";
import type { CountResult } from "@/lib/domain/schemas";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import {
  cropItemKey,
  fireworksConfig,
  glimmerLabelRead,
  GLIMMER_READER_NAME,
  LABEL_CONFIDENCE_FLOOR,
  LABEL_READER_NOT_RUN,
  listFireworksModels,
  recordedGlimmerLabelRead,
  type FireworksConfig,
  type GlimmerExtras,
} from "@/lib/openweights/fireworks";
import { loadCrops } from "@/lib/learning/corrections";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-fw-"));
const LOG = path.join(tmp, "llm-calls.jsonl");
beforeAll(() => {
  // Keep test calls out of the real spend log, recordings and crop archive.
  process.env.RETURNWITNESS_LLM_LOG = LOG;
  process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(tmp, "recordings");
  process.env.RETURNWITNESS_CROPS_DIR = path.join(tmp, "crops");
});
beforeEach(() => fs.rmSync(LOG, { force: true }));
const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const rma = RMAS[1];
const slip = ORDERS[1].slip; // complete kit: camera_body BW-CB-55120, lens BW-LN-80311, battery (no serial)
const count: CountResult = { clipId: "c", counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } };
const img = "data:image/jpeg;base64,/9j/AA==";
const ev = (over: Partial<ReaderEvidence> = {}): ReaderEvidence => ({
  rma,
  slip,
  policy: POLICY,
  count,
  images: [
    { caption: "key frame at 1.0 s (overhead)", dataUrl: "data:image/jpeg;base64,KEYFRAME" },
    ...["camera_body", "lens", "battery"].map((k) => ({ caption: `crop of the counted ${k} as it settled in the tray at 2.0 s (read any serial label exactly)`, dataUrl: img })),
  ],
  caseId: "case_fw1",
  ...over,
});
const ENV = { RETURNWITNESS_LABEL_READER: "fireworks", FIREWORKS_API_KEY: "fw-test", FIREWORKS_GLIMMER_MODEL: "accounts/fireworks/models/muse-glimmer-test" } as unknown as NodeJS.ProcessEnv;
const cfg = (over: Partial<FireworksConfig> = {}): FireworksConfig => ({ ...fireworksConfig(ENV), maxRetries: 0, ...over });

const cleanItems = [
  { itemKey: "camera_body", serialRead: "BW-CB-55120", skuRead: "CK-BODY-01", legible: true, confidence: 0.97 },
  { itemKey: "lens", serialRead: "bw ln 80311", skuRead: null, legible: true, confidence: 0.93 },
  { itemKey: "battery", serialRead: null, skuRead: "CK-BATT-CHG", legible: true, confidence: 0.9 },
];

type Captured = { url: string; body: Record<string, unknown> };
function fakeFetch(respond: (n: number) => Response | Promise<Response>, captured: Captured[] = []): typeof fetch {
  let n = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return respond(n++);
  }) as typeof fetch;
}
const completion = (message: Record<string, unknown>, usage = { prompt_tokens: 1200, completion_tokens: 80 }) =>
  new Response(JSON.stringify({ id: "cmpl-1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", ...message } }], usage }), { status: 200, headers: { "content-type": "application/json" } });
const answer = (items: unknown, extra: Record<string, unknown> = {}) => completion({ content: JSON.stringify({ items }), ...extra });

const merge = (r: ReaderResult) => {
  const det = reconcile(rma, slip, count);
  return crossCheckReaders(det, [{ reader: GLIMMER_READER_NAME, mode: r.mode, output: r.output, required: false, readsSerials: true }], { rma, slip }).reconciliation;
};
const line = (r: ReturnType<typeof merge>, k: string) => r.lines.find((l) => l.itemKey === k)!;

describe("fireworksConfig", () => {
  it("is disabled with every missing piece named, including the unconfirmed model id", () => {
    const c = fireworksConfig({} as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/RETURNWITNESS_LABEL_READER=fireworks/);
    expect(c.reason).toMatch(/FIREWORKS_API_KEY not set/);
    expect(c.reason).toMatch(/FIREWORKS_GLIMMER_MODEL not set .*not guessed/);
    expect(c.baseURL).toBe("https://api.fireworks.ai/inference/v1");
  });

  it("selector + key without a model id stays disabled (no guessed default)", () => {
    const c = fireworksConfig({ RETURNWITNESS_LABEL_READER: "fireworks", FIREWORKS_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.model).toBeNull();
    expect(c.reason).not.toMatch(/API_KEY/);
    expect(c.reason).toMatch(/FIREWORKS_GLIMMER_MODEL/);
  });

  it("enables with all three, reads account id, base URL and prices from env only", () => {
    const c = fireworksConfig({ ...ENV, FIREWORKS_ACCOUNT_ID: "code-happy-sf-fyvhjz", FIREWORKS_BASE_URL: "http://x/v1", FIREWORKS_GLIMMER_USD_PER_MTOK_IN: "0.2", FIREWORKS_GLIMMER_USD_PER_MTOK_OUT: "0.8" });
    expect(c).toMatchObject({ enabled: true, accountId: "code-happy-sf-fyvhjz", baseURL: "http://x/v1", prices: { in: 0.2, out: 0.8 }, reason: "", timeoutMs: 15_000, maxRetries: 1 });
    expect(fireworksConfig(ENV).prices).toBeNull();
    expect(fireworksConfig({ ...ENV, FIREWORKS_GLIMMER_USD_PER_MTOK_IN: "0.2" }).prices).toBeNull();
  });
});

describe("glimmerLabelRead", () => {
  it("not configured → not run, labelled, no call", async () => {
    let called = false;
    const r = await glimmerLabelRead(ev(), fireworksConfig({} as NodeJS.ProcessEnv), { fetch: fakeFetch(() => ((called = true), answer([]))) });
    expect(r.output).toBeNull();
    expect(r.error).toContain(LABEL_READER_NOT_RUN);
    expect(called).toBe(false);
    expect(logged()).toHaveLength(0);
  });

  it("clean read → no holds; sends only the crops, a strict label_reads schema, and never the slip's serials", async () => {
    const cap: Captured[] = [];
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems), cap) });
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe("LIVE_OPEN_WEIGHTS");
    expect(merge(r).summary.allClear).toBe(true);
    expect(r.output!.lines.find((l) => l.itemKey === "lens")!.serialRead).toBe("bw ln 80311"); // normalised compare passes
    const body = cap[0].body as { messages: Array<{ content: unknown }>; response_format: unknown; model: string };
    expect(cap[0].url).toMatch(/\/chat\/completions$/);
    expect(body.model).toBe("accounts/fireworks/models/muse-glimmer-test");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "label_reads", strict: true } });
    expect((body.response_format as { json_schema: { schema: { additionalProperties: boolean } } }).json_schema.schema.additionalProperties).toBe(false);
    const parts = body.messages[1].content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(JSON.stringify(parts)).not.toContain("KEYFRAME");
    expect(JSON.stringify(body)).not.toContain("BW-CB-55120");
    expect(JSON.stringify(body)).not.toContain("CK-BODY-01");
    const extras = r.extras as GlimmerExtras;
    expect(extras.confidenceFloor).toBe(LABEL_CONFIDENCE_FLOOR);
    expect(extras.items.find((i) => i.itemKey === "lens")!.cropCaption).toMatch(/crop of the counted lens/);
  });

  it("illegible serial → HELD label_unreadable", async () => {
    const items = cleanItems.map((i) => (i.itemKey === "camera_body" ? { ...i, serialRead: null, legible: false, confidence: 0.2 } : i));
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(items)) });
    const out = r.output!.lines.find((l) => l.itemKey === "camera_body")!;
    expect(out.status).toBe("HELD");
    expect(out.reasons.map((x) => x.code)).toContain("label_unreadable");
    const m = merge(r);
    expect(line(m, "camera_body").status).toBe("HELD");
    expect(m.summary.allClear).toBe(false);
  });

  it("a legible read below the confidence floor is unreadable too, and its text is not passed on", async () => {
    const items = cleanItems.map((i) => (i.itemKey === "lens" ? { ...i, confidence: LABEL_CONFIDENCE_FLOOR - 0.05 } : i));
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(items)) });
    const out = r.output!.lines.find((l) => l.itemKey === "lens")!;
    expect(out.reasons[0].code).toBe("label_unreadable");
    expect(out.serialRead).toBeNull();
    expect(line(merge(r), "lens").status).toBe("HELD");
  });

  it("wrong serial → serial_mismatch, held", async () => {
    const items = cleanItems.map((i) => (i.itemKey === "camera_body" ? { ...i, serialRead: "BW-CB-55107" } : i));
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(items)) });
    const m = merge(r);
    expect(line(m, "camera_body").status).toBe("HELD");
    expect(line(m, "camera_body").reasons.some((x) => x.code === "serial_mismatch" && x.detail.includes("BW-CB-55107"))).toBe(true);
  });

  it("a SKU that contradicts the slip raises concept_conflict, even on a line without a serial", async () => {
    const items = cleanItems.map((i) => (i.itemKey === "battery" ? { ...i, skuRead: "XX-KNOCKOFF-9" } : i));
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(items)) });
    const m = merge(r);
    expect(line(m, "battery").status).toBe("HELD");
    expect(line(m, "battery").reasons.some((x) => x.code === "concept_conflict")).toBe(true);
  });

  it("a crop the reader skipped on a serial line holds that line", async () => {
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems.filter((i) => i.itemKey !== "lens"))) });
    expect(line(merge(r), "lens").status).toBe("HELD");
  });

  it("can never clear a line the counter holds or misses", async () => {
    const short: CountResult = { ...count, counts: { camera_body: 1, lens: 0, battery: 1 } };
    const r = await glimmerLabelRead(ev({ count: short }), cfg(), { fetch: fakeFetch(() => answer(cleanItems)) });
    const det = reconcile(rma, slip, short);
    const x = crossCheckReaders(det, [{ reader: GLIMMER_READER_NAME, mode: r.mode, output: r.output, required: false, readsSerials: true }], { rma, slip }).reconciliation;
    expect(x.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(x.summary.allClear).toBe(false);
  });

  it("reasoning in reasoning_content is ignored and logged separately", async () => {
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems, { reasoning_content: 'draft: {"items":[{"itemKey":"camera_body","serialRead":"WRONG","legible":true,"confidence":1}]}' })) });
    expect(merge(r).summary.allClear).toBe(true);
    const rec = logged()[0];
    expect(rec).toMatchObject({ provider: "fireworks", purpose: "label_read", ok: true, reasoningSource: "field", inputTokens: 1200, outputTokens: 80, costUsd: null });
    expect(rec.output).not.toContain("WRONG");
    expect(rec.reasoning).toContain("WRONG");
  });

  it("reasoning inside <think> is ignored", async () => {
    const content = `<think>maybe {"items":[{"itemKey":"camera_body","serialRead":"WRONG","legible":true,"confidence":1}]}</think>${JSON.stringify({ items: cleanItems })}`;
    const r = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => completion({ content })) });
    expect(r.output!.lines.find((l) => l.itemKey === "camera_body")!.serialRead).toBe("BW-CB-55120");
    expect(logged()[0].reasoningSource).toBe("think-tags");
  });

  it("logs a cost only when prices are configured", async () => {
    await glimmerLabelRead(ev(), cfg({ prices: { in: 1, out: 2 } }), { fetch: fakeFetch(() => answer(cleanItems)) });
    expect(logged()[0].costUsd).toBeCloseTo((1200 * 1 + 80 * 2) / 1_000_000, 12);
  });

  it("timeout → error result, logged as failed, case not cleared", async () => {
    const hang = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
    const r = await glimmerLabelRead(ev(), cfg({ timeoutMs: 30 }), { fetch: hang });
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/timed out/i);
    expect(logged()[0]).toMatchObject({ ok: false, purpose: "label_read" });
    expect(merge(r).summary.allClear).toBe(true); // a silent optional reader changes nothing...
    const det = reconcile(rma, slip, count);
    const req = crossCheckReaders(det, [{ reader: GLIMMER_READER_NAME, mode: r.mode, output: r.output, required: true, readsSerials: true }], { rma, slip });
    expect(req.reconciliation.summary.allClear).toBe(false); // ...and holds everything if made required
  });

  it("HTTP 500 → retried once (maxRetries 1), then an error result", async () => {
    let calls = 0;
    const r = await glimmerLabelRead(ev(), cfg({ maxRetries: 1 }), { fetch: fakeFetch(() => (calls++, new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } }))) });
    expect(calls).toBe(2);
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/500/);
    expect(logged()).toHaveLength(1);
    expect(logged()[0].ok).toBe(false);
  }, 10_000);

  it("bad JSON / wrong schema → error result, logged not ok", async () => {
    const r1 = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => completion({ content: "I can see a camera." })) });
    expect(r1.output).toBeNull();
    expect(r1.error).toMatch(/schema/);
    const r2 = await glimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer([{ itemKey: "lens", legible: "yes", confidence: 3 }])) });
    expect(r2.output).toBeNull();
    expect(logged().map((x) => x.ok)).toEqual([false, false]);
  });

  it("a contributor model is refused before any call", async () => {
    let called = false;
    const r = await glimmerLabelRead(ev(), cfg({ model: "accounts/fireworks/models/muse-glimmer-contributor" }), { fetch: fakeFetch(() => ((called = true), answer(cleanItems))) });
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/refused model/);
    expect(called).toBe(false);
  });

  it("no crops → no call", async () => {
    let called = false;
    const r = await glimmerLabelRead(ev({ images: [{ caption: "key frame", dataUrl: img }] }), cfg(), { fetch: fakeFetch(() => ((called = true), answer([]))) });
    expect(r.error).toMatch(/no settled-item crops/);
    expect(called).toBe(false);
  });

  it("saves a recording only with a clip id, archives crops by case, and replays it labelled RECORDED_FIXTURE", async () => {
    await glimmerLabelRead(ev({ clipId: undefined, caseId: "case_noclip" }), cfg(), { fetch: fakeFetch(() => answer(cleanItems)) });
    expect(fs.existsSync(path.join(tmp, "recordings"))).toBe(false);
    expect(loadCrops("case_noclip").map((c) => c.itemKey)).toEqual(["camera_body", "lens", "battery"]);

    const missing = await recordedGlimmerLabelRead(ev({ clipId: "clip-fw" }));
    expect(missing.output).toBeNull();
    expect(missing.mode).toBe("RECORDED_FIXTURE");

    await glimmerLabelRead(ev({ clipId: "clip-fw" }), cfg(), { fetch: fakeFetch(() => answer(cleanItems.map((i) => (i.itemKey === "lens" ? { ...i, serialRead: "BW-LN-00000" } : i)))) });
    const rep = await recordedGlimmerLabelRead(ev({ clipId: "clip-fw" }));
    expect(rep.mode).toBe("RECORDED_FIXTURE");
    expect(rep.model).toBe("accounts/fireworks/models/muse-glimmer-test");
    expect(line(merge(rep), "lens").reasons.some((x) => x.code === "serial_mismatch")).toBe(true);
  });
});

describe("helpers", () => {
  it("cropItemKey picks the item named in the caption, not a substring of another word", () => {
    const keys = ["camera_body", "lens", "battery"];
    expect(cropItemKey("crop of the counted lens as it settled", keys)).toBe("lens");
    expect(cropItemKey("crop of the counted camera_body as it settled", keys)).toBe("camera_body");
    expect(cropItemKey("crop of the lenses", keys)).toBeNull();
  });

  it("listFireworksModels lists ids from the OpenAI-compatible endpoint", async () => {
    const cap: Captured[] = [];
    const ids = await listFireworksModels(cfg(), { fetch: fakeFetch(() => new Response(JSON.stringify({ object: "list", data: [{ id: "b-model", object: "model" }, { id: "a-muse-glimmer", object: "model" }] }), { status: 200, headers: { "content-type": "application/json" } }), cap) });
    expect(ids).toEqual(["a-muse-glimmer", "b-model"]);
    expect(cap[0].url).toBe("https://api.fireworks.ai/inference/v1/models");
    await expect(listFireworksModels(fireworksConfig({} as NodeJS.ProcessEnv))).rejects.toThrow(/FIREWORKS_API_KEY/);
  });
});
