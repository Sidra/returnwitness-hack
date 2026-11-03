/**
 * "How does it scale": one returns shift at a planning volume, computed from MEASURED model latency and cost
 * (data/measured-calls.json) plus a few labelled assumptions about people at the bench. Pure arithmetic; every
 * input carries where it came from, so the page can show measured, assumed and configured numbers apart.
 *
 * The critical path after a box's clip ends is sequential (lib/engine/pipeline.ts): segmentation (one SAM 3.1
 * request per concept, all in parallel, so the slowest concept sets the time) → tray count (app code) →
 * readers (Muse Spark; readers run in parallel) → the Wonder decision agent. The voice note is transcribed while
 * the person is still unpacking, so it is off that path. Planning uses p90, not p50.
 */
import type { MeasuredCalls, ModelMeasure } from "./measured";

export type SourceKind = "measured" | "assumption" | "fixture" | "config" | "target";

export interface Input<T = number> {
  value: T;
  kind: SourceKind;
  note: string;
}

export interface CapacityParams {
  returnsPerDay: Input;
  shiftHours: Input;
  peakFactor: Input;
  clipSeconds: Input;
  samConcepts: Input;
  benchSecondsPerBox: Input;
  heldShare: Input;
  reviewSecondsPerHold: Input;
  approveSecondsPerClean: Input;
}

export interface Capacity {
  avgBoxesPerHour: number;
  peakBoxesPerHour: number;
  /** Clip end → decision draft, at p90 per stage. */
  modelPathSeconds: { segment: number; readers: number; agent: number; total: number };
  /** Little's law at the peak hour: boxes whose models are running at once. */
  boxesInFlightPeak: number;
  /** Logged calls per box (SAM concepts + reader + agent run + voice) and per minute at the peak hour. */
  callsPerBox: number;
  callsPerMinutePeak: number;
  benchesNeeded: number;
  peopleHoursPerDay: number;
  usdPerBox: { segment: number; reader: number; agent: number; voice: number; total: number };
  usdPerDay: number;
  usdPer30Days: number;
  /** True when the model result is ready before the person has the next box unpacked. */
  modelsKeepUp: boolean;
  bottleneck: "people at the bench" | "model time";
}

/** The planning defaults. Assumptions are named as such and are replaced by bench timings from the filmed clips. */
export const DEFAULT_PARAMS: CapacityParams = {
  returnsPerDay: { value: 500, kind: "target", note: "planning volume for one returns centre's kit returns (a target, not a customer's figure)" },
  shiftHours: { value: 8, kind: "assumption", note: "one 8-hour shift" },
  peakFactor: { value: 2, kind: "assumption", note: "the busiest hour sees twice the average" },
  clipSeconds: { value: 20, kind: "config", note: "bench clips run 10–25 s (gate/CLIP-SPEC.md); 5 fps after preparation" },
  samConcepts: { value: 6, kind: "config", note: "3 kit items + hand + 2 packing concepts (data/kit.config.ts), one SAM 3.1 request each" },
  benchSecondsPerBox: { value: 120, kind: "assumption", note: "open, unpack into the tray, repack: to be replaced by the filmed clips' timings" },
  heldShare: { value: 0.25, kind: "fixture", note: "the seeded shift holds 6 of 24 boxes (data/shift.ts)" },
  reviewSecondsPerHold: { value: 90, kind: "assumption", note: "a person reads the reasons and evidence on a held box" },
  approveSecondsPerClean: { value: 10, kind: "assumption", note: "a person approves a complete box" },
};

const SAM_MIN_BILLED_FRAMES = 50;
const PREPARED_FPS = 5;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function findMeasure(m: MeasuredCalls, model: string, job: string): ModelMeasure {
  const hit = m.models.find((x) => x.model === model && x.job === job && x.ok > 0);
  if (!hit) throw new Error(`no successful measured calls for ${model}/${job} in ${m.source}`);
  return hit;
}

/**
 * SAM is billed per frame with a 50-frame minimum per request. The measured cost per request was on the minimum,
 * so a longer clip is priced by the frame ratio (latency is left as measured and flagged on the page).
 */
export function samCostPerConcept(measuredUsd: number, clipSeconds: number): number {
  const frames = Math.max(SAM_MIN_BILLED_FRAMES, Math.round(clipSeconds * PREPARED_FPS));
  return (measuredUsd * frames) / SAM_MIN_BILLED_FRAMES;
}

export function shiftCapacity(measured: MeasuredCalls, p: CapacityParams = DEFAULT_PARAMS): Capacity {
  if (p.returnsPerDay.value <= 0 || p.shiftHours.value <= 0) throw new Error("returns per day and shift hours must be positive");
  const sam = findMeasure(measured, "sam-3.1", "segment");
  const spark = findMeasure(measured, "muse-spark-1.3", "reconcile");
  const wonder = findMeasure(measured, "muse-wonder-1.0", "decision_agent");
  const voice = findMeasure(measured, "muse-voice-transcribe-1.0", "voice_note");

  const avg = p.returnsPerDay.value / p.shiftHours.value;
  const peak = avg * p.peakFactor.value;
  const segment = sam.latencyMs.p90 / 1000;
  const readers = spark.latencyMs.p90 / 1000;
  const agent = wonder.latencyMs.p90 / 1000;
  const total = segment + readers + agent;

  const callsPerBox = p.samConcepts.value + 1 + 1 + 1;
  const usdSeg = p.samConcepts.value * samCostPerConcept(sam.costUsd.p50, p.clipSeconds.value);
  const usd = { segment: r4(usdSeg), reader: r4(spark.costUsd.p50), agent: r4(wonder.costUsd.p50), voice: r4(voice.costUsd.p50), total: 0 };
  usd.total = r4(usdSeg + spark.costUsd.p50 + wonder.costUsd.p50 + voice.costUsd.p50);

  const held = p.heldShare.value;
  const personSecondsPerBox = p.benchSecondsPerBox.value + held * p.reviewSecondsPerHold.value + (1 - held) * p.approveSecondsPerClean.value;
  const modelsKeepUp = total < p.benchSecondsPerBox.value;

  return {
    avgBoxesPerHour: r2(avg),
    peakBoxesPerHour: r2(peak),
    modelPathSeconds: { segment: r2(segment), readers: r2(readers), agent: r2(agent), total: r2(total) },
    boxesInFlightPeak: r2((peak / 3600) * total),
    callsPerBox,
    callsPerMinutePeak: r2((peak / 60) * callsPerBox),
    benchesNeeded: Math.ceil((peak * p.benchSecondsPerBox.value) / 3600),
    peopleHoursPerDay: r2((p.returnsPerDay.value * personSecondsPerBox) / 3600),
    usdPerBox: usd,
    usdPerDay: r2(usd.total * p.returnsPerDay.value),
    usdPer30Days: r2(usd.total * p.returnsPerDay.value * 30),
    modelsKeepUp,
    bottleneck: modelsKeepUp ? "people at the bench" : "model time",
  };
}
