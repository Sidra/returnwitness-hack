/**
 * Stripe webhook reconciliation (U08).
 *
 * - Signature: Stripe's scheme (HMAC-SHA256 over `${t}.${rawBody}`, 5-minute tolerance) via
 *   Stripe.webhooks.constructEvent on the RAW body. A missing or bad signature, or any change to
 *   the body, is refused before anything is read.
 * - Dedup: the event id is claimed in the case store (persistent, atomic). A redelivery is
 *   acknowledged and ignored. If processing fails the claim is released so Stripe's retry runs.
 * - Trust: the event only says WHICH refund to look at. Its status is never used: the refund is
 *   retrieved from Stripe, and it must carry our intent id, the intent's payment intent, charge and
 *   amount. A foreign case/charge can't mark anything refunded; arrival order doesn't matter.
 * - Provenance: a webhook-settled intent is "webhook_verified" and carries the event id, distinct
 *   from the Events API payload the rail fetches on its own ("events_api").
 */
import Stripe from "stripe";
import type { ReturnCase } from "@/lib/domain/case";
import type { CaseStore } from "@/lib/store/case-store";
import { outcomeOfStatus, type RailOutcome, type RefundRail, type RetrievedRefund } from "./stripe-rail";
import { applyOutcome, intentRef, type WebhookMark } from "@/lib/engine/refund-intent";
import { logDecision } from "@/lib/obs/decision-log";

