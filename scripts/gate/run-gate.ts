/**
 * Gate test harness (spec §3 hole 1). Rule: scripts/gate/RULE.md (committed before any run).
 *
 *   npm run gate:run -- --list-models            # live models.list, prints the SAM model id to use
 *   npm run gate:run -- --synthetic              # exercise the rule on the synthetic clips (no key, no cost)
 *   npm run gate:run -- [--clips gate/clips] [--manifest gate/manifest.json] [--only g1,g2] [--dry]
 *   npm run gate:run -- --from-recordings [--calibrated]   # free re-score of the recorded SAM runs, no model call
 *
 * Sizes: a live run counts with kit.config's estimated item sizes ("estimates"). --calibrated applies the sizes
 * measured from g1 (data/kit-calibration.json, rule evals/CALIBRATION-PREREG.md; the file must be committed) and
 * reports g1 as the calibration clip, not scored. Both runs are kept in gate/results/ and evidence.json.
 *
 * Live run: each clip → 5 fps / 720p → SAM 3.1 (one call per concept, in parallel) → tray counter →
 * the rule. Writes gate/results/<ts>.json, saves each raw segmentation to data/recordings/ (it
 * becomes the clip's recorded fixture), and appends the run to evidence.json. Prints the cost first.
 */
import fs from "node:fs";
import OpenAI from "openai";
import { KIT } from "../../data/kit.config";
import { counterConfigForKit } from "../../lib/vision/counter-config";
import { countClip } from "../../lib/vision/tray-counter";
import { gateVerdict, judgeClip, runSyntheticGate, type ClipVerdict, type ManifestClip } from "../../lib/evals/suite";
import { findClip, prepareClip } from "../../lib/vision/prepare-clip";
import { MetaSamSegmenter } from "../../lib/meta/sam";
import { assertNotContributor, isContributorModel, metaConfig } from "../../lib/meta/config";
import { appendRun, gitHash } from "../../lib/obs/evidence";
import { execFileSync } from "node:child_process";
import { SegmentationResult } from "../../lib/domain/schemas";
import { loadRecording } from "../../lib/meta/recordings";
import { CALIBRATION_CLIP, isCalibrated, withCalibration } from "../../lib/vision/calibration";
import { readKitCalibration } from "../../lib/runtime";
import { PRICES } from "../../lib/obs/llm-log";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

