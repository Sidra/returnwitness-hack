/**
 * Stripe refund rail: TEST MODE ONLY.
 *
 * - Refuses to construct with any key that doesn't start with `sk_test_`.
 * - Seeds one test-mode charge per fixture order (idempotent by order id), so the refund has
 *   a real original charge to run against ([Seeded test-mode charge]).
 * - Refunds one persisted REFUND INTENT (U08). Every create for an intent carries the intent's
 *   idempotency key, so a retry of the same intent can never become a second refund.
 * - Classifies every outcome: Stripe's 4xx rejection is a confirmed failure; a timeout, dropped
 *   connection or 5xx is UNKNOWN (Stripe may have accepted it). It never reports "nothing
 *   happened" for an answer it didn't get.
 * - recover(): retrieves the intent's refund by its metadata first, and only re-sends the SAME
 *   create (same key, same params) when no refund for the intent exists.
 * - On success: books the $2.00 inspection fee as its own test-mode payment and fetches the
 *   `charge.refunded` event from Stripe's Events API (source "events_api", not a webhook delivery).
 */
import Stripe from "stripe";

export const INSPECTION_FEE_CENTS = 200;

/** Seeded charges are tagged per environment so local runs and the public deploy never share one. */
const RAIL_ENV = process.env.VERCEL_ENV || "local";

export class StripeKeyRefused extends Error {}

export interface SeededCharge {
  orderId: string;
  paymentIntentId: string;
  chargeId: string;
  amountCents: number;
  receiptUrl: string | null;
  created: number;
}

/** What the rail needs from a persisted refund intent. */
export interface IntentRef {
  intentId: string;
  caseId: string;
  rmaId: string;
  chargeId: string;
  paymentIntentId: string;
  amountCents: number;
  approver: string;
  idempotencyKey: string;
}

export interface RailRefund {
  refundId: string;
  status: string;
  amountCents: number;
  chargeId: string;
  paymentIntentId: string;
  receiptUrl: string | null;
}

export interface RailFee {
  paymentIntentId: string;
  chargeId: string | null;
  amountCents: number;
  receiptUrl: string | null;
}

export interface RailEvent {
  id: string;
  type: string;
  created: number;
  payload: unknown;
  source: "events_api";
}

/** create: the outcome of refunds.create with the intent's key. lookup: found by retrieving the intent's refund. */
export type RailVia = "create" | "lookup";

export type RailOutcome =
  | { outcome: "succeeded" | "pending"; via: RailVia; refund: RailRefund; fee: RailFee | null; feeError?: string; event: RailEvent | null }
  | { outcome: "failed"; via: RailVia; code: string; message: string; refundId?: string; stripeStatus?: string }
  | { outcome: "unknown"; via: RailVia; code: string; message: string };

/** A refund as Stripe reports it on retrieve: the authoritative status a webhook is reconciled against. */
export interface RetrievedRefund {
  refundId: string;
  status: string;
  amountCents: number;
  chargeId: string | null;
  paymentIntentId: string | null;
  livemode: boolean;
  metadata: Record<string, string>;
}

export interface RefundRail {
  readonly mode: "stripe_test";
  ensureCharge(order: { id: string; totalCents: number; customerEmail: string }): Promise<SeededCharge>;
  /** The person's one attempt: balance pre-flight, then refunds.create with the intent's idempotency key. */
  refund(intent: IntentRef): Promise<RailOutcome>;
  /**
   * Server-side recovery of the SAME intent: retrieve first; re-send the same create (same key) only
   * if no refund for the intent exists and `createIfMissing` isn't false (a webhook only retrieves).
   */
  recover(intent: IntentRef, opts?: { createIfMissing?: boolean }): Promise<RailOutcome>;
  /** Authoritative refund state (null when Stripe has no such refund). Used to reconcile webhooks. */
  retrieveRefund(refundId: string): Promise<RetrievedRefund | null>;
  /** Every refund on a charge (a charge.* webhook names the charge, not the refund). */
  refundsForCharge(chargeId: string): Promise<RetrievedRefund[]>;
}

export function assertTestKey(key: string | undefined): string {
  if (!key) throw new StripeKeyRefused("RETURNWITNESS_STRIPE_SECRET_KEY is not set");
  if (!key.startsWith("sk_test_")) throw new StripeKeyRefused("refusing to start the payment rail: the Stripe key is not a test-mode key (sk_test_)");
  return key;
}

