/**
 * Smoke test on the one real clip g1: is the live pipeline working on real footage? NOT the gate, not scored.
 *
 *   npx tsx --env-file=.env.local scripts/smoke-g1.ts                    # free: quote from the real clip
 *   npx tsx --env-file=.env.local scripts/smoke-g1.ts --confirm-spend    # live, refuses above --cap (default $1)
 *
 * One live inspection (SAM 3.1 → tray counter with kit.config's estimates → Muse Spark 1.3 → open-weight auditor →
 * Muse Wonder 1.0) under clip id "smoke-g1", so its recordings never stand in for the gate's (gate-g1) or a demo
 * RMA's. The case stays in memory: nothing is written to the case store, gate/results or evidence.json. The
 * calibration table is the pre-registered rule (lib/vision/calibration.ts) applied to this run's masks, printed
 * only: data/kit-calibration.json is written from the gate's own g1 run, in the live run's order.
 */
import fs from "node:fs";
import path from "node:path";
import { ORDERS, RMAS } from "../data/fixtures";
import { SegmentationResult, type Mask } from "../lib/domain/schemas";
import { MetaSamSegmenter } from "../lib/meta/sam";
import { runInspection } from "../lib/engine/pipeline";
import { liveMetaAvailable, metaConfig } from "../lib/meta/config";
import { loadRecording } from "../lib/meta/recordings";
import { PRICES } from "../lib/obs/llm-log";
import { COUNTER_CONFIG, liveEvidenceImages, pipelineDeps, POLICY } from "../lib/runtime";
import { MemoryCaseStore } from "../lib/store/case-store";
import { CALIBRATION_RULE, calibrateItems } from "../lib/vision/calibration";
import { findClip, prepareClip } from "../lib/vision/prepare-clip";
import { countClip } from "../lib/vision/tray-counter";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CAP = Number(opt("cap", "1.00"));
const CLIP_ID = "smoke-g1";
const MIN_FRAMES = 50; // Meta bills each video request for at least 50 frames

function spentSince(t0: number): { meta: number; other: Array<{ provider: string; calls: number }> } {
  const f = process.env.RETURNWITNESS_LLM_LOG || path.join(process.cwd(), ".data", "llm-calls.jsonl");
  if (!fs.existsSync(f)) return { meta: 0, other: [] };
  const rows = fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at?: string; provider?: string; costUsd?: number | null })
    .filter((r) => Date.parse(r.at ?? "") >= t0);
  const other = new Map<string, number>();
  for (const r of rows) if (r.provider !== "meta") other.set(r.provider ?? "?", (other.get(r.provider ?? "?") ?? 0) + 1);
  return { meta: rows.filter((r) => r.provider === "meta").reduce((s, r) => s + (r.costUsd ?? 0), 0), other: [...other].map(([provider, calls]) => ({ provider, calls })) };
}

