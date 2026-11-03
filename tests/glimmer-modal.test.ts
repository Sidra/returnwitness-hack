import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { crossCheckReaders, reconcile } from "@/lib/engine/reconcile";
import type { CountResult } from "@/lib/domain/schemas";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { GLIMMER_SYSTEM, LABEL_CONFIDENCE_FLOOR, type GlimmerExtras } from "@/lib/openweights/glimmer";
import {
  GLIMMER_MODAL_READER_NAME,
  MODAL_GLIMMER_DEFAULT_MODEL,
  MODAL_GLIMMER_NOT_RUN,
  modalGlimmerConfig,
  modalGlimmerHealth,
  modalGlimmerLabelRead,
  readHeldOutRow,
  type ModalGlimmerConfig,
} from "@/lib/openweights/glimmer-modal";
import { GLIMMER_READER_NAME } from "@/lib/openweights/fireworks";
import { selectLabelReader } from "@/lib/openweights/label-reader";
import { RETIRED_CONTRIBUTOR_FLAG } from "@/lib/meta/config";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-glm-"));
const LOG = path.join(tmp, "llm-calls.jsonl");
beforeAll(() => {
  process.env.RETURNWITNESS_LLM_LOG = LOG;
  process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(tmp, "recordings");
  process.env.RETURNWITNESS_CROPS_DIR = path.join(tmp, "crops");
});
beforeEach(() => fs.rmSync(LOG, { force: true }));
const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const rma = RMAS[1];
const slip = ORDERS[1].slip; // camera_body BW-CB-55120, lens BW-LN-80311, battery (no serial)
const count: CountResult = { clipId: "c", counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } };
const img = "data:image/jpeg;base64,/9j/AA==";
const ev = (over: Partial<ReaderEvidence> = {}): ReaderEvidence => ({
  rma,
  slip,
  policy: POLICY,
  count,
  images: [{ caption: "key frame at 1.0 s (overhead)", dataUrl: "data:image/jpeg;base64,KEYFRAME" }, ...["camera_body", "lens", "battery"].map((k) => ({ caption: `crop of the counted ${k} as it settled in the tray at 2.0 s (read any serial label exactly)`, dataUrl: img }))],
  caseId: "case_glm1",
  ...over,
});
const ENV = { RETURNWITNESS_LABEL_READER: "modal", MODAL_GLIMMER_URL: "https://code-happy-sf--returnwitness-glimmer-glimmer-web.modal.run", MODAL_GLIMMER_TOKEN: "tok-test" } as unknown as NodeJS.ProcessEnv;
const cfg = (over: Partial<ModalGlimmerConfig> = {}): ModalGlimmerConfig => ({ ...modalGlimmerConfig(ENV), ...over });

const cleanItems = [
  { itemKey: "camera_body", serialRead: "BW-CB-55120", skuRead: "CK-BODY-01", legible: true, confidence: 0.97 },
  { itemKey: "lens", serialRead: "BW-LN-80311", skuRead: null, legible: true, confidence: 0.93 },
  { itemKey: "battery", serialRead: null, skuRead: "CK-BATT-CHG", legible: true, confidence: 0.9 },
];

type Captured = { url: string; body: Record<string, unknown>; auth: string | null };
function fakeFetch(respond: (n: number) => Response | Promise<Response>, captured: Captured[] = []): typeof fetch {
  let n = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers);
    captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {}, auth: h.get("authorization") });
    return respond(n++);
  }) as typeof fetch;
}
const completion = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ id: "chatcmpl-modal-1", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 3100, completion_tokens: 90 }, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
const answer = (items: unknown, extra: Record<string, unknown> = { gpu_seconds: 2.481 }) => completion(JSON.stringify({ items }), extra);

const merge = (r: ReaderResult, required = false) => {
  const det = reconcile(rma, slip, count);
  return crossCheckReaders(det, [{ reader: GLIMMER_MODAL_READER_NAME, mode: r.mode, output: r.output, required, readsSerials: true }], { rma, slip }).reconciliation;
};

