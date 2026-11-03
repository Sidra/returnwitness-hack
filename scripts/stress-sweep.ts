/**
 * Tray-counter stress sweep (eval table).
 *
 *   npx tsx scripts/stress-sweep.ts [--seeds 20] [--json out.json] [--md out.md] [--hand-rule]
 *       DETERMINISTIC · synthetic segmentation with mask-level perturbations (no camera, no model, $0)
 *
 *   npx tsx --env-file=.env.local scripts/stress-sweep.ts --modal --clips gate/clips/*.mp4 [--manifest gate/manifest.json]
 *       Video level, for when the Modal SAM 3.1 endpoint is deployed: ffmpeg perturbations (brightness,
 *       blur, downscale, frame drop) on the real gate clips → ModalSamSegmenter → counter → gate rule.
 *       Rows are labelled LIVE_OPEN_WEIGHTS. Refuses to run unless modalSamConfig().enabled. Costs GPU time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { KIT } from "../data/kit.config";
import { counterConfigForKit } from "../lib/vision/counter-config";
import { countClip } from "../lib/vision/tray-counter";
import { prepareClip } from "../lib/vision/prepare-clip";
import { type ManifestClip } from "../lib/evals/suite";
import { ffmpegArgsFor, formatStressTable, rowFrom, runStressSweep, scoreRun, summarize, VIDEO_PERTURBATIONS, type RunScore, type StressReport, type StressRow } from "../lib/evals/stress";
import { modalSamConfig, ModalSamSegmenter } from "../lib/openweights/modal-sam";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
/** Everything after --clips up to the next flag (the shell expands the glob into many args). */
const many = (n: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]);
  return out;
};

function write(report: StressReport) {
  const json = opt("json", "");
  const md = opt("md", "");
  if (json) fs.writeFileSync(json, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2));
  if (md) fs.writeFileSync(md, `${formatStressTable(report)}\n`);
  if (json || md) console.log(`\nwrote ${[json, md].filter(Boolean).join(" and ")}`);
}

async function modalMode() {
  const cfg = modalSamConfig();
  if (!cfg.enabled) {
    console.error(`--modal refused: ${cfg.reason}`);
    process.exit(1);
  }
  const files = many("clips");
  if (!files.length) throw new Error("--modal needs --clips <files…> (e.g. gate/clips/*.mp4)");
  const manifest = JSON.parse(fs.readFileSync(opt("manifest", "gate/manifest.json"), "utf8")) as { clips: Array<ManifestClip & { file: string }> };
  const counter = counterConfigForKit(KIT, { handBlocksTray: flag("hand-rule"), checkLabels: false });
  const concepts = [...counter.items.map((i) => i.concept), counter.handConcept, ...counter.ignoreConcepts];
  const clips = files.map((f) => {
    const base = path.basename(f);
    const stem = base.replace(/\.[^.]+$/, "");
    const m = manifest.clips.find((c) => c.file === base || c.file.replace(/\.[^.]+$/, "") === stem || stem.startsWith(`${c.id}-`) || stem === c.id);
    if (!m) throw new Error(`${base}: no matching clip in the manifest`);
    if (!fs.existsSync(f)) throw new Error(`${f}: not found`);
    return { file: f, clip: m };
  });
  const seg = new ModalSamSegmenter(cfg);
  const work = path.join("gate", "frames", "stress");
  fs.mkdirSync(work, { recursive: true });
  console.log(`LIVE_OPEN_WEIGHTS · SAM 3.1 open weights on Modal · ${clips.length} clips × ${VIDEO_PERTURBATIONS.length + 1} variants = ${clips.length * (VIDEO_PERTURBATIONS.length + 1)} segmentation calls (GPU time is billed; check Modal's usage page)`);
  const variants = [{ key: "none", severity: "-", detail: "prepared clip, unperturbed", vf: "" }, ...VIDEO_PERTURBATIONS];
  const results = new Map<string, Array<{ clipId: string; score: RunScore }>>();
  for (const { file, clip } of clips) {
    const prepared = prepareClip(file, path.join("gate", "frames"));
    for (const v of variants) {
      const id = `${v.key}-${v.severity}`;
      let p = prepared.path;
      if (v.vf) {
        p = path.join(work, `${clip.id}.${id}.mp4`);
        execFileSync("ffmpeg", ffmpegArgsFor(prepared.path, p, v.vf));
      }
      const s = await seg.segment({ clipId: `stress-${clip.id}-${id}`, videoPath: p, concepts, fps: prepared.fps });
      const score = scoreRun(clip, countClip(clip.id, s.frames, counter));
      results.set(id, [...(results.get(id) ?? []), { clipId: clip.id, score }]);
      console.log(`${score.pass ? "PASS" : "FAIL"} ${clip.id} ${id}`);
    }
  }
  const rows: StressRow[] = variants.map((v) => rowFrom("LIVE_OPEN_WEIGHTS", v.key, v.severity, v.detail, results.get(`${v.key}-${v.severity}`) ?? []));
  const report: StressReport = { label: `LIVE_OPEN_WEIGHTS · SAM 3.1 open weights on Modal, video-level ffmpeg perturbations (model: ${cfg.model})`, mode: "LIVE_OPEN_WEIGHTS", seeds: 1, rows, summary: summarize(rows) };
  console.log(`\n${formatStressTable(report)}`);
  write(report);
}

async function main() {
  if (flag("modal")) return modalMode();
  const seeds = Number(opt("seeds", "20"));
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 1000) throw new Error(`--seeds must be an integer 1..1000 (got ${opt("seeds", "20")})`);
  const report = runStressSweep({ cfg: counterConfigForKit(KIT, { handBlocksTray: flag("hand-rule") }), seeds });
  console.log(formatStressTable(report));
  write(report);
}

main().catch((e) => {
  console.error(`stress sweep: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
