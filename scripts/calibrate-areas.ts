/**
 * Item-size calibration from the clean gate clip g1 (rule pre-registered in evals/CALIBRATION-PREREG.md).
 * Free: reads the gate run's recorded SAM 3.1 segmentation (data/recordings/gate-g1.sam.json), no model call.
 *
 *   npx tsx scripts/calibrate-areas.ts            # print the per-item table, change nothing
 *   npx tsx scripts/calibrate-areas.ts --write    # write data/kit-calibration.json (commit it before the calibrated re-score)
 *
 * Only g1 is accepted: the pre-registration names one clip, so there is no flag to pick another.
 */
import fs from "node:fs";
import path from "node:path";
import { KIT, KIT_ID } from "../data/kit.config";
import { SegmentationResult } from "../lib/domain/schemas";
import { loadRecording } from "../lib/meta/recordings";
import { gitHash } from "../lib/obs/evidence";
import { CALIBRATION_CLIP, CALIBRATION_VERSION, calibrateItems, isCalibrated, type KitCalibration } from "../lib/vision/calibration";
import { counterConfigForKit } from "../lib/vision/counter-config";
import { countClip } from "../lib/vision/tray-counter";

function main() {
  const rec = loadRecording<unknown>(CALIBRATION_CLIP, "sam");
  if (!rec) throw new Error(`no recorded SAM run for ${CALIBRATION_CLIP}: run the gate on the real clips first (scripts/gate/run-gate.ts)`);
  const seg = SegmentationResult.parse(rec.data);
  // Counted the way the gate counts real clips: kit.config's estimates, labels left to the reader model.
  const cfg = counterConfigForKit(KIT, { checkLabels: false });
  const count = countClip(CALIBRATION_CLIP, seg.frames, cfg);
  const items = calibrateItems(seg.frames, count, cfg);

  console.log(`Calibration clip ${CALIBRATION_CLIP} · ${seg.frames.length} frames · SAM run recorded ${rec.recordedAt || "(time not stored)"}`);
  for (const [k, v] of Object.entries(items)) {
    console.log(`  ${k.padEnd(12)} estimate ${v.estimate.toFixed(4)}  measured ${v.measured == null ? "   —  " : v.measured.toFixed(4)}  frames ${String(v.frames).padStart(3)}  ${v.applied ? "APPLIED" : "kept   "}  ${v.reason}`);
  }

  const cal: KitCalibration = {
    version: CALIBRATION_VERSION,
    status: Object.values(items).some((i) => i.applied) ? "calibrated" : "estimates",
    kitId: KIT_ID,
    clipId: CALIBRATION_CLIP,
    recordedAt: rec.recordedAt || null,
    calibratedAt: new Date().toISOString(),
    gitHash: gitHash(),
    note: "Measured from clean clip g1 by scripts/calibrate-areas.ts (rule: evals/CALIBRATION-PREREG.md). Applied to real footage only; synthetic scenes keep kit.config's estimates. g1 is the calibration clip and is not scored in the calibrated gate run.",
    items,
  };
  if (!isCalibrated(cal)) console.log("\nNo item met the rule: the counter keeps every estimate.");
  if (!process.argv.includes("--write")) return console.log("\nDry run. Re-run with --write to save data/kit-calibration.json.");
  const out = path.join("data", "kit-calibration.json");
  fs.writeFileSync(out, `${JSON.stringify(cal, null, 2)}\n`);
  console.log(`\nwrote ${out} (${cal.status})`);
}

try {
  main();
} catch (e) {
  console.error(`calibrate-areas: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