describe("modalGlimmerConfig", () => {
  it("is off with every missing piece named, and never guesses a URL", () => {
    const off = modalGlimmerConfig({} as NodeJS.ProcessEnv);
    expect(off).toMatchObject({ selected: false, enabled: false, url: null, token: null, model: MODAL_GLIMMER_DEFAULT_MODEL, adapter: null, timeoutMs: 15_000, maxRetries: 0 });
    expect(off.reason).toMatch(/RETURNWITNESS_LABEL_READER=modal/);
    const noUrl = modalGlimmerConfig({ RETURNWITNESS_LABEL_READER: "modal" } as unknown as NodeJS.ProcessEnv);
    expect(noUrl.enabled).toBe(false);
    expect(noUrl.reason).toMatch(/MODAL_GLIMMER_URL and MODAL_GLIMMER_TOKEN not set .*Sidra's typed OK/);
  });

  it("on with URL + token; trims a trailing slash or /v1; refuses plain http except localhost", () => {
    expect(modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_URL: "https://x.modal.run/v1/" })).toMatchObject({ enabled: true, url: "https://x.modal.run", reason: "" });
    const http = modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_URL: "http://x.modal.run" });
    expect(http.enabled).toBe(false);
    expect(http.reason).toMatch(/must be https/);
    expect(modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_URL: "http://localhost:8000" }).enabled).toBe(true);
    expect(modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_URL: "not a url" }).reason).toMatch(/not a valid URL/);
  });

  it("an adapter name must be a served-name pattern; a bad one turns the reader off rather than sending it", () => {
    expect(modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_ADAPTER: "rw-labels-2026-11-02" }).adapter).toBe("rw-labels-2026-11-02");
    const bad = modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_ADAPTER: "../../etc/passwd" });
    expect(bad.enabled).toBe(false);
    expect(bad.adapter).toBeNull();
    expect(bad.reason).toMatch(/not a served adapter name/);
  });
});

