/**
 * Damage reader: what does each item's crop show? A dent or crack holds that line
 * (`visible_damage`); scuffs and an opened sleeve are reported for the policy agent and the
 * restock grader but hold nothing on their own. It also reports the outer carton.
 * Deterministic: the seeded crop annotations in data/shift.ts (what a model would see), read by rules.
 * Live (`damageReaderLive`): muse-spark-1.3 on the item crops and the last key frame.
 */
import { z } from "zod";
import type { ItemKey, SurfaceCondition } from "@/data/shift";
import { budgetBasis, cropsOf, keyFramesOf, slipAndCount, tokenBudgetUsd, type DamageReaderOutput, type LiveRoleDef, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, HoldEffect } from "../types";

const BUDGET = { inTok: 6000, outTok: 500 };

export const damageReaderSpec: AgentSpec = {
  name: "damage-reader",
  role: "damage-reader",
  kind: "model",
  model: "muse-spark-1.3",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok, "three item crops + the carton frame"),
  scope: "return",
  does: "reads each item crop for dents, scuffs or an opened sleeve, and the outer carton",
};

function fromItems(items: DamageReaderOutput["items"], outerBox: DamageReaderOutput["outerBox"], who = "damage reader"): AgentResult<DamageReaderOutput> {
  const holds: HoldEffect[] = items.filter((i) => i.holds).map((i) => ({ itemKey: i.itemKey, code: "visible_damage" as const, detail: `${who}: ${i.detail} (crop at ${i.t.toFixed(1)} s)` }));
  const marks = items.filter((i) => i.surface === "dented" || i.surface === "scuffed");
  const box = outerBox === "crushed" ? "; outer carton crushed" : outerBox === "not_in_frame" ? "; outer carton not in frame" : "";
  return {
    output: { items, outerBox },
    trace: marks.length ? `${marks.map((m) => `${m.itemKey} ${m.surface}`).join(", ")}${box}` : `${items.length} crop(s): ${[...new Set(items.map((i) => i.surface))].join(" / ") || "none"}, no marks${box}`,
    holds,
    workItems: [],
  };
}

export function runDamageReader(ctx: ReturnCtx): AgentResult<DamageReaderOutput> {
  return fromItems(ctx.ret.crops.map((c) => ({ ...c, holds: c.surface === "dented" })), ctx.ret.outerBox);
}

/* ---------- Live: muse-spark-1.3 on the crops ---------- */

const SURFACES = ["sealed", "opened", "scuffed", "dented"] as const;
const RANK: Record<SurfaceCondition, number> = { sealed: 0, opened: 1, scuffed: 2, dented: 3 };
const BOX_RANK: Record<DamageReaderOutput["outerBox"], number> = { intact: 0, not_in_frame: 1, crushed: 2 };

export const DamageReaderLiveAnswer = z.object({
  items: z.array(z.object({ itemKey: z.string(), surface: z.enum(SURFACES), detail: z.string() })),
  outerBox: z.enum(["intact", "crushed", "not_in_frame"]),
});
export type DamageReaderLiveAnswer = z.infer<typeof DamageReaderLiveAnswer>;

export const damageReaderLive: LiveRoleDef<DamageReaderOutput, DamageReaderLiveAnswer> = {
  role: "damage-reader",
  modelKind: "spark",
  schemaName: "damage_read",
  schema: DamageReaderLiveAnswer,
  system: `You inspect returned items for damage at a returns bench. For each item crop give its surface:
"sealed" (factory sleeve or blister intact), "opened" (out of its packaging, no marks), "scuffed" (cosmetic marks),
or "dented" (a dent, crack or broken part). Describe what you see in a few words. From the key frame, say whether
the outer carton is "intact", "crushed", or "not_in_frame". Report only what is visible. You do not decide refunds.`,
  prompt: (ctx) => {
    const frames = keyFramesOf(ctx);
    return { text: JSON.stringify(slipAndCount(ctx), null, 1), images: [...cropsOf(ctx), ...frames.slice(-1)] };
  },
  toResult: (live, ctx) => {
    const t = (k: string) => ctx.up.inspector?.count.arrivals.find((a) => a.itemKey === k)?.t ?? ctx.ret.crops.find((c) => c.itemKey === k)?.t ?? 0;
    const items = live.items.map((i) => ({ itemKey: i.itemKey as ItemKey, surface: i.surface, detail: i.detail, t: t(i.itemKey), holds: i.surface === "dented" }));
    return fromItems(items, live.outerBox, "damage reader (live)");
  },
  combine: (det, live) => {
    // Per item the worse surface wins; the worse carton wins. Holds are a union.
    const keys = [...new Set([...det.output.items, ...live.output.items].map((i) => i.itemKey))];
    const items = keys.map((k) => {
      const d = det.output.items.find((i) => i.itemKey === k);
      const l = live.output.items.find((i) => i.itemKey === k);
      return !d ? l! : !l ? d : RANK[l.surface] >= RANK[d.surface] ? l : d;
    });
    const outerBox = BOX_RANK[live.output.outerBox] >= BOX_RANK[det.output.outerBox] ? live.output.outerBox : det.output.outerBox;
    const merged = fromItems(items, outerBox, "damage reader");
    return { ...merged, trace: live.trace, holds: [...det.holds, ...live.holds.filter((h) => !det.holds.some((x) => x.itemKey === h.itemKey))] };
  },
};
