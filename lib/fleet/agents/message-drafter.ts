/**
 * Customer-message drafter: the note the customer gets, in plain words: what was seen, what
 * wasn't, which clause applies, and that a hold is not a denial. It never accuses (a pattern hold
 * reads "needs a second review") and never promises money: an amount is described as waiting for
 * a person's approval. A person sends it. Deterministic: a template over the findings. Live
 * (`messageDrafterLive`): muse-wonder-1.0 writes the note; app code rejects a note that says money moved,
 * accuses the customer, or leaves out clause 5.1 on a held return (the template stands in, with the reason).
 */
import { KIT } from "@/data/kit.config";
import { formatCents } from "@/lib/format";
import { z } from "zod";
import { budgetBasis, slipAndCount, tokenBudgetUsd, type LiveRoleDef, type ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, FleetReasonCode } from "../types";

const BUDGET = { inTok: 2500, outTok: 600 };

export const messageDrafterSpec: AgentSpec = {
  name: "customer-message-drafter",
  role: "customer-message-drafter",
  kind: "model",
  model: "muse-wonder-1.0",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-wonder-1.0", BUDGET.inTok, BUDGET.outTok, "findings + clauses → a short note"),
  scope: "return",
  does: "drafts the customer's note: what was seen, what wasn't, the clause, and that a hold isn't a denial",
};

/** What the coordinator sends when no drafter ran. */
export const fallbackMessage = (rmaId: string) => `Your return ${rmaId} has been received and is being reviewed.`;

const PHRASE: Partial<Record<FleetReasonCode, (item: string) => string>> = {
  not_observed: (i) => `the ${i} was not seen in the box`,
  short_count: (i) => `fewer ${i} items were seen than were shipped`,
  serial_mismatch: (i) => `the serial on the ${i} doesn't match the one shipped on this order`,
  label_unreadable: (i) => `the serial label on the ${i} couldn't be read clearly and is being re-checked`,
  visible_damage: (i) => `the ${i} shows damage`,
  condition_review: (i) => `the ${i} shows wear, and a person is checking its condition`,
  spoken_claim: (i) => `an accessory for the ${i} (the lens cap) was not in the box`,
  battery_hazard: () => "the battery was set aside for a safety check",
  merged_mask: (i) => `the ${i} needs a second look on the recording`,
  seen_not_placed: (i) => `the ${i} needs a second look on the recording`,
  left_tray: (i) => `the ${i} needs a second look on the recording`,
  duplicate_serial: () => "the return needs a second review",
  repeat_address: () => "the return needs a second review",
  no_count: () => "the inspection recording needs a second look",
};

const openedLine = (ctx: ReturnCtx) => `Your return ${ctx.ret.rma.id} was opened on camera at the returns bench.`;
const completeLine = (ctx: ReturnCtx) => `Every item on the packing slip came back. A refund of ${formatCents(ctx.ret.rma.requestedRefundCents)} to the original payment method is waiting for a reviewer's approval (clause 6.1).`;

/**
 * The note for a complete box (every line OK, inside the window, no claim): fixed wording, app code, word for word what
 * the drafter's template writes for such a box. The coordinator sends it when the drafter doesn't run on a complete box
 * (selective dispatch skips the drafter there: there is no hold to explain).
 */
export const completeBoxNote = (ctx: ReturnCtx) => `Hi ${ctx.ret.rma.customer.name.split(" ")[0]},\n${openedLine(ctx)} ${completeLine(ctx)}\n${KIT.merchantName} returns desk`;