function table(rows: Array<ClipVerdict & { note?: string }>) {
  for (const r of rows) {
    const items = r.perItem.map((p) => `${p.itemKey}=${p.arrivals}/${p.expected}${p.samIds ? ` (ids ${p.samIds})` : ""}`).join("  ");
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.clipId.padEnd(3)} ${items}${r.holdCodes.length ? `  holds: ${r.holdCodes.join(",")}` : ""}${r.failures.length ? `\n      ${r.failures.join("\n      ")}` : ""}`);
  }
}

async function listModels() {
  const cfg = metaConfig();
  if (!cfg.apiKey) throw new Error("META_HACK_API_KEY is not set");
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  ids.sort();
  console.log(ids.map((i) => (isContributorModel(i) ? `${i}  [contributor mode: refused]` : i)).join("\n"));
  const usable = ids.filter((i) => !isContributorModel(i));
  const sam = usable.find((i) => /^sam-3[.-]1$/.test(i)) ?? usable.find((i) => i.startsWith("sam"));
  console.log(`\nSAM id to use: ${sam ?? "NOT FOUND"} (env META_MODEL_SAM=${cfg.models.sam})`);
  for (const want of [cfg.models.spark, cfg.models.wonder]) console.log(`${want}: ${ids.includes(want) ? "listed" : "NOT LISTED"}`);
}

async function main() {
  // SAM 3.1 returns no text reads, so label checks belong to the reader model, not the gate.
  // --hand-rule re-scores with the hand-overlap fallback rule (RULE.md allows re-running with it after a FAIL).
  const cfgCounter = counterConfigForKit(KIT, { handBlocksTray: flag("hand-rule") });
  if (flag("list-models")) return listModels();

  if (flag("synthetic")) {
    const rows = runSyntheticGate(cfgCounter);
    table(rows);
    console.log(`\nSynthetic: ${rows.filter((r) => r.pass).length}/${rows.length} pass (rule exercised; this is not the gate result).`);
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(opt("manifest", "gate/manifest.json"), "utf8")) as { clips: Array<ManifestClip & { file: string }> };
  const dir = opt("clips", "gate/clips");
  const only = opt("only", "").split(",").filter(Boolean);
  // Every manifest clip is registered: a run on fewer is reported INCOMPLETE, never PASS (RULE.md, addendum).
  const registered = manifest.clips.map((c) => c.id);
  if (flag("from-recordings")) return rescore(manifest.clips.filter((c) => (only.length ? only.includes(c.id) : true)), cfgCounter, registered);
  if (flag("calibrated")) throw new Error("--calibrated re-scores the recorded runs: add --from-recordings (the live run always counts with the estimates)");
  // A clip is found by its stem in any container (.mov from the phone, .mp4 after a conversion).
  const clips = manifest.clips.filter((c) => (only.length ? only.includes(c.id) : true)).flatMap((c) => {
    const src = findClip(dir, c.file);
    return src ? [{ ...c, src }] : [];
  });
  if (!clips.length) throw new Error(`no gate clips found in ${dir} (names: gate/CLIP-SPEC.md)`);

  const prepared = clips.map((c) => ({ c, p: prepareClip(c.src, "gate/frames") }));
  const concepts = [...cfgCounter.items.map((i) => i.concept), cfgCounter.handConcept, ...cfgCounter.ignoreConcepts];
  const frames = prepared.reduce((s, x) => s + x.p.frames, 0);
  const estUsd = frames * concepts.length * PRICES.samPerFrameUsd;
  console.log(`${clips.length} clips · ${frames} frames · ${concepts.length} concepts → estimated SAM cost $${estUsd.toFixed(3)}`);
  if (flag("dry")) return;

  const cfg = metaConfig();
  if (!cfg.apiKey) throw new Error("META_HACK_API_KEY is not set: use --synthetic to exercise the rule without a key");
  assertNotContributor(cfg.models.sam);
  cfgCounter.checkLabels = false;
  const seg = new MetaSamSegmenter(cfg);
  const verdicts: Array<ClipVerdict & { latencyMs: number; frames: number; samIds: Record<string, number> }> = [];
  for (const { c, p } of prepared) {
    const t0 = Date.now();
    // The adapter saves the raw run to data/recordings/gate-<id>.sam.json (the clip's recorded fixture).
    const s = await seg.segment({ clipId: `gate-${c.id}`, videoPath: p.path, concepts, fps: p.fps });
    const latencyMs = Date.now() - t0;
    const r = countClip(c.id, s.frames, cfgCounter);
    verdicts.push({ ...judgeClip(c, r), latencyMs, frames: s.frames.length, samIds: r.diagnostics.rawTrackIdsPerItem });
  }
  table(verdicts);
  const { verdict, notRun } = gateVerdict(verdicts, registered);
  const at = new Date().toISOString();
  const runId = `gate_${at.replace(/[:.]/g, "-")}`;
  const result = { runId, at, gitHash: gitHash(), rule: "scripts/gate/RULE.md", sizes: "estimates", verdict, notRun, model: cfg.models.sam, counterConfig: cfgCounter, clips: verdicts };
  fs.mkdirSync("gate/results", { recursive: true });
  fs.writeFileSync(`gate/results/${runId}.json`, JSON.stringify(result, null, 2));
  appendRun({ runId, kind: "gate", at, gitHash: result.gitHash, mode: "LIVE_META", summary: { verdict, sizes: "estimates", clips: verdicts.length, passed: verdicts.filter((v) => v.pass).length, notRun, frames, estUsd: Number(estUsd.toFixed(4)) }, details: verdicts });
  console.log(`\nGATE ${verdict}${notRun.length ? ` (not run as registered: ${notRun.join(", ")} not filmed)` : ""} · gate/results/${runId}.json · appended to evidence.json`);
  if (verdict === "FAIL") process.exitCode = 2;
}

/**
 * Free re-score of the recorded SAM runs (data/recordings/gate-<id>.sam.json). With --calibrated: the committed g1
 * sizes, and g1 is reported as the calibration clip, outside the verdict. Losses are kept like a live run's.
 */
function rescore(clips: ManifestClip[], base: ReturnType<typeof counterConfigForKit>, registered: string[]) {
  const calibrated = flag("calibrated");
  let cfgCounter = { ...base, checkLabels: false };
  let calibrationNote: string | null = null;
  if (calibrated) {
    const cal = readKitCalibration();
    if (!isCalibrated(cal)) throw new Error("data/kit-calibration.json is not calibrated: run scripts/calibrate-areas.ts --write first");
    // RULE.md tuning guard: the tuned config is committed before g5–g8 are scored on it.
    const dirty = execFileSync("git", ["status", "--porcelain", "data/kit-calibration.json"], { encoding: "utf8" }).trim();
    if (dirty) throw new Error("data/kit-calibration.json has uncommitted changes: commit it before the calibrated re-score");
    cfgCounter = withCalibration(cfgCounter, cal);
    calibrationNote = `sizes from ${cal!.clipId} at commit ${cal!.gitHash}: ${Object.entries(cal!.items).map(([k, v]) => `${k} ${v.applied ? `${v.estimate}→${v.measured}` : "estimate kept"}`).join(", ")}`;
    console.log(`Calibrated re-score · ${calibrationNote}`);
  }
  const calibrationId = CALIBRATION_CLIP.replace(/^gate-/, "");
  const verdicts: Array<ClipVerdict & { frames: number; samIds: Record<string, number>; scored: boolean; note?: string }> = [];
  const missing: string[] = [];
  for (const c of clips) {
    const rec = loadRecording<unknown>(`gate-${c.id}`, "sam");
    if (!rec) {
      missing.push(c.id);
      continue;
    }
    const seg = SegmentationResult.parse(rec.data);
    const r = countClip(c.id, seg.frames, cfgCounter);
    const scored = !(calibrated && c.id === calibrationId);
    verdicts.push({ ...judgeClip(c, r), frames: seg.frames.length, samIds: r.diagnostics.rawTrackIdsPerItem, scored, ...(scored ? {} : { note: "calibration clip, not scored" }) });
  }
  if (!verdicts.length) throw new Error("no recorded gate runs found (data/recordings/gate-<id>.sam.json): run the live gate first");
  if (missing.length) console.log(`no recording (skipped): ${missing.join(", ")}`);
  table(verdicts.map((v) => (v.scored ? v : { ...v, failures: [...v.failures, "(calibration clip, not scored)"] })));
  const scoredRows = verdicts.filter((v) => v.scored);
  // The calibration clip is outside the calibrated verdict, so it isn't owed to it either.
  const { verdict, notRun } = gateVerdict(scoredRows, calibrated ? registered.filter((id) => id !== calibrationId) : registered);
  const at = new Date().toISOString();
  const sizes = calibrated ? "calibrated" : "estimates";
  const runId = `gate_${sizes}_replay_${at.replace(/[:.]/g, "-")}`;
  const result = { runId, at, gitHash: gitHash(), rule: "scripts/gate/RULE.md", sizes, source: "recorded SAM 3.1 runs (no model call)", calibration: calibrationNote, verdict, notRun, counterConfig: cfgCounter, clips: verdicts };
  fs.mkdirSync("gate/results", { recursive: true });
  fs.writeFileSync(`gate/results/${runId}.json`, JSON.stringify(result, null, 2));
  appendRun({ runId, kind: "gate", at, gitHash: result.gitHash, mode: "RECORDED_FIXTURE", summary: { verdict, sizes, clips: scoredRows.length, passed: scoredRows.filter((v) => v.pass).length, notRun, notScored: verdicts.filter((v) => !v.scored).map((v) => v.clipId) }, details: verdicts });
  console.log(`\nGATE (${sizes}, re-scored from recordings) ${verdict} on ${scoredRows.length} scored clips${notRun.length ? ` (not run as registered: ${notRun.join(", ")})` : ""} · gate/results/${runId}.json · appended to evidence.json`);
  if (verdict === "FAIL") process.exitCode = 2;
}

main().catch((e) => {
  console.error(`gate harness: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
