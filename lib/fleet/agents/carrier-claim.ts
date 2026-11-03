/**
 * Carrier-claim agent: when an item is damaged AND there is evidence it happened in transit (a
 * carrier exception scan, a crushed carton on camera, or the lead saying the box arrived crushed),
 * drafts the claim against the return carrier: tracking, the exception scan, photo references
 * (the damage crops' clip times) and the damaged items' value. A person files it. Damage without
 * transit evidence is not a carrier claim; carton damage with undamaged contents is noted, not
 * claimed. Deterministic: rules. Live (`carrierClaimLive`): muse-wonder-1.0 decides and writes the
 * evidence; app code still sets the carrier, tracking, photo references and the claimed amount.
 */
import { z } from "zod";
import { budgetBasis, slipAndCount, tokenBudgetUsd, type LiveRoleDef, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, CarrierClaimDraft } from "../types";

const BUDGET = { inTok: 2500, outTok: 700 };

export const carrierClaimSpec: AgentSpec = {
  name: "carrier-claim-agent",
  role: "carrier-claim-agent",
  kind: "model",
  model: "muse-wonder-1.0",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok, "runs only when there is damage or transit evidence"),
  scope: "return",
  does: "drafts a claim against the return carrier when damage and transit evidence meet",
};

function evidence(ctx: ReturnCtx) {
  const damaged = (ctx.up.damageReader?.items ?? []).filter((i) => i.surface === "dented");
  const exception = ctx.ret.order.returnShipment.scans.find((s) => /exception|damaged/i.test(s.event)) ?? null;
  const crushedOnCamera = ctx.up.damageReader?.outerBox === "crushed";
  const spoken = (ctx.up.voiceReader?.claims ?? []).find((c) => c.kind === "carton_crushed") ?? null;
  const transit = [
    ...(exception ? [`carrier scan ${exception.at.slice(0, 10)}: "${exception.event}"`] : []),
    ...(crushedOnCamera ? ["outer carton crushed on the bench camera"] : []),
    ...(spoken ? [`${ctx.ret.voiceNote?.person ?? "returns lead"} said: "${spoken.quote}"`] : []),
  ];
  return { damaged, exception, transit };
}

/** The agent only runs (and costs) when something points at damage or transit. */
export function carrierClaimTriggered(ctx: ReturnCtx): boolean {
  const e = evidence(ctx);
  return e.damaged.length > 0 || e.transit.length > 0;
}

/** What points at damage or transit on this box, in a few words each (the dispatch reason). */
export function claimSignals(ctx: ReturnCtx): { damaged: string[]; transit: string[] } {
  const e = evidence(ctx);
  return { damaged: e.damaged.map((d) => `dented ${d.itemKey.replace("_", " ")}`), transit: e.transit.map((t) => t.split(":")[0]) };
}

/** The claim draft. Carrier, tracking, photo references and the amount always come from app data, never a model. */
function draft(ctx: ReturnCtx, itemKeys: string[], evidenceLines: string[]): CarrierClaimDraft {
  const ship = ctx.ret.order.returnShipment;
  const { exception } = evidence(ctx);
  const items = itemKeys.map((k) => ({ itemKey: k, valueCents: ctx.ret.order.slip.lines.find((l) => l.itemKey === k)?.unitPriceCents ?? 0 }));
  const t = (k: string) => ctx.up.damageReader?.items.find((i) => i.itemKey === k)?.t ?? 0;
  return {
    carrier: ship.carrier,
    tracking: ship.tracking,
    exceptionScan: exception?.event ?? null,
    evidence: evidenceLines,
    photoRefs: itemKeys.map((k) => `${ctx.ret.rma.clipId} @ ${t(k).toFixed(1)} s`),
    damagedItems: items,
    claimCents: items.reduce((s, i) => s + i.valueCents, 0),
    status: "draft · a person files it",
  };
}

