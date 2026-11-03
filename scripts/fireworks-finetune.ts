/**
 * Reviewer corrections → a Fireworks supervised fine-tune of the label reader.
 *   npx tsx scripts/fireworks-finetune.ts                      quote only (default): builds the dataset
 *                                                              from the case store, writes
 *                                                              .data/finetune/labels-<date>.jsonl, prints the quote
 *   npx tsx --env-file=.env.local scripts/fireworks-finetune.ts --submit --confirm-spend [--epochs 3] [--poll]
 *                                                              submits ONLY with --confirm-spend AND a priced
 *                                                              quote (FIREWORKS_SFT_USD_PER_MTOK), and prints
 *                                                              the spend before the first call
 * The submit is logged to .data/llm-calls.jsonl (purpose finetune_submit) with the estimate; the
 * actual charge is whatever Fireworks bills for the job.
 */
import path from "node:path";
import { getStore } from "../lib/store/case-store";
import { fireworksConfig } from "../lib/openweights/fireworks";
import { assertCanSubmit, buildDataset, parseFinetuneArgs, pollSftJob, quoteFineTune, sftPriceFromEnv, SpendRefused, submitFineTune, writeDataset } from "../lib/learning/finetune";

async function main() {
  const args = parseFinetuneArgs(process.argv.slice(2));
  const cases = await getStore().list();
  const { rows, report } = buildDataset(cases);
  const file = args.out ?? path.join(process.cwd(), ".data", "finetune", `labels-${new Date().toISOString().slice(0, 10)}.jsonl`);
  writeDataset(rows, file);
  console.log(`Dataset: ${report.rows} rows from ${report.labelCorrections} label correction(s) across ${report.cases} case(s) → ${file}`);
  console.log(`  skipped (not a label field): ${report.skippedNonLabel} · dropped (no archived crop image): ${report.droppedNoImage} · duplicates: ${report.duplicates}`);
  const quote = quoteFineTune(rows, { epochs: args.epochs, usdPerMTok: sftPriceFromEnv() });
  console.log(`Quote: ${quote.estUsd == null ? "no estimate" : `≈ $${quote.estUsd.toFixed(2)}`} · ${quote.trainingTokens.toLocaleString("en-US")} training tokens · ${quote.basis}`);
  if (args.mode === "quote") return;

  const cfg = fireworksConfig();
  try {
    assertCanSubmit({ rows, quote, confirmSpend: args.confirmSpend, cfg });
  } catch (e) {
    if (e instanceof SpendRefused) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const r = await submitFineTune({ rows, quote, confirmSpend: args.confirmSpend, cfg, announce: (line) => console.log(line) });
  console.log(`Submitted: job ${r.jobName} · dataset ${r.datasetId} · output model ${r.outputModelId}`);
  if (args.poll) {
    const done = await pollSftJob({ accountId: cfg.accountId!, apiKey: cfg.apiKey! }, r.jobName, { onState: (s) => console.log(`  ${new Date().toISOString()} ${s}`) });
    console.log(`Final state: ${done.state}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
