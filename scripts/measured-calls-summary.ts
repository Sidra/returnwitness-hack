/**
 * Writes data/measured-calls.json: the committed, per-model record of measured live calls (latency and logged cost)
 * that the "How it scales" section computes from. The raw call log (.data/llm-calls.jsonl) stays local; this keeps
 * only counts, percentiles and sums. Re-run after each live run so the scale numbers follow the newest measurements.
 *
 *   npx tsx scripts/measured-calls-summary.ts --since <ISO time> --source "meta-preflight: 4 runs on a synthetic 25-frame clip"
 */
import fs from "node:fs";
import path from "node:path";
import { summarizeCalls, type CallRow } from "../lib/scale/measured";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const since = arg("since");
const source = arg("source");
if (!since || !source) throw new Error('usage: --since <ISO> --source "<what was run>" [--until <ISO>] [--log .data/llm-calls.jsonl]');
const log = arg("log") ?? path.join(".data", "llm-calls.jsonl");
const rows = fs
  .readFileSync(log, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CallRow);
const summary = summarizeCalls(rows, { since, until: arg("until"), source });
fs.writeFileSync(path.join("data", "measured-calls.json"), JSON.stringify(summary, null, 2) + "\n");
for (const m of summary.models) console.log(`${m.id.padEnd(28)} n ${m.calls} ok ${m.ok} · p50 ${m.latencyMs.p50} ms p90 ${m.latencyMs.p90} ms · $${m.costUsd.p50}/call`);
console.log(`→ data/measured-calls.json (${summary.window.from} → ${summary.window.to})`);
