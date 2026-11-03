import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metaConfig } from "@/lib/meta/config";
import { hasAudioStream, toTranscribeWav, transcribeFile, transcribeRequest, transcribeWav, VoiceTranscribeError } from "@/lib/meta/voice";
import { generateIllustration, IMAGE_TOOL_ENABLEMENT, ILLUSTRATION_LABEL, illustrationPrompt } from "@/lib/meta/image";
import { KIT } from "@/data/kit.config";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-voice-test-"));
const LOG = path.join(tmp, "llm-calls.jsonl");
const cfg = metaConfig({ META_HACK_API_KEY: "test-key", META_BASE_URL: "https://api.meta.test/v1" } as unknown as NodeJS.ProcessEnv);
const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function tone(seconds: number, file: string, withVideo = false) {
  const args = withVideo
    ? ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-f", "lavfi", "-i", `color=c=gray:s=64x48:d=${seconds}`, "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", file]
    : ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", file];
  execFileSync("ffmpeg", args);
  return file;
}

beforeEach(() => {
  process.env.RETURNWITNESS_LLM_LOG = LOG;
  fs.rmSync(LOG, { force: true });
});
afterEach(() => {
  delete process.env.RETURNWITNESS_LLM_LOG;
});

describe("Muse Voice Transcribe adapter (POST /asr/transcribe, multipart, WAV only)", () => {
  it("converts any audio/video to mono 16 kHz 16-bit WAV and measures its length", () => {
    const { wavPath, durationMs } = toTranscribeWav(tone(1.5, path.join(tmp, "note.m4a")), tmp);
    const head = fs.readFileSync(wavPath).subarray(0, 44);
    expect(head.toString("ascii", 0, 4)).toBe("RIFF");
    expect(head.toString("ascii", 8, 12)).toBe("WAVE");
    expect(head.readUInt16LE(22)).toBe(1); // mono
    expect(head.readUInt32LE(24)).toBe(16000); // 16 kHz
    expect(head.readUInt16LE(34)).toBe(16); // 16-bit
    expect(durationMs).toBeGreaterThan(1300);
    expect(durationMs).toBeLessThan(1700);
  });

  it("knows whether a clip carries audio", () => {
    expect(hasAudioStream(tone(0.5, path.join(tmp, "with-audio.mp4"), true))).toBe(true);
    const silent = path.join(tmp, "silent.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x48:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    expect(hasAudioStream(silent)).toBe(false);
  });

  it("sends the documented multipart request and returns a LIVE voice note, billed by whole seconds", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ sessionId: "sess-9f1c", transcript: " Lens cap is missing, box corner crushed. ", audioDurationMs: 8240, turns: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { wavPath } = toTranscribeWav(tone(1, path.join(tmp, "n2.m4a")), tmp);
    const note = await transcribeWav(wavPath, cfg, { fetch: fakeFetch, keywords: KIT.items.map((i) => i.name), caseId: "case_t", person: "Rita" });
    expect(seen!.url).toBe("https://api.meta.test/v1/asr/transcribe");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const form = seen!.init.body as FormData;
    const req = JSON.parse(await (form.get("request") as Blob).text());
    expect(req).toMatchObject({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" });
    expect(req.keywords).toEqual(KIT.items.map((i) => i.name));
    expect((form.get("audio") as Blob).type).toBe("audio/wav");
    expect(note).toMatchObject({ transcript: "Lens cap is missing, box corner crushed.", mode: "LIVE_META", model: "muse-voice-transcribe-1.0", audioDurationMs: 8240, requestId: "sess-9f1c", person: "Rita" });
    const [rec] = logged();
    expect(rec).toMatchObject({ provider: "meta", purpose: "voice_note", ok: true, units: { kind: "audio_seconds", count: 8 } });
    expect(rec.costUsd).toBeCloseTo((8 * 0.18) / 3600, 10);
  });

  it("an HTTP error is a typed failure, logged as not billed, never an empty transcript", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: { message: "unsupported WAV" } }), { status: 400 })) as unknown as typeof fetch;
    const { wavPath } = toTranscribeWav(tone(1, path.join(tmp, "n3.m4a")), tmp);
    await expect(transcribeWav(wavPath, cfg, { fetch: fakeFetch })).rejects.toMatchObject({ status: 400 });
    const [rec] = logged();
    expect(rec).toMatchObject({ ok: false, costUsd: null });
    expect(rec.error).toMatch(/HTTP 400/);
  });

  it("rejects a malformed 200 body and a missing key", async () => {
    const bad = (async () => new Response(JSON.stringify({ text: "wrong field" }), { status: 200 })) as unknown as typeof fetch;
    const { wavPath } = toTranscribeWav(tone(1, path.join(tmp, "n4.m4a")), tmp);
    await expect(transcribeWav(wavPath, cfg, { fetch: bad })).rejects.toThrow(VoiceTranscribeError);
    const noKey = metaConfig({} as NodeJS.ProcessEnv);
    await expect(transcribeWav(wavPath, noKey, { fetch: bad })).rejects.toThrow(/META_HACK_API_KEY/);
  });

  it("refuses a contributor model id before any request", async () => {
    let called = false;
    const fakeFetch = (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch;
    const c = metaConfig({ META_HACK_API_KEY: "k", META_MODEL_VOICE: "muse-voice-transcribe-1.0-contributor" } as unknown as NodeJS.ProcessEnv);
    const { wavPath } = toTranscribeWav(tone(1, path.join(tmp, "n5.m4a")), tmp);
    await expect(transcribeWav(wavPath, c, { fetch: fakeFetch })).rejects.toThrow(/refused model/);
    expect(called).toBe(false);
  });

  it("a near-silent file is refused before any paid call", async () => {
    let called = false;
    const fakeFetch = (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch;
    await expect(transcribeFile(tone(0.1, path.join(tmp, "blip.m4a")), cfg, { fetch: fakeFetch })).rejects.toThrow(/no audible note/);
    expect(called).toBe(false);
  });

  it("the request part carries no undocumented fields", () => {
    expect(Object.keys(transcribeRequest("m", ["lens"])).sort()).toEqual(["audioEncoding", "keywords", "languageBias", "mode", "model"]);
    expect(transcribeRequest("m")).not.toHaveProperty("keywords");
  });
});

