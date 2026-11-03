import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SegmentationResult } from "@/lib/domain/schemas";
import { RETIRED_CONTRIBUTOR_FLAG } from "@/lib/meta/config";
import { loadRecording } from "@/lib/meta/recordings";
import { SamParseError } from "@/lib/meta/sam";
import { FailoverSegmenter } from "@/lib/vision/failover-segmenter";
import { MAX_CLIP_BYTES, modalResponseToFrames, modalSamConfig, ModalSamHttpError, ModalSamResponse, ModalSamSegmenter, withModalFailover, type ModalSamConfig } from "@/lib/openweights/modal-sam";
import type { Segmenter } from "@/lib/vision/segmenter";
import type { LlmCallRecord } from "@/lib/obs/llm-log";

// No test here touches the network: every fetch is a mock, and the URL is a reserved .invalid host.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rw-modal-sam-"));
const LOG = path.join(TMP, "llm-calls.jsonl");
const CLIP = path.join(TMP, "clip.mp4");

beforeAll(() => {
  process.env.RETURNWITNESS_LLM_LOG = LOG;
  process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(TMP, "recordings");
  fs.writeFileSync(CLIP, Buffer.from("not really an mp4, the endpoint is mocked"));
});
beforeEach(() => fs.rmSync(LOG, { force: true }));
afterEach(() => vi.unstubAllGlobals());

const ENV = { RETURNWITNESS_SAM_FAILOVER: "modal", MODAL_SAM_URL: "https://rw-sam31.modal.invalid/", MODAL_SAM_TOKEN: "tok-123" } as unknown as NodeJS.ProcessEnv;
const cfg = (over: Partial<ModalSamConfig> = {}): ModalSamConfig => ({ ...modalSamConfig(ENV), ...over });
const logged = (): LlmCallRecord[] => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A contract-shaped answer: camera settles at frame 1, a hand passes on frame 0, one object for an unrequested concept. */
const GOOD = {
  width: 1280,
  height: 720,
  model: "facebook/sam3.1",
  gpu_seconds: 4.2,
  request_id: "req-abc",
  frames: [
    { frame_index: 0, objects: [{ track_id: 7, concept: "hand", box: [100, 100, 260, 300], score: 0.95 }] },
    { frame_index: 1, objects: [{ track_id: 1, concept: "film camera", box: [870, 180, 972, 240], score: 0.91, area: 5000 }, { track_id: 2, concept: "toaster", box: [0, 0, 10, 10], score: 0.5 }] },
    { frame_index: 2, objects: [] },
  ],
};

const jsonRes = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input = (over: Record<string, unknown> = {}) => ({ clipId: "rma-test-modal", videoPath: CLIP, concepts: ["film camera", "hand"], fps: 5, caseId: "case-1", ...over });

