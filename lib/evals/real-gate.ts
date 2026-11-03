/**
 * The registered gate's real result on the filmed clips, from gate/results/: the newest LIVE run (SAM 3.1 on the
 * filmed clips) and the newest calibrated re-score (recorded SAM output, no model call). Read by /api/evals and the
 * evals summary; served without a commit hash and without run dates (`at`, a dated `runId`).
 */
import fs from "node:fs";
import path from "node:path";

export interface GateClip {
  clipId: string;
  pass: boolean;
  failures: string[];
  perItem: Array<{ itemKey: string; expected: number; arrivals: number; samIds: number; held: string[] }>;
  holdCodes: string[];
}
export interface GateRun {
  runId?: string;
  at?: string;
  verdict?: "PASS" | "FAIL" | "INCOMPLETE" | string;
  notRun?: string[];
  sizes?: string;
  source?: string;
  calibration?: string;
  model?: string;
  clips?: GateClip[];
}

export function loadGateRuns(dir = path.join(process.cwd(), "gate", "results")): GateRun[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as GateRun & { gitHash?: string })
      .map(({ gitHash: _gitHash, at: _at, runId: _runId, ...g }, i) => ({ ...g, runId: `${g.source ? "rescore" : "gate"}-${i + 1}`, ...(typeof g.calibration === "string" ? { calibration: g.calibration.replace(/ at commit \S+/, "") } : {}) }));
  } catch {
    return [];
  }
}

export function latestGate(runs = loadGateRuns()): { live: GateRun | null; rescore: GateRun | null; liveRuns: number; rescores: number } {
  const live = runs.filter((g) => !g.source);
  const rescore = runs.filter((g) => g.source);
  return { live: live.at(-1) ?? null, rescore: rescore.at(-1) ?? null, liveRuns: live.length, rescores: rescore.length };
}