describe("modalGlimmerLabelRead", () => {
  it("not configured → not run, labelled, no call, nothing logged", async () => {
    let called = false;
    const r = await modalGlimmerLabelRead(ev(), modalGlimmerConfig({} as NodeJS.ProcessEnv), { fetch: fakeFetch(() => ((called = true), answer([]))) });
    expect(r.output).toBeNull();
    expect(r.error).toContain(MODAL_GLIMMER_NOT_RUN);
    expect(r.mode).toBe("LIVE_OPEN_WEIGHTS");
    expect(called).toBe(false);
    expect(logged()).toHaveLength(0);
  });

  it("happy path: bearer token, /v1/chat/completions, base model id, temperature 0, crops only, no slip serials; no holds", async () => {
    const cap: Captured[] = [];
    const r = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems), cap) });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ mode: "LIVE_OPEN_WEIGHTS", provider: "modal", model: MODAL_GLIMMER_DEFAULT_MODEL, requestId: "chatcmpl-modal-1" });
    expect(merge(r).summary.allClear).toBe(true);
    expect(cap[0].url).toBe("https://code-happy-sf--returnwitness-glimmer-glimmer-web.modal.run/v1/chat/completions");
    expect(cap[0].auth).toBe("Bearer tok-test");
    const body = cap[0].body as { model: string; temperature: number; response_format: unknown; messages: Array<{ content: unknown }> };
    expect(body.model).toBe(MODAL_GLIMMER_DEFAULT_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "label_reads", strict: true } });
    expect((body.response_format as { json_schema: { schema: { additionalProperties: boolean } } }).json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[0].content).toBe(GLIMMER_SYSTEM); // same prompt as the Fireworks reader and the training rows
    const parts = body.messages[1].content as Array<{ type: string }>;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("KEYFRAME");
    expect(JSON.stringify(body)).not.toContain("BW-CB-55120");
    const extras = r.extras as GlimmerExtras;
    expect(extras).toMatchObject({ confidenceFloor: LABEL_CONFIDENCE_FLOOR, adapter: null, gpuSeconds: 2.481 });
  });

  it("logs every call: provider modal, gpu_seconds as a unit, cost null (GPU time is unpriced per call), no token", async () => {
    await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems)) });
    const rec = logged()[0];
    expect(rec).toMatchObject({ provider: "modal", model: MODAL_GLIMMER_DEFAULT_MODEL, purpose: "label_read", mode: "live", ok: true, inputTokens: 3100, outputTokens: 90, costUsd: null, costMicroCents: null, units: { kind: "gpu_seconds", count: 2.481 } });
    expect(JSON.stringify(rec)).not.toContain("tok-test");
    // No gpu_seconds in the response → no units, still unpriced.
    fs.rmSync(LOG, { force: true });
    await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems, {})) });
    expect(logged()[0].units).toBeUndefined();
    expect(logged()[0].costUsd).toBeNull();
  });

  it("sends the adapter name only when MODAL_GLIMMER_ADAPTER is configured, and says so on the card", async () => {
    const cap: Captured[] = [];
    await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(cleanItems), cap) });
    expect(cap[0].body.model).toBe(MODAL_GLIMMER_DEFAULT_MODEL);
    const withAdapter = modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_ADAPTER: "rw-labels-20261102" });
    const r = await modalGlimmerLabelRead(ev(), withAdapter, { fetch: fakeFetch(() => answer(cleanItems), cap) });
    expect(cap[1].body.model).toBe("rw-labels-20261102");
    expect(r.model).toBe(`${MODAL_GLIMMER_DEFAULT_MODEL} · LoRA rw-labels-20261102`);
    expect((r.extras as GlimmerExtras).adapter).toBe("rw-labels-20261102");
    expect(logged()[1]).toMatchObject({ model: MODAL_GLIMMER_DEFAULT_MODEL });
    expect(logged()[1].input).toContain("rw-labels-20261102");
  });

  it("a wrong serial read raises serial_mismatch; an illegible one holds the line", async () => {
    const wrong = cleanItems.map((i) => (i.itemKey === "camera_body" ? { ...i, serialRead: "BW-CB-55107" } : i));
    const r1 = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(wrong)) });
    const l1 = merge(r1).lines.find((l) => l.itemKey === "camera_body")!;
    expect(l1.status).toBe("HELD");
    expect(l1.reasons.some((x) => x.code === "serial_mismatch")).toBe(true);
    const blurry = cleanItems.map((i) => (i.itemKey === "lens" ? { ...i, legible: false, confidence: 0.3 } : i));
    const r2 = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer(blurry)) });
    expect(merge(r2).lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");
  });

  it("timeout (15 s budget, no retry) → error card, logged as failed; optional reader changes nothing, required holds everything", async () => {
    let calls = 0;
    const hang = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }) as typeof fetch;
    const r = await modalGlimmerLabelRead(ev(), cfg({ timeoutMs: 30 }), { fetch: hang });
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/timed out/i);
    expect(calls).toBe(1); // maxRetries 0: a cold GPU never doubles the wait
    expect(logged()[0]).toMatchObject({ ok: false, provider: "modal", purpose: "label_read" });
    expect(merge(r).summary.allClear).toBe(true);
    expect(merge(r, true).summary.allClear).toBe(false);
  });

  it("bad JSON or a wrong schema → error card, logged not ok", async () => {
    const r1 = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => completion("The lens label says BW-LN-80311.")) });
    expect(r1.output).toBeNull();
    expect(r1.error).toMatch(/schema/);
    const r2 = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => answer([{ itemKey: "lens", legible: "yes", confidence: 7 }])) });
    expect(r2.output).toBeNull();
    const r3 = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 })) });
    expect(r3.output).toBeNull();
    expect(r3.error).toMatch(/502/);
    expect(logged().map((x) => x.ok)).toEqual([false, false, false]);
  });

  it("HTTP 401 from the endpoint (wrong token) → error card, no retry", async () => {
    let calls = 0;
    const r = await modalGlimmerLabelRead(ev(), cfg(), { fetch: fakeFetch(() => (calls++, new Response(JSON.stringify({ detail: "bad or missing bearer token" }), { status: 401, headers: { "content-type": "application/json" } }))) });
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/401/);
    expect(calls).toBe(1);
  });

  it("refuses a contributor-mode model id or adapter name before any call, even with the retired opt-in flag set", async () => {
    let called = false;
    const f = fakeFetch(() => ((called = true), answer(cleanItems)));
    const r1 = await modalGlimmerLabelRead(ev(), modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_MODEL: "meta-models/Muse-Glimmer-30B-contributor", [RETIRED_CONTRIBUTOR_FLAG]: "1" }), { fetch: f });
    expect(r1.error).toMatch(/refused model/);
    const r2 = await modalGlimmerLabelRead(ev(), modalGlimmerConfig({ ...ENV, MODAL_GLIMMER_ADAPTER: "rw-contributor-labels" }), { fetch: f });
    expect(r2.error).toMatch(/refused model/);
    expect(called).toBe(false);
    expect(logged()).toHaveLength(0);
  });

  it("no crops → no call", async () => {
    let called = false;
    const r = await modalGlimmerLabelRead(ev({ images: [{ caption: "key frame", dataUrl: img }] }), cfg(), { fetch: fakeFetch(() => ((called = true), answer([]))) });
    expect(r.error).toMatch(/no settled-item crops/);
    expect(called).toBe(false);
  });
});

