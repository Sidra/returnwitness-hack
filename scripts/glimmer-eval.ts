/**
 * Reviewer corrections → Muse Glimmer QLoRA on my Modal GPU → the held-out switch test.
 *
 *   npx tsx scripts/glimmer-eval.ts export [--recipe v1|v2] [--no-label-set] [--out f.jsonl] [--seed 1729] [--fraction 0.2] [--epochs 3]
 *       --recipe v2 (written before any v2 row is scored, ADR-007): every row also carries a templated rationale as
 *       reasoning_content (GLIMMER_RECIPES, reasoningTarget); the Modal trainer refuses if the chat template drops it.
 *       Builds the rows from the bench label set (.data/label-set, scripts/build-label-set.ts) plus any
 *       reviewer corrections in the case store, splits them by label id, writes
 *       .data/finetune/glimmer-<date>.jsonl ({messages, meta} per line) and prints the row counts
 *       against the floors and the GPU quote. Free: no network.
 *       The fine-tune itself is `modal run modal/glimmer_finetune.py ... --confirm-spend` (needs Sidra's
 *       typed OK; see modal/README.md).
 *
 *   npx tsx scripts/glimmer-eval.ts decide --data f.jsonl --base base.json --adapter adapter.json --adapter-name rw-labels-... [--train-rows N] [--record] [--rule v1|v2]
 *       Scores two reads files (ReadRecord[]) on the held-out rows of f.jsonl and applies the switch
 *       rule (lib/learning/glimmer-eval.ts). Free. --record appends the entry to the decision log named by GLIMMER_RECORD_FILE (default ./DECISIONS.md).
 *       Every decision is also appended to .data/finetune/glimmer-decisions.jsonl.
 *
 *   npx tsx --env-file=.env.local scripts/glimmer-eval.ts live --data f.jsonl --adapter-name rw-labels-... --confirm-spend [--record] [--rule v1|v2]
 *       --rule v2 (pre-registered): reads and scores only the held-out rows v1 never scored (data/glimmer-switch.json).
 *       Reads each held-out row through the DEPLOYED endpoint twice (base, then the adapter), writes
 *       both reads files next to the data, then decides. GPU time: refuses without --confirm-spend and
 *       prints the quote first.
 */
import fs from "node:fs";
import path from "node:path";
import { getStore } from "../lib/store/case-store";
import {
  buildGlimmerSplit,
  decideSwitch,
  decisionLogEntry,
  evaluateReads,
  parseGlimmerEvalArgs,
  parseReadsFile,
  parseTrainingJsonl,
  quoteLearningPlan,
  quoteLiveEval,
  toModalJsonl,
  unionTrainingLines,
  type EvalMetrics,
  type TrainingLine, decideSwitchV2, SWITCH_RULE_V2_TEXT, applyRecipe, GLIMMER_RECIPES
} from "../lib/learning/glimmer-eval";
import { LABEL_SET_NAME, loadLabelSetLines } from "../lib/learning/label-set";
import { modalGlimmerConfig, readHeldOutRow, type ReadRecord } from "../lib/openweights/glimmer-modal";

/** Where --record appends a switch decision (a markdown decision log). */
const recordFile = () => process.env.GLIMMER_RECORD_FILE || path.join(process.cwd(), "DECISIONS.md");

const dataDir = () => path.join(process.cwd(), ".data", "finetune");

function heldOut(lines: TrainingLine[]) {
  return lines.filter((l) => l.meta.split === "heldout");
}

function printMetrics(label: string, m: EvalMetrics) {
  console.log(`  ${label}: exact serial ${m.exactSerial}/${m.rows} · SKU ${m.skuMatch}/${m.skuRows} · false clears ${m.falseClears.total}${m.falseClears.total ? ` (${m.falseClears.rowIds.join(", ")})` : ""} · no read ${m.errors}${m.unknownReads ? ` · ${m.unknownReads} reads for unknown rows ignored` : ""}`);
}

/** The row ids the v1 test scored (data/glimmer-switch.json): rule v2 may never be scored on them. */
function scoredBefore(): Set<string> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "glimmer-switch.json"), "utf8")) as { v1?: { scoredRowIds?: string[] } };
    return new Set(j.v1?.scoredRowIds ?? []);
  } catch {
    return new Set();
  }
}

