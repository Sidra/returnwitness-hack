/**
 * One run record for every number (evidence.json at the repo root). Every figure quoted in the
 * UI, README, pitch or video must come from one run in here; runs are appended, never edited.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export interface EvidenceRun {
  runId: string;
  kind: "gate" | "demo" | "latency";
  at: string;
  gitHash: string;
  mode: string;
  summary: Record<string, unknown>;
  details?: unknown;
}

export interface Evidence {
  note: string;
  current: Partial<Record<EvidenceRun["kind"], string>>;
  runs: EvidenceRun[];
}

export const EVIDENCE_FILE = path.join(process.cwd(), "evidence.json");

export function gitHash(): string {
  try {
    const h = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() ? "-dirty" : "";
    return h + dirty;
  } catch {
    return "unknown";
  }
}

export function readEvidence(file = EVIDENCE_FILE): Evidence {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Evidence;
  } catch {
    return { note: "One run record for every number. Append-only; `current` names the run each surface quotes.", current: {}, runs: [] };
  }
}

export function appendRun(run: EvidenceRun, makeCurrent = true, file = EVIDENCE_FILE): Evidence {
  const ev = readEvidence(file);
  if (ev.runs.some((r) => r.runId === run.runId)) throw new Error(`run ${run.runId} already recorded`);
  ev.runs.push(run);
  if (makeCurrent) ev.current[run.kind] = run.runId;
  fs.writeFileSync(file, `${JSON.stringify(ev, null, 2)}\n`);
  return ev;
}
