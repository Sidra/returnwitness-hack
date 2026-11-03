/**
 * Same-input A/B, pre-registered in evals/AB-SAME-INPUT-PREREG.md before any arm has run.
 *
 *   Arm A · Muse Spark 1.3 alone: the packing slip, the policy, the customer's reason and the clip's four key
 *           frames (the exact images the pipeline's Spark reader gets), one question: "is this kit complete?
 *           refund or hold?". One call per clip, no retry.
 *   Arm B · the full ReturnWitness pipeline on the same clip: SAM 3.1 at 5 fps → tray counter → Muse Spark 1.3
 *           reader → reconciliation (app code) → Muse Wonder 1.0 draft. Its answer is the case state:
 *           Held = hold, AwaitingApproval = refund recommended (a person still signs; no arm moves money).
 *
 * Every clip is scored against its known contents (gate/manifest.json, plus d1/d2 from their RMAs), every loss is
 * kept, and a failed call is "no answer" (never re-run, never counted as a hold or a refund).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { KIT } from "@/data/kit.config";
import { policyText } from "@/data/fixtures";
import type { PackingSlip, Policy, Rma } from "@/lib/domain/schemas";
import type { CaseState } from "@/lib/domain/case";
import type { ManifestClip } from "@/lib/evals/suite";
import { promptCacheKey } from "@/lib/obs/llm-log";
import { metaJson, type ReaderEvidence } from "@/lib/meta/readers";
import type { MetaConfig } from "@/lib/meta/config";

export const AB_VERSION = "same-input-ab/1";

/** Frozen: the prompt's sha256 is printed in the pre-registration, and a test holds them together. */
export const ARM_A_SYSTEM = `You check a returned e-commerce kit at an inspection bench.
You get: the packing slip (what should be in the box), the store's return policy, what the customer says,
and key frames from an overhead camera filming the box being unpacked (box on the left, inspection tray on the right).
Answer two questions: is this kit complete? Refund or hold?
- refund: every packing-slip item is there and the policy allows the refund.
- hold: anything is missing, or you cannot tell. A person then reviews the box before any money moves.
List the itemKey of every packing-slip item you could not see in missingItemKeys.`;

export const armAPromptSha256 = () => crypto.createHash("sha256").update(ARM_A_SYSTEM).digest("hex");

export const ArmAReply = z
  .object({
    complete: z.boolean(),
    decision: z.enum(["refund", "hold"]),
    missingItemKeys: z.array(z.string()),
    reason: z.string().min(1),
  })
  .strict();
export type ArmAReply = z.infer<typeof ArmAReply>;

export function armAUserText(rma: Rma, slip: PackingSlip, policy: Policy): string {
  return [
    `RETURN POLICY (${policy.id}, version ${policy.version}):\n${policyText(policy)}`,
    `RMA ${rma.id} for order ${rma.orderId}. Customer says: "${rma.reason}". Requested refund: ${rma.requestedRefundCents} cents.`,
    `PACKING SLIP:\n${JSON.stringify(slip.lines.map((l) => ({ itemKey: l.itemKey, sku: l.sku, description: l.description, qty: l.qty, serial: l.serial ?? null })), null, 1)}`,
  ].join("\n\n");
}

export type ArmDecision = "refund" | "hold" | null;

export interface ArmARun {
  decision: ArmDecision;
  reply: ArmAReply | null;
  latencyMs: number;
  requestId?: string;
  error?: string;
}

/** Arm A: one Spark call, no retry (the pre-registration counts a failed call as "no answer"). */
export async function runArmA(args: { rma: Rma; slip: PackingSlip; policy: Policy; images: ReaderEvidence["images"]; clipId: string }, cfg: MetaConfig): Promise<ArmARun> {
  if (!cfg.apiKey || cfg.publicDemo) return { decision: null, reply: null, latencyMs: 0, error: "no live Meta key in this profile" };
  const r = await metaJson({
    cfg,
    model: cfg.models.spark,
    purpose: "ab_spark_alone",
    system: ARM_A_SYSTEM,
    cacheKey: promptCacheKey("ab-spark-alone", AB_VERSION),
    userText: armAUserText(args.rma, args.slip, args.policy),
    images: args.images,
    schemaName: "kit_decision",
    schema: ArmAReply,
    caseId: `ab:${args.clipId}`,
  });
  return { decision: r.value?.decision ?? null, reply: r.value, latencyMs: r.latencyMs, ...(r.requestId ? { requestId: r.requestId } : {}), ...(r.error ? { error: r.error } : {}) };
}

/** Arm B's answer is the case state the pipeline left the box in. Anything else (a stage failed) is no answer. */
export function armBDecision(state: CaseState): ArmDecision {
  if (state === "Held") return "hold";
  if (state === "AwaitingApproval") return "refund";
  return null;
}

/* ---------- Truth and scoring ---------- */

export interface AbClip {
  id: string;
  /** File stem under the clips folder. */
  file: string;
  expected: Record<string, number>;
  /** Hold codes the manifest accepts on this clip (a hold here is not a false hold, for either arm). */
  acceptHold: string[];
  /** Arm B source: "demo" = the d1–d3 live inspection; "gate" = the gate run's recorded SAM output + live readers. */
  kind: "gate" | "demo";
}

const full = Object.fromEntries(KIT.items.map((i) => [i.key, 1]));