async function main() {
  const src = findClip("gate/clips", "g1-clean");
  if (!src) throw new Error("gate/clips/g1-clean.* not found");
  const prepared = prepareClip(src, path.join(".data", "clips", "prepared"));
  const cfgCounter = { ...COUNTER_CONFIG, checkLabels: false }; // the estimates, as the gate counts real clips
  const concepts = cfgCounter.items.length + 1 + cfgCounter.ignoreConcepts.length;
  const samUsd = concepts * Math.max(MIN_FRAMES, prepared.frames) * PRICES.samPerFrameUsd;
  const sp = PRICES["muse-spark-1.3"];
  const wo = PRICES["muse-wonder-1.0"];
  const sparkUsd = (14_000 * sp.in + 2_000 * sp.out) / 1e6;
  const wonderUsd = (15_000 * wo.in + 2_000 * wo.out) / 1e6;
  const total = samUsd + sparkUsd + wonderUsd;
  console.log(`SMOKE TEST, NOT SCORED · ${path.basename(src)} → ${prepared.frames} frames at ${prepared.fps} fps`);
  console.log(`  sam-3.1          $${samUsd.toFixed(3)}  ${concepts} concepts × ${Math.max(MIN_FRAMES, prepared.frames)} billed frames @ $0.20/1k`);
  console.log(`  muse-spark-1.3   $${sparkUsd.toFixed(3)}  1 call, ~14k in / 2k out (estimate)`);
  console.log(`  muse-wonder-1.0  $${wonderUsd.toFixed(3)}  1 agent run, ~15k in / 2k out (estimate)`);
  console.log(`  TOTAL (Meta)     $${total.toFixed(3)}  cap $${CAP.toFixed(2)} · the open-weight auditor (Baseten) is unpriced in the log`);
  const probe = opt("probe", "").split(",").map((s) => s.trim()).filter(Boolean);
  if (probe.length) console.log(`  --probe: SAM only, ${probe.length} concepts × ${Math.max(MIN_FRAMES, prepared.frames)} frames = $${(probe.length * Math.max(MIN_FRAMES, prepared.frames) * PRICES.samPerFrameUsd).toFixed(3)} (replaces the run above)`);
  if (!args.includes("--confirm-spend")) return console.log("\nQuote only. Re-run with --confirm-spend.");
  if (total > CAP) throw new Error(`quote $${total.toFixed(2)} is over the cap $${CAP.toFixed(2)}; not starting`);
  const cfg = metaConfig();
  if (!liveMetaAvailable(cfg)) throw new Error("no live Meta key in this profile");
  if (probe.length) return probeConcepts(probe, prepared, cfg);

  const t0 = Date.now();
  const rma = { ...RMAS[1], id: "SMOKE-G1", clipId: CLIP_ID, reason: "Return requested.", scenario: "smoke test on real clip g1 (complete kit), not scored" };
  const deps = pipelineDeps({ liveModels: true, liveSegmentation: true, clipId: CLIP_ID });
  deps.store = new MemoryCaseStore(); // never enters the shared case store
  deps.counterConfig = cfgCounter;
  deps.evidenceImages = liveEvidenceImages(src);
  const c = await runInspection({ rma, slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: CLIP_ID, source: "camera", videoPath: prepared.path } }, deps);

  console.log(`\nCase state: ${c.state}${c.holdReasons.length ? ` · holds: ${c.holdReasons.join(" | ")}` : ""}`);
  console.log("Arrivals counted (tray counter, estimates):");
  for (const a of c.count?.arrivals ?? []) console.log(`  ${a.itemKey.padEnd(12)} t=${a.t.toFixed(1)} s  frame ${a.frameIndex}`);
  console.log(`  per item: ${JSON.stringify(c.count?.diagnostics.rawTrackIdsPerItem ?? {})} raw SAM track ids`);
  console.log("Reconciliation (observed / expected):");
  for (const l of c.reconciliation?.lines ?? []) console.log(`  ${l.itemKey.padEnd(12)} ${l.observedQty}/${l.expectedQty} ${l.status.padEnd(7)} ${l.reasons.map((r) => `${r.code}: ${r.detail}`).join(" | ")}`);
  console.log("Readers:");
  for (const r of c.readerRuns ?? []) console.log(`  ${r.reader.padEnd(28)} ${r.ok ? "ok " : "ERR"} ${String(r.latencyMs).padStart(6)} ms ${r.requestId ?? ""}${r.error ? `  ${r.error}` : ""}`);
  const spark = loadRecording<unknown>(CLIP_ID, "spark");
  console.log(`Muse Spark's answer (data/recordings/${CLIP_ID}.spark.json):\n${JSON.stringify(spark?.data ?? null, null, 1)}`);
  console.log(`Decision draft: ${c.draft?.source ?? "none"} ${c.draft?.mode ?? ""}${c.draft?.agentNotRun ? ` (not run: ${c.draft.agentNotRun})` : ""}`);
  console.log(`Timings: ${c.timings.map((t) => `${t.stage} ${Math.round(t.ms)}ms ${t.mode}`).join(" | ")}`);

  // The pre-registered calibration rule on this run's masks: printed, never written.
  const rec = loadRecording<unknown>(CLIP_ID, "sam");
  if (rec) {
    const seg = SegmentationResult.parse(rec.data);
    const items = calibrateItems(seg.frames, countClip(CLIP_ID, seg.frames, cfgCounter), cfgCounter);
    console.log(`\nCalibration rule on this run (printed only; band 1/${CALIBRATION_RULE.maxRatio}–${CALIBRATION_RULE.maxRatio}×, ≥${CALIBRATION_RULE.minFrames} frames):`);
    for (const [k, v] of Object.entries(items)) console.log(`  ${k.padEnd(12)} estimate ${v.estimate.toFixed(4)}  median ${v.measured == null ? "  —   " : v.measured.toFixed(4)}  ${v.measured == null ? "" : `${(v.measured / v.estimate).toFixed(2)}×`}  frames ${v.frames}  ${v.applied ? "IN BAND" : "estimate kept"} · ${v.reason}`);
  }
  const s = spentSince(t0);
  console.log(`\nLogged Meta spend: $${s.meta.toFixed(4)} (quote $${total.toFixed(3)})${s.other.length ? ` · other calls: ${s.other.map((o) => `${o.provider} ×${o.calls}`).join(", ")}` : ""}`);
  console.log("SMOKE TEST, NOT SCORED: nothing written to gate/results, evidence.json or the case store.");
}

/**
 * Diagnostic: which concept words SAM 3.1 finds in g1 (masks per concept, settled area, where). Recorded under
 * "smoke-g1-probe-<concepts>"; nothing is counted or scored. Choosing a concept here is tuning on g1, so any kit.config change
 * it leads to is committed and disclosed before a gate run (RULE.md tuning guard).
 */
async function probeConcepts(concepts: string[], prepared: { path: string; fps: number }, cfg: ReturnType<typeof metaConfig>) {
  const s = await new MetaSamSegmenter(cfg).segment({ clipId: `${CLIP_ID}-probe-${concepts.map((c) => c.replace(/[^a-z0-9]+/gi, "_")).join("-")}`, videoPath: prepared.path, concepts, fps: prepared.fps });
  const zone = COUNTER_CONFIG.trayZone;
  console.log(`\nPROBE (diagnostic, not scored) · ${s.frames.length} frames · tray zone x ${zone.x0}–${zone.x1}`);
  for (const k of concepts) {
    const ms = s.frames.flatMap((f) => f.masks.filter((m) => m.concept === k).map((m) => ({ f: f.index, m })));
    const ids = new Set(ms.map((x) => x.m.trackId));
    const late = ms.filter((x) => x.f >= s.frames.length - 20); // the last 4 s: everything settled, hands out
    const cx = (m: Mask) => m.bbox[0] + m.bbox[2] / 2;
    const cy = (m: Mask) => m.bbox[1] + m.bbox[3] / 2;
    const desc = late.length ? [...new Set(late.map((x) => x.m.trackId))].map((id) => { const xs = late.filter((x) => x.m.trackId === id).map((x) => x.m); const m = xs[Math.floor(xs.length / 2)]; return `${id} at (${cx(m).toFixed(2)}, ${cy(m).toFixed(2)}) area ${m.area.toFixed(4)}`; }).join("; ") : "none in the last 4 s";
    console.log(`  ${k.padEnd(22)} ${String(new Set(ms.map((x) => x.f)).size).padStart(3)} frames with a mask · ${ids.size} track(s) · ${desc}`);
  }
}

main().catch((e) => {
  console.error(`smoke-g1: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