export interface WebhookDeps {
  store: CaseStore;
  rail: RefundRail | Error;
  secret: string | undefined;
  now?: () => Date;
  /** Seconds a signature stays valid (Stripe's default 300). */
  toleranceS?: number;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Event types that name a refund (object = refund) or a charge whose refunds changed (object = charge). */
export const HANDLED_EVENTS = new Set(["refund.created", "refund.updated", "refund.failed", "charge.refund.updated", "charge.refunded"]);

export interface RefundReconcile {
  refundId: string;
  caseId?: string;
  intentId?: string;
  outcome?: string;
  ignored?: string;
}

class RailDown extends Error {}

export async function handleStripeWebhook(deps: WebhookDeps, raw: string, signature: string | null): Promise<WebhookResult> {
  if (!deps.secret) return { status: 503, body: { error: "webhook_not_configured" } };
  if (!signature) return { status: 400, body: { error: "missing_signature" } };
  let ev: Stripe.Event;
  try {
    ev = Stripe.webhooks.constructEvent(raw, signature, deps.secret, deps.toleranceS);
  } catch (e) {
    return { status: 400, body: { error: "bad_signature", message: e instanceof Error ? e.message : String(e) } };
  }
  if (ev.livemode) return { status: 400, body: { error: "live_mode_event_refused" } };
  if (!HANDLED_EVENTS.has(ev.type)) return { status: 200, body: { received: true, ignored: "unhandled_event_type", type: ev.type } };
  if (!(await deps.store.claimWebhookEvent(ev.id))) return { status: 200, body: { received: true, duplicate: true, eventId: ev.id } };

  try {
    const results = await reconcileEvent(deps, ev, deps.now?.() ?? new Date());
    return { status: 200, body: { received: true, eventId: ev.id, results } };
  } catch (e) {
    await deps.store.releaseWebhookEvent(ev.id).catch(() => {});
    const message = e instanceof Error ? e.message : String(e);
    return { status: e instanceof RailDown ? 503 : 500, body: { error: e instanceof RailDown ? "rail_unavailable" : "reconcile_failed", message } };
  }
}

async function reconcileEvent(deps: WebhookDeps, ev: Stripe.Event, now: Date): Promise<RefundReconcile[]> {
  if (deps.rail instanceof Error) throw new RailDown(`refund rail unavailable: ${deps.rail.message}`);
  const rail = deps.rail;
  const obj = ev.data.object as { object?: string; id?: string };
  if (!obj?.id) return [{ refundId: "", ignored: "event has no object id" }];
  let candidates: RetrievedRefund[];
  let eventChargeId: string | null = null;
  if (obj.object === "refund") {
    const r = await rail.retrieveRefund(obj.id);
    if (!r) return [{ refundId: obj.id, ignored: "Stripe has no such refund" }];
    candidates = [r];
  } else if (obj.object === "charge") {
    eventChargeId = obj.id;
    candidates = await rail.refundsForCharge(obj.id);
  } else {
    return [{ refundId: "", ignored: `object ${String(obj.object)} is not a refund or charge` }];
  }
  const out: RefundReconcile[] = [];
  for (const rr of candidates) out.push(await reconcileRefund(deps.store, rail, ev, rr, eventChargeId, now));
  return out;
}

const fromRetrieved = (rr: RetrievedRefund, chargeId: string, paymentIntentId: string): RailOutcome => {
  const o = outcomeOfStatus(rr.status);
  if (o === "failed") return { outcome: "failed", via: "lookup", code: `refund_${rr.status}`, message: `Stripe reports refund ${rr.refundId} as ${rr.status}`, refundId: rr.refundId, stripeStatus: rr.status };
  return { outcome: o, via: "lookup", refund: { refundId: rr.refundId, status: rr.status, amountCents: rr.amountCents, chargeId: rr.chargeId ?? chargeId, paymentIntentId: rr.paymentIntentId ?? paymentIntentId, receiptUrl: null }, fee: null, event: null };
};

async function reconcileRefund(store: CaseStore, rail: RefundRail, ev: Stripe.Event, rr: RetrievedRefund, eventChargeId: string | null, now: Date): Promise<RefundReconcile> {
  const base = { refundId: rr.refundId };
  if (rr.livemode) return { ...base, ignored: "live-mode refund" };
  const caseId = rr.metadata.rw_case_id;
  const intentId = rr.metadata.rw_intent_id;
  if (!caseId || !intentId) return { ...base, ignored: "not a ReturnWitness intent refund" };
  const c: ReturnCase | null = await store.get(caseId);
  if (!c) return { ...base, caseId, ignored: "no such case" };
  const intent = c.refundIntents?.find((i) => i.id === intentId);
  if (!intent) return { ...base, caseId, intentId, ignored: "the case has no such refund intent" };
  // The retrieved refund must be THIS intent's money: same payment intent, charge and amount.
  const foreign =
    rr.paymentIntentId !== intent.paymentIntentId ||
    (rr.chargeId !== null && rr.chargeId !== intent.chargeId) ||
    (eventChargeId !== null && eventChargeId !== intent.chargeId) ||
    rr.amountCents !== intent.amountCents;
  if (foreign) return { ...base, caseId, intentId, ignored: "refund doesn't match the intent's charge, payment intent or amount" };

  const mark: WebhookMark = { eventId: ev.id, type: ev.type, verifiedAt: now.toISOString() };
  let r: RailOutcome;
  if (intent.outcome === "pending" || intent.outcome === "unknown") {
    // Settle from Stripe's current state (lookup also books the fee and fetches the event); never re-send a create from here.
    r = await rail.recover(intentRef(c, intent), { createIfMissing: false });
    if (r.outcome === "unknown") r = fromRetrieved(rr, intent.chargeId, intent.paymentIntentId);
  } else {
    r = fromRetrieved(rr, intent.chargeId, intent.paymentIntentId);
  }
  const saved = await applyOutcome(store, caseId, intentId, r, "webhook", now, mark);
  const after = saved.refundIntents?.find((i) => i.id === intentId);
  logDecision({ caseId, rmaId: c.rmaId, runId: c.runId, kind: "webhook_reconciled", state: saved.state, detail: `${ev.type} ${ev.id} → ${after?.outcome}` });
  return { ...base, caseId, intentId, outcome: after?.outcome };
}
