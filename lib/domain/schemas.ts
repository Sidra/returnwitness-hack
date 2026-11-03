/**
 * Domain contracts. Money is integer cents, times are UTC ISO strings, clip times are
 * seconds from clip start, geometry is normalised to the frame (0..1).
 */
import { z } from "zod";

/* ---------- Geometry + segmentation ---------- */

export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]); // x, y, w, h
export type BBox = z.infer<typeof BBox>;

export const LabelRead = z.object({
  text: z.string(),
  confidence: z.number().min(0).max(1),
});
export type LabelRead = z.infer<typeof LabelRead>;

export const Mask = z.object({
  /** Raw tracker identity from the segmenter. Diagnostics only: never counted. */
  trackId: z.union([z.string(), z.number()]),
  concept: z.string(),
  bbox: BBox,
  /** Mask area as a fraction of the frame. */
  area: z.number().min(0).max(1),
  score: z.number().min(0).max(1).default(1),
  /** Optional label/serial read for this mask in this frame (from the label-read stage). */
  label: LabelRead.optional(),
});
export type Mask = z.infer<typeof Mask>;

export const Frame = z.object({
  index: z.number().int().nonnegative(),
  t: z.number().nonnegative(),
  masks: z.array(Mask),
});
export type Frame = z.infer<typeof Frame>;

// LIVE_OPEN_WEIGHTS: a live call to Meta's open weights served by a partner (Baseten, Modal, Fireworks),
// not to Meta's own API. Labelled separately so a partner-hosted run is never shown as "LIVE · Meta".
export const ModeLabel = z.enum(["LIVE_META", "LIVE_OPEN_WEIGHTS", "RECORDED_FIXTURE", "DETERMINISTIC"]);
export type ModeLabel = z.infer<typeof ModeLabel>;

export const MODE_TEXT: Record<ModeLabel, string> = {
  LIVE_META: "LIVE · Meta",
  LIVE_OPEN_WEIGHTS: "LIVE · Meta open weights on a partner GPU",
  RECORDED_FIXTURE: "RECORDED FIXTURE · synthetic scene, not a live Meta call",
  DETERMINISTIC: "DETERMINISTIC · app code, no model",
};

/** A replay of a recorded REAL run (filmed clip, real model answers) is not a synthetic scene: it says so. */
export const REAL_REPLAY_TEXT = "RECORDED · replay of a recorded real run, not a live call";
/** The provenance the replaying segmenter writes for a recorded real run ("replay of …"). */
export const isRealReplay = (provenance: string | undefined) => !!provenance && provenance.startsWith("replay of ");
export const modeText = (mode: ModeLabel, realReplay = false) => (mode === "RECORDED_FIXTURE" && realReplay ? REAL_REPLAY_TEXT : MODE_TEXT[mode]);

