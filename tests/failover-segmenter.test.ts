import { describe, expect, it, vi } from "vitest";
import type { ModeLabel, SegmentationResult } from "@/lib/domain/schemas";
import { FailoverSegmenter } from "@/lib/vision/failover-segmenter";
import type { SegmentInput, Segmenter } from "@/lib/vision/segmenter";

const result = (mode: ModeLabel, provenance: string): SegmentationResult => ({
  clipId: "c1",
  fps: 5,
  width: 1280,
  height: 720,
  durationS: 1,
  frames: [{ index: 0, t: 0, masks: [] }],
  source: { mode, model: mode === "LIVE_META" ? "sam-3.1" : "facebook/sam3.1", provenance, requestIds: [] },
});
const seg = (name: string, mode: ModeLabel, impl: (i: SegmentInput) => Promise<SegmentationResult>): Segmenter & { calls: SegmentInput[] } => {
  const calls: SegmentInput[] = [];
  return { name, mode, calls, segment: (i) => (calls.push(i), impl(i)) };
};
const META = (impl: (i: SegmentInput) => Promise<SegmentationResult>) => seg("meta", "LIVE_META", impl);
const okModal = () => seg("modal", "LIVE_OPEN_WEIGHTS", async () => result("LIVE_OPEN_WEIGHTS", "SAM 3.1 open weights on Modal (failover), 5 concepts, 900 ms"));
const IN: SegmentInput = { clipId: "c1", videoPath: "/tmp/c1.mp4", concepts: ["film camera"], fps: 5, caseId: "case-9" };

describe("FailoverSegmenter", () => {
  it("names both engines and reports the primary's mode", () => {
    const f = new FailoverSegmenter(META(async () => result("LIVE_META", "x")), okModal(), { timeoutMs: 1000 });
    expect(f.name).toBe("meta → modal on failure");
    expect(f.mode).toBe("LIVE_META");
    expect(() => new FailoverSegmenter(okModal(), okModal(), { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });

  it("primary ok → primary result, fallback never called", async () => {
    const fb = okModal();
    const r = await new FailoverSegmenter(META(async () => result("LIVE_META", "live SAM 3.1 call")), fb, { timeoutMs: 1000 }).segment(IN);
    expect(r.source).toMatchObject({ mode: "LIVE_META", provenance: "live SAM 3.1 call" });
    expect(fb.calls).toEqual([]);
  });

  it("primary throws → fallback result with the reason prefixed, fallback's mode kept", async () => {
    const fb = okModal();
    const r = await new FailoverSegmenter(META(async () => Promise.reject(new Error("503 from api.meta.ai\nstack…"))), fb, { timeoutMs: 1000 }).segment(IN);
    expect(r.source.mode).toBe("LIVE_OPEN_WEIGHTS");
    expect(r.source.provenance).toBe("failover: meta failed (503 from api.meta.ai) → SAM 3.1 open weights on Modal (failover), 5 concepts, 900 ms");
    expect(fb.calls[0]).toMatchObject({ clipId: "c1", videoPath: "/tmp/c1.mp4", caseId: "case-9" });
  });

  it("a very long primary error is cut short in the provenance", async () => {
    const r = await new FailoverSegmenter(META(async () => Promise.reject(new Error("e".repeat(500)))), okModal(), { timeoutMs: 1000 }).segment(IN);
    expect(r.source.provenance.length).toBeLessThan(260);
  });

  it("primary hangs → times out (fake timers), its signal is aborted, fallback answers", async () => {
    vi.useFakeTimers();
    try {
      const primary = META(() => new Promise(() => {}));
      const p = new FailoverSegmenter(primary, okModal(), { timeoutMs: 60_000 }).segment(IN);
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await p;
      expect(r.source.provenance).toMatch(/^failover: meta failed \(timed out after 60000 ms\) → /);
      expect(primary.calls[0].signal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail over before the budget is spent", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (r: SegmentationResult) => void;
      const fb = okModal();
      const p = new FailoverSegmenter(META(() => new Promise((res) => (resolve = res))), fb, { timeoutMs: 1000 }).segment(IN);
      await vi.advanceTimersByTimeAsync(999);
      resolve(result("LIVE_META", "slow but in time"));
      expect((await p).source.provenance).toBe("slow but in time");
      expect(fb.calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a primary that ignores its signal and rejects late causes no unhandled rejection", async () => {
    const r = await new FailoverSegmenter(META(() => new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 40))), okModal(), { timeoutMs: 10 }).segment(IN);
    expect(r.source.mode).toBe("LIVE_OPEN_WEIGHTS");
    await new Promise((res) => setTimeout(res, 60));
  });

  it("both fail → one error naming both failures", async () => {
    const fb = seg("modal", "LIVE_OPEN_WEIGHTS", async () => Promise.reject(new Error("Modal SAM endpoint returned HTTP 401")));
    await expect(new FailoverSegmenter(META(async () => Promise.reject(new Error("503 from api.meta.ai"))), fb, { timeoutMs: 1000 }).segment(IN)).rejects.toThrow(
      "segmentation failed on both engines: meta: 503 from api.meta.ai; modal: Modal SAM endpoint returned HTTP 401",
    );
  });

  it("the abort signal reaches the primary, and the caller's abort cancels it without spending the fallback", async () => {
    const ctl = new AbortController();
    const fb = okModal();
    const primary = META((i) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("primary saw abort")))));
    const p = new FailoverSegmenter(primary, fb, { timeoutMs: 10_000 }).segment({ ...IN, signal: ctl.signal });
    expect(primary.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(primary.calls[0].signal).not.toBe(ctl.signal);
    ctl.abort(new Error("case cancelled"));
    await expect(p).rejects.toThrow(/case cancelled|primary saw abort/);
    expect(primary.calls[0].signal!.aborted).toBe(true);
    expect(fb.calls).toEqual([]);
  });

  it("an already-aborted caller signal runs nothing", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("gone"));
    const primary = META(async () => result("LIVE_META", "x"));
    await expect(new FailoverSegmenter(primary, okModal(), { timeoutMs: 1000 }).segment({ ...IN, signal: ctl.signal })).rejects.toThrow("gone");
    expect(primary.calls).toEqual([]);
  });
});