export function runMessageDrafter(ctx: ReturnCtx): AgentResult<{ text: string }> {
  const lines = ctx.lines ?? [];
  const first = ctx.ret.rma.customer.name.split(" ")[0];
  const policy = ctx.up.policy;
  const st = ctx.settlement;
  const parts: string[] = [`Hi ${first},`, openedLine(ctx)];
  const allClear = lines.length > 0 && lines.every((l) => l.status === "OK") && !policy?.late;
  if (allClear) {
    parts.push(completeLine(ctx));
  } else {
    const found = new Set<string>();
    for (const l of lines) {
      const name = l.description.toLowerCase();
      for (const r of l.reasons) {
        const p = PHRASE[r.code];
        if (p) found.add(p(name));
      }
    }
    if (policy?.late) found.add(`the return arrived ${policy.daysSinceDelivery} days after delivery, and the policy allows ${ctx.settings.returnWindowDays} (clause 1.1)`);
    const list = [...found];
    parts.push(list.length ? `The refund is on hold because ${list.join("; ")}.` : "The refund is on hold for a reviewer.");
    const partial = st?.options.find((o) => o.key === "partial");
    if (partial?.available && lines.some((l) => l.status === "MISSING") && !lines.some((l) => l.status === "HELD")) {
      parts.push(`A reviewer may approve a partial refund of ${formatCents(partial.refundCents)} for the items that were returned (clause 4.3).`);
    }
    parts.push("A hold is not a denial: reply within 14 days with anything that helps (clause 5.1).");
  }
  if (ctx.up.carrierClaim) parts.push("The transit damage is being claimed with the carrier; that doesn't change your refund review.");
  parts.push(`${KIT.merchantName} returns desk`);
  const [greeting, ...body] = parts;
  const signOff = body.pop()!;
  const text = `${greeting}\n${body.join(" ")}\n${signOff}`;
  return {
    output: { text },
    trace: allClear ? "drafted: complete, refund waiting for approval" : `drafted: hold explained${policy ? ` (clauses ${policy.clauses.join(", ")})` : ""}`,
    holds: [],
    workItems: [],
  };
}

/* ---------- Live: muse-wonder-1.0 writes the note ---------- */

export const MessageLiveAnswer = z.object({ text: z.string().min(1) });
export type MessageLiveAnswer = z.infer<typeof MessageLiveAnswer>;

/** A customer note may never say money moved or accuse the customer; a held return's note must cite clause 5.1. */
export function checkCustomerNote(text: string, held: boolean): string[] {
  const errors: string[] = [];
  if (/\b(refund(ed)?|money)\b[^.]*\b(has been|was|is being|have been)\s+(issued|sent|processed|approved|completed|refunded)\b|\bwe('ve| have) refunded\b|\byou('ve| have) been refunded\b/i.test(text)) errors.push("says money moved; only a person's approval can do that");
  if (/\b(fraud|fraudulent|stolen|scam|lying|lied)\b/i.test(text)) errors.push("accuses the customer");
  if (held && !/5\.1/.test(text)) errors.push("a held return's note must cite clause 5.1 (a hold is not a denial)");
  return errors;
}

export const messageDrafterLive: LiveRoleDef<{ text: string }, MessageLiveAnswer> = {
  role: "customer-message-drafter",
  modelKind: "wonder",
  schemaName: "customer_note",
  schema: MessageLiveAnswer,
  system: `You draft the note a merchant's returns desk sends a customer after their return was opened on camera.
Plain words, under 90 words: what was seen, what wasn't, which policy clause applies. If the refund is on hold, say a hold
is not a denial and the customer may reply within 14 days (clause 5.1). Never say a refund was issued, approved or
processed: an amount can only be described as waiting for a reviewer's approval. Never accuse the customer. Sign as the
merchant's returns desk.`,
  prompt: (ctx) => {
    const st = ctx.settlement;
    return {
      text: JSON.stringify({ customerFirstName: ctx.ret.rma.customer.name.split(" ")[0], merchant: KIT.merchantName, ...slipAndCount(ctx), clauses: ctx.up.policy?.clauses ?? [], late: ctx.up.policy?.late ?? false, settlement: st ? { recommended: st.recommended, options: st.options.filter((o) => o.available).map((o) => ({ key: o.key, refundCents: o.refundCents, clause: o.clause })) } : null }, null, 1),
      images: [],
    };
  },
  toResult: (live, ctx) => {
    const held = (ctx.lines ?? []).some((l) => l.status !== "OK") || Boolean(ctx.up.policy?.late);
    const errors = checkCustomerNote(live.text, held);
    if (errors.length) throw new Error(`customer note rejected: ${errors.join("; ")}`);
    return { output: { text: live.text.trim() }, trace: `drafted live: ${held ? "hold explained" : "complete, refund waiting for approval"}`, holds: [], workItems: [] };
  },
};