export const SegmentationResult = z.object({
  clipId: z.string(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationS: z.number().nonnegative(),
  frames: z.array(Frame),
  source: z.object({
    mode: ModeLabel,
    model: z.string(),
    provenance: z.string(),
    recordedAt: z.string().optional(),
    requestIds: z.array(z.string()).default([]),
  }),
});
export type SegmentationResult = z.infer<typeof SegmentationResult>;

/* ---------- Tray counter output ---------- */

export const FlagCode = z.enum([
  "merged_mask",
  "left_tray",
  "label_unreadable",
  "concept_conflict",
  "seen_not_placed",
  "reentry_rebound",
  "occlusion_long",
  // A merge of counted items that later split back into each item at its own spot: informational.
  "merge_resolved",
]);
export type FlagCode = z.infer<typeof FlagCode>;

/** Flags that force the affected line to HELD. The rest are informational. */
export const HOLDING_FLAGS: ReadonlySet<FlagCode> = new Set<FlagCode>([
  "merged_mask",
  "left_tray",
  "label_unreadable",
  "concept_conflict",
  "seen_not_placed",
]);

export const CounterFlag = z.object({
  code: FlagCode,
  itemKeys: z.array(z.string()),
  t: z.number(),
  frameIndex: z.number().int(),
  detail: z.string(),
  bbox: BBox.optional(),
});
export type CounterFlag = z.infer<typeof CounterFlag>;

export const Arrival = z.object({
  slotId: z.string(),
  itemKey: z.string(),
  t: z.number(),
  frameIndex: z.number().int(),
  bbox: BBox,
  area: z.number(),
  label: LabelRead.optional(),
});
export type Arrival = z.infer<typeof Arrival>;

export const CountResult = z.object({
  clipId: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  arrivals: z.array(Arrival),
  flags: z.array(CounterFlag),
  diagnostics: z.object({
    framesProcessed: z.number().int(),
    /** Distinct raw track IDs seen per item concept anywhere in frame (fragmentation). */
    rawTrackIdsPerItem: z.record(z.string(), z.number().int()),
    /** Distinct raw track IDs bound to each counted slot (the gate's "IDs per physical item"). */
    trackIdsPerSlot: z.record(z.string(), z.array(z.string())),
    ignoredMasks: z.number().int(),
  }),
});
export type CountResult = z.infer<typeof CountResult>;

/* ---------- Merchant fixtures ---------- */

export const PackingSlipLine = z.object({
  itemKey: z.string(),
  sku: z.string(),
  description: z.string(),
  qty: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  requiresSerial: z.boolean(),
  serial: z.string().optional(),
});
export type PackingSlipLine = z.infer<typeof PackingSlipLine>;

export const PackingSlip = z.object({
  orderId: z.string(),
  shippedAt: z.string(),
  lines: z.array(PackingSlipLine).min(1),
});
export type PackingSlip = z.infer<typeof PackingSlip>;

export const PolicyClause = z.object({ id: z.string(), title: z.string(), text: z.string() });
export type PolicyClause = z.infer<typeof PolicyClause>;

export const Policy = z.object({
  id: z.string(),
  merchant: z.string(),
  version: z.string(),
  effective: z.string(),
  clauses: z.array(PolicyClause).min(1),
});
export type Policy = z.infer<typeof Policy>;

export const Rma = z.object({
  id: z.string(),
  orderId: z.string(),
  customer: z.object({ name: z.string(), email: z.string() }),
  reason: z.string(),
  requestedRefundCents: z.number().int().nonnegative(),
  createdAt: z.string(),
  clipId: z.string(),
  /** Which demo scenario this RMA is (for labels; not used in decisions). */
  scenario: z.string(),
});
export type Rma = z.infer<typeof Rma>;

/* ---------- Reconciliation contract ---------- */

export const LineStatus = z.enum(["OK", "MISSING", "HELD", "EXTRA"]);
export type LineStatus = z.infer<typeof LineStatus>;

export const ReasonCode = z.enum([
  "count_match",
  "not_observed",
  "short_count",
  "extra_observed",
  "merged_mask",
  "left_tray",
  "label_unreadable",
  "serial_mismatch",
  "concept_conflict",
  "seen_not_placed",
  "model_disagrees",
  "model_unavailable",
  "pipeline_error",
  "visible_damage",
  "stand_in_suspected",
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const LineReason = z.object({
  code: ReasonCode,
  detail: z.string(),
  t: z.number().optional(),
  bbox: BBox.optional(),
});
export type LineReason = z.infer<typeof LineReason>;

export const ReconciliationLine = z.object({
  itemKey: z.string(),
  sku: z.string(),
  description: z.string(),
  expectedQty: z.number().int().nonnegative(),
  observedQty: z.number().int().nonnegative(),
  missingQty: z.number().int().nonnegative(),
  status: LineStatus,
  reasons: z.array(LineReason),
  unitPriceCents: z.number().int().nonnegative(),
});
export type ReconciliationLine = z.infer<typeof ReconciliationLine>;

/** A hold that comes from the return policy, not from any one line (e.g. the return window, clause 1.1). */
export const PolicyHold = z.object({ code: z.literal("outside_return_window"), clauseId: z.string(), detail: z.string() });
export type PolicyHold = z.infer<typeof PolicyHold>;

export const Reconciliation = z.object({
  rmaId: z.string(),
  source: z.enum(["deterministic", "model", "cross_checked"]),
  mode: ModeLabel,
  lines: z.array(ReconciliationLine),
  /** Case-level holds from the policy; any one of them means the case isn't all clear. */
  policyHolds: z.array(PolicyHold).optional(),
  summary: z.object({
    expectedCents: z.number().int(),
    observedCents: z.number().int(),
    heldCents: z.number().int(),
    allClear: z.boolean(),
  }),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

/** What a model is asked to return (the reconciliation lines only; app code computes the summary). */
export const ModelReconciliationOutput = z.object({
  lines: z.array(
    z.object({
      itemKey: z.string(),
      observedQty: z.number().int().nonnegative(),
      status: LineStatus,
      reasons: z.array(z.object({ code: ReasonCode, detail: z.string() })).default([]),
      serialRead: z.string().nullable().optional(),
    }),
  ),
  notes: z.string().default(""),
});
export type ModelReconciliationOutput = z.infer<typeof ModelReconciliationOutput>;

/* ---------- Decision draft ---------- */

export const Recommendation = z.enum(["HOLD", "APPROVE_FULL", "APPROVE_PARTIAL"]);
export type Recommendation = z.infer<typeof Recommendation>;

export const DecisionDraft = z.object({
  recommendation: Recommendation,
  proposedRefundCents: z.number().int().nonnegative(),
  citedClauses: z.array(z.object({ clauseId: z.string(), quote: z.string() })).min(1),
  rationale: z.string().min(1),
  lineNotes: z.array(z.object({ itemKey: z.string(), note: z.string() })).default([]),
  /** A verbatim quote from the returns lead's transcribed voice note, when the draft relies on it. */
  citedVoiceNote: z.string().optional(),
});
export type DecisionDraft = z.infer<typeof DecisionDraft>;
