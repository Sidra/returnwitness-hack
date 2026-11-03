/**
 * Selective dispatch: an optional specialist runs on a box only when that box's evidence calls for it. Each trigger is
 * derived from what the role actually reads, so a skip is never a guess about the answer:
 *   - label reader: reads the counter's label reads of serialised items in the tray. Runs when a read is missing, close
 *     to the 0.80 legibility bar (under 0.90), or outside the kit's serial format. A confident, well-formed read is
 *     matched by the serial matcher (app code) without it.
 *   - voice-note reader: reads the lead's transcript. Runs when there is one.
 *   - carrier-claim agent: reads damage and transit evidence. Runs when a damaged item or transit evidence exists.
 *   - policy agent: reads the dates, each item's condition and the merged lines. Runs when the return is within 5 days of
 *     the window or past it, an item shows wear, or a line is held (the hold needs its clauses named). The window
 *     arithmetic itself is app code and runs on every box, in the trigger.
 *   - restock grader: reads the returned items' condition and the merged findings. Runs on a complete box (its items go
 *     back to stock now) or when a rule must divert an item now (a hazard battery, a unit whose serial doesn't tie to the
 *     order). On a held box without either, grading waits for the person's decision.
 *   - customer-message drafter: reads the findings to explain them. Runs on a held box or one with a claim; a complete
 *     box gets the fixed app-code note (lib/fleet/agents/message-drafter.ts `completeBoxNote`).
 * Core roles (inspector, damage reader, serial matcher, cost agent, coordinator, and the fraud-pattern agent when it is in
 * the roster) run on every box in both modes: counting, serial matching, arithmetic and the restrictive merge stay code.
 * Pure: no clock, no network, no keys.
 */
import type { ReturnCtx } from "./context";
import { serialFits, serialisedInTray, LEGIBLE_MIN_CONFIDENCE } from "./agents/label-reader";
import { claimSignals } from "./agents/carrier-claim";
import { daysSinceDelivery } from "./agents/policy";
import { divertNow } from "./agents/restock-grader";
import type { DispatchMode, RoleId } from "./types";

/** A read under this confidence is close enough to the legibility bar that the label reader looks at it. */
export const LABEL_REVIEW_BELOW = 0.9;
/** A return this many days before the window closes (or later) gets the policy agent. */
export const POLICY_NEAR_WINDOW_DAYS = 5;

export const OPTIONAL_ROLES = ["label-reader", "voice-note-reader", "carrier-claim-agent", "policy-agent", "restock-grader", "customer-message-drafter"] as const satisfies readonly RoleId[];
export type OptionalRole = (typeof OPTIONAL_ROLES)[number];
export const isOptional = (role: RoleId): role is OptionalRole => (OPTIONAL_ROLES as readonly RoleId[]).includes(role);

export interface Trigger {
  run: boolean;
  /** The signal that fired, or why the role has nothing to do on this box. */
  reason: string;
  /**
   * True when the box has nothing for the role to read (no transcript, no count, nothing in the tray, no damage or
   * transit evidence). A live answer recorded for such a box is rejected as missing evidence.
   */
  inputMissing: boolean;
}

const fire = (reason: string): Trigger => ({ run: true, reason, inputMissing: false });
const skip = (reason: string, inputMissing = false): Trigger => ({ run: false, reason, inputMissing });
const item = (k: string) => k.replace("_", " ");

function labelTrigger(ctx: ReturnCtx): Trigger {
  if (!ctx.up.inspector) return skip("no count from the inspector: no label read to judge", true);
  const lines = serialisedInTray(ctx);
  if (!lines.length) return skip("no serialised item reached the tray", true);
  const doubts: string[] = [];
  for (const l of lines) {
    const read = ctx.up.inspector.count.arrivals.find((a) => a.itemKey === l.itemKey && a.label)?.label;
    if (!read) doubts.push(`no label read on the ${item(l.itemKey)}`);
    else if (!serialFits(l.itemKey, read.text)) doubts.push(`${item(l.itemKey)} read "${read.text}" is outside the serial format`);
    else if (read.confidence < LABEL_REVIEW_BELOW) doubts.push(`${item(l.itemKey)} read at ${read.confidence.toFixed(2)}, under ${LABEL_REVIEW_BELOW.toFixed(2)}`);
  }
  return doubts.length
    ? fire(doubts.join("; "))
    : skip(`every serial read is at ${LABEL_REVIEW_BELOW.toFixed(2)} or above and in the kit's format (bar ${LEGIBLE_MIN_CONFIDENCE.toFixed(2)}): the serial matcher checks it as code`);
}

