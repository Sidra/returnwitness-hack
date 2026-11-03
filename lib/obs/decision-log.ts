/**
 * Self-improvement loop: every decision the system drafts and every human outcome is logged,
 * so the evals page can show how often drafts were accepted, overridden or partially approved,
 * and which counter flags people disagreed with. Append-only JSONL.
 */
import fs from "node:fs";
import path from "node:path";
import { kv } from "@/lib/store/kv";

const KEY = `${process.env.RETURNWITNESS_KV_PREFIX || "rw"}:decisions`;

export interface DecisionEvent {
  at: string;
  caseId: string;
  rmaId: string;
  runId: string;
  kind: "pipeline_result" | "human_approve" | "human_hold" | "refund" | "refund_failed" | "refund_unknown" | "webhook_reconciled" | "evidence_requested" | "evidence_supplied" | "evidence_stale";
  state: string;
  recommendation?: string;
  draftSource?: string;
  heldCents?: number;
  approvedCents?: number;
  override?: boolean;
  flags?: string[];
  disagreements?: number;
  detail?: string;
}

const g = globalThis as unknown as { __rwDecisions?: DecisionEvent[] };

export function logDecision(e: Omit<DecisionEvent, "at">): void {
  const rec = { at: new Date().toISOString(), ...e };
  (g.__rwDecisions ??= []).push(rec);
  const r = kv();
  if (r) {
    // Shared across instances; capped so the free tier stays small.
    void r
      .lpush(KEY, JSON.stringify(rec))
      .then(() => r.ltrim(KEY, 0, 4999))
      .catch(() => {});
  }
  try {
    const file = decisionLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  } catch {
    /* memory only */
  }
}

/** The local decision log; RETURNWITNESS_DECISION_LOG moves it (the tests use their own, so fake runs never count as learning). */
const decisionLogFile = () => process.env.RETURNWITNESS_DECISION_LOG || path.join(process.cwd(), ".data", "decisions.jsonl");

export async function readDecisions(): Promise<DecisionEvent[]> {
  const r = kv();
  if (r) {
    try {
      const rows = (await r.lrange<string>(KEY, 0, 4999)) ?? [];
      return rows.map((x) => JSON.parse(x) as DecisionEvent).reverse();
    } catch {
      /* fall through to the local file */
    }
  }
  try {
    const file = decisionLogFile();
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DecisionEvent);
  } catch {
    return [...(g.__rwDecisions ?? [])];
  }
}