function claimed(ctx: ReturnCtx, claim: CarrierClaimDraft, transitCount: number): AgentResult<CarrierClaimDraft | null> {
  const ship = ctx.ret.order.returnShipment;
  return {
    output: claim,
    trace: `claim draft for ${ship.carrier} ${ship.tracking}: ${claim.damagedItems.map((i) => i.itemKey).join(", ")}, ${transitCount} transit evidence item(s)`,
    holds: [],
    workItems: [{ by: carrierClaimSpec.name, text: `File the ${ship.carrier} claim on ${ship.tracking} with the attached photo references` }],
  };
}

export function runCarrierClaim(ctx: ReturnCtx): AgentResult<CarrierClaimDraft | null> {
  const { damaged, transit } = evidence(ctx);
  const ship = ctx.ret.order.returnShipment;
  if (!damaged.length) {
    return {
      output: null,
      trace: transit.length ? "transit evidence but no damaged item: noted, nothing to claim" : "no damage, no transit evidence",
      holds: [],
      workItems: transit.length ? [{ by: carrierClaimSpec.name, text: `Note the carton damage on ${ship.tracking}; contents undamaged, no claim` }] : [],
    };
  }
  if (!transit.length) return { output: null, trace: `damage on ${damaged.map((d) => d.itemKey).join(", ")} with no transit evidence: not a carrier claim`, holds: [], workItems: [] };
  return claimed(ctx, draft(ctx, damaged.map((d) => d.itemKey), [...transit, ...damaged.map((d) => `${d.itemKey.replace("_", " ")}: ${d.detail}`)]), transit.length);
}

/* ---------- Live: muse-wonder-1.0 decides and writes the evidence ---------- */

export const CarrierClaimLiveAnswer = z.object({
  fileClaim: z.boolean(),
  damagedItems: z.array(z.string()),
  evidence: z.array(z.string()),
  summary: z.string(),
});
export type CarrierClaimLiveAnswer = z.infer<typeof CarrierClaimLiveAnswer>;

export const carrierClaimLive: LiveRoleDef<CarrierClaimDraft | null, CarrierClaimLiveAnswer> = {
  role: "carrier-claim-agent",
  modelKind: "wonder",
  schemaName: "carrier_claim",
  schema: CarrierClaimLiveAnswer,
  system: `You prepare carrier damage claims for a merchant's returns desk. A claim is warranted only when a
returned item is damaged AND there is evidence the damage happened in transit (a carrier exception scan, a crushed
carton, or the returns lead saying the box arrived crushed). Damage with no transit evidence is not a carrier claim;
a crushed carton with undamaged contents is not a claim. List the damaged packing-slip items and the evidence lines
you rely on, verbatim from the input. Do not state amounts: the app prices the claim. A person files it.`,
  prompt: (ctx) => {
    const e = evidence(ctx);
    return {
      text: JSON.stringify({ ...slipAndCount(ctx), damage: ctx.up.damageReader ?? null, transitEvidence: e.transit, carrier: ctx.ret.order.returnShipment.carrier, scans: ctx.ret.order.returnShipment.scans }, null, 1),
      images: [],
    };
  },
  toResult: (live, ctx) => {
    const keys = new Set(ctx.ret.order.slip.lines.map((l) => l.itemKey));
    const items = live.damagedItems.filter((k) => keys.has(k));
    if (!live.fileClaim || !items.length) return { output: null, trace: `no claim: ${live.summary}`, holds: [], workItems: [] };
    return claimed(ctx, draft(ctx, items, live.evidence.length ? live.evidence : [live.summary]), evidence(ctx).transit.length);
  },
  // A claim is extra work, not a refund: if either side drafts one, keep it (the live draft when both do).
  combine: (det, live) => ({
    output: live.output ?? det.output,
    trace: live.trace,
    holds: [],
    workItems: [...det.workItems, ...live.workItems.filter((w) => !det.workItems.some((x) => x.text === w.text))],
  }),
};
