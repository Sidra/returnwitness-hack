import { describe, expect, it } from "vitest";
import { decodeMaskToRaster } from "@meta-sam/parser";
import { eventsFromText, parseSamTokenStream, recordsToFrames, samVideoRequest, SamTokenError } from "@/lib/meta/sam-tokens";
import { samRequestBody } from "@/lib/meta/sam";
import { countClip } from "@/lib/vision/tray-counter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { KIT } from "@/data/kit.config";

// Frame 0 exactly as Meta's docs print it (https://dev.meta.ai/docs/sam/reading-segmentation):
// a 320×334 source, prompt "button", object ids 0 and 1.
const MASK0 = "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
const MASK1 = "<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>";
const BOX0 = "<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>";
const BOX1 = "<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>";
const line = (f: number, conf = "") => `<${f}f>0${conf ? BOX0.replace("|>", `;c=${conf}|>`) : BOX0}${MASK0},1${BOX1}${MASK1}\n`;
const opts = { concept: "button", fps: 5, width: 320, height: 334 };

async function* split(text: string, at: number) {
  const lane = { item_id: "message-1", output_index: 0, content_index: 0 };
  yield { type: "response.created", response: { id: "resp_123" } };
  yield { type: "response.output_text.delta", ...lane, delta: text.slice(0, at) };
  yield { type: "response.output_text.delta", ...lane, delta: text.slice(at) };
  yield { type: "response.output_text.done", ...lane, text };
  yield { type: "response.completed" };
}

describe("SAM 3.1 token output (Meta's documented format)", () => {
  it("parses the docs' frame 0 into two objects with normalised boxes, even split inside a mask", async () => {
    const text = line(0);
    const p = await parseSamTokenStream(split(text, text.indexOf("0c[q=") + 3), opts);
    expect(p.frames).toHaveLength(1);
    expect(p.objects).toBe(2);
    const [a, b] = p.frames[0].masks;
    expect(a.trackId).toBe("0");
    expect(a.concept).toBe("button");
    // x2/y2 are inclusive pixels (Meta's parser reports half-open bounds), so the box is 60×27 px: the mask raster's own size.
    expect(a.bbox.map((v) => +v.toFixed(4))).toEqual([+(211 / 320).toFixed(4), +(228 / 334).toFixed(4), +(60 / 320).toFixed(4), +(27 / 334).toFixed(4)]);
    expect(b.trackId).toBe("1");
    expect(a.score).toBe(1); // no `c` without include_confidence: absent means unscored, not zero
  });

  it("mask area is the decoded foreground, scaled from the raster to source pixels, as a frame fraction", async () => {
    const p = await parseSamTokenStream(eventsFromText(line(0)), opts);
    const m = p.frames[0].masks[0];
    const raster = decodeMaskToRaster({ encoding: "lossless", payload: `~${MASK0.split("~")[1].replace("|>", "")}`, width: 60, height: 27 });
    const on = raster.reduce((s, v) => s + v, 0);
    expect(on).toBeGreaterThan(0);
    const expected = on / (320 * 334); // raster 60×27 covers the 60×27 px box one-to-one
    expect(m.area).toBeCloseTo(expected, 8);
    // A mask can never cover more than its own box.
    expect(m.area).toBeLessThanOrEqual(m.bbox[2] * m.bbox[3] + 1e-9);
  });

  it("reads the optional confidence, keeps object ids stable across omitted frames", async () => {
    const p = await parseSamTokenStream(eventsFromText(line(0, "0.9609375") + line(3, "0.5")), opts);
    expect(p.frames.map((f) => f.index)).toEqual([0, 3]); // frame 1 and 2 had no match: omitted, not an error
    expect(p.frames[0].masks[0].score).toBeCloseTo(0.9609375);
    expect(p.frames[1].masks[0].score).toBeCloseTo(0.5);
    expect(p.frames[1].t).toBeCloseTo(0.6);
    expect(new Set(p.frames.flatMap((f) => f.masks.map((m) => m.trackId)))).toEqual(new Set(["0", "1"]));
  });

  it("an empty answer is a legitimate 'no matches', not a parse error", async () => {
    const p = await parseSamTokenStream(eventsFromText(""), opts);
    expect(p.frames).toEqual([]);
    expect(p.objects).toBe(0);
  });

  it("an incomplete or failed response is an error (the case holds), never an empty success", async () => {
    async function* incomplete() {
      yield { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: line(0) };
      yield { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } };
    }
    await expect(parseSamTokenStream(incomplete(), opts)).rejects.toThrow();
    async function* failed() {
      yield { type: "response.failed", response: { error: { message: "video too long" } } };
    }
    await expect(parseSamTokenStream(failed(), opts)).rejects.toThrow();
  });

  it("refuses to normalise without a frame size", () => {
    expect(() => recordsToFrames([], { ...opts, width: 0 })).toThrow(SamTokenError);
  });

  it("the request body matches the docs: message wrapper, text concept, file_id video, confidence as a string", () => {
    const body = samVideoRequest("sam-3.1", "file-842549258569145", "camera lens");
    expect(body).toEqual({
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "camera lens" }, { type: "input_video", file_id: "file-842549258569145" }] }],
      metadata: { include_confidence: "true" },
    });
    expect(samRequestBody("sam-3.1", "f", "lens")).toEqual(samVideoRequest("sam-3.1", "f", "lens"));
  });

  it("parsed frames feed the real tray counter without reshaping", async () => {
    const p = await parseSamTokenStream(eventsFromText(line(0) + line(1) + line(2)), opts);
    const r = countClip("tok", p.frames, counterConfigForKit(KIT));
    expect(r.diagnostics.framesProcessed).toBe(3);
  });
});