describe("modalSamConfig", () => {
  it("is off with a plain reason when the failover flag isn't 'modal'", () => {
    const c = modalSamConfig({} as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.reason).toMatch(/RETURNWITNESS_SAM_FAILOVER is not set/);
    expect(modalSamConfig({ ...ENV, RETURNWITNESS_SAM_FAILOVER: "baseten" }).reason).toMatch(/"baseten"/);
  });
  it("names exactly what is missing", () => {
    expect(modalSamConfig({ RETURNWITNESS_SAM_FAILOVER: "modal" } as unknown as NodeJS.ProcessEnv).reason).toMatch(/MODAL_SAM_URL and MODAL_SAM_TOKEN not set/);
    expect(modalSamConfig({ ...ENV, MODAL_SAM_TOKEN: " " }).reason).toMatch(/MODAL_SAM_TOKEN not set/);
  });
  it("refuses a non-https URL (except localhost) and a malformed one", () => {
    expect(modalSamConfig({ ...ENV, MODAL_SAM_URL: "http://example.modal.run" }).reason).toMatch(/must be https/);
    expect(modalSamConfig({ ...ENV, MODAL_SAM_URL: "not a url" }).reason).toMatch(/not a valid URL/);
    expect(modalSamConfig({ ...ENV, MODAL_SAM_URL: "http://localhost:8000" }).enabled).toBe(true);
  });
  it("is on with defaults, trims the trailing slash, and parses the primary timeout", () => {
    const c = modalSamConfig(ENV);
    expect(c).toMatchObject({ enabled: true, url: "https://rw-sam31.modal.invalid", token: "tok-123", model: "facebook/sam3.1", timeoutMs: 60_000, reason: "" });
    expect(modalSamConfig({ ...ENV, RETURNWITNESS_SAM_TIMEOUT_MS: "1500", MODAL_SAM_MODEL: "facebook/sam3.1-large" })).toMatchObject({ timeoutMs: 1500, model: "facebook/sam3.1-large" });
    expect(modalSamConfig({ ...ENV, RETURNWITNESS_SAM_TIMEOUT_MS: "-3" }).timeoutMs).toBe(60_000);
    expect(modalSamConfig({ ...ENV, RETURNWITNESS_SAM_TIMEOUT_MS: "soon" }).timeoutMs).toBe(60_000);
  });
  it("the segmenter can't be built without a URL and token", () => {
    expect(() => new ModalSamSegmenter(modalSamConfig({} as NodeJS.ProcessEnv))).toThrow(/not configured/);
  });
});

describe("contract parsing", () => {
  it("turns a frame-major pixel response into normalised, concept-namespaced frames", () => {
    const { frames, dropped } = modalResponseToFrames(ModalSamResponse.parse(GOOD), ["film camera", "hand"], 5);
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2]);
    expect(dropped).toBe(1);
    const cam = frames[1].masks.find((m) => m.concept === "film camera")!;
    expect(cam.trackId).toBe("film camera#1");
    expect(cam.bbox.map((v) => Number(v.toFixed(4)))).toEqual([0.6797, 0.25, 0.0797, 0.0833]);
    expect(cam.area).toBeCloseTo(5000 / (1280 * 720), 6);
    expect(frames[0].masks[0]).toMatchObject({ trackId: "hand#7", concept: "hand", score: 0.95 });
    expect(frames[2].masks).toEqual([]);
    expect(frames[1].t).toBe(0.2);
  });
  it("normalises a tiny pixel box near the origin correctly (no pixel/normalised guess)", () => {
    const res = ModalSamResponse.parse({ ...GOOD, frames: [{ frame_index: 0, objects: [{ track_id: 1, concept: "hand", box: [0, 0, 1, 1], score: 1 }] }] });
    const m = modalResponseToFrames(res, ["hand"], 5).frames[0].masks[0];
    expect(m.bbox[2]).toBeCloseTo(1 / 1280, 8);
  });
  it("clamps boxes to the frame and drops degenerate ones", () => {
    const res = ModalSamResponse.parse({ ...GOOD, frames: [{ frame_index: 0, objects: [{ track_id: 1, concept: "hand", box: [1200, 600, 1400, 900], score: 2 }, { track_id: 2, concept: "hand", box: [50, 50, 50, 80], score: 1 }] }] });
    const ms = modalResponseToFrames(res, ["hand"], 5).frames[0].masks;
    expect(ms).toHaveLength(1);
    expect(ms[0].bbox[0] + ms[0].bbox[2]).toBeCloseTo(1, 8);
    expect(ms[0].score).toBe(1);
  });
});