const chargeIdOf = (pi: Stripe.PaymentIntent): string | null =>
  typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
const idOf = (x: string | { id: string } | null | undefined): string | null => (typeof x === "string" ? x : (x?.id ?? null));

/** Stripe's refund status → our outcome. requires_action and pending are accepted-but-settling. */
export function outcomeOfStatus(status: string | null | undefined): "succeeded" | "pending" | "failed" {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

/**
 * An exception from a Stripe call → failed (Stripe confirmed it rejected the request) or unknown
 * (we can't tell whether it executed). Only an explicit 4xx rejection counts as confirmed; a
 * timeout, connection drop, 5xx, 409 lock, 429 or an error we don't recognise is unknown.
 */
export function classifyStripeError(e: unknown): { outcome: "failed" | "unknown"; code: string; message: string } {
  const err = e as { type?: string; statusCode?: number; code?: string; message?: string } | null;
  const message = err?.message ?? String(e);
  const status = err?.statusCode;
  switch (err?.type) {
    case "StripeConnectionError":
      return { outcome: "unknown", code: "connection_lost", message };
    case "StripeAPIError":
      return { outcome: "unknown", code: `stripe_${status ?? "5xx"}`, message };
    case "StripeRateLimitError":
      return { outcome: "unknown", code: "rate_limited", message };
    case "StripeIdempotencyError":
      return { outcome: "unknown", code: "idempotency_conflict", message };
    case "StripeInvalidRequestError":
    case "StripeCardError":
    case "StripeAuthenticationError":
    case "StripePermissionError":
      if (status === undefined || (status >= 400 && status < 500 && status !== 409 && status !== 429)) return { outcome: "failed", code: err.code ?? err.type, message };
      return { outcome: "unknown", code: `stripe_${status}`, message };
    default:
      if (typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429) return { outcome: "failed", code: err?.code ?? `stripe_${status}`, message };
      return { outcome: "unknown", code: err?.code ?? "unclassified_error", message };
  }
}

const toRetrieved = (r: Stripe.Refund): RetrievedRefund => ({
  refundId: r.id,
  status: r.status ?? "unknown",
  amountCents: r.amount,
  chargeId: idOf(r.charge as string | { id: string } | null),
  paymentIntentId: idOf(r.payment_intent as string | { id: string } | null),
  livemode: Boolean((r as { livemode?: boolean }).livemode),
  metadata: (r.metadata ?? {}) as Record<string, string>,
});

export interface RailOptions {
  /** Tests inject a fake transport (Stripe.createFetchHttpClient(fakeFetch)); production uses the default. */
  httpClient?: Stripe.HttpClient;
  maxNetworkRetries?: number;
  timeoutMs?: number;
  /** The charge.refunded event can lag a moment behind the refund. */
  eventPollTries?: number;
  eventPollDelayMs?: number;
}

export class StripeTestRail implements RefundRail {
  readonly mode = "stripe_test" as const;
  private stripe: Stripe;
  private charges = new Map<string, SeededCharge>();
  private readonly eventPollTries: number;
  private readonly eventPollDelayMs: number;

  constructor(key: string | undefined, opts: RailOptions = {}) {
    this.stripe = new Stripe(assertTestKey(key), {
      maxNetworkRetries: opts.maxNetworkRetries ?? 2,
      timeout: opts.timeoutMs ?? 20_000,
      ...(opts.httpClient ? { httpClient: opts.httpClient } : {}),
    });
    this.eventPollTries = opts.eventPollTries ?? 4;
    this.eventPollDelayMs = opts.eventPollDelayMs ?? 600;
  }

  async ensureCharge(order: { id: string; totalCents: number; customerEmail: string }): Promise<SeededCharge> {
    // Another instance (or an earlier refund) may have refunded the cached charge: re-check it.
    const cached = this.charges.get(order.id);
    if (cached) {
      const ch = await this.stripe.charges.retrieve(cached.chargeId).catch(() => null);
      if (ch && !ch.refunded && ch.amount_refunded === 0) return cached;
      this.charges.delete(order.id);
    }
    // Reuse an existing seeded charge for this order if one is still refundable.
    const found = await this.stripe.paymentIntents.search({
      query: `metadata['rw_order_id']:'${order.id}' AND metadata['rw_kind']:'order_charge' AND metadata['rw_env']:'${RAIL_ENV}' AND status:'succeeded'`,
      limit: 10,
    });
    for (const pi of found.data) {
      const chId = chargeIdOf(pi);
      if (!chId) continue;
      const ch = await this.stripe.charges.retrieve(chId);
      if (!ch.refunded && ch.amount_refunded === 0 && pi.amount === order.totalCents) {
        const s = { orderId: order.id, paymentIntentId: pi.id, chargeId: ch.id, amountCents: pi.amount, receiptUrl: ch.receipt_url, created: pi.created };
        this.charges.set(order.id, s);
        return s;
      }
    }
    const pi = await this.stripe.paymentIntents.create({
      amount: order.totalCents,
      currency: "usd",
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `ReturnWitness seeded order ${order.id}`,
      receipt_email: undefined,
      metadata: { rw_order_id: order.id, rw_kind: "order_charge", rw_env: RAIL_ENV, rw_label: "Seeded test-mode charge", rw_customer: order.customerEmail },
    });
    const chId = chargeIdOf(pi);
    const ch = chId ? await this.stripe.charges.retrieve(chId) : null;
    const s = { orderId: order.id, paymentIntentId: pi.id, chargeId: chId ?? "", amountCents: pi.amount, receiptUrl: ch?.receipt_url ?? null, created: pi.created };
    this.charges.set(order.id, s);
    return s;
  }

  async refund(intent: IntentRef): Promise<RailOutcome> {
    return this.preflightAndCreate(intent);
  }

  async recover(intent: IntentRef, opts: { createIfMissing?: boolean } = {}): Promise<RailOutcome> {
    let mine: Stripe.Refund | undefined;
    try {
      mine = await this.findIntentRefund(intent);
    } catch (e) {
      // We couldn't look, so we still don't know. Never re-send blind when the lookup itself failed.
      const c = classifyStripeError(e);
      return { outcome: "unknown", via: "lookup", code: `lookup_${c.code}`, message: `couldn't retrieve the intent's refund: ${c.message}` };
    }
    if (mine) return this.settle(intent, mine, "lookup");
    if (opts.createIfMissing === false) return { outcome: "unknown", via: "lookup", code: "not_found_yet", message: "no refund for this intent on the charge yet" };
    // No refund for this intent exists on the charge: re-send the SAME create (same key, same params).
    return this.preflightAndCreate(intent);
  }

  async retrieveRefund(refundId: string): Promise<RetrievedRefund | null> {
    try {
      return toRetrieved(await this.stripe.refunds.retrieve(refundId));
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }

  async refundsForCharge(chargeId: string): Promise<RetrievedRefund[]> {
    const list = await this.stripe.refunds.list({ charge: chargeId, limit: 100 });
    return list.data.map(toRetrieved);
  }

  /** The intent's own refund, found by the metadata every create for it carries. */
  private async findIntentRefund(intent: IntentRef): Promise<Stripe.Refund | undefined> {
    const list = await this.stripe.refunds.list({ payment_intent: intent.paymentIntentId, limit: 100 });
    return list.data.find((r) => r.metadata?.rw_intent_id === intent.intentId);
  }

  private async preflightAndCreate(intent: IntentRef): Promise<RailOutcome> {
    // Pre-flight: the charge must be this intent's, test mode, with enough balance left. Nothing has
    // been sent yet, so a failure here is a confirmed "no refund".
    let ch: Stripe.Charge;
    try {
      ch = await this.stripe.charges.retrieve(intent.chargeId);
    } catch (e) {
      const c = classifyStripeError(e);
      return { outcome: "failed", via: "create", code: `preflight_${c.code}`, message: `couldn't read the original charge, so no refund was sent: ${c.message}` };
    }
    if ((ch as { livemode?: boolean }).livemode) return { outcome: "failed", via: "create", code: "live_charge_refused", message: "the charge is a live-mode charge; this rail refunds test mode only" };
    if (idOf(ch.payment_intent as string | { id: string } | null) !== intent.paymentIntentId) {
      return { outcome: "failed", via: "create", code: "charge_mismatch", message: `charge ${ch.id} doesn't belong to payment intent ${intent.paymentIntentId}` };
    }
    const remaining = ch.amount - (ch.amount_refunded ?? 0);
    if (!Number.isInteger(intent.amountCents) || intent.amountCents <= 0 || intent.amountCents > remaining) {
      return { outcome: "failed", via: "create", code: "over_balance", message: `refund of ${intent.amountCents} cents exceeds the charge's remaining balance of ${remaining} cents` };
    }

    let refund: Stripe.Refund;
    try {
      refund = await this.stripe.refunds.create(
        {
          payment_intent: intent.paymentIntentId,
          amount: intent.amountCents,
          reason: "requested_by_customer",
          metadata: { rw_intent_id: intent.intentId, rw_case_id: intent.caseId, rw_rma_id: intent.rmaId, rw_approved_by: intent.approver, rw_env: RAIL_ENV },
        },
        { idempotencyKey: intent.idempotencyKey },
      );
    } catch (e) {
      const c = classifyStripeError(e);
      return { ...c, via: "create" };
    }
    return this.settle(intent, refund, "create");
  }

  private async settle(intent: IntentRef, refund: Stripe.Refund, via: RailVia): Promise<RailOutcome> {
    const o = outcomeOfStatus(refund.status);
    if (o === "failed") return { outcome: "failed", via, code: `refund_${refund.status}`, message: `Stripe reports refund ${refund.id} as ${refund.status}`, refundId: refund.id, stripeStatus: refund.status ?? undefined };
    const chargeId = idOf(refund.charge as string | { id: string } | null) ?? intent.chargeId;
    // The seeded charge is now (partly) refunded; the next case for this order seeds a fresh one.
    for (const [orderId, s] of this.charges) if (s.chargeId === chargeId) this.charges.delete(orderId);
    const out: RailOutcome = {
      outcome: o,
      via,
      refund: { refundId: refund.id, status: refund.status ?? "unknown", amountCents: refund.amount, chargeId, paymentIntentId: intent.paymentIntentId, receiptUrl: null },
      fee: null,
      event: null,
    };
    if (o !== "succeeded") return out;
    // Extras after the money moved. None of them can change the refund's outcome.
    try {
      const refundedCharge = await this.stripe.charges.retrieve(chargeId);
      out.refund.receiptUrl = refundedCharge.receipt_url;
    } catch {
      // The receipt link is a nicety; the refund stands.
    }
    try {
      const fee = await this.stripe.paymentIntents.create(
        {
          amount: INSPECTION_FEE_CENTS,
          currency: "usd",
          payment_method: "pm_card_visa",
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          description: `ReturnWitness inspection fee ${intent.rmaId}`,
          metadata: { rw_case_id: intent.caseId, rw_rma_id: intent.rmaId, rw_kind: "inspection_fee" },
        },
        { idempotencyKey: `rw-fee-${intent.caseId}` },
      );
      const feeChargeId = chargeIdOf(fee);
      const feeCharge = feeChargeId ? await this.stripe.charges.retrieve(feeChargeId).catch(() => null) : null;
      out.fee = { paymentIntentId: fee.id, chargeId: feeChargeId, amountCents: fee.amount, receiptUrl: feeCharge?.receipt_url ?? null };
    } catch (e) {
      out.feeError = e instanceof Error ? e.message : String(e);
    }
    out.event = await this.findRefundEvent(chargeId).catch(() => null);
    return out;
  }

  /** The `charge.refunded` event for this charge, fetched from the Events API (not a webhook delivery). */
  private async findRefundEvent(chargeId: string): Promise<RailEvent | null> {
    for (let i = 0; i < this.eventPollTries; i++) {
      const evs = await this.stripe.events.list({ type: "charge.refunded", limit: 10 });
      const ev = evs.data.find((e) => (e.data.object as Stripe.Charge).id === chargeId);
      if (ev) return { id: ev.id, type: ev.type, created: ev.created, payload: ev, source: "events_api" };
      if (this.eventPollDelayMs > 0) await new Promise((r) => setTimeout(r, this.eventPollDelayMs));
    }
    return null;
  }
}

const g = globalThis as unknown as { __rwRail?: RefundRail | Error };

/** The configured rail, or the reason it can't run (shown on /settings; the refund stays blocked). */
export function getRail(): RefundRail | Error {
  if (!g.__rwRail) {
    try {
      g.__rwRail = new StripeTestRail(process.env.RETURNWITNESS_STRIPE_SECRET_KEY);
    } catch (e) {
      g.__rwRail = e instanceof Error ? e : new Error(String(e));
    }
  }
  return g.__rwRail;
}

export function setRail(r: RefundRail | Error) {
  g.__rwRail = r;
}