describe("held-out reads and health", () => {
  const row = { rowId: "r1", itemKey: "lens", messages: [{ role: "system" as const, content: GLIMMER_SYSTEM }, { role: "user" as const, content: [{ type: "text" as const, text: "Crop 1 · itemKey=lens" }] }] };

  it("readHeldOutRow sends the row's own turns with the requested model, picks the row's item, and keeps gpu_seconds", async () => {
    const cap: Captured[] = [];
    const rec = await readHeldOutRow(row, "rw-labels-x", cfg(), { fetch: fakeFetch(() => answer(cleanItems), cap) });
    expect(cap[0].body.model).toBe("rw-labels-x");
    expect(cap[0].body.temperature).toBe(0);
    expect(rec).toMatchObject({ rowId: "r1", read: { itemKey: "lens", serialRead: "BW-LN-80311" }, gpuSeconds: 2.481 });
  });

  it("readHeldOutRow turns failures into an error record, refuses a drifted system prompt and a contributor model", async () => {
    expect((await readHeldOutRow(row, MODAL_GLIMMER_DEFAULT_MODEL, cfg(), { fetch: fakeFetch(() => completion("nope")) })).error).toMatch(/schema/);
    expect((await readHeldOutRow({ ...row, messages: [{ role: "system", content: "old prompt" }, row.messages[1]] }, MODAL_GLIMMER_DEFAULT_MODEL, cfg(), { fetch: fakeFetch(() => answer(cleanItems)) })).error).toMatch(/system prompt differs/);
    expect((await readHeldOutRow(row, "x-contributor", cfg(), { fetch: fakeFetch(() => answer(cleanItems)) })).error).toMatch(/refused model/);
    expect((await readHeldOutRow(row, "m", modalGlimmerConfig({} as NodeJS.ProcessEnv))).error).toMatch(/not set/);
  });

  it("modalGlimmerHealth GETs /healthz without a token", async () => {
    const cap: Captured[] = [];
    const h = await modalGlimmerHealth(cfg(), { fetch: fakeFetch(() => new Response(JSON.stringify({ ok: true, model: MODAL_GLIMMER_DEFAULT_MODEL, gpu: "NVIDIA L40S", adapters: [] }), { status: 200 }), cap) });
    expect(cap[0].url).toMatch(/\/healthz$/);
    expect(cap[0].auth).toBeNull();
    expect(h).toMatchObject({ ok: true, status: 200, body: { gpu: "NVIDIA L40S" } });
    await expect(modalGlimmerHealth({ url: null })).rejects.toThrow(/MODAL_GLIMMER_URL/);
  });
});

