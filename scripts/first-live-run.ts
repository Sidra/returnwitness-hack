/**
 * The first live run, in one command, with one spend line for Sidra:
 *   1. gate test: g0–g8 through SAM 3.1 (scripts/gate/run-gate.ts, pre-registered rule)
 *   1b. item-size calibration from g1 (pre-registered: evals/CALIBRATION-PREREG.md): calibrate-areas --write, a local
 *      commit of data/kit-calibration.json, then a free calibrated re-score of the gate (g1 reported, not scored).
 *      Everything after this counts with the calibrated sizes. If calibration fails, the run goes on with the estimates.
 *   2. the three demo returns d1–d3 end to end LIVE: SAM 3.1 → tray counter → Muse Spark 1.3 →
 *      Muse Wonder 1.0, with the clip's own audio transcribed by Muse Voice Transcribe 1.0 first.
 *      Each runs under its seeded RMA's clip id, so the public site replays real Meta output, labelled.
 *      After each live inspection, the fleet's model roles (lib/fleet/live.ts) run once each on that box's
 *      evidence (count, reconciliation, crops, transcript) and are saved to data/recordings/fleet/.
 *   3. the same-input A/B (pre-registered: evals/AB-SAME-INPUT-PREREG.md; skip with --no-ab):
 *      Arm A = Muse Spark 1.3 alone on each clip's four key frames + slip + policy ("complete? refund or hold?");
 *      Arm B = the pipeline: d1–d3 are step 2's cases, g0–g8 replay the gate run's SAM output + live Spark + Wonder.
 *      Every clip scored against its known contents, every loss kept → data/ab/<runId>.json.
 *   4. one Muse Image 1.0 "complete return" illustration
 *   --glimmer: the Muse Glimmer label reader (my Modal GPU, base model) also reads the settled crops of d1–d3.
 *      Off by default. The endpoint is warmed right before d1–d3 (a cold start is ~150–200 s, the reader's budget
 *      15 s); if warming fails the run goes on without it. Its GPU time is Modal credits under Sidra's Glimmer cap,
 *      reported separately from the Meta spend and the Meta cap. Never set on Vercel.
 *
 *   npx tsx --env-file=.env.local scripts/first-live-run.ts            # free: per-model quote from the real clips
 *   npx tsx --env-file=.env.local scripts/first-live-run.ts --confirm-spend [--cap 3.00]
 *
 * Spend guard: the quote is computed from the real clip lengths before anything runs, and the run refuses
 * to start above --cap. Between every step it re-reads the spend logged since the run began
 * (.data/llm-calls.jsonl) and stops if the next step could cross the cap. One step costs at most a few
 * tens of cents, so the cap is the ceiling to within one step.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KIT, KIT_ID } from "../data/kit.config";
import { ORDERS, RMAS } from "../data/fixtures";
import { SEEDED_SHIFT } from "../data/shift";
import { buildRoster } from "../lib/fleet/coordinator";
import { fleetLiveQuote, runFleetLive } from "../lib/fleet/live";
import { runInspection } from "../lib/engine/pipeline";
import { generateIllustration } from "../lib/meta/image";
import { liveMetaAvailable, metaConfig } from "../lib/meta/config";
import { hasAudioStream, kitVocabulary, transcribeFile } from "../lib/meta/voice";
import { PRICES } from "../lib/obs/llm-log";
import { COUNTER_CONFIG, keyFrameImages, liveEvidenceImages, pipelineDeps, POLICY, readKitCalibration } from "../lib/runtime";
import { isCalibrated, withCalibration } from "../lib/vision/calibration";
import { MemoryCaseStore } from "../lib/store/case-store";
import { FixtureSegmenter } from "../lib/vision/fixture-segmenter";
import type { ReturnCase } from "../lib/domain/case";
import { AB_VERSION, abClips, abQuote, armAPromptSha256, armBDecision, armTotals, runArmA, scoreDecision, truthOf, type AbReport, type AbRow } from "../lib/evals/same-input-ab";
import { modalGlimmerConfig, modalGlimmerHealth } from "../lib/openweights/glimmer-modal";
import { MODAL_GPU_USD_PER_HOUR, quoteLiveEval } from "../lib/learning/glimmer-eval";
import { labelSetDir } from "../lib/learning/label-set";
import { counterConfigForKit } from "../lib/vision/counter-config";
import { findClip, prepareClip, probe } from "../lib/vision/prepare-clip";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CLIPS = opt("clips", "gate/clips");
const CAP = Number(opt("cap", "3.00"));
const AB = !args.includes("--no-ab");
const FPS = 5;
const MIN_FRAMES = 50; // Meta bills each video request for at least 50 frames

// Token estimates per call (no measured Meta number exists yet; replaced by the logged usage after the run).
// Spark: 4 key frames + 3 crops + slip/policy/counter text. Wonder: a 2–3 turn tool loop.
const EST = {
  spark: { in: 14_000, out: 2_000 },
  wonder: { in: 15_000, out: 2_000 },
};

const GATE = ["g0-empty", "g1-clean", "g2-hand-occlusion", "g3-kraft-paper", "g4-lift-replace", "g5-missing-lens", "g6-merge", "g7-label-covered", "g8-fast"];
const DEMO: Array<{ file: string; rmaIndex: 0 | 1 | 2 }> = [
  { file: "d1-rma-20418-lens-missing", rmaIndex: 0 },
  { file: "d2-rma-20419-complete", rmaIndex: 1 },
  { file: "d3-camera-reboxed", rmaIndex: 2 },
];

const find = (stem: string) => findClip(CLIPS, stem) ?? undefined;

function quote() {
  const cfgCounter = counterConfigForKit(KIT);
  const concepts = cfgCounter.items.length + 1 + cfgCounter.ignoreConcepts.length;
  const rows: Array<{ clip: string; seconds: number; frames: number; billed: number; audioS: number }> = [];
  const missing: string[] = [];
  for (const stem of [...GATE, ...DEMO.map((d) => d.file)]) {
    const f = find(stem);
    if (!f) {
      missing.push(stem);
      continue;
    }
    const p = probe(f);
    const frames = Math.max(1, Math.round(p.durationS * FPS));
    const demo = DEMO.some((d) => d.file === stem);
    rows.push({ clip: stem, seconds: p.durationS, frames, billed: concepts * Math.max(MIN_FRAMES, frames), audioS: demo && hasAudioStream(f) ? Math.floor(p.durationS) : 0 });
  }
  const samUsd = rows.reduce((s, r) => s + r.billed, 0) * PRICES.samPerFrameUsd;
  const sp = PRICES["muse-spark-1.3"];
  const wo = PRICES["muse-wonder-1.0"];
  const demoCount = rows.filter((r) => DEMO.some((d) => d.file === r.clip)).length;
  const sparkUsd = demoCount * ((EST.spark.in * sp.in + EST.spark.out * sp.out) / 1e6);
  const wonderUsd = demoCount * ((EST.wonder.in * wo.in + EST.wonder.out * wo.out) / 1e6);
  const voiceUsd = rows.reduce((s, r) => s + r.audioS, 0) * PRICES.voicePerSecondUsd;
  const imageUsd = PRICES.imagePerImageUsd;
  // The fleet's model roles, one call each per demo box; worst case counts the claim agent as if it always fires.
  const fleet = fleetLiveQuote(demoCount, buildRoster(SEEDED_SHIFT));
  const found = (stems: string[]) => stems.filter((s) => rows.some((r) => r.clip === s)).length;
  const ab = AB ? abQuote({ gateClips: found(GATE), allClips: found([...GATE, ...DEMO.map((d) => d.file)]), prices: { spark: sp, wonder: wo } }) : null;
  const total = samUsd + sparkUsd + wonderUsd + voiceUsd + imageUsd + fleet.totalUsd + (ab?.usd.total ?? 0);
  return { rows, missing, concepts, lines: [
    { model: "sam-3.1", usd: samUsd, basis: `${rows.reduce((s, r) => s + r.billed, 0)} billed frames (${rows.length} clips × ${concepts} concepts, ≥${MIN_FRAMES} frames per request) @ $0.20/1k` },
    { model: "muse-spark-1.3", usd: sparkUsd, basis: `${demoCount} calls × ~${EST.spark.in / 1000}k in / ${EST.spark.out / 1000}k out tokens (estimate) @ $1.25/$4.25 per M` },
    { model: "muse-wonder-1.0", usd: wonderUsd, basis: `${demoCount} agent runs × ~${EST.wonder.in / 1000}k in / ${EST.wonder.out / 1000}k out (estimate) @ $4/$20 per M` },
    { model: "muse-voice-transcribe-1.0", usd: voiceUsd, basis: `${rows.reduce((s, r) => s + r.audioS, 0)} s of clip audio @ $0.18/h` },
    { model: "muse-image-1.0", usd: imageUsd, basis: "1 image @ $0.01" },
    {
      model: "fleet model roles",
      usd: fleet.totalUsd,
      basis: `${demoCount} boxes × (${demoCount ? fleet.spark.calls / demoCount : 0} Spark + ${demoCount ? fleet.wonder.calls / demoCount : 0} Wonder) calls = ${fleet.spark.calls + fleet.wonder.calls} calls; per box ~${fleet.spark.inTok / 1000}k in / ${fleet.spark.outTok / 1000}k out Spark tokens and ~${fleet.wonder.inTok / 1000}k in / ${fleet.wonder.outTok / 1000}k out Wonder tokens (estimate; worst case, claim agent included) @ $1.25/$4.25 and $4/$20 per M`,
    },
    ...(ab ? [{ model: "same-input A/B", usd: ab.usd.total, basis: `${ab.calls.armASpark + ab.calls.armBSpark} Spark calls + ${ab.calls.armBWonderRuns} Wonder runs; ${ab.basis}` }] : []),
  ], total, fleetPerBoxUsd: fleet.perBoxUsd, ab };
}

function glimmerGpuSecondsSince(t0: number): { calls: number; gpuSeconds: number } {
  const f = process.env.RETURNWITNESS_LLM_LOG || path.join(process.cwd(), ".data", "llm-calls.jsonl");
  if (!fs.existsSync(f)) return { calls: 0, gpuSeconds: 0 };
  const rows = fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at?: string; provider?: string; purpose?: string; units?: { kind?: string; count?: number } })
    .filter((r) => r.provider === "modal" && r.purpose === "label_read" && r.units?.kind === "gpu_seconds" && Date.parse(r.at ?? "") >= t0);
  return { calls: rows.length, gpuSeconds: rows.reduce((s, r) => s + (r.units?.count ?? 0), 0) };
}

function spentSince(t0: number): number {
  const f = process.env.RETURNWITNESS_LLM_LOG || path.join(process.cwd(), ".data", "llm-calls.jsonl");
  if (!fs.existsSync(f)) return 0;
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at?: string; ts?: string; provider?: string; costUsd?: number | null })
    .filter((r) => r.provider === "meta" && Date.parse(r.at ?? r.ts ?? "") >= t0)
    .reduce((s, r) => s + (r.costUsd ?? 0), 0);
}

async function main() {
  const q = quote();
  console.log(`First live run · clips from ${CLIPS}`);
  for (const r of q.rows) console.log(`  ${r.clip.padEnd(28)} ${r.seconds.toFixed(1).padStart(5)} s  ${String(r.frames).padStart(4)} frames${r.audioS ? `  audio ${r.audioS} s` : ""}`);
  if (q.missing.length) console.log(`  not found (skipped): ${q.missing.join(", ")}`);
  console.log("\nQuote per model:");
  for (const l of q.lines) console.log(`  ${l.model.padEnd(26)} $${l.usd.toFixed(3).padStart(6)}  ${l.basis}`);
  console.log(`  ${"TOTAL".padEnd(26)} $${q.total.toFixed(3).padStart(6)}   stop cap $${CAP.toFixed(2)}`);
  if (args.includes("--glimmer")) {
    // Modal credits under Sidra's Glimmer cap, not the Meta cap above. The container is billed for its wall time:
    // the warm-up, the d1–d3 inspections it stays warm through (~120 s each, an estimate), then 120 s idle.
    const demos = DEMO.filter((d) => find(d.file)).length;
    const warmS = 300 + demos * 120 + 120;
    const freshFiles = fs.existsSync(labelSetDir()) ? fs.readdirSync(labelSetDir()).filter((f) => /^fresh-\d+\.jsonl$/.test(f)) : [];
    const freshRows = freshFiles.length ? fs.readFileSync(path.join(labelSetDir(), freshFiles.sort().at(-1)!), "utf8").trim().split("\n").length : 30;
    const v2 = quoteLiveEval(freshRows);
    console.log(`\nMuse Glimmer (Modal credits, Glimmer cap, separate from the Meta cap):`);
    console.log(`  label reads during d1–d3     ≈ $${((warmS / 3600) * MODAL_GPU_USD_PER_HOUR.L40S).toFixed(2)}  300 s warm-up + ${demos} inspections × ~120 s + 120 s idle on one L40S (estimates)`);
    console.log(`  rule v2 scoring (separate)   ≈ $${v2.usd.toFixed(2)}  ${freshRows} fresh rows${freshFiles.length ? "" : " (estimate: ~24 fresh renders + ~6 bench crops)"}; ${v2.basis}`);
  }
  if (q.total > CAP) console.log(`\nThe worst-case total $${q.total.toFixed(2)} is over the $${CAP.toFixed(2)} cap. The run will refuse to start; to allow it, re-run with --cap ${(Math.ceil(q.total * 2) / 2).toFixed(2)} (Sidra's call).`);
  if (!args.includes("--confirm-spend")) return console.log("\nQuote only. Re-run with --confirm-spend once Sidra has typed the spend line.");
  if (q.total > CAP) throw new Error(`quote $${q.total.toFixed(2)} is over the cap $${CAP.toFixed(2)}; not starting`);
  const cfg = metaConfig();
  if (!liveMetaAvailable(cfg)) throw new Error("no live Meta key in this profile");
  const t0 = Date.now();
  const guard = (next: string, nextMaxUsd: number) => {
    const spent = spentSince(t0);
    if (spent + nextMaxUsd > CAP) throw new Error(`stopping before ${next}: $${spent.toFixed(3)} spent, the next step could cross the $${CAP.toFixed(2)} cap`);
    console.log(`[spend so far $${spent.toFixed(3)}] ${next}`);
  };

  // 1. Gate (SAM only). The harness prints its own PASS/FAIL table and writes gate/results + evidence.json.
  const gateClips = GATE.filter((g) => find(g));
  if (gateClips.length) {
    guard("gate run (SAM 3.1)", q.lines[0].usd);
    try {
      execFileSync("npx", ["tsx", "scripts/gate/run-gate.ts", "--clips", CLIPS], { stdio: "inherit", env: process.env });
    } catch {
      console.log("gate harness exited non-zero (a FAIL is reported above; the demo runs continue so the result is complete)");
    }
  }

  // 1b. Item sizes from g1, committed before anything is scored on them (free: the recorded SAM runs, no model call).
  let realCounter = COUNTER_CONFIG;
  if (gateClips.includes("g1-clean")) {
    try {
      execFileSync("npx", ["tsx", "scripts/calibrate-areas.ts", "--write"], { stdio: "inherit", env: process.env });
      const cal = readKitCalibration();
      if (isCalibrated(cal)) {
        if (execFileSync("git", ["status", "--porcelain", "data/kit-calibration.json"], { encoding: "utf8" }).trim()) {
          execFileSync("git", ["add", "data/kit-calibration.json"]);
          execFileSync("git", ["commit", "-q", "-m", "Calibration: item sizes from g1 (rule evals/CALIBRATION-PREREG.md)", "--", "data/kit-calibration.json"]);
        }
        console.log(`calibration committed at ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}`);
        try {
          execFileSync("npx", ["tsx", "scripts/gate/run-gate.ts", "--from-recordings", "--calibrated"], { stdio: "inherit", env: process.env });
        } catch {
          console.log("calibrated gate re-score exited non-zero (a FAIL is reported above; both gate rows are kept)");
        }
        realCounter = withCalibration(COUNTER_CONFIG, cal);
      } else console.log("calibration: no item met the rule; the counter keeps the estimates");
    } catch (e) {
      console.log(`calibration failed (${e instanceof Error ? e.message : e}); continuing with the estimates`);
    }
  }

  // 2a. Muse Glimmer label reader for d1–d3, only with --glimmer: warm first, then select it for this process.
  if (args.includes("--glimmer") && DEMO.some((d) => find(d.file))) {
    const gcfg = modalGlimmerConfig({ ...process.env, RETURNWITNESS_LABEL_READER: "modal" });
    if (!gcfg.url || !gcfg.token) console.log(`glimmer: not configured (${gcfg.reason}); continuing without it`);
    else {
      console.log("glimmer: warming the endpoint (a cold start is ~150–200 s)…");
      const h = await modalGlimmerHealth(gcfg, { timeoutMs: 1_200_000 }).catch((e: unknown) => ({ ok: false, status: 0, body: String(e), latencyMs: 0 }));
      const ready = h.ok && (h.body as { ready?: boolean })?.ready === true;
      console.log(`glimmer: ${ready ? `ready in ${Math.round(h.latencyMs / 1000)} s` : `not ready (HTTP ${h.status}); continuing without it`}`);
      if (ready) process.env.RETURNWITNESS_LABEL_READER = "modal";
    }
  }

  let fleetUsd = 0;
  const demoCases = new Map<string, ReturnCase>();
  // 2. Demo returns, end to end live, recorded under the seeded clip ids.
  for (const d of DEMO) {
    const src = find(d.file);
    if (!src) continue;
    const rma = RMAS[d.rmaIndex];
    const order = ORDERS[d.rmaIndex];
    guard(`${d.file} live inspection`, 0.5);
    const voiceNote = hasAudioStream(src) ? await transcribeFile(src, cfg, { keywords: kitVocabulary(KIT) }).catch((e) => (console.log(`  voice: ${e instanceof Error ? e.message : e}`), undefined)) : undefined;
    const prepared = prepareClip(src, path.join(".data", "clips", "prepared"));
    const deps = pipelineDeps({ liveModels: true, liveSegmentation: true, clipId: rma.clipId });
    deps.evidenceImages = liveEvidenceImages(src);
    deps.counterConfig = { ...realCounter, checkLabels: false }; // the import-time config predates step 1b
    const c = await runInspection({ rma, slip: order.slip, policy: POLICY, clip: { clipId: rma.clipId, source: "camera", videoPath: prepared.path }, ...(voiceNote ? { voiceNote } : {}) }, deps);
    demoCases.set(d.file, c);
    console.log(`  ${rma.id}: ${c.state} · ${c.reconciliation?.lines.map((l) => `${l.itemKey}=${l.status}`).join(" ")} · ${c.timings.map((t) => `${t.stage} ${Math.round(t.ms)}ms ${t.mode}`).join(" | ")}`);

    // The fleet's model roles on this box's live evidence, one call per role, saved for replay.
    const box = SEEDED_SHIFT.returns.find((r) => r.rma.id === rma.id);
    if (box && c.count && c.reconciliation) {
      guard(`${rma.id} fleet model roles`, q.fleetPerBoxUsd);
      const images = deps.evidenceImages ? await deps.evidenceImages(c) : [];
      const fl = await runFleetLive({ ret: box, count: c.count, reconciliation: c.reconciliation, images, voiceTranscript: voiceNote?.transcript, caseId: c.id, frames: c.count.diagnostics.framesProcessed }, cfg, { settings: SEEDED_SHIFT.settings });
      fleetUsd += fl.costUsd;
      for (const r of fl.recordings) console.log(`    fleet ${r.role.padEnd(26)} ${r.ok ? "ok " : "ERR"} ${String(r.latencyMs).padStart(6)} ms  ${r.requestId ?? "-"}  ${r.costUsd == null ? "unpriced" : `$${r.costUsd.toFixed(4)}`}${r.error ? `  ${r.error}` : ""}`);
    } else {
      console.log(`    fleet: skipped (${box ? "no count/reconciliation on the case" : "box not in the seeded shift"})`);
    }
  }

  // 3. The same-input A/B (pre-registered). Losses are kept; nothing is re-run.
  if (AB && q.ab) {
    guard("same-input A/B", q.ab.usd.total);
    await runSameInputAb(demoCases, cfg, t0, realCounter);
  }

  // 4. The illustration.
  guard("Muse Image illustration", 0.02);
  const ill = await generateIllustration(KIT_ID, KIT.items.map((i) => ({ concept: i.genericName, qty: 1 })), cfg);
  console.log(`  illustration saved: public${ill.imagePath} · ${ill.latencyMs} ms`);
  console.log(`\nDone. Logged Meta spend this run: $${spentSince(t0).toFixed(3)} (quote was $${q.total.toFixed(3)}; fleet model roles $${fleetUsd.toFixed(3)} of it).`);
  if (process.env.RETURNWITNESS_LABEL_READER === "modal") {
    const g = glimmerGpuSecondsSince(t0);
    console.log(`Muse Glimmer (Modal credits, Glimmer cap): ${g.calls} label reads, ${g.gpuSeconds.toFixed(1)} GPU-s in the engine; the container's wall time (warm-up + 120 s idle) is on Modal's billing page.`);
  }
}

const holdCodesOf = (c: ReturnCase) => [...new Set((c.reconciliation?.lines ?? []).filter((l) => l.status !== "OK").flatMap((l) => l.reasons.map((r) => r.code)))];

async function runSameInputAb(demoCases: Map<string, ReturnCase>, cfg: ReturnType<typeof metaConfig>, t0: number, realCounter: typeof COUNTER_CONFIG) {
  const manifest = JSON.parse(fs.readFileSync("gate/manifest.json", "utf8"));
  const before = spentSince(t0);
  const rows: AbRow[] = [];
  const notFilmed: string[] = [];
  let armBUsd = 0;
  for (const clip of abClips(manifest)) {
    const src = find(clip.file);
    if (!src) {
      notFilmed.push(clip.id);
      continue;
    }
    const truth = truthOf(clip);
    const demo = DEMO.find((d) => d.file === clip.file);
    // Gate clips carry no RMA: both arms get the complete kit's slip and a neutral reason.
    const rma = demo ? RMAS[demo.rmaIndex] : { ...RMAS[1], id: `AB-${clip.id.toUpperCase()}`, clipId: `gate-${clip.id}`, reason: "Return requested.", scenario: `gate clip ${clip.id}` };
    const slip = (demo ? ORDERS[demo.rmaIndex] : ORDERS[1]).slip;

    // Arm B.
    let armB: AbRow["armB"];
    if (demo) {
      const c = demoCases.get(clip.file);
      armB = c
        ? { decision: armBDecision(c.state), outcome: scoreDecision(armBDecision(c.state), truth), state: c.state, holdCodes: holdCodesOf(c), caseId: c.id, source: "live inspection (step 2)" }
        : { decision: null, outcome: "no_answer", state: null, holdCodes: [], error: "the live inspection did not run", source: "live inspection (step 2)" };
    } else {
      const spent0 = spentSince(t0);
      const deps = pipelineDeps({ liveModels: true, liveSegmentation: false, clipId: rma.clipId });
      deps.store = new MemoryCaseStore(); // A/B cases never enter the shared case store
      deps.segmenter = new FixtureSegmenter(); // replays data/recordings/gate-<id>.sam.json from step 1
      deps.counterConfig = { ...realCounter, checkLabels: false };
      deps.evidenceImages = liveEvidenceImages(src);
      try {
        const prepared = prepareClip(src, path.join(".data", "clips", "prepared"));
        const c = await runInspection({ rma, slip, policy: POLICY, clip: { clipId: rma.clipId, source: "camera", videoPath: prepared.path } }, deps);
        armB = { decision: armBDecision(c.state), outcome: scoreDecision(armBDecision(c.state), truth), state: c.state, holdCodes: holdCodesOf(c), caseId: c.id, source: "gate run's SAM output + live Spark + Wonder" };
      } catch (e) {
        armB = { decision: null, outcome: "no_answer", state: null, holdCodes: [], error: e instanceof Error ? e.message : String(e), source: "gate run's SAM output + live Spark + Wonder" };
      }
      armBUsd += spentSince(t0) - spent0;
    }

    // Arm A: the same four key frames the pipeline's Spark reader gets.
    const a = await runArmA({ rma, slip, policy: POLICY, images: keyFrameImages(src), clipId: clip.id }, cfg);
    const armA: AbRow["armA"] = { decision: a.decision, outcome: scoreDecision(a.decision, truth), missingItemKeys: a.reply?.missingItemKeys ?? [], reason: a.reply?.reason ?? null, latencyMs: a.latencyMs, ...(a.requestId ? { requestId: a.requestId } : {}), ...(a.error ? { error: a.error } : {}) };
    rows.push({ clipId: clip.id, truth, armA, armB });
    console.log(`  A/B ${clip.id.padEnd(3)} truth ${truth.padEnd(15)} Spark alone: ${String(armA.decision).padEnd(6)} ${armA.outcome.padEnd(14)} pipeline: ${String(armB.decision).padEnd(6)} ${armB.outcome}`);
  }
  const at = new Date().toISOString();
  // Arm B counted with sizes measured on g1 only if step 1b applied them (addendum).
  const calibrationClip = realCounter !== COUNTER_CONFIG && rows.some((r) => r.clipId === "g1") ? "g1" : null;
  const rest = rows.filter((r) => r.clipId !== calibrationClip);
  const report: AbReport = {
    version: AB_VERSION,
    runId: `ab_${at.replace(/[:.]/g, "-")}`,
    at,
    gitHash: execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
    promptSha256: armAPromptSha256(),
    model: cfg.models.spark,
    rows,
    totals: { armA: armTotals(rows, "armA"), armB: armTotals(rows, "armB") },
    costUsd: { armA: Number((spentSince(t0) - before - armBUsd).toFixed(4)), armB: Number(armBUsd.toFixed(4)) },
    notFilmed,
    calibrationClip,
    totalsWithoutCalibration: calibrationClip ? { armA: armTotals(rest, "armA"), armB: armTotals(rest, "armB") } : null,
  };
  fs.mkdirSync(path.join("data", "ab"), { recursive: true });
  fs.writeFileSync(path.join("data", "ab", `${report.runId}.json`), JSON.stringify(report, null, 2));
  const t = report.totals;
  console.log(`  A/B wrong refunds: Spark alone ${t.armA.wrongRefunds}/${t.armA.clips} · pipeline ${t.armB.wrongRefunds}/${t.armB.clips} | false holds ${t.armA.falseHolds} vs ${t.armB.falseHolds} | no answer ${t.armA.noAnswer} vs ${t.armB.noAnswer} ${notFilmed.length ? ` | not filmed: ${notFilmed.join(", ")}` : ""}${report.totalsWithoutCalibration ? ` | without ${calibrationClip}: pipeline wrong refunds ${report.totalsWithoutCalibration.armB.wrongRefunds}, false holds ${report.totalsWithoutCalibration.armB.falseHolds}` : ""} → data/ab/${report.runId}.json`);
}

main().catch((e) => {
  console.error(`first live run: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
