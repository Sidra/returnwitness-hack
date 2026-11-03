/**
 * An in-memory Stripe API behind the real stripe-node SDK (injected as its fetch transport), so
 * the real StripeTestRail runs end to end with NO network. It models what U08 depends on:
 *  - idempotency: the first response for a key (2xx, 4xx or an executed 5xx) is replayed for that
 *    key; the same key with different params is a 400 idempotency_error.
 *  - balances: a refund can't exceed the charge's remaining amount (amount_too_large).
 *  - faults injected per refunds.create: the response dropped AFTER Stripe accepted it, the
 *    request dropped BEFORE it arrived, a 500 after or before executing (cached either way),
 *    a decline, or a refund left `pending`.
 */
import Stripe from "stripe";

export type RefundFault =
  | "timeout_after_accept"
  | "drop_before_accept"
  | "500_after_accept"
  | "500_before_accept"
  | "pending"
  | { decline: string };

interface FakeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  refunded: boolean;
  payment_intent: string;
  livemode: boolean;
  receipt_url: string;
}

interface FakeRefund {
  id: string;
  object: "refund";
  amount: number;
  charge: string;
  payment_intent: string;
  status: string;
  metadata: Record<string, string>;
  livemode: boolean;
  created: number;
}

export interface SeenRequest {
  method: string;
  path: string;
  idempotencyKey: string | null;
  params: Record<string, string>;
}

const listOf = (data: unknown[], url: string) => ({ object: "list", data, has_more: false, url });