describe("ModalSamSegmenter.segment", () => {
  it("POSTs the contract with the bearer token, returns LIVE_OPEN_WEIGHTS frames, logs and records the run", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonRes(GOOD));
    const seg = new ModalSamSegmenter(cfg(), { fetch: fetchMock as unknown as typeof fetch });
    const r = await seg.segment(input());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://rw-sam31.modal.invalid/segment");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ clipId: "rma-test-modal", fps: 5, concepts: ["film camera", "hand"] });
    expect(Buffer.from(body.video_b64, "base64").toString()).toMatch(/not really an mp4/);

    expect(SegmentationResult.parse(r)).toBeTruthy();
    expect(r.source).toMatchObject({ mode: "LIVE_OPEN_WEIGHTS", model: "facebook/sam3.1", requestIds: ["req-abc"] });
    expect(r.source.provenance).toMatch(/^SAM 3\.1 open weights on Modal \(failover\), 2 concepts, \d+ ms \(1 objects for unrequested concepts dropped\)$/);
    expect(r.frames).toHaveLength(3);
    expect(r.durationS).toBeCloseTo(0.6, 6);
    expect([seg.name, seg.mode]).toEqual(["sam-3.1 open weights (Modal GPU)", "LIVE_OPEN_WEIGHTS"]);

    const [rec] = logged();
    expect(rec).toMatchObject({ provider: "modal", model: "facebook/sam3.1", purpose: "segment", mode: "live", ok: true, units: { kind: "gpu_seconds", count: 4.2 }, costUsd: null, costMicroCents: null, caseId: "case-1" });
    expect(rec.input).not.toMatch(/video_b64|bm90IHJlYWxseQ/);
    expect(rec.input).toMatch(/rw-sam31\.modal\.invalid\/segment/);
    expect(rec.input).not.toMatch(/tok-123/);

    const saved = loadRecording<SegmentationResult>("rma-test-modal", "sam-modal");
    expect(saved!.data.source.mode).toBe("LIVE_OPEN_WEIGHTS");
  });

  it("works through the global fetch too (vi.stubGlobal)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ ...GOOD, gpu_seconds: undefined })));
    const r = await new ModalSamSegmenter(cfg()).segment(input({ clipId: "rma-test-modal-2" }));
    expect(r.frames.length).toBe(3);
    expect(logged()[0].units).toBeUndefined();
  });

  it("401 → throws with the status and a short body, logged as a failed call", async () => {
    const seg = new ModalSamSegmenter(cfg(), { fetch: (async () => jsonRes({ detail: "bad token" }, 401)) as unknown as typeof fetch });
    const err = await seg.segment(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ModalSamHttpError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/HTTP 401: \{"detail":"bad token"\}/);
    expect(logged()).toEqual([expect.objectContaining({ provider: "modal", ok: false, error: expect.stringMatching(/HTTP 401/) })]);
  });

  it("500 → throws, and a long error body is cut short", async () => {
    const seg = new ModalSamSegmenter(cfg(), { fetch: (async () => new Response(`Traceback ${"x".repeat(5000)}`, { status: 500 })) as unknown as typeof fetch });
    const err = await seg.segment(input()).catch((e) => e);
    expect(err.message).toMatch(/HTTP 500: Traceback x+/);
    expect(err.message.length).toBeLessThan(260);
    expect(logged()[0].ok).toBe(false);
  });

  it("times out a hung endpoint, aborting the request", async () => {
    let seen: AbortSignal | undefined;
    const hang = ((_u: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const seg = new ModalSamSegmenter(cfg(), { fetch: hang, requestTimeoutMs: 30 });
    await expect(seg.segment(input())).rejects.toThrow(/timed out after 30 ms/);
    expect(seen?.aborted).toBe(true);
    expect(logged()[0]).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
  });

  it("respects the caller's abort signal", async () => {
    const ctl = new AbortController();
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const p = new ModalSamSegmenter(cfg(), { fetch: hang }).segment(input({ signal: ctl.signal }));
    ctl.abort(new Error("failover budget spent"));
    await expect(p).rejects.toThrow(/aborted by caller \(failover budget spent\)/);
  });

  it("bad shape → SamParseError (never a silent empty result)", async () => {
    for (const bad of [{ frames: [], width: 1280, height: 720, model: "m" }, { frames: [{ frame_index: 0, objects: [{ track_id: 1, concept: "hand", box: [1, 2, 3], score: 1 }] }], width: 1280, height: 720, model: "m" }, { width: 1280 }]) {
      const seg = new ModalSamSegmenter(cfg(), { fetch: (async () => jsonRes(bad)) as unknown as typeof fetch });
      await expect(seg.segment(input())).rejects.toBeInstanceOf(SamParseError);
    }
    const seg = new ModalSamSegmenter(cfg(), { fetch: (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch });
    await expect(seg.segment(input())).rejects.toThrow(/not JSON/);
    expect(logged().every((r) => !r.ok)).toBe(true);
    expect(logged()).toHaveLength(4);
  });

  it("refuses an oversize clip before any request", async () => {
    const fetchMock = vi.fn();
    const seg = new ModalSamSegmenter(cfg(), { fetch: fetchMock as unknown as typeof fetch, maxClipBytes: 8 });
    await expect(seg.segment(input())).rejects.toThrow(/takes at most .* MB \(prepare it to 5 fps/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ ok: false });
    expect(MAX_CLIP_BYTES).toBe(25 * 1024 * 1024);
  });

  it("refuses a contributor-mode model before any request, with no opt-in", async () => {
    const fetchMock = vi.fn(async () => jsonRes(GOOD));
    const seg = new ModalSamSegmenter(cfg({ model: "facebook/sam3.1-contributor" }), { fetch: fetchMock as unknown as typeof fetch });
    await expect(seg.segment(input())).rejects.toThrow(/refused model "facebook\/sam3\.1-contributor"/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()[0]).toMatchObject({ ok: false, model: "facebook/sam3.1-contributor" });
    process.env[RETIRED_CONTRIBUTOR_FLAG] = "1";
    try {
      await expect(seg.segment(input({ clipId: "rma-test-modal-3" }))).rejects.toThrow(/refused model/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env[RETIRED_CONTRIBUTOR_FLAG];
    }
  });

  it("refuses a response from a contributor model even when we asked for the normal one", async () => {
    const seg = new ModalSamSegmenter(cfg(), { fetch: (async () => jsonRes({ ...GOOD, model: "sam3.1-contributor" })) as unknown as typeof fetch });
    await expect(seg.segment(input())).rejects.toThrow(/refused model/);
  });

  it("needs a prepared clip, concepts, and an existing file; every refusal is logged", async () => {
    const seg = new ModalSamSegmenter(cfg(), { fetch: vi.fn() as unknown as typeof fetch });
    await expect(seg.segment(input({ videoPath: undefined }))).rejects.toThrow(/prepared clip/);
    await expect(seg.segment(input({ concepts: [] }))).rejects.toThrow(/no concepts/);
    await expect(seg.segment(input({ videoPath: path.join(TMP, "missing.mp4") }))).rejects.toThrow(/ENOENT/);
    expect(logged().map((r) => r.ok)).toEqual([false, false, false]);
  });
});

describe("withModalFailover", () => {
  const primary: Segmenter = { name: "sam-3.1 (Meta Model API)", mode: "LIVE_META", segment: async () => Promise.reject(new Error("503 from api.meta.ai")) };
  it("returns the primary untouched when the failover is off", () => {
    expect(withModalFailover(primary, {} as NodeJS.ProcessEnv)).toBe(primary);
  });
  it("wraps Meta → Modal when on, with the configured primary budget, and a Meta outage lands on Modal", async () => {
    const s = withModalFailover(primary, { ...ENV, RETURNWITNESS_SAM_TIMEOUT_MS: "5000" }, { fetch: (async () => jsonRes(GOOD)) as unknown as typeof fetch });
    expect(s).toBeInstanceOf(FailoverSegmenter);
    expect(s.name).toBe("sam-3.1 (Meta Model API) → sam-3.1 open weights (Modal GPU) on failure");
    const r = await s.segment(input({ clipId: "rma-test-modal-4" }));
    expect(r.source.mode).toBe("LIVE_OPEN_WEIGHTS");
    expect(r.source.provenance).toMatch(/^failover: sam-3\.1 \(Meta Model API\) failed \(503 from api\.meta\.ai\) → SAM 3\.1 open weights on Modal/);
  });
});
