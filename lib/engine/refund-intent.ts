/**
 * Refund intents (U08): the persisted record that makes the human refund rail correct through
 * ambiguous outcomes.
 *
 * - One intent per approval (case + amount + the approval's nonce), reserved in the case store
 *   BEFORE Stripe is called. Its idempotency key is derived from that identity and never changes,
 *   so every retry of the intent is the same Stripe request.
 * - withOutcome() is the only place an intent's outcome changes. It is pure, settles an intent at
 *   most once (succeeded/failed are terminal), and moves the case: succeeded → Refunded,
 *   failed → Held ("safe to request a new approval"), pending/unknown → stays Approved with new
 *   approvals blocked.
 * - applyOutcome() writes it with the store's compare-and-set, re-reading on a conflict, so a
 *   concurrent webhook or a rejected double-click can't make a Stripe answer go unrecorded.
 */
import type { RefundAttempt, RefundConfirmation, RefundIntent, ReturnCase } from "@/lib/domain/case";
import type { IntentRef, RailOutcome } from "@/lib/payments/stripe-rail";
import type { CaseStore } from "@/lib/store/case-store";
import { VersionConflict } from "@/lib/store/errors";
import { canTransition, transition } from "./case-machine";
import { sha256 } from "./digest";

export const intentIdFor = (caseId: string, amountCents: number, approvalNonce: string) => `ri_${sha256(`${caseId}|${amountCents}|${approvalNonce}`).slice(0, 24)}`;
export const idempotencyKeyFor = (intentId: string) => `rw-refund-${intentId}`;

/** The intent whose money outcome isn't settled yet. While one exists, no new approval or hold is accepted. */
export const activeIntent = (c: ReturnCase): RefundIntent | undefined => c.refundIntents?.find((i) => i.outcome === "pending" || i.outcome === "unknown");
export const latestIntent = (c: ReturnCase): RefundIntent | undefined => c.refundIntents?.at(-1);

export const intentRef = (c: ReturnCase, i: RefundIntent): IntentRef => ({
  intentId: i.id,
  caseId: c.id,
  rmaId: c.rmaId,
  chargeId: i.chargeId,
  paymentIntentId: i.paymentIntentId,
  amountCents: i.amountCents,
  approver: i.approver,
  idempotencyKey: i.idempotencyKey,
});

export type AttemptBy = RefundAttempt["by"];

export interface WebhookMark {
  eventId: string;
  type: string;
  verifiedAt: string;
}

const describe = (r: RailOutcome, by: AttemptBy): string => {
  const how = by === "webhook" ? "after a verified webhook, Stripe's refund was retrieved" : r.via === "lookup" ? "Stripe's refund for this intent was retrieved" : "Stripe answered the create (idempotency key reused on any retry)";
  switch (r.outcome) {
    case "succeeded":
      return `${how}: refund ${r.refund.refundId} succeeded for ${r.refund.amountCents} cents`;
    case "pending":
      return `${how}: refund ${r.refund.refundId} is ${r.refund.status}; Stripe accepted it and is settling it`;
    case "failed":
      return `Stripe confirmed no refund (${r.code}): ${r.message}. Nothing was refunded; safe to request a new approval`;
    case "unknown":
      return `outcome unknown (${r.code}): ${r.message}. Stripe may have accepted it; recovery retrieves or re-sends the SAME intent`;
  }
};

const confirmationOf = (r: RailOutcome, by: AttemptBy): RefundConfirmation => (by === "webhook" ? "webhook_verified" : r.via === "lookup" ? "api_retrieve" : "api_response");

/**
 * The case with `r` applied to intent `intentId`. Returns the SAME object when there is nothing
 * to change (unknown intent, or a repeat of an already-settled outcome), so callers can skip the write.
 */
