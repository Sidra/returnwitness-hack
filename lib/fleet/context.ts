/**
 * What each agent is handed: the return, the shift's merchant settings and policy, and the
 * outputs of the agents upstream of it. An upstream output is `undefined` when that agent was
 * removed (ablation) or didn't run; every agent has to cope with that.
 */
import type { CountResult, Policy } from "@/lib/domain/schemas";
import type { Settlement } from "@/lib/engine/reconcile";
import { PRICES } from "@/lib/obs/llm-log";
import type { CropAnnotation, ItemKey, SeededShift, ShiftReturn } from "@/data/shift";
import type { z } from "zod";
import type { AgentResult, CarrierClaimDraft, FleetLine, MetaModelId, RestockLine } from "./types";

export interface InspectorOutput {
  count: CountResult;
  /** Count-only reconciliation lines (serials are the serial matcher's job). */
  lines: FleetLine[];
  frames: number;
}

export interface LabelRead {
  itemKey: ItemKey;
  text: string | null;
  confidence: number | null;
  legible: boolean;
  why: string;
}
export interface LabelReaderOutput {
  reads: LabelRead[];
}

export interface DamageReaderOutput {
  items: Array<CropAnnotation & { holds: boolean }>;
  outerBox: ShiftReturn["outerBox"];
}

export type SpokenClaimKind = "accessory_missing" | "carton_crushed" | "battery_hazard" | "customer_assertion";
export interface VoiceClaim {
  kind: SpokenClaimKind;
  itemKey: ItemKey | null;
  quote: string;
}
export interface VoiceReaderOutput {
  claims: VoiceClaim[];
}

export interface SerialCheck {
  itemKey: ItemKey;
  expected: string;
  read: string | null;
  match: boolean | null;
  /** If the read serial belongs to another order in the shift. */
  belongsTo?: { orderId: string; rmaId: string };
}
export interface SerialMatcherOutput {
  checks: SerialCheck[];
}

export interface FraudFlag {
  kind: "repeat_address" | "duplicate_serial";
  detail: string;
  related: string[];
  itemKey: string;
}
export interface FraudOutput {
  flags: FraudFlag[];
}

export interface PolicyOutput {
  clauses: string[];
  daysSinceDelivery: number;
  late: boolean;
}

export interface Upstream {
  inspector?: InspectorOutput;
  labelReader?: LabelReaderOutput;
  damageReader?: DamageReaderOutput;
  voiceReader?: VoiceReaderOutput;
  serialMatcher?: SerialMatcherOutput;
  fraud?: FraudOutput;
  carrierClaim?: CarrierClaimDraft | null;
  policy?: PolicyOutput;
  restock?: RestockLine[];
}

export interface ReturnCtx {
  ret: ShiftReturn;
  settings: SeededShift["settings"];
  policy: Policy;
  up: Upstream;
  /** The coordinator's merged lines so far (stage 3 and 4 agents). */
  lines?: FleetLine[];
  settlement?: Settlement;
  /** Names of agents that ran on this return before the cost agent (for its ledger). */
  ran?: Array<{ name: string; costPerRunUsd: number }>;
  /** Live runs only: key frames and item crops of the real clip (JPEG data URLs). */
  images?: EvidenceImage[];
}

export interface EvidenceImage {
  caption: string;
  dataUrl: string;
}

export const cropsOf = (ctx: ReturnCtx, itemKeys?: string[]) => (ctx.images ?? []).filter((i) => i.caption.startsWith("crop of") && (!itemKeys || itemKeys.some((k) => i.caption.includes(` ${k} `))));
export const keyFramesOf = (ctx: ReturnCtx) => (ctx.images ?? []).filter((i) => i.caption.startsWith("key frame"));

/**
 * A model role's live call: the zod schema its answer must match, its prompt, how a validated answer
 * becomes the role's result (holds only), and how that result combines with the deterministic one
 * (never less restrictive). lib/fleet/live.ts makes the call; lib/fleet/live-merge.ts replays it.
 */
export interface LiveRoleDef<O, L> {
  role: "label-reader" | "damage-reader" | "voice-note-reader" | "carrier-claim-agent" | "policy-agent" | "restock-grader" | "customer-message-drafter";
  modelKind: "spark" | "wonder";
  schemaName: string;
  schema: z.ZodType<L>;
  system: string;
  prompt(ctx: ReturnCtx): { text: string; images: EvidenceImage[] };
  /** A validated live answer → the role's result. Throws (→ deterministic fallback) when the answer can't be used. */
  toResult(live: L, ctx: ReturnCtx): AgentResult<O>;
  /** Combine with the deterministic result: holds and work items are a union; outputs take the more restrictive side. */
  combine?(det: AgentResult<O>, live: AgentResult<O>): AgentResult<O>;
}

/** Shared item fields for prompts: what the slip lists and what the counter saw. */
export function slipAndCount(ctx: ReturnCtx) {
  return {
    rma: { id: ctx.ret.rma.id, reason: ctx.ret.rma.reason },
    packingSlip: ctx.ret.order.slip.lines.map((l) => ({ itemKey: l.itemKey, description: l.description, qty: l.qty, serial: l.serial ?? null })),
    counter: ctx.up.inspector
      ? { counts: ctx.up.inspector.count.counts, flags: ctx.up.inspector.count.flags.map((f) => ({ code: f.code, itemKeys: f.itemKeys, detail: f.detail })), labels: ctx.up.inspector.count.arrivals.filter((a) => a.label).map((a) => ({ itemKey: a.itemKey, text: a.label!.text, confidence: a.label!.confidence })) }
      : null,
    lines: (ctx.lines ?? ctx.up.inspector?.lines ?? []).map((l) => ({ itemKey: l.itemKey, status: l.status, reasons: l.reasons.filter((r) => r.code !== "count_match").map((r) => r.detail) })),
  };
}

const unionBy = <T,>(a: T[], b: T[], key: (x: T) => string) => [...a, ...b.filter((x) => !a.some((y) => key(y) === key(x)))];

/** Default combine: union of holds and work items, the live output and trace. */
export function combineDefault<O>(det: AgentResult<O>, live: AgentResult<O>): AgentResult<O> {
  return {
    output: live.output,
    trace: live.trace,
    holds: unionBy(det.holds, live.holds, (h) => `${h.itemKey}|${h.code}`),
    workItems: unionBy(det.workItems, live.workItems, (w) => w.text),
  };
}

/** Estimated live cost of one run from a token budget at Meta list price. */
export function tokenBudgetUsd(model: keyof Pick<typeof PRICES, "muse-spark-1.3" | "muse-wonder-1.0">, inTok: number, outTok: number): number {
  const p = PRICES[model];
  return Math.round(((inTok * p.in + outTok * p.out) / 1_000_000) * 1e6) / 1e6;
}

export const budgetBasis = (model: MetaModelId, inTok: number, outTok: number, note = "") =>
  `${inTok.toLocaleString("en-US")} in + ${outTok.toLocaleString("en-US")} out tokens at ${model} list price${note ? `; ${note}` : ""} (estimate)`;

export const SAM_PER_FRAME_USD = PRICES.samPerFrameUsd;
