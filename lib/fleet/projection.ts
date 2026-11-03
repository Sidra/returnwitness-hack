/**
 * "At 500 returns a day": a projection from the seeded shift's per-return agent count and
 * estimated live cost. It is arithmetic on the seeded mix, not a measurement, and is labelled so.
 */
import type { AgentSpec, ShiftRun } from "./types";

export interface DailyProjection {
  returnsPerDay: number;
  shiftReturns: number;
  /** Average agents that run on one return (per-return agents only). */
  agentsPerReturn: number;
  modelAgentsPerReturn: number;
  /** Per-return runs × returns, plus shift-scope agents once per batch of the shift's size. */
  agentRunsPerDay: number;
  namedInspectorsPerDay: number;
  /** Estimated live cost of one return: model agents + segmentation (USD). */
  usdPerReturn: number;
  modelUsdPerDay: number;
  usdPer30Days: number;
  /** Share of agent runs that are app code. */
  codeShare: number;
}

export function projectDaily(run: ShiftRun, roster: AgentSpec[], returnsPerDay = 500): DailyProjection {
  const n = run.outcomes.length || 1;
  const byName = new Map(roster.map((a) => [a.name, a]));
  const perReturnRuns = run.outcomes.map((o) => o.agentsRun.filter((name) => byName.get(name)?.scope === "return"));
  const agentsPerReturn = perReturnRuns.reduce((s, r) => s + r.length, 0) / n;
  const modelAgentsPerReturn = perReturnRuns.reduce((s, r) => s + r.filter((name) => byName.get(name)?.kind === "model").length, 0) / n;
  const shiftScoped = roster.filter((a) => a.scope === "shift").length;
  const batches = Math.ceil(returnsPerDay / n);
  const agentRunsPerDay = Math.round(agentsPerReturn * returnsPerDay) + shiftScoped * batches;
  const usdPerReturn = run.outcomes.reduce((s, o) => s + o.agentCostUsd + (o.cost?.segmentationUsd ?? 0), 0) / n;
  const codeRuns = perReturnRuns.reduce((s, r) => s + r.filter((name) => byName.get(name)?.kind === "code").length, 0) + shiftScoped;
  const allRuns = perReturnRuns.reduce((s, r) => s + r.length, 0) + shiftScoped;
  return {
    returnsPerDay,
    shiftReturns: run.outcomes.length,
    agentsPerReturn: Math.round(agentsPerReturn * 100) / 100,
    modelAgentsPerReturn: Math.round(modelAgentsPerReturn * 100) / 100,
    agentRunsPerDay,
    namedInspectorsPerDay: returnsPerDay,
    usdPerReturn: Math.round(usdPerReturn * 1e6) / 1e6,
    modelUsdPerDay: Math.round(usdPerReturn * returnsPerDay * 100) / 100,
    usdPer30Days: Math.round(usdPerReturn * returnsPerDay * 30 * 100) / 100,
    codeShare: allRuns ? Math.round((codeRuns / allRuns) * 1000) / 1000 : 0,
  };
}
