/**
 * Cost agent: what this return costs the merchant beyond the refund itself: the estimated live
 * inspection cost (segmentation frames × concepts at SAM 3.1 list price, plus the model agents
 * that ran at their token-budget estimates), the processing fee on the original charge that a
 * refund doesn't give back, and the prepaid return label. Estimates are labelled as such; this
 * build spends nothing on models. App code.
 */
import type { ReturnCtx } from "../context";
import { SAM_PER_FRAME_USD } from "../context";
import type { AgentResult, AgentSpec, CostLedger } from "../types";

export const costSpec: AgentSpec = {
  name: "cost-agent",
  role: "cost-agent",
  kind: "code",
  costPerRunUsd: 0,
  costBasis: "app code",
  scope: "return",
  does: "prices the inspection (estimated live model cost) and the fees a return costs the merchant",
};

export function runCost(ctx: ReturnCtx): AgentResult<CostLedger> {
  const s = ctx.settings;
  const agentUsd = Math.round((ctx.ran ?? []).reduce((t, a) => t + a.costPerRunUsd, 0) * 1e6) / 1e6;
  const frames = ctx.up.inspector?.frames ?? 0;
  const segmentationUsd = Math.round(frames * s.segmentationConcepts * SAM_PER_FRAME_USD * 1e6) / 1e6;
  const refunds = (ctx.settlement && ctx.settlement.options.find((o) => o.key === ctx.settlement!.recommended)!.refundCents > 0) ?? false;
  const processingFeeLostCents = refunds ? Math.round(ctx.ret.rma.requestedRefundCents * s.processingFee.pct) + s.processingFee.fixedCents : 0;
  const totalCents = Math.round((agentUsd + segmentationUsd) * 100) + processingFeeLostCents + s.returnLabelCents;
  return {
    output: { agentUsd, segmentationUsd, processingFeeLostCents, returnLabelCents: s.returnLabelCents, totalCents },
    trace: `inspection ≈ ${(agentUsd + segmentationUsd).toFixed(4)} USD est. live; fees ${((processingFeeLostCents + s.returnLabelCents) / 100).toFixed(2)} USD${processingFeeLostCents ? " (fee not returned on refund + label)" : " (label only; nothing refunds yet)"}`,
    holds: [],
    workItems: [],
  };
}