describe("Muse Image adapter (generic, unbranded illustration only)", () => {
  const items = KIT.items.map((i) => ({ concept: i.genericName, qty: 1 }));

  it("builds the prompt only from generic concepts and forbids logos, brands and text", () => {
    const p = illustrationPrompt(items);
    for (const i of KIT.items) {
      expect(p).toContain(`generic ${i.genericName}`);
      expect(p).not.toContain(i.name === i.genericName ? "\u0000" : i.sku);
    }
    expect(p).toMatch(/No logos, no brand names, no text/);
    expect(p).toMatch(/not a photograph of any real product/);
  });

  it("refuses a brand-like concept and an empty kit", () => {
    expect(() => illustrationPrompt([{ concept: "Leica lens", qty: 1 }])).toThrow(/brand-like/);
    expect(() => illustrationPrompt([])).toThrow();
  });

  it("calls /images/generations with the documented body, labels the result, logs $0.01", async () => {
    let body: Record<string, unknown> | null = null;
    const client = { images: { generate: async (b: Record<string, unknown>) => ((body = b), { created: 1, data: [{ b64_json: Buffer.from("img").toString("base64") }] }) } };
    const ill = await generateIllustration("camera-kit", items, cfg, { client: client as never, save: false });
    expect(body).toMatchObject({ model: "muse-image-1.0", n: 1, response_format: "b64_json", output_format: "webp" });
    expect(ill).toMatchObject({ mode: "LIVE_META", label: ILLUSTRATION_LABEL, kitId: "camera-kit" });
    expect(ill.imagePath.startsWith("data:image/webp;base64,")).toBe(true);
    const [rec] = logged();
    expect(rec).toMatchObject({ purpose: "illustration", ok: true, costUsd: 0.01, units: { kind: "images", count: 1 } });
  });

  it("turns image search, web search and shell OFF on every request (no real product as a reference)", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = { images: { generate: async (b: Record<string, unknown>) => (bodies.push(b), { created: 1, data: [{ b64_json: Buffer.from("img").toString("base64") }] }) } };
    await generateIllustration("camera-kit", items, cfg, { client: client as never, save: false });
    await generateIllustration("camera-kit", [{ concept: "battery charger", qty: 2 }], cfg, { client: client as never, save: false });
    for (const b of bodies) expect(b.tool_enablement).toEqual({ enable_image_search: false, enable_web_search: false, enable_shell: false });
    expect(Object.isFrozen(IMAGE_TOOL_ENABLEMENT)).toBe(true);
    // the logged input carries the same switches, so the spend log shows they were off
    expect(JSON.stringify(bodies[0])).toContain('"enable_image_search":false');
  });

  it("an empty image answer is an error, logged unbilled", async () => {
    const client = { images: { generate: async () => ({ data: [] }) } };
    await expect(generateIllustration("camera-kit", items, cfg, { client: client as never, save: false })).rejects.toThrow(/no image/);
    expect(logged()[0]).toMatchObject({ ok: false, costUsd: null });
  });
});

describe("Voice vocabulary biasing from the kit file", () => {
  it("names, concepts, SKUs, kit + merchant, serial prefixes and bench terms; deduped; capped at 50", async () => {
    const { KIT } = await import("@/data/kit.config");
    const { kitVocabulary, transcribeRequest, MAX_KEYWORDS } = await import("@/lib/meta/voice");
    const v = kitVocabulary(KIT);
    for (const i of KIT.items) for (const w of [i.name, i.genericName, i.sku]) expect(v).toContain(w);
    expect(v).toEqual(expect.arrayContaining([KIT.kitName, KIT.merchantName, "BW-CB", "BW-LN", "lens cap", "battery door"]));
    expect(new Set(v.map((w) => w.toLowerCase())).size).toBe(v.length);
    expect(v.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    expect(transcribeRequest("muse-voice-transcribe-1.0", v)).toMatchObject({ keywords: v, languageBias: ["English"] });
  });

  it("never biases toward a full serial (a misheard serial must not become a match)", async () => {
    const { KIT } = await import("@/data/kit.config");
    const { kitVocabulary } = await import("@/lib/meta/voice");
    const v = kitVocabulary(KIT);
    for (const i of KIT.items) for (const s of [i.serials.complete, i.serials.missingCase]) if (s) expect(v).not.toContain(s);
    const serials = KIT.items.flatMap((i) => [i.serials.complete, i.serials.missingCase]).filter(Boolean);
    expect(v.some((w) => serials.some((s) => w.includes(s) || s.endsWith(w.split("-").at(-1) ?? "#")))).toBe(false);
  });
});
