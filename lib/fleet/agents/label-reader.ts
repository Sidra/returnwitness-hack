/**
 * Label reader: is each serial label legible enough to match? The tray counter accepts a read at
 * confidence ≥ 0.60 (enough to say "a label was seen"); a serial that releases money under policy
 * 4.4 needs more. This agent holds a serialised line whose read is under 0.80 or doesn't fit the
 * kit's serial format, so a smudged label is re-scanned instead of matched on a guess.
 * Deterministic: rules on the counter's reads. Live (`labelReaderLive`): muse-spark-1.3 on the label crops.
 */
import { z } from "zod";
import { KIT } from "@/data/kit.config";
import type { ItemKey } from "@/data/shift";
import { budgetBasis, cropsOf, slipAndCount, tokenBudgetUsd, type LabelRead, type LabelReaderOutput, type LiveRoleDef, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, HoldEffect } from "../types";

export const LEGIBLE_MIN_CONFIDENCE = 0.8;
const BUDGET = { inTok: 3000, outTok: 300 };

/** Serial format per item, derived from the kit file (digits become \d). */
const FORMAT: Record<string, RegExp> = Object.fromEntries(
  KIT.items.filter((i) => i.requiresSerial).map((i) => [i.key, new RegExp(`^${i.serials.complete.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d/g, "\\d")}$`)]),
);

export const labelReaderSpec: AgentSpec = {
  name: "label-reader",
  role: "label-reader",
  kind: "model",
  model: "muse-spark-1.3",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok, "the serialised items' label crops"),
  scope: "return",
  does: "decides whether each serial label is legible enough to match (≥ 0.80 and in the kit's serial format)",
};

/** Serialised slip lines whose item reached the tray. */
export const serialisedInTray = (ctx: ReturnCtx) => ctx.ret.order.slip.lines.filter((l) => l.requiresSerial && ctx.up.inspector?.count.arrivals.some((a) => a.itemKey === l.itemKey));

/** Whether a read fits the kit's serial format for this item (items without a format pass). */
export const serialFits = (itemKey: string, text: string) => FORMAT[itemKey]?.test(text.trim().toUpperCase()) ?? true;

function summarize(reads: LabelRead[], holds: HoldEffect[], prefix = ""): AgentResult<LabelReaderOutput> {
  const bad = reads.filter((r) => !r.legible && r.text !== null);
  return {
    output: { reads },
    trace: `${prefix}${reads.length === 0 ? "no serialised item reached the tray" : bad.length ? `holding ${bad.map((b) => b.itemKey).join(", ")}: ${bad[0].why}` : holds.length ? `holding ${holds.map((h) => h.itemKey).join(", ")}` : `${reads.filter((r) => r.legible).length} serial label(s) legible`}`,
    holds,
    workItems: holds.map((h) => ({ by: labelReaderSpec.name, text: `Re-scan the ${h.itemKey.replace("_", " ")} label under the bench light` })),
  };
}

export function runLabelReader(ctx: ReturnCtx): AgentResult<LabelReaderOutput> {
  const insp = ctx.up.inspector;
  if (!insp) return { output: { reads: [] }, trace: "no count from the inspector: no label reads to judge", holds: [], workItems: [] };
  const reads: LabelRead[] = [];
  const holds: HoldEffect[] = [];
  for (const line of serialisedInTray(ctx)) {
    const key = line.itemKey as ItemKey;
    const arrival = insp.count.arrivals.find((a) => a.itemKey === key && a.label);
    if (!arrival?.label) {
      reads.push({ itemKey: key, text: null, confidence: null, legible: false, why: "no label read (the counter already holds this line)" });
      continue;
    }
    const text = arrival.label.text.trim().toUpperCase();
    const conf = arrival.label.confidence;
    const fits = FORMAT[key]?.test(text) ?? true;
    if (conf < LEGIBLE_MIN_CONFIDENCE || !fits) {
      const why = !fits ? `"${text}" doesn't fit the serial format` : `read "${text}" at ${conf.toFixed(2)}, under ${LEGIBLE_MIN_CONFIDENCE.toFixed(2)}`;
      reads.push({ itemKey: key, text, confidence: conf, legible: false, why });
      holds.push({ itemKey: key, code: "label_unreadable", detail: `label reader: ${why}; too uncertain to verify the serial (clause 4.4), re-scan the label` });
    } else {
      reads.push({ itemKey: key, text, confidence: conf, legible: true, why: `read at ${conf.toFixed(2)}` });
    }
  }
  return summarize(reads, holds);
}

/* ---------- Live: muse-spark-1.3 reads the label crops ---------- */

export const LabelReaderLiveAnswer = z.object({
  reads: z.array(z.object({ itemKey: z.string(), serialText: z.string().nullable(), legible: z.boolean(), why: z.string() })),
});
export type LabelReaderLiveAnswer = z.infer<typeof LabelReaderLiveAnswer>;

export const labelReaderLive: LiveRoleDef<LabelReaderOutput, LabelReaderLiveAnswer> = {
  role: "label-reader",
  modelKind: "spark",
  schemaName: "label_reads",
  schema: LabelReaderLiveAnswer,
  system: `You read serial-number labels on returned items at an inspection bench. For every serialised item listed,
look at its crop and copy the serial exactly as printed into serialText, or null if you can't see it.
Set legible=true only if every character is clearly readable; a smudge, glare, a cut-off edge or any guess means legible=false.
Say why in a few words. Never guess a character. You do not decide refunds.`,
  prompt: (ctx) => {
    const items = serialisedInTray(ctx).map((l) => l.itemKey);
    return { text: JSON.stringify({ serialisedItems: items, ...slipAndCount(ctx) }, null, 1), images: cropsOf(ctx, items) };
  },
  toResult: (live, ctx) => {
    const reads: LabelRead[] = [];
    const holds: HoldEffect[] = [];
    for (const line of serialisedInTray(ctx)) {
      const key = line.itemKey as ItemKey;
      const r = live.reads.find((x) => x.itemKey === key);
      if (!r) {
        // The model left a serialised item out: that is not a pass.
        reads.push({ itemKey: key, text: null, confidence: null, legible: false, why: "the live read left this item out" });
        holds.push({ itemKey: key, code: "label_unreadable", detail: "label reader (live): no read returned for this item; re-scan the label" });
        continue;
      }
      const text = r.serialText?.trim().toUpperCase() ?? null;
      const fits = text ? (FORMAT[key]?.test(text) ?? true) : false;
      const legible = r.legible && fits;
      reads.push({ itemKey: key, text, confidence: null, legible, why: legible ? r.why : fits ? r.why : `${r.why}; "${text ?? ""}" doesn't fit the serial format` });
      if (!legible) holds.push({ itemKey: key, code: "label_unreadable", detail: `label reader (live): ${r.why}; re-scan the label (clause 4.4)` });
    }
    return summarize(reads, holds);
  },
  combine: (det, live) => {
    // An item is legible only if both readers say so; the serial matcher then uses the live text.
    const reads = live.output.reads.map((r) => {
      const d = det.output.reads.find((x) => x.itemKey === r.itemKey);
      return d && !d.legible ? { ...r, legible: false, why: `${r.why}; the counter's read: ${d.why}` } : r;
    });
    return {
      output: { reads },
      trace: live.trace,
      holds: [...det.holds, ...live.holds.filter((h) => !det.holds.some((x) => x.itemKey === h.itemKey && x.code === h.code))],
      workItems: [...det.workItems, ...live.workItems.filter((w) => !det.workItems.some((x) => x.text === w.text))],
    };
  },
};