export function withOutcome(c: ReturnCase, intentId: string, r: RailOutcome, by: AttemptBy, now: Date, webhook?: WebhookMark): ReturnCase {
  const intents = c.refundIntents ?? [];
  const idx = intents.findIndex((i) => i.id === intentId);
  if (idx < 0) return c;
  const intent = intents[idx];
  const at = now.toISOString();
  const refundId = r.outcome === "succeeded" || r.outcome === "pending" ? r.refund.refundId : r.outcome === "failed" ? r.refundId : undefined;
  const attempt: RefundAttempt = {
    n: intent.attempts.length + 1,
    at,
    by,
    action: by === "webhook" ? "webhook" : r.via,
    outcome: r.outcome,
    detail: describe(r, by),
    ...(refundId ? { refundId } : {}),
    ...(r.outcome === "succeeded" || r.outcome === "pending" ? { stripeStatus: r.refund.status } : r.outcome === "failed" && r.stripeStatus ? { stripeStatus: r.stripeStatus } : {}),
    ...(r.outcome === "failed" || r.outcome === "unknown" ? { errorCode: r.code } : {}),
    ...(webhook ? { eventId: webhook.eventId } : {}),
  };

  // A settled intent never changes outcome. A verified webhook is still noted on it, and an
  // authoritative answer that contradicts the settled one is recorded for a person, not applied.
  if (intent.outcome === "succeeded" || intent.outcome === "failed") {
    const contradicts = (r.outcome === "succeeded" || r.outcome === "failed") && r.outcome !== intent.outcome;
    if (!webhook && !contradicts) return c;
    if (webhook && intent.webhook?.eventId === webhook.eventId && !contradicts) return c;
    const noted: RefundIntent = {
      ...intent,
      updatedAt: at,
      ...(webhook ? { webhook } : {}),
      attempts: [...intent.attempts, contradicts ? { ...attempt, detail: `Stripe now reports ${r.outcome} for an intent already settled as ${intent.outcome}: not applied; a person must review. ${attempt.detail}` } : { ...attempt, outcome: intent.outcome, detail: `verified webhook ${webhook!.type} (${webhook!.eventId}) for this refund; outcome already ${intent.outcome}` }],
    };
    const refund = webhook && c.refund && c.refund.intentId === intent.id ? { ...c.refund, webhook } : c.refund;
    return { ...c, refund, refundIntents: intents.map((x, i) => (i === idx ? noted : x)), updatedAt: at };
  }

  const next: RefundIntent = {
    ...intent,
    outcome: r.outcome,
    updatedAt: at,
    attempts: [...intent.attempts, attempt],
    ...(refundId ? { refundId } : {}),
    ...(webhook ? { webhook } : {}),
    ...(r.outcome === "succeeded" || r.outcome === "failed" ? { confirmedBy: confirmationOf(r, by) } : {}),
    ...(r.outcome === "failed" ? { failure: { code: r.code, message: r.message } } : {}),
  };
  const actor = "system" as const;
  let out: ReturnCase = { ...c, refundIntents: intents.map((x, i) => (i === idx ? next : x)), updatedAt: at };

  if (r.outcome === "succeeded") {
    if (canTransition(out.state, "REFUNDED")) {
      out = transition(out, { type: "REFUNDED", refundId: r.refund.refundId, detail: `Stripe test-mode refund ${r.refund.refundId} for ${r.refund.amountCents} cents (intent ${intent.id}, ${next.confirmedBy})${r.fee ? `; inspection fee ${r.fee.amountCents} cents` : ""}` }, actor, now);
    }
    out = {
      ...out,
      refund: {
        refundId: r.refund.refundId,
        status: r.refund.status,
        amountCents: r.refund.amountCents,
        chargeId: r.refund.chargeId,
        paymentIntentId: r.refund.paymentIntentId,
        receiptUrl: r.refund.receiptUrl,
        createdAt: at,
        livemode: false,
        fee: r.fee,
        event: r.event,
        intentId: intent.id,
        confirmedBy: next.confirmedBy,
        ...(webhook ? { webhook } : {}),
        ...(r.feeError ? { feeError: r.feeError } : {}),
      },
    };
    return out;
  }
  if (r.outcome === "failed") {
    if (canTransition(out.state, "ERROR")) {
      out = transition(out, { type: "ERROR", reason: "refund_rail_error", detail: `refund failed, nothing was refunded by intent ${intent.id}: ${r.message}` }, actor, now);
    }
    return out;
  }
  // pending / unknown: the case stays where it is (Approved); the intent blocks new approvals.
  const event = r.outcome === "unknown" ? "REFUND_UNKNOWN" : "REFUND_PENDING";
  return { ...out, audit: [...out.audit, { at, actor, event, from: out.state, to: out.state, detail: attempt.detail }] };
}

export class OutcomeNotRecorded extends Error {}

/**
 * Write `r` for intent `intentId` with compare-and-set, re-reading on a version conflict. If the
 * store can't take it, the intent stays pending in the store and recovery settles it later.
 */
export async function applyOutcome(store: CaseStore, caseId: string, intentId: string, r: RailOutcome, by: AttemptBy, now: Date, webhook?: WebhookMark): Promise<ReturnCase> {
  for (let i = 0; i < 5; i++) {
    let cur: ReturnCase | null;
    let saved: ReturnCase;
    try {
      cur = await store.get(caseId);
      if (!cur) throw new OutcomeNotRecorded(`case ${caseId} disappeared`);
      const next = withOutcome(cur, intentId, r, by, now, webhook);
      if (next === cur) return cur;
      saved = await store.put(next, cur.version);
    } catch (e) {
      if (e instanceof VersionConflict) continue;
      if (e instanceof OutcomeNotRecorded) throw e;
      throw new OutcomeNotRecorded(e instanceof Error ? e.message : String(e));
    }
    return saved;
  }
  throw new OutcomeNotRecorded("the case kept changing while the refund outcome was being recorded");
}