export class FakeStripe {
  charges = new Map<string, FakeCharge>();
  paymentIntents = new Map<string, { id: string; object: "payment_intent"; amount: number; status: string; latest_charge: string; created: number; metadata: Record<string, string> }>();
  refunds: FakeRefund[] = [];
  events: Array<{ id: string; object: "event"; type: string; created: number; livemode: boolean; data: { object: unknown } }> = [];
  requests: SeenRequest[] = [];
  refundFaults: RefundFault[] = [];
  /** The next N refunds.list calls drop the connection. */
  listDrops = 0;
  private idem = new Map<string, { status: number; body: unknown; params: string }>();
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}_fake${String(++this.seq).padStart(4, "0")}`;
  }

  /** A succeeded test-mode payment intent + charge (what ensureCharge would have seeded). */
  seedCharge(amount: number, opts: { livemode?: boolean; orderId?: string } = {}) {
    const ch = this.id("ch");
    const pi = this.id("pi");
    this.charges.set(ch, { id: ch, object: "charge", amount, amount_refunded: 0, refunded: false, payment_intent: pi, livemode: Boolean(opts.livemode), receipt_url: `https://pay.stripe.com/receipts/${ch}` });
    this.paymentIntents.set(pi, { id: pi, object: "payment_intent", amount, status: "succeeded", latest_charge: ch, created: 1, metadata: opts.orderId ? { rw_order_id: opts.orderId, rw_kind: "order_charge" } : {} });
    return { chargeId: ch, paymentIntentId: pi };
  }

  /** Refunds that actually moved money (status succeeded or pending), for "exactly one" assertions. */
  liveRefunds(paymentIntent?: string) {
    return this.refunds.filter((r) => (r.status === "succeeded" || r.status === "pending") && (!paymentIntent || r.payment_intent === paymentIntent));
  }

  createCalls() {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/v1/refunds");
  }

  /** Change a refund's state as Stripe would later (e.g. pending → succeeded). */
  setRefundStatus(id: string, status: string) {
    const r = this.refunds.find((x) => x.id === id);
    if (r) r.status = status;
  }

  /** A refund created outside our rail (another case, the dashboard): it shares nothing with our intents. */
  foreignRefund(chargeId: string, amount: number, metadata: Record<string, string> = {}) {
    const ch = this.charges.get(chargeId)!;
    return this.execRefund({ payment_intent: ch.payment_intent, amount: String(amount) }, metadata);
  }

  readonly httpClient = Stripe.createFetchHttpClient((async (input: string | URL | Request, init?: RequestInit) => this.handle(String(input), init)) as typeof fetch);

  private execRefund(p: Record<string, string>, metadata: Record<string, string>, status = "succeeded"): FakeRefund {
    const pi = p.payment_intent;
    const ch = [...this.charges.values()].find((c) => c.payment_intent === pi);
    if (!ch) throw Object.assign(new Error("No such payment_intent"), { http: 404, code: "resource_missing" });
    const amount = Number(p.amount ?? ch.amount - ch.amount_refunded);
    if (ch.refunded) throw Object.assign(new Error("Charge has already been refunded."), { http: 400, code: "charge_already_refunded" });
    if (amount > ch.amount - ch.amount_refunded) throw Object.assign(new Error("Refund amount is greater than unrefunded amount on charge"), { http: 400, code: "amount_too_large" });
    ch.amount_refunded += amount;
    ch.refunded = ch.amount_refunded === ch.amount;
    const r: FakeRefund = { id: this.id("re"), object: "refund", amount, charge: ch.id, payment_intent: pi, status, metadata, livemode: false, created: 2 };
    this.refunds.push(r);
    this.events.unshift({ id: this.id("evt"), object: "event", type: "charge.refunded", created: 3, livemode: false, data: { object: { ...ch } } });
    return r;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    const key = headers.get("idempotency-key");
    const params: Record<string, string> = {};
    const qs = method === "GET" ? u.searchParams : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    qs.forEach((v, k) => (params[k] = v));
    const path = u.pathname;
    this.requests.push({ method, path, idempotencyKey: key, params });
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": `req_${this.seq}` } });
    const err = (status: number, type: string, message: string, code?: string) => ok({ error: { type, message, ...(code ? { code } : {}) } }, status);
    const metadata = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));

    if (method === "POST" && path === "/v1/refunds") {
      const fp = JSON.stringify(Object.entries(params).sort());
      if (key && this.idem.has(key)) {
        const saved = this.idem.get(key)!;
        if (saved.params !== fp) return err(400, "idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.");
        return ok(saved.body, saved.status);
      }
      const fault = this.refundFaults.shift();
      if (fault === "drop_before_accept") throw new TypeError("fetch failed (connection reset before the request reached Stripe)");
      if (fault === "500_before_accept") {
        const body = { error: { type: "api_error", message: "An unknown error occurred" } };
        if (key) this.idem.set(key, { status: 500, body, params: fp });
        return ok(body, 500);
      }
      if (typeof fault === "object" && fault?.decline) {
        const body = { error: { type: "invalid_request_error", code: fault.decline, message: `declined: ${fault.decline}` } };
        if (key) this.idem.set(key, { status: 400, body, params: fp });
        return ok(body, 400);
      }
      let r: FakeRefund;
      try {
        r = this.execRefund(params, metadata, fault === "pending" ? "pending" : "succeeded");
      } catch (e) {
        const x = e as { http?: number; code?: string; message: string };
        const body = { error: { type: "invalid_request_error", code: x.code, message: x.message } };
        if (key) this.idem.set(key, { status: x.http ?? 400, body, params: fp });
        return ok(body, x.http ?? 400);
      }
      if (fault === "500_after_accept") {
        const body = { error: { type: "api_error", message: "An unknown error occurred" } };
        if (key) this.idem.set(key, { status: 500, body, params: fp });
        return ok(body, 500);
      }
      if (key) this.idem.set(key, { status: 200, body: r, params: fp });
      if (fault === "timeout_after_accept") throw new TypeError("fetch failed (response lost after Stripe accepted the refund)");
      return ok(r);
    }
    if (method === "GET" && path === "/v1/refunds") {
      if (this.listDrops > 0) {
        this.listDrops--;
        throw new TypeError("fetch failed (list dropped)");
      }
      const data = this.refunds.filter((r) => (!params.payment_intent || r.payment_intent === params.payment_intent) && (!params.charge || r.charge === params.charge));
      return ok(listOf(data, "/v1/refunds"));
    }
    let m = /^\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const r = this.refunds.find((x) => x.id === m![1]);
      return r ? ok(r) : err(404, "invalid_request_error", `No such refund: '${m[1]}'`, "resource_missing");
    }
    m = /^\/v1\/charges\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const c = this.charges.get(m[1]);
      return c ? ok(c) : err(404, "invalid_request_error", `No such charge: '${m[1]}'`, "resource_missing");
    }
    if (method === "GET" && path === "/v1/payment_intents/search") {
      const order = /rw_order_id'\]:'([^']+)'/.exec(params.query ?? "")?.[1];
      const data = [...this.paymentIntents.values()].filter((p) => p.metadata.rw_order_id === order && p.metadata.rw_kind === "order_charge");
      return ok({ object: "search_result", data, has_more: false, next_page: null, url: "/v1/payment_intents/search" });
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      if (key && this.idem.has(key)) return ok(this.idem.get(key)!.body);
      const { chargeId, paymentIntentId } = this.seedCharge(Number(params.amount), { orderId: metadata.rw_order_id });
      const pi = { ...this.paymentIntents.get(paymentIntentId)!, metadata, latest_charge: chargeId };
      this.paymentIntents.set(paymentIntentId, pi);
      if (key) this.idem.set(key, { status: 200, body: pi, params: "" });
      return ok(pi);
    }
    if (method === "GET" && path === "/v1/events") {
      return ok(listOf(this.events.filter((e) => !params.type || e.type === params.type).slice(0, Number(params.limit ?? 10)), "/v1/events"));
    }
    return err(404, "invalid_request_error", `fake stripe: no route ${method} ${path}`);
  }
}
