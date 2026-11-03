/**
 * Restock grader: what happens to each returned item after the bench. A = sealed, restock as new;
 * B = opened with no marks, open-box listing; C = scuffed or dented, refurbish or sell for parts;
 * recycle = a battery the lead flagged as a hazard. A unit whose serial doesn't match the order (or
 * appears in two boxes) is quarantined: it may not be the merchant's unit. Recovery is the
 * merchant's seeded recovery rate × list price (app code, never a model's number).
 * Deterministic: rules over the damage and voice readers' output. Live (`restockGraderLive`):
 * muse-spark-1.3 on the crops plus the merged findings; the more conservative grade wins.
 */
import { z } from "zod";
import { budgetBasis, cropsOf, slipAndCount, tokenBudgetUsd, type LiveRoleDef, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, RestockGrade, RestockLine } from "../types";

const BUDGET = { inTok: 4500, outTok: 400 };

export const restockGraderSpec: AgentSpec = {
  name: "restock-grader",
  role: "restock-grader",
  kind: "model",
  model: "muse-spark-1.3",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok, "item crops + findings"),
  scope: "return",
  does: "grades each returned item A / B / C and picks its resale channel",
};

const CHANNEL: Record<RestockGrade, string> = { A: "Restock as new", B: "Open-box listing", C: "Refurbish or parts", recycle: "Lithium battery recycling" };
const QUARANTINE = "Quarantine until the serial is resolved";
const GRADE_RANK: Record<RestockGrade, number> = { A: 0, B: 1, C: 2, recycle: 3 };

function line(ctx: ReturnCtx, itemKey: string, grade: RestockGrade, channel: string, why: string, qty: number, price: number): RestockLine {
  const rate = channel === QUARANTINE || channel.startsWith("Manual") ? 0 : ctx.settings.recovery[grade];
  return { itemKey, grade, channel, recoveryCents: Math.round(price * rate * qty), why };
}

function finish(out: RestockLine[], prefix = ""): AgentResult<RestockLine[]> {
  const total = out.reduce((s, r) => s + r.recoveryCents, 0);
  return {
    output: out,
    trace: `${prefix}${out.length ? `${out.map((r) => `${r.itemKey} ${r.grade}`).join(", ")} → recovery ${(total / 100).toFixed(2)} USD est.` : "nothing returned to grade"}`,
    holds: [],
    workItems: out.filter((r) => r.channel === QUARANTINE || r.grade === "recycle").map((r) => ({ by: restockGraderSpec.name, text: `${r.itemKey.replace("_", " ")}: ${r.channel.toLowerCase()}` })),
  };
}

/** Rules that override any grade: a hazard battery is recycled, a unit whose serial doesn't tie to the order is quarantined. */
function override(ctx: ReturnCtx, itemKey: string): { grade: RestockGrade; channel: string; why: string } | null {
  const l = (ctx.lines ?? []).find((x) => x.itemKey === itemKey);
  const reasons = new Set(l?.reasons.map((r) => r.code) ?? []);
  if ((ctx.up.voiceReader?.claims ?? []).some((c) => c.kind === "battery_hazard" && c.itemKey === itemKey)) return { grade: "recycle", channel: CHANNEL.recycle, why: "the lead flagged it as a battery hazard" };
  if (reasons.has("serial_mismatch") || reasons.has("duplicate_serial")) return { grade: "C", channel: QUARANTINE, why: "the serial doesn't tie this unit to the order" };
  return null;
}

/** Returned items a rule must divert now, whatever a person later decides on the box: a hazard battery, a unit whose serial doesn't tie to the order. */
export function divertNow(ctx: ReturnCtx): Array<{ itemKey: string; why: string }> {
  return (ctx.lines ?? []).filter((l) => l.observedQty > 0).flatMap((l) => {
    const o = override(ctx, l.itemKey);
    return o ? [{ itemKey: l.itemKey, why: o.why }] : [];
  });
}

export function runRestockGrader(ctx: ReturnCtx): AgentResult<RestockLine[]> {
  const out: RestockLine[] = [];
  for (const l of ctx.lines ?? []) {
    if (l.observedQty === 0) continue;
    const o = override(ctx, l.itemKey);
    const crop = ctx.up.damageReader?.items.find((i) => i.itemKey === l.itemKey);
    if (o) out.push(line(ctx, l.itemKey, o.grade, o.channel, o.why, l.observedQty, l.unitPriceCents));
    else if (!crop) out.push(line(ctx, l.itemKey, "C", "Manual grading (no condition read)", "no condition read for this item", l.observedQty, l.unitPriceCents));
    else {
      const grade: RestockGrade = crop.surface === "sealed" ? "A" : crop.surface === "opened" ? "B" : "C";
      out.push(line(ctx, l.itemKey, grade, CHANNEL[grade], crop.detail, l.observedQty, l.unitPriceCents));
    }
  }
  return finish(out);
}

/* ---------- Live: muse-spark-1.3 grades from the crops ---------- */

export const RestockLiveAnswer = z.object({
  items: z.array(z.object({ itemKey: z.string(), grade: z.enum(["A", "B", "C", "recycle"]), why: z.string() })),
});
export type RestockLiveAnswer = z.infer<typeof RestockLiveAnswer>;

export const restockGraderLive: LiveRoleDef<RestockLine[], RestockLiveAnswer> = {
  role: "restock-grader",
  modelKind: "spark",
  schemaName: "restock_grades",
  schema: RestockLiveAnswer,
  system: `You grade returned items for resale. A: sealed, as new. B: opened, no marks (open-box). C: scuffed, dented
or otherwise not fit for open-box (refurbish or parts). recycle: a battery with any sign of swelling, leaking or burning.
Grade every item that came back, from its crop and the findings. When unsure between two grades, pick the lower one.`,
  prompt: (ctx) => ({ text: JSON.stringify({ ...slipAndCount(ctx), condition: ctx.up.damageReader?.items ?? [], spokenClaims: ctx.up.voiceReader?.claims ?? [] }, null, 1), images: cropsOf(ctx) }),
  toResult: (live, ctx) => {
    const out: RestockLine[] = [];
    for (const l of ctx.lines ?? []) {
      if (l.observedQty === 0) continue;
      const o = override(ctx, l.itemKey);
      const g = live.items.find((x) => x.itemKey === l.itemKey);
      if (o) out.push(line(ctx, l.itemKey, o.grade, o.channel, o.why, l.observedQty, l.unitPriceCents));
      else if (!g) out.push(line(ctx, l.itemKey, "C", "Manual grading (no live grade)", "the live grade left this item out", l.observedQty, l.unitPriceCents));
      else out.push(line(ctx, l.itemKey, g.grade, CHANNEL[g.grade], g.why, l.observedQty, l.unitPriceCents));
    }
    return finish(out);
  },
  // Per item the more conservative grade wins (lower recovery), so a live grade can't inflate resale value.
  combine: (det, live) => {
    const out = det.output.map((d) => {
      const l = live.output.find((x) => x.itemKey === d.itemKey);
      return !l ? d : GRADE_RANK[l.grade] > GRADE_RANK[d.grade] || (l.grade === d.grade && l.recoveryCents < d.recoveryCents) ? l : d;
    });
    return { ...finish(out), trace: live.trace };
  },
};