function voiceTrigger(ctx: ReturnCtx): Trigger {
  const t = ctx.ret.voiceNote?.transcript?.trim();
  return t ? fire(`the lead left a note (${t.split(/\s+/).length} words)`) : skip("no voice note on this box", true);
}

function claimTrigger(ctx: ReturnCtx): Trigger {
  const s = claimSignals(ctx);
  if (!s.damaged.length && !s.transit.length) return skip("no damaged item and no transit evidence (no exception scan, carton not crushed, nothing said)", true);
  return fire([...s.damaged, ...s.transit].join(" + "));
}

function policyTrigger(ctx: ReturnCtx): Trigger {
  const days = daysSinceDelivery(ctx);
  const w = ctx.settings.returnWindowDays;
  const why: string[] = [];
  if (days > w) why.push(`${days} days since delivery, past the ${w}-day window`);
  else if (days >= w - POLICY_NEAR_WINDOW_DAYS) why.push(`${days} days since delivery, within ${POLICY_NEAR_WINDOW_DAYS} of the ${w}-day window`);
  const worn = (ctx.up.damageReader?.items ?? []).filter((i) => i.surface === "scuffed" || i.surface === "dented");
  if (worn.length) why.push(`wear on ${worn.map((i) => item(i.itemKey)).join(", ")}`);
  const held = (ctx.lines ?? []).filter((l) => l.status !== "OK");
  if (held.length) why.push(`${held.length} line(s) held: the hold needs its clauses`);
  return why.length ? fire(why.join("; ")) : skip(`${days} of ${w} days, no wear, every line OK: clause 4.2 governs (the window arithmetic ran as code)`);
}

function restockTrigger(ctx: ReturnCtx): Trigger {
  const back = (ctx.lines ?? []).filter((l) => l.observedQty > 0);
  if (!back.length) return skip("nothing came back to grade", true);
  const divert = divertNow(ctx);
  const clear = (ctx.lines ?? []).every((l) => l.status === "OK") && !ctx.up.policy?.late;
  if (clear) return fire(`complete box: ${back.length} item(s) go back to stock now`);
  if (divert.length) return fire(`divert now: ${divert.map((d) => `${item(d.itemKey)} (${d.why})`).join("; ")}`);
  return skip("held for a person: grading waits for the decision (no item needs diverting now)");
}

function drafterTrigger(ctx: ReturnCtx): Trigger {
  const held = (ctx.lines ?? []).some((l) => l.status !== "OK") || Boolean(ctx.up.policy?.late);
  if (held) return fire("held: the note has a hold to explain");
  if (ctx.up.carrierClaim) return fire("a carrier claim to mention");
  return skip("complete box: the fixed app-code note says everything came back (no model call)");
}

const TRIGGERS: Record<OptionalRole, (ctx: ReturnCtx) => Trigger> = {
  "label-reader": labelTrigger,
  "voice-note-reader": voiceTrigger,
  "carrier-claim-agent": claimTrigger,
  "policy-agent": policyTrigger,
  "restock-grader": restockTrigger,
  "customer-message-drafter": drafterTrigger,
};

/** The trigger for an optional role on this box (needs the upstream outputs and, for stage 3–4 roles, the merged lines). */
export const triggerFor = (role: OptionalRole, ctx: ReturnCtx): Trigger => TRIGGERS[role](ctx);

export interface Decision extends Trigger {
  /** When the box has nothing for the role to read: why (a live answer recorded for it is then rejected). */
  missingEvidence: string | null;
}

/** What dispatch decides for a role on a box under a mode. Core roles always run; "always" runs every optional role too. */
export function decide(role: RoleId, ctx: ReturnCtx, mode: DispatchMode): Decision {
  if (!isOptional(role)) return { ...fire("core: runs on every box"), missingEvidence: null };
  const t = triggerFor(role, ctx);
  const missingEvidence = t.inputMissing ? t.reason : null;
  if (mode === "always" && !t.run) return { run: true, reason: `always-run mode (selective skips it: ${t.reason})`, inputMissing: t.inputMissing, missingEvidence };
  return { ...t, missingEvidence };
}