describe("selectLabelReader (runtime precedence)", () => {
  const FW = { FIREWORKS_API_KEY: "fw-test", FIREWORKS_GLIMMER_MODEL: "accounts/fireworks/models/muse-glimmer-test" };

  it("modal takes precedence: with =modal, Fireworks is never chosen even with every Fireworks variable set", () => {
    const l = selectLabelReader({ ...ENV, ...FW } as unknown as NodeJS.ProcessEnv);
    expect(l).toMatchObject({ provider: "modal", enabled: true, readerName: GLIMMER_MODAL_READER_NAME, model: MODAL_GLIMMER_DEFAULT_MODEL, adapter: null, reason: "" });
    expect(l.read).toBeTypeOf("function");
    expect(l.status).toMatch(/only once a real call succeeds/);
  });

  it("=modal without URL/token is off on this server and does NOT fall back to Fireworks", () => {
    const l = selectLabelReader({ RETURNWITNESS_LABEL_READER: "modal", ...FW } as unknown as NodeJS.ProcessEnv);
    expect(l).toMatchObject({ provider: "modal", enabled: false, read: null });
    expect(l.reason).toContain(MODAL_GLIMMER_NOT_RUN);
    expect(l.status).toMatch(/deployed \(vLLM FP8 on an L40S\) and evaluated; off on this server/);
  });

  it("=fireworks keeps the Fireworks reader exactly as written; nothing selected says both states honestly", () => {
    const fw = selectLabelReader({ RETURNWITNESS_LABEL_READER: "fireworks", ...FW } as unknown as NodeJS.ProcessEnv);
    expect(fw).toMatchObject({ provider: "fireworks", enabled: true, readerName: GLIMMER_READER_NAME });
    const fwOff = selectLabelReader({ RETURNWITNESS_LABEL_READER: "fireworks" } as unknown as NodeJS.ProcessEnv);
    expect(fwOff.status).toMatch(/not configured \(no Fireworks credits\)/);
    const none = selectLabelReader({} as NodeJS.ProcessEnv);
    expect(none).toMatchObject({ provider: null, enabled: false, read: null });
    expect(none.status).toBe("Muse Glimmer on Modal: deployed (vLLM FP8 on an L40S) and evaluated; off on this server. Fireworks: not configured (no Fireworks credits)");
  });

  it("the adapter shows in the model line once configured", () => {
    expect(selectLabelReader({ ...ENV, MODAL_GLIMMER_ADAPTER: "rw-labels-1" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ adapter: "rw-labels-1", model: `${MODAL_GLIMMER_DEFAULT_MODEL} · LoRA rw-labels-1` });
  });
});

describe("pipelineDeps wiring", () => {
  afterEach(() => vi.unstubAllEnvs());
  const stubAll = (env: Record<string, string>) => {
    for (const k of ["RETURNWITNESS_LABEL_READER", "MODAL_GLIMMER_URL", "MODAL_GLIMMER_TOKEN", "MODAL_GLIMMER_ADAPTER", "FIREWORKS_API_KEY", "FIREWORKS_GLIMMER_MODEL"]) vi.stubEnv(k, env[k] ?? "");
  };

  it("a live clip with =modal gets the Modal reader (optional, readsSerials), not Fireworks", async () => {
    stubAll({ RETURNWITNESS_LABEL_READER: "modal", MODAL_GLIMMER_URL: "https://x.modal.run", MODAL_GLIMMER_TOKEN: "t", FIREWORKS_API_KEY: "k", FIREWORKS_GLIMMER_MODEL: "m" });
    const { pipelineDeps, systemStatus } = await import("@/lib/runtime");
    const d = pipelineDeps({ liveModels: false, liveSegmentation: true });
    const r = d.readers.find((x) => /glimmer/.test(x.name));
    expect(r).toMatchObject({ name: GLIMMER_MODAL_READER_NAME, required: false, readsSerials: true });
    expect(d.readers.some((x) => x.name === GLIMMER_READER_NAME)).toBe(false);
    expect(systemStatus().labelReader).toMatchObject({ enabled: true, provider: "modal", model: MODAL_GLIMMER_DEFAULT_MODEL });
  });

  it("off on this server → skipped with the plain reason; Settings status says it is off here", async () => {
    stubAll({ RETURNWITNESS_LABEL_READER: "modal" });
    const { pipelineDeps, systemStatus } = await import("@/lib/runtime");
    const d = pipelineDeps({ liveModels: false, liveSegmentation: true });
    expect(d.readers.some((x) => /glimmer/.test(x.name))).toBe(false);
    expect(d.skippedReaders?.find((x) => x.name === "muse-glimmer")?.reason).toContain(MODAL_GLIMMER_NOT_RUN);
    expect(systemStatus().labelReader).toMatchObject({ enabled: false, provider: "modal" });
    expect(systemStatus().labelReader.status).toMatch(/off on this server/);
  });
});

describe("Glimmer's JSON-mode channel envelope (first live read)", () => {
  it("takes the answer from {self, user} and keeps self as reasoning", async () => {
    const { parseGlimmerMessage } = await import("@/lib/openweights/glimmer");
    const content = JSON.stringify({ self: "Crop 1 is camera_body label. Serial likely BW-CB-55120.", user: { items: [{ itemKey: "camera_body", serialRead: "BW-CB-55120", skuRead: "CK-BODY-01", legible: true, confidence: 0.99 }] } });
    const r = parseGlimmerMessage({ content });
    expect(r.read?.items[0]).toMatchObject({ serialRead: "BW-CB-55120", legible: true });
    expect(r.source).toBe("json-envelope");
    expect(r.reasoning).toContain("Serial likely");
    expect(r.answer).not.toContain("Serial likely");
  });
  it("accepts user given as a JSON string; refuses an object with other keys or no user", async () => {
    const { parseGlimmerMessage, unwrapChannelEnvelope } = await import("@/lib/openweights/glimmer");
    const inner = { items: [{ itemKey: "lens", serialRead: null, skuRead: null, legible: false, confidence: 0.2 }] };
    expect(parseGlimmerMessage({ content: JSON.stringify({ self: "hard to read", user: JSON.stringify(inner) }) }).read?.items[0].legible).toBe(false);
    expect(unwrapChannelEnvelope({ self: "x", user: inner, extra: 1 })).toBeNull();
    expect(unwrapChannelEnvelope({ self: "x" })).toBeNull();
    expect(unwrapChannelEnvelope({ user: "not json" })).toBeNull();
    // A plain answer is unchanged.
    expect(parseGlimmerMessage({ content: JSON.stringify(inner) }).source).toBe("none");
  });
  it("the strict schema requires every key and allows null serial/sku", async () => {
    const { GLIMMER_RESPONSE_FORMAT } = await import("@/lib/openweights/glimmer");
    const item = (GLIMMER_RESPONSE_FORMAT.json_schema.schema as { properties: { items: { items: { required: string[]; properties: Record<string, unknown> } } } }).properties.items.items;
    expect([...item.required].sort()).toEqual(["confidence", "itemKey", "legible", "serialRead", "skuRead"]);
    expect(JSON.stringify(item.properties.serialRead)).toContain("null");
  });
});
