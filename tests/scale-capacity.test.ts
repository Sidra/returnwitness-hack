import { describe, expect, it } from "vitest";
import measuredJson from "@/data/measured-calls.json";
import { DEFAULT_PARAMS, samCostPerConcept, shiftCapacity, type CapacityParams } from "@/lib/scale/capacity";
import { percentile, summarizeCalls, type CallRow, type MeasuredCalls } from "@/lib/scale/measured";

const at = (m: number) => new Date(Date.UTC(2026, 9, 29, 18, m)).toISOString();
const rows: CallRow[] = [
  ...[2000, 2400, 3000, 3200].map((ms, i) => ({ at: at(i), provider: "meta", model: "sam-3.1", purpose: "segment:hand", ok: true, latencyMs: ms, costUsd: 0.01 })),
  { at: at(5), provider: "meta", model: "muse-spark-1.3", purpose: "reconcile", ok: false, latencyMs: 400, costUsd: 0 },
  { at: at(6), provider: "meta", model: "muse-spark-1.3", purpose: "reconcile", ok: true, latencyMs: 14000, costUsd: 0.02 },
  { at: at(7), provider: "meta", model: "muse-wonder-1.0", purpose: "decision_agent", ok: true, latencyMs: 30000, costUsd: 0.07 },
  { at: at(8), provider: "meta", model: "muse-voice-transcribe-1.0", purpose: "voice_note", ok: true, latencyMs: 1800, costUsd: 0.0001 },
  { at: at(9), provider: "modal", model: "facebook/sam3.1", purpose: "segment", ok: true, latencyMs: 6000, costUsd: 0 },
  { at: "2026-10-28T10:00:00Z", provider: "meta", model: "muse-wonder-1.0", purpose: "decision_agent", ok: true, latencyMs: 99999, costUsd: 9 },
];
const m = summarizeCalls(rows, { since: "2026-10-29T18:00:00Z", source: "test" });

describe("measured call summary", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 90)).toBe(4);
    expect(percentile([7], 90)).toBe(7);
  });

  it("groups by model and job, keeps the window and provider, and times only successful calls", () => {
    expect(m.models.map((x) => x.id)).toEqual(["muse-spark-1.3/reconcile", "muse-voice-transcribe-1.0/voice_note", "muse-wonder-1.0/decision_agent", "sam-3.1/segment"]);
    const spark = m.models.find((x) => x.model === "muse-spark-1.3")!;
    expect(spark).toMatchObject({ calls: 2, ok: 1, latencyMs: { p50: 14000, p90: 14000 } });
    expect(m.models.find((x) => x.model === "muse-wonder-1.0")!.latencyMs.max).toBe(30000); // the 10-28 row is outside the window
    expect(m.window.from).toBe(at(0));
  });

  it("refuses a bad window start", () => {
    expect(() => summarizeCalls(rows, { since: "yesterday", source: "x" })).toThrow(/bad --since/);
  });
});

describe("shift capacity", () => {
  const c = shiftCapacity(m);

  it("the model path is the slowest SAM concept + reader + agent, at p90", () => {
    expect(c.modelPathSeconds).toEqual({ segment: 3.2, readers: 14, agent: 30, total: 47.2 });
  });

  it("500 a day over 8 h at a 2× peak: 62.5 / 125 boxes an hour, Little's law for boxes in flight", () => {
    expect(c.avgBoxesPerHour).toBe(62.5);
    expect(c.peakBoxesPerHour).toBe(125);
    expect(c.boxesInFlightPeak).toBeCloseTo((125 / 3600) * 47.2, 2);
    expect(c.callsPerBox).toBe(9);
    expect(c.callsPerMinutePeak).toBeCloseTo((125 / 60) * 9, 2);
  });

  it("benches come from the bench time, and people time adds review on held boxes", () => {
    expect(c.benchesNeeded).toBe(Math.ceil((125 * 120) / 3600)); // 5
    expect(c.peopleHoursPerDay).toBeCloseTo((500 * (120 + 0.25 * 90 + 0.75 * 10)) / 3600, 2);
    expect(c.modelsKeepUp).toBe(true);
    expect(c.bottleneck).toBe("people at the bench");
  });

  it("SAM is priced per billed frame with the 50-frame minimum", () => {
    expect(samCostPerConcept(0.01, 5)).toBeCloseTo(0.01, 6); // 25 frames → billed 50
    expect(samCostPerConcept(0.01, 20)).toBeCloseTo(0.02, 6); // 100 frames
    expect(c.usdPerBox.segment).toBeCloseTo(6 * 0.02, 4);
    expect(c.usdPerBox.total).toBeCloseTo(0.12 + 0.02 + 0.07 + 0.0001, 4);
    expect(c.usdPerDay).toBeCloseTo(c.usdPerBox.total * 500, 1);
  });

  it("names model time as the bottleneck when the path outlasts the bench", () => {
    const slow: CapacityParams = { ...DEFAULT_PARAMS, benchSecondsPerBox: { ...DEFAULT_PARAMS.benchSecondsPerBox, value: 30 } };
    expect(shiftCapacity(m, slow).bottleneck).toBe("model time");
  });

  it("refuses inputs it can't compute from", () => {
    const empty: MeasuredCalls = { ...m, models: m.models.filter((x) => x.model !== "muse-wonder-1.0") };
    expect(() => shiftCapacity(empty)).toThrow(/no successful measured calls for muse-wonder-1.0/);
    expect(() => shiftCapacity(m, { ...DEFAULT_PARAMS, shiftHours: { ...DEFAULT_PARAMS.shiftHours, value: 0 } })).toThrow();
  });

  it("every default input says where it comes from", () => {
    for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
      expect(v.note.length, k).toBeGreaterThan(10);
      expect(["measured", "assumption", "fixture", "config", "target"]).toContain(v.kind);
    }
  });

  it("the committed measurements compute (the page's own input)", () => {
    const real = shiftCapacity(measuredJson as MeasuredCalls);
    expect(real.modelPathSeconds.total).toBeGreaterThan(0);
    expect(real.usdPerBox.total).toBeGreaterThan(0);
  });
});