function decideAndLog(lines: TrainingLine[], base: ReadRecord[], adapter: ReadRecord[], o: { adapterName: string; trainRows: number | null; record: boolean; source: string; rule: "v1" | "v2" }) {
  if (o.rule === "v2") {
    const metas = heldOut(lines).map((l) => l.meta);
    const v2 = decideSwitchV2({ metas, baseReads: base, adapterReads: adapter, scoredBefore: scoredBefore(), trainRows: o.trainRows ?? undefined, adapterName: o.adapterName });
    console.log(v2.summary);
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.appendFileSync(path.join(dataDir(), "glimmer-decisions.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), adapter: o.adapterName, source: o.source, ...v2 })}\n`);
    if (o.record) fs.appendFileSync(recordFile(), `\n## ${new Date().toISOString().slice(0, 10)} · Glimmer adapter switch test (rule v2): ${v2.useAdapter ? `use ${o.adapterName}` : "keep the base model"}\n- ${v2.summary}\n- Rule: ${SWITCH_RULE_V2_TEXT}\n`);
    console.log(v2.useAdapter ? `Next: set MODAL_GLIMMER_ADAPTER=${o.adapterName} (after Sidra's OK).` : "Next: leave MODAL_GLIMMER_ADAPTER unset.");
    return;
  }
  const rows = heldOut(lines);
  const meta = rows.map((l) => l.meta);
  const b = evaluateReads(meta, base);
  const a = evaluateReads(meta, adapter);
  const trainRows = o.trainRows ?? lines.length - rows.length;
  const d = decideSwitch(b, a, { trainRows, adapterName: o.adapterName });
  console.log(`Held-out rows: ${rows.length} (trained on ${trainRows})`);
  printMetrics("base", b);
  printMetrics(o.adapterName, a);
  // Per source, so the printed-sheet result (the real labels) is never hidden inside an average with rendered ones.
  for (const src of [...new Set(meta.map((m) => m.source ?? "correction"))]) {
    const sub = meta.filter((m) => (m.source ?? "correction") === src);
    const ids = new Set(sub.map((m) => m.rowId));
    printMetrics(`  ${src} · base`, evaluateReads(sub, base.filter((r) => ids.has(r.rowId))));
    printMetrics(`  ${src} · ${o.adapterName}`, evaluateReads(sub, adapter.filter((r) => ids.has(r.rowId))));
  }
  console.log(d.summary);
  const at = new Date();
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.appendFileSync(path.join(dataDir(), "glimmer-decisions.jsonl"), `${JSON.stringify({ at: at.toISOString(), adapter: o.adapterName, source: o.source, useAdapter: d.useAdapter, failed: d.failed, gainPoints: d.gainPoints, extraCorrect: d.extraCorrect, trainRows, base: { ...b, judgements: undefined }, adapterMetrics: { ...a, judgements: undefined } })}\n`);
  if (o.record) {
    const file = recordFile();
    const counts = new Map<string, number>();
    for (const l of heldOut(lines)) counts.set(l.meta.source ?? "correction", (counts.get(l.meta.source ?? "correction") ?? 0) + 1);
    const sources = [...counts].map(([k, n]) => `${k} ${n}`).join(", ");
    fs.appendFileSync(file, `\n${decisionLogEntry(d, { at, adapterName: o.adapterName, base: b, adapter: a, trainRows, source: o.source, seed: lines[0]?.meta.seed, fraction: lines[0]?.meta.fraction, sources })}`);
    console.log(`Recorded in ${path.relative(process.cwd(), file)}`);
  }
  console.log(d.useAdapter ? `Next: set MODAL_GLIMMER_ADAPTER=${o.adapterName} (after Sidra's OK).` : "Next: leave MODAL_GLIMMER_ADAPTER unset.");
}

async function main() {
  const args = parseGlimmerEvalArgs(process.argv.slice(2));

  if (args.command === "export") {
    // Reviewer corrections (source "correction") + the bench label set (truth from the printed label design), one split rule.
    const corr = buildGlimmerSplit(await getStore().list(), { seed: args.seed, fraction: args.fraction });
    const labelSet = args.noLabelSet ? [] : (loadLabelSetLines() ?? []);
    const { lines: raw, report } = unionTrainingLines([labelSet, corr.lines], args.seed, args.fraction);
    const lines = raw.map((l) => applyRecipe(l, args.recipe));
    const file = args.out ?? path.join(dataDir(), `glimmer-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toModalJsonl(lines));
    console.log(`Rows: ${report.rows} → ${file} · recipe ${args.recipe} (${GLIMMER_RECIPES[args.recipe].text})`);
    console.log(`  ${LABEL_SET_NAME}: ${labelSet.length} row(s)${args.noLabelSet ? " (excluded with --no-label-set)" : labelSet.length ? "" : " (not generated yet: npx tsx scripts/build-label-set.ts)"}`);
    console.log(`  reviewer corrections: ${corr.report.rows} row(s) from ${corr.report.labelCorrections} label correction(s) across ${corr.report.cases} case(s); dropped (no archived crop image): ${corr.report.droppedNoImage}`);
    console.log(`  split by label id (seed ${args.seed}, held-out fraction ${args.fraction}; the printed sheet's serials always held out): ${report.train} train · ${report.heldout} held out`);
    for (const [s, c] of Object.entries(report.bySource)) if (c.train + c.heldout) console.log(`    ${s.padEnd(10)} train ${c.train} · held out ${c.heldout}`);
    console.log(`  distinct labels: train ${report.distinctLabels.train} · held out ${report.distinctLabels.heldout} · in both: ${report.leaked.length ? report.leaked.join(", ") : "none"}`);
    console.log("Quotes (estimates; Modal L40S list price):");
    for (const l of quoteLearningPlan({ trainRows: report.train, heldoutRows: report.heldout, epochs: args.epochs }).lines) console.log(`  ${l}`);
    if (report.floorProblems.length) console.log(`The fine-tune would refuse: ${report.floorProblems.join("; ")}.`);
    return;
  }

  const lines = parseTrainingJsonl(fs.readFileSync(args.data!, "utf8"));
  if (args.command === "decide") {
    decideAndLog(lines, parseReadsFile(fs.readFileSync(args.base!, "utf8")), parseReadsFile(fs.readFileSync(args.adapter!, "utf8")), { adapterName: args.adapterName!, trainRows: args.trainRows, record: args.record, rule: args.rule, source: `files ${path.basename(args.base!)} / ${path.basename(args.adapter!)}` });
    return;
  }

  // live (rule v2 reads only the rows v1 never scored: no GPU time on rows that can't count)
  const done = args.rule === "v2" ? scoredBefore() : new Set<string>();
  const rows = heldOut(lines).filter((l) => !done.has(l.meta.rowId));
  const q = quoteLiveEval(rows.length);
  console.log(`Live held-out read on the deployed endpoint: ${rows.length} rows × 2 · quote ≈ $${q.usd.toFixed(2)} · ${q.basis}`);
  if (!args.confirmSpend) {
    console.error("refusing: --confirm-spend not given (reading through the endpoint runs a GPU)");
    process.exit(2);
  }
  const cfg = modalGlimmerConfig({ ...process.env, RETURNWITNESS_LABEL_READER: "modal" });
  if (!cfg.url || !cfg.token) {
    console.error(`refusing: ${cfg.reason}`);
    process.exit(2);
  }
  const base: ReadRecord[] = [];
  const adapter: ReadRecord[] = [];
  for (const [i, l] of rows.entries()) {
    const row = { rowId: l.meta.rowId, itemKey: l.meta.itemKey, messages: l.messages.slice(0, 2) as Parameters<typeof readHeldOutRow>[0]["messages"] };
    base.push(await readHeldOutRow(row, cfg.model, cfg));
    adapter.push(await readHeldOutRow(row, args.adapterName!, cfg));
    console.log(`  ${i + 1}/${rows.length} ${l.meta.rowId}`);
  }
  const stem = args.data!.replace(/\.jsonl$/, "");
  fs.writeFileSync(`${stem}.reads.base.json`, JSON.stringify(base, null, 1));
  fs.writeFileSync(`${stem}.reads.${args.adapterName}.json`, JSON.stringify(adapter, null, 1));
  decideAndLog(lines, base, adapter, { adapterName: args.adapterName!, trainRows: args.trainRows, record: args.record, rule: args.rule, source: `live through the served endpoint (${new URL(cfg.url).host}, FP8 base vs LoRA ${args.adapterName})` });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
