/**
 * Policy agent: which clause of the merchant's return policy governs this return?
 *   - 1.1 return window: a return received more than the window after delivery holds every line;
 *   - 2.1 condition: an item with wear beyond "opened" (scuffs) holds that line for a person,
 *     because "resalable condition" is a judgement, not a count;
 *   - and it names the clauses the customer message and the person will cite (4.2 / 4.3 / 4.4 / 5.1).
 * Deterministic: rules. Live (`policyLive`): muse-wonder-1.0 reads the policy text against the merged
 * findings; app code computes the days since delivery and drops any clause id the policy doesn't have.
 */
import { z } from "zod";
import { policyText } from "@/data/fixtures";
import { budgetBasis, slipAndCount, tokenBudgetUsd, type LiveRoleDef, type PolicyOutput, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, HoldEffect } from "../types";

const BUDGET = { inTok: 3000, outTok: 600 };

export const policySpec: AgentSpec = {
  name: "policy-agent",
  role: "policy-agent",
  kind: "model",
  model: "muse-wonder-1.0",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok, "policy text + merged findings"),
  scope: "return",
  does: "applies the return window and condition clauses and names the governing clauses",
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const daysSinceDelivery = (ctx: ReturnCtx) => Math.floor((Date.parse(ctx.ret.receivedAt) - Date.parse(ctx.ret.order.deliveredAt)) / DAY_MS);

function governing(ctx: ReturnCtx, late: boolean, holds: HoldEffect[]): string[] {
  const lines = ctx.lines ?? [];
  const codes = new Set(lines.flatMap((l) => l.reasons.map((r) => r.code)));
  const clauses = new Set<string>();
  if (late) clauses.add("1.1");
  if (holds.some((h) => h.code === "condition_review") || codes.has("visible_damage") || codes.has("spoken_claim") || codes.has("battery_hazard")) clauses.add("2.1");
  if (lines.some((l) => l.status === "MISSING")) clauses.add("4.3");
  if (codes.has("serial_mismatch") || codes.has("label_unreadable") || codes.has("duplicate_serial")) clauses.add("4.4");
  clauses.add(holds.length > 0 || lines.some((l) => l.status !== "OK") ? "5.1" : "4.2");
  return [...clauses].sort();
}

function result(ctx: ReturnCtx, out: PolicyOutput, holds: HoldEffect[], prefix = ""): AgentResult<PolicyOutput> {
  const w = ctx.settings.returnWindowDays;
  return {
    output: out,
    trace: `${prefix}${out.daysSinceDelivery} days since delivery (window ${w})${out.late ? " → outside the window" : ""}; governing ${out.clauses.join(", ")}${holds.some((h) => h.code === "condition_review") ? "; condition review" : ""}`,
    holds,
    workItems: out.late ? [{ by: policySpec.name, text: "Outside the return window: a person decides whether to make an exception" }] : [],
  };
}

export function runPolicy(ctx: ReturnCtx): AgentResult<PolicyOutput> {
  const quote = (id: string) => ctx.policy.clauses.find((c) => c.id === id)?.text ?? "";
  const days = daysSinceDelivery(ctx);
  const late = days > ctx.settings.returnWindowDays;
  const holds: HoldEffect[] = [];
  if (late) holds.push({ itemKey: "*", code: "outside_window", detail: `policy agent: received ${days} days after delivery; clause 1.1: "${quote("1.1")}"` });
  for (const c of ctx.up.damageReader?.items ?? []) {
    if (c.surface === "scuffed") holds.push({ itemKey: c.itemKey, code: "condition_review", detail: `policy agent: ${c.detail}; clause 2.1 asks for resalable condition, a person decides` });
  }
  return result(ctx, { clauses: governing(ctx, late, holds), daysSinceDelivery: days, late }, holds);
}

/* ---------- Live: muse-wonder-1.0 on the policy text ---------- */

export const PolicyLiveAnswer = z.object({
  clauses: z.array(z.string()),
  outsideWindow: z.boolean(),
  conditionHolds: z.array(z.object({ itemKey: z.string(), reason: z.string() })),
  rationale: z.string(),
});
export type PolicyLiveAnswer = z.infer<typeof PolicyLiveAnswer>;

export const policyLive: LiveRoleDef<PolicyOutput, PolicyLiveAnswer> = {
  role: "policy-agent",
  modelKind: "wonder",
  schemaName: "policy_reading",
  schema: PolicyLiveAnswer,
  system: `You apply a merchant's return policy to one inspected return. You get the policy text, the delivery and
receipt dates, the days between them (computed by app code), the merged inspection findings and the condition of each
item. Say whether the return is outside the return window, list any item whose condition needs a person's review under
the condition clause, and list the clause ids that govern this return. Use only clause ids that appear in the policy.
You can only add reasons to hold; you never approve or refund.`,
  prompt: (ctx) => ({
    text: JSON.stringify(
      { policy: policyText(ctx.policy), deliveredAt: ctx.ret.order.deliveredAt, receivedAt: ctx.ret.receivedAt, daysSinceDelivery: daysSinceDelivery(ctx), returnWindowDays: ctx.settings.returnWindowDays, condition: ctx.up.damageReader?.items.map((i) => ({ itemKey: i.itemKey, surface: i.surface, detail: i.detail })) ?? [], ...slipAndCount(ctx) },
      null,
      1,
    ),
    images: [],
  }),
  toResult: (live, ctx) => {
    const ids = new Set(ctx.policy.clauses.map((c) => c.id));
    const days = daysSinceDelivery(ctx);
    const holds: HoldEffect[] = [];
    if (live.outsideWindow) holds.push({ itemKey: "*", code: "outside_window", detail: `policy agent (live): outside the return window (${days} days); ${live.rationale}` });
    for (const c of live.conditionHolds) holds.push({ itemKey: c.itemKey, code: "condition_review", detail: `policy agent (live): ${c.reason} (clause 2.1)` });
    const unknown = live.clauses.filter((c) => !ids.has(c));
    const clauses = [...new Set([...live.clauses.filter((c) => ids.has(c)), ...governing(ctx, live.outsideWindow, holds)])].sort();
    return result(ctx, { clauses, daysSinceDelivery: days, late: live.outsideWindow }, holds, unknown.length ? `dropped unknown clause id(s) ${unknown.join(", ")}; ` : "");
  },
  combine: (det, live) => ({
    output: { clauses: [...new Set([...det.output.clauses, ...live.output.clauses])].sort(), daysSinceDelivery: det.output.daysSinceDelivery, late: det.output.late || live.output.late },
    trace: live.trace,
    holds: [...det.holds, ...live.holds.filter((h) => !det.holds.some((x) => x.itemKey === h.itemKey && x.code === h.code))],
    workItems: [...det.workItems, ...live.workItems.filter((w) => !det.workItems.some((x) => x.text === w.text))],
  }),
};
