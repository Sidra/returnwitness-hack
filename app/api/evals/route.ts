import fs from "node:fs";
import path from "node:path";
import { connection } from "next/server";
import { runSyntheticGate } from "@/lib/evals/suite";
import { COUNTER_CONFIG } from "@/lib/runtime";
import { readDecisions } from "@/lib/obs/decision-log";
import { json } from "@/lib/api";
import { latestGate, loadGateRuns } from "@/lib/evals/real-gate";

export async function GET() {
  await connection();
  const synthetic = runSyntheticGate(COUNTER_CONFIG);
  const real = loadGateRuns();
  const g = latestGate(real);
  let framing: unknown = null;
  try {
    framing = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "clip-framing.json"), "utf8"));
  } catch {
    framing = null;
  }
  const decisions = await readDecisions();
  const approvals = decisions.filter((d) => d.kind === "human_approve");
  return json({
    synthetic,
    real,
    gate: { ...g, framing },
    learning: {
      pipelineRuns: decisions.filter((d) => d.kind === "pipeline_result").length,
      held: decisions.filter((d) => d.kind === "pipeline_result" && d.state === "Held").length,
      approvals: approvals.length,
      overrides: approvals.filter((a) => a.override).length,
      manualHolds: decisions.filter((d) => d.kind === "human_hold").length,
      refunds: decisions.filter((d) => d.kind === "refund").length,
      refundFailures: decisions.filter((d) => d.kind === "refund_failed").length,
      flagCounts: decisions
        .filter((d) => d.kind === "pipeline_result")
        .flatMap((d) => d.flags ?? [])
        .reduce<Record<string, number>>((m, f) => ({ ...m, [f]: (m[f] ?? 0) + 1 }), {}),
    },
  });
}
