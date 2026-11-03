/**
 * Build the bench label set · truth from the printed label design (lib/learning/label-set.ts).
 *   npx tsx scripts/build-label-set.ts [--seed 20261029] [--per-kind 30] [--variants 3] [--sheet-variants 4] [--chargers 6]
 *   npx tsx scripts/build-label-set.ts --fresh <seed> [--per-kind 6] [--variants 2]
 *       Fresh rows for switch rule v2 (ADR-007): re-rendered labels from a NEW seed, every row held out, any serial
 *       already in the label set (trained on or scored) dropped, plus the d1–d3 bench crops when they exist.
 *       Written to .data/label-set/fresh-<seed>.jsonl (the main set is untouched); prints the v2 scoring quote.
 * Free and local: headless Chrome (Playwright, channel "chrome") renders every label from the sheet's own
 * HTML/CSS; no network, no model, no Modal. Writes:
 *   .data/label-set/images/*.jpg          every crop (gitignored)
 *   .data/label-set/label-set.jsonl       {messages, meta} rows, split by label id (what the fine-tune and eval read)
 *   .data/label-set/manifest.json         the summary
 *   data/label-set.manifest.json          the same summary, committed (the evals page reads it on the deploy)
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { HELDOUT_FRACTION, MIN_HELDOUT_ROWS, quoteLearningPlan, quoteLiveEval, SPLIT_SEED, type TrainingLine } from "../lib/learning/glimmer-eval";
import {
  augmentationFor,
  benchLabelRows,
  IDENTITY,
  LABEL_SET_JSONL,
  LABEL_SET_NAME,
  LABEL_SET_SEED,
  labelPageHtml,
  labelSetDir,
  labelSetRow,
  MEASURE_SCRIPT,
  renderSpecs,
  SHEET_BOXES,
  sheetCss,
  sheetSpecs,
  splitLabelSet,
  summarizeLabelSet,
  type LabelBoxes,
  type LabelSetLine,
} from "../lib/learning/label-set";

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
}

/** Fresh held-out rows for rule v2: a new seed, nothing trained on or scored, bench crops added when present. */
async function fresh(seed: number) {
  if (seed === LABEL_SET_SEED) throw new Error(`--fresh needs a seed other than the label set's own (${LABEL_SET_SEED})`);
  const perKind = arg("--per-kind", 6);
  const variants = arg("--variants", 2);
  const root = process.cwd();
  const out = labelSetDir();
  const mainFile = path.join(out, LABEL_SET_JSONL);
  if (!fs.existsSync(mainFile)) throw new Error(`${path.relative(root, mainFile)} is missing: build the label set first, so fresh serials can be checked against it`);
  const used = new Set(fs.readFileSync(mainFile, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as TrainingLine).meta.labelId).filter(Boolean));
  const imgDir = path.join(out, `fresh-${seed}`);
  fs.rmSync(imgDir, { recursive: true, force: true });
  fs.mkdirSync(imgDir, { recursive: true });
  const css = sheetCss(fs.readFileSync(path.join(root, "labels/label-sheet.html"), "utf8"));
  const sheetDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(root, "labels/preview.png")).toString("base64")}`;
  const specs = renderSpecs(seed, { perKind, chargers: 0 }).filter((spec) => spec.serial && !used.has(spec.labelId));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const lines: LabelSetLine[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 360 }, deviceScaleFactor: 1 });
    for (const spec of specs)
      for (let v = 0; v < variants; v++) {
        const aug = augmentationFor(seed, spec.key, v + 1);
        await page.setContent(labelPageHtml(spec, aug, css, sheetDataUrl), { waitUntil: "load" });
        const boxes: LabelBoxes = await page.evaluate(MEASURE_SCRIPT);
        const buf = await page.locator("#stage").screenshot({ type: "jpeg", quality: aug.jpegQuality });
        const name = `${spec.key}-v${aug.variant}.jpg`;
        fs.writeFileSync(path.join(imgDir, name), buf);
        lines.push(labelSetRow(spec, aug, boxes, { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, file: path.join(`fresh-${seed}`, name) }, seed));
      }
  } finally {
    await browser.close();
  }
  const bench = await benchLabelRows({ writeImage: (name, dataUrl) => {
    fs.writeFileSync(path.join(imgDir, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    return path.join(`fresh-${seed}`, name);
  } });
  // Every fresh row is held out: none was trained on, none was scored by v1.
  const all = [...lines, ...bench.lines].map((l) => ({ ...l, meta: { ...l.meta, split: "heldout" as const, seed: SPLIT_SEED, fraction: HELDOUT_FRACTION } }));
  const file = path.join(out, `fresh-${seed}.jsonl`);
  fs.writeFileSync(file, all.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const q = quoteLiveEval(all.length);
  console.log(`fresh rows for rule v2: ${all.length} (${lines.length} re-rendered from seed ${seed}, ${bench.lines.length} bench crops${bench.clipsFound.length ? ` from ${bench.clipsFound.join(", ")}` : "; no filmed clip with a SAM recording yet"}) → ${path.relative(root, file)}`);
  console.log(`  ${all.length >= MIN_HELDOUT_ROWS ? "enough" : `NOT enough (v2 needs at least ${MIN_HELDOUT_ROWS})`} · serials dropped as already used: ${renderSpecs(seed, { perKind, chargers: 0 }).length - specs.length}`);
  console.log(`  v2 scoring quote (Modal credits, Glimmer cap): ≈ $${q.usd.toFixed(2)} · ${q.basis}`);
}

async function main() {
  const freshAt = process.argv.indexOf("--fresh");
  if (freshAt >= 0) return fresh(arg("--fresh", 0));
  const seed = arg("--seed", LABEL_SET_SEED);
  const perKind = arg("--per-kind", 30);
  const variants = arg("--variants", 3);
  const sheetVariants = arg("--sheet-variants", 4);
  const chargers = arg("--chargers", 6);
  const root = process.cwd();
  const out = labelSetDir();
  const imgDir = path.join(out, "images");
  fs.rmSync(imgDir, { recursive: true, force: true });
  fs.mkdirSync(imgDir, { recursive: true });

  const css = sheetCss(fs.readFileSync(path.join(root, "labels/label-sheet.html"), "utf8"));
  const sheetDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(root, "labels/preview.png")).toString("base64")}`;
  const jobs = [
    // The sheet: variant 0 is the label as printed (no augmentation), then seeded augmentations.
    ...sheetSpecs().flatMap((spec) => Array.from({ length: sheetVariants }, (_, v) => ({ spec, aug: v === 0 ? IDENTITY(0) : augmentationFor(seed, spec.key, v) }))),
    // Rendered labels: serial labels get `variants` views, chargers two.
    ...renderSpecs(seed, { perKind, chargers }).flatMap((spec) => Array.from({ length: spec.serial ? variants : Math.min(2, variants) }, (_, v) => ({ spec, aug: augmentationFor(seed, spec.key, v + 1) }))),
  ];

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const lines: LabelSetLine[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 360 }, deviceScaleFactor: 1 });
    for (const { spec, aug } of jobs) {
      await page.setContent(labelPageHtml(spec, aug, css, sheetDataUrl), { waitUntil: "load" });
      const boxes: LabelBoxes = spec.source === "sheet" ? SHEET_BOXES(spec) : await page.evaluate(MEASURE_SCRIPT);
      const buf = await page.locator("#stage").screenshot({ type: "jpeg", quality: aug.jpegQuality });
      const name = `${spec.key}-v${aug.variant}.jpg`;
      fs.writeFileSync(path.join(imgDir, name), buf);
      lines.push(labelSetRow(spec, aug, boxes, { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, file: path.join("images", name) }, seed));
    }
  } finally {
    await browser.close();
  }

  const bench = await benchLabelRows({ writeImage: (name, dataUrl) => {
    fs.writeFileSync(path.join(imgDir, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    return path.join("images", name);
  } });
  const split = splitLabelSet([...lines, ...bench.lines]);
  fs.writeFileSync(path.join(out, LABEL_SET_JSONL), split.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const manifest = summarizeLabelSet(split, { generatedAt: new Date().toISOString(), seed, bench: { clipsFound: bench.clipsFound, clipsMissing: bench.clipsMissing } });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(root, "data", "label-set.manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

  console.log(`${LABEL_SET_NAME}: ${manifest.rows} rows → ${path.relative(root, path.join(out, LABEL_SET_JSONL))}`);
  for (const [s, c] of Object.entries(manifest.bySource)) if (c.train + c.heldout) console.log(`  ${s.padEnd(10)} train ${String(c.train).padStart(4)} · held out ${String(c.heldout).padStart(4)}`);
  console.log(`  total      train ${String(manifest.train).padStart(4)} · held out ${String(manifest.heldout).padStart(4)}`);
  console.log(`  distinct serials: train ${manifest.distinctSerials.train} · held out ${manifest.distinctSerials.heldout} (real sheet serials held out: ${manifest.distinctSerials.heldoutReal.join(", ")})`);
  console.log(`  serial hidden by an occluder (truth "unreadable"): ${manifest.unreadableSerialRows} · stand-in rows (slip serial is a near-miss): ${manifest.standInRows}`);
  console.log(`  bench clips: ${manifest.bench.clipsFound.length ? manifest.bench.clipsFound.join(", ") : "none yet"}${manifest.bench.clipsMissing.length ? ` · missing: ${manifest.bench.clipsMissing.join("; ")}` : ""}`);
  console.log(`  label ids in both splits: ${manifest.leaked.length ? manifest.leaked.join(", ") : "none"} · floors: ${manifest.floorProblems.length ? manifest.floorProblems.join("; ") : "met (≥50 train, ≥20 held out)"}`);
  console.log("Quotes (estimates; Modal L40S list price):");
  for (const l of quoteLearningPlan({ trainRows: manifest.train, heldoutRows: manifest.heldout, epochs: 3 }).lines) console.log(`  ${l}`);
  const sample = (src: string) => split.find((l) => l.meta.source === src && l.meta.image)?.meta.image;
  console.log(`Samples: ${["sheet", "render"].map((s) => sample(s)).filter(Boolean).map((p) => path.join(out, p!)).join("  ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