/** The 12 clips: g0–g8 from gate/manifest.json, d1–d3 from their RMAs (d3 is also in the manifest's demoClips). */
export function abClips(manifest: { clips: Array<ManifestClip & { file: string }>; demoClips?: Array<ManifestClip & { file: string }> }): AbClip[] {
  const stem = (f: string) => f.replace(/\.[a-z0-9]+$/i, "");
  const gate = manifest.clips.map((c) => ({ id: c.id, file: stem(c.file), expected: c.expected, acceptHold: c.acceptHold, kind: "gate" as const }));
  const d3 = manifest.demoClips?.find((c) => c.id === "d3");
  return [
    ...gate,
    { id: "d1", file: "d1-rma-20418-lens-missing", expected: { ...full, lens: 0 }, acceptHold: [], kind: "demo" },
    { id: "d2", file: "d2-rma-20419-complete", expected: { ...full }, acceptHold: [], kind: "demo" },
    { id: "d3", file: d3 ? stem(d3.file) : "d3-camera-reboxed", expected: d3?.expected ?? { ...full }, acceptHold: d3?.acceptHold ?? [], kind: "demo" },
  ];
}

export type Truth = "must_hold" | "hold_acceptable" | "complete";

/** A slip item short in the box → must hold. A complete kit whose clip accepts a hold → either answer is fine. */
export function truthOf(c: Pick<AbClip, "expected" | "acceptHold">): Truth {
  if (KIT.items.some((i) => (c.expected[i.key] ?? 0) < 1)) return "must_hold";
  return c.acceptHold.length ? "hold_acceptable" : "complete";
}

export type Outcome = "correct_hold" | "correct_refund" | "accepted_hold" | "wrong_refund" | "false_hold" | "no_answer";

export function scoreDecision(d: ArmDecision, truth: Truth): Outcome {
  if (d === null) return "no_answer";
  if (truth === "must_hold") return d === "hold" ? "correct_hold" : "wrong_refund";
  if (d === "refund") return "correct_refund";
  return truth === "hold_acceptable" ? "accepted_hold" : "false_hold";
}

export const LOSSES: ReadonlySet<Outcome> = new Set(["wrong_refund", "false_hold", "no_answer"]);

export interface AbRow {
  clipId: string;
  truth: Truth;
  armA: { decision: ArmDecision; outcome: Outcome; missingItemKeys: string[]; reason: string | null; requestId?: string; error?: string; latencyMs: number };
  armB: { decision: ArmDecision; outcome: Outcome; state: CaseState | null; holdCodes: string[]; caseId?: string; error?: string; source: string };
}

export interface ArmTotals {
  clips: number;
  wrongRefunds: number;
  falseHolds: number;
  noAnswer: number;
  correct: number;
}

export function armTotals(rows: AbRow[], arm: "armA" | "armB"): ArmTotals {
  const n = (o: Outcome) => rows.filter((r) => r[arm].outcome === o).length;
  return { clips: rows.length, wrongRefunds: n("wrong_refund"), falseHolds: n("false_hold"), noAnswer: n("no_answer"), correct: n("correct_hold") + n("correct_refund") + n("accepted_hold") };
}

export interface AbReport {
  version: typeof AB_VERSION;
  runId: string;
  at: string;
  gitHash: string;
  promptSha256: string;
  model: string;
  rows: AbRow[];
  totals: { armA: ArmTotals; armB: ArmTotals };
  costUsd: { armA: number; armB: number };
  /** Registered clips with no file on the bench: listed as not filmed, never scored as no answer (addendum). */
  notFilmed?: string[];
  /** The clip the item sizes were measured on, when Arm B counted with them; its row is kept and marked. */
  calibrationClip?: string | null;
  /** Both arms' totals without the calibration clip's row (the addendum's second headline). */
  totalsWithoutCalibration?: { armA: ArmTotals; armB: ArmTotals } | null;
}

/** Worst-case extra spend for the A/B on top of the d1–d3 run (Arm B on d1–d3 is that run itself, not extra). */
export function abQuote(args: { gateClips: number; allClips: number; prices: { spark: { in: number; out: number }; wonder: { in: number; out: number } } }) {
  const ARM_A = { in: 8_000, out: 1_000 }; // 4 key frames at 1280 px + slip/policy text; a short JSON answer
  const SPARK = { in: 14_000, out: 2_000 };
  const WONDER = { in: 15_000, out: 2_000 };
  const usd = (t: { in: number; out: number }, p: { in: number; out: number }) => (t.in * p.in + t.out * p.out) / 1e6;
  const armA = args.allClips * usd(ARM_A, args.prices.spark);
  const armB = args.gateClips * (usd(SPARK, args.prices.spark) + usd(WONDER, args.prices.wonder));
  return {
    calls: { armASpark: args.allClips, armBSpark: args.gateClips, armBWonderRuns: args.gateClips, sam: 0 },
    usd: { armA, armB, total: armA + armB },
    basis: `Arm A ${args.allClips} Spark calls × ~${ARM_A.in / 1000}k in / ${ARM_A.out / 1000}k out; Arm B on the ${args.gateClips} gate clips replays the gate run's SAM output (0 new SAM) + ${args.gateClips} Spark + ${args.gateClips} Wonder agent runs (estimate, 2–4 model turns each); d1–d3 Arm B is the live run itself`,
  };
}

/** The newest A/B report under data/ab/, or null before the run (the page then shows the pre-registration only). */
export function loadLatestAbReport(dir = path.join(process.cwd(), "data", "ab")): AbReport | null {
  try {
    const f = fs.readdirSync(dir).filter((x) => /^ab_.*\.json$/.test(x)).sort().at(-1);
    if (!f) return null;
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AbReport;
    return r.version === AB_VERSION && Array.isArray(r.rows) ? r : null;
  } catch {
    return null;
  }
}
