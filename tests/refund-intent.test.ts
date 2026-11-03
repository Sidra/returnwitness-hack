/**
 * U08: the human refund rail through ambiguous outcomes. The REAL StripeTestRail runs against an
 * in-memory Stripe (tests/helpers/fake-stripe.ts) injected as the SDK's transport: no network,
 * no keys, no spend. Every "exactly one refund" assertion counts refunds in that fake ledger.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection, type PipelineDeps } from "@/lib/engine/pipeline";
import { approveCase, holdCase, recoverRefund, refundCase, ServiceError } from "@/lib/engine/service";
import { activeIntent, latestIntent, withOutcome } from "@/lib/engine/refund-intent";
import { MemoryCaseStore, VersionConflict, type CaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { classifyStripeError, outcomeOfStatus, StripeKeyRefused, StripeTestRail, type RefundRail } from "@/lib/payments/stripe-rail";
import { handleStripeWebhook } from "@/lib/payments/webhook";
import type { ReturnCase } from "@/lib/domain/case";
import { FakeStripe } from "./helpers/fake-stripe";

const SECRET = "x".repeat(48);
const WH_SECRET = `whsec_${"w".repeat(32)}`;
const FULL = 34000;

let store: MemoryCaseStore;
let fake: FakeStripe;
let rail: StripeTestRail;

const pdeps = (): PipelineDeps => ({ store, segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
const inspect = (i: 0 | 1 = 1) => runInspection({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" } }, pdeps());
const sdeps = (over: Partial<{ store: CaseStore; rail: RefundRail | Error; now: () => Date }> = {}) => ({ store, secret: SECRET, rail, ...over });
async function approved(amountCents = FULL) {
  const c = await inspect(1);
  const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita Calder", amountCents, note: "" });
  return { id: c.id, token };
}

beforeEach(() => {
  store = new MemoryCaseStore(null);
  fake = new FakeStripe();
  rail = new StripeTestRail("sk_test_fake_for_unit_tests", { httpClient: fake.httpClient, maxNetworkRetries: 0, eventPollTries: 1, eventPollDelayMs: 0 });
});

describe("refund intent: reserved in the store before Stripe, one idempotency key per intent", () => {
  it("happy path: one intent, one create carrying the intent's key and id, Refunded via Stripe's response", async () => {
    const { id, token } = await approved();
    const done = await refundCase(sdeps(), id, token);
    expect(done.state).toBe("Refunded");
    const intent = latestIntent(done)!;
    expect(intent).toMatchObject({ outcome: "succeeded", confirmedBy: "api_response", amountCents: FULL });
    expect(intent.idempotencyKey).toBe(`rw-refund-${intent.id}`);
    const creates = fake.createCalls();
    expect(creates).toHaveLength(1);
    expect(creates[0].idempotencyKey).toBe(intent.idempotencyKey);
    expect(creates[0].params["metadata[rw_intent_id]"]).toBe(intent.id);
    expect(fake.liveRefunds()).toHaveLength(1);
    expect(done.refund).toMatchObject({ refundId: intent.refundId, amountCents: FULL, intentId: intent.id, confirmedBy: "api_response", livemode: false });
    expect(done.refund!.fee!.amountCents).toBe(200);
    // The charge.refunded payload was fetched from the Events API: it is labelled as such, not as a webhook delivery.
    expect(done.refund!.event!.source).toBe("events_api");
    expect(done.refund!.webhook).toBeUndefined();
    // The intent was written BEFORE the Stripe call: its reservation is in the audit trail ahead of REFUNDED.
    const events = done.audit.map((a) => a.event);
    expect(events.indexOf("REFUND_INTENT")).toBeGreaterThan(-1);
    expect(events.indexOf("REFUND_INTENT")).toBeLessThan(events.indexOf("REFUNDED"));
  });

  it("the store is checked before Stripe: the intent is pending in the store at the moment the create goes out", async () => {
    const { id, token } = await approved();
    let seenInStore: string | undefined;
    const spy: RefundRail = Object.assign(Object.create(rail), {
      refund: async (ref: Parameters<RefundRail["refund"]>[0]) => {
        seenInStore = latestIntent((await store.get(id))!)?.outcome;
        return rail.refund(ref);
      },
    });
    await refundCase(sdeps({ rail: spy }), id, token);
    expect(seenInStore).toBe("pending");
  });

  it("store CAS failure while reserving: Stripe is never called (intent_not_reserved)", async () => {
    const { id, token } = await approved();
    const racy: CaseStore = Object.assign(Object.create(store), {
      put: async (c: ReturnCase, v: number) => {
        if (c.refundIntents?.length) throw new VersionConflict(c.id, v, v + 1);
        return store.put(c, v);
      },
    });
    await expect(refundCase(sdeps({ store: racy }), id, token)).rejects.toMatchObject({ code: "intent_not_reserved" });
    expect(fake.createCalls()).toHaveLength(0);
    expect(fake.liveRefunds()).toHaveLength(0);
  });

  it("store down while reserving: Stripe is never called (store_unavailable)", async () => {
    const { id, token } = await approved();
    const down: CaseStore = Object.assign(Object.create(store), {
      put: async (c: ReturnCase, v: number) => {
        if (c.refundIntents?.length) throw new Error("ECONNREFUSED upstash");
        return store.put(c, v);
      },
    });
    await expect(refundCase(sdeps({ store: down }), id, token)).rejects.toMatchObject({ code: "store_unavailable" });
    expect(fake.createCalls()).toHaveLength(0);
  });

  it("a person's hold that lands while the intent is being reserved aborts it: no Stripe call", async () => {
    const { id, token } = await approved();
    let first = true;
    const racy: CaseStore = Object.assign(Object.create(store), {
      put: async (c: ReturnCase, v: number) => {
        if (c.refundIntents?.length && first) {
          first = false;
          await holdCase({ store }, id, "Rita Calder", "box looked re-taped");
          throw new VersionConflict(c.id, v, v + 1);
        }
        return store.put(c, v);
      },
    });
    await expect(refundCase(sdeps({ store: racy }), id, token)).rejects.toMatchObject({ code: "intent_not_reserved" });
    expect(fake.createCalls()).toHaveLength(0);
    expect((await store.get(id))!.state).toBe("Held");
  });

  it("double-click: two concurrent refunds with one token → exactly one refund; the other is refused and recorded", async () => {
    const { id, token } = await approved();
    const results = await Promise.allSettled([refundCase(sdeps(), id, token), refundCase(sdeps(), id, token)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(["token_used", "refund_in_progress", "bad_state"]).toContain((refused[0].reason as ServiceError).code);
    expect(fake.createCalls()).toHaveLength(1);
    expect(fake.liveRefunds()).toHaveLength(1);
    const after = (await store.get(id))!;
    expect(after.state).toBe("Refunded");
    // The losing click's refusal is on the record (it stays visible after a reload), not swallowed by the race.
    expect(after.tokenRejections).toHaveLength(1);
    expect(after.tokenRejections![0].code).toBe((refused[0].reason as ServiceError).code);
  });

  it("many concurrent clicks with one token still make exactly one refund", async () => {
    const { id, token } = await approved();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => refundCase(sdeps(), id, token)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fake.createCalls()).toHaveLength(1);
    expect(fake.liveRefunds()).toHaveLength(1);
    expect((await store.get(id))!.state).toBe("Refunded");
  });

  it("replay after success, cross-case, expiry, a forged amount and changed evidence never reach Stripe (existing codes)", async () => {
    const a = await approved();
    await refundCase(sdeps(), a.id, a.token);
    await expect(refundCase(sdeps(), a.id, a.token)).rejects.toMatchObject({ code: "bad_state" });
    // The refused replay stays visible on the case record.
    expect((await store.get(a.id))!.tokenRejections!.at(-1)).toMatchObject({ code: "bad_state" });

    const b = await approved();
    await expect(refundCase(sdeps(), a.id, b.token)).rejects.toMatchObject({ code: "token_wrong_case" });

    const t0 = new Date("2026-11-01T10:00:00Z");
    const c = await inspect(1);
    const { token: old } = await approveCase({ ...sdeps(), now: () => t0 }, c.id, RMAS[1], { approver: "Rita Calder", amountCents: FULL, note: "" });
    await expect(refundCase(sdeps({ now: () => new Date(t0.getTime() + 11 * 60_000) }), c.id, old)).rejects.toMatchObject({ code: "token_expired" });

    const [body, sig] = b.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), amountCents: 99999 })).toString("base64url");
    await expect(refundCase(sdeps(), b.id, `${forged}.${sig}`)).rejects.toMatchObject({ code: "token_bad_signature" });

    const cur = (await store.get(b.id))!;
    await store.put({ ...cur, count: { ...cur.count!, counts: { ...cur.count!.counts, lens: 2 } } }, cur.version);
    await expect(refundCase(sdeps(), b.id, b.token)).rejects.toMatchObject({ code: "digest_mismatch" });

    expect(fake.createCalls()).toHaveLength(1);
    expect(fake.liveRefunds()).toHaveLength(1);
  });

  it("a refund can't exceed the charge's remaining balance: refused before any create, case held", async () => {
    const { id, token } = await approved();
    // Another refund takes most of the charge between seeding and the create.
    const racing: RefundRail = Object.assign(Object.create(rail), {
      ensureCharge: async (o: Parameters<RefundRail["ensureCharge"]>[0]) => {
        const s = await rail.ensureCharge(o);
        fake.foreignRefund(s.chargeId, 20000);
        return s;
      },
    });
    await expect(refundCase(sdeps({ rail: racing }), id, token)).rejects.toMatchObject({ code: "rail_error" });
    const after = (await store.get(id))!;
    expect(latestIntent(after)).toMatchObject({ outcome: "failed", failure: { code: "over_balance" } });
    expect(after.state).toBe("Held");
    expect(fake.createCalls().filter((r) => r.params["metadata[rw_intent_id]"])).toHaveLength(0);
  });
});

describe("ambiguous outcomes: unknown blocks new approvals until recovery settles the SAME intent", () => {
  it("timeout after Stripe accepted → unknown → approvals/holds/token blocked → recovery retrieves → exactly one refund", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["timeout_after_accept"];
    const after = await refundCase(sdeps(), id, token);
    expect(after.state).toBe("Approved");
    const intent = activeIntent(after)!;
    expect(intent.outcome).toBe("unknown");
    expect(intent.attempts.at(-1)).toMatchObject({ by: "person", action: "create", outcome: "unknown", errorCode: "connection_lost" });
    expect(fake.liveRefunds()).toHaveLength(1); // Stripe did take it

    await expect(approveCase(sdeps(), id, RMAS[1], { approver: "Rita Calder", amountCents: FULL, note: "" })).rejects.toMatchObject({ code: "refund_in_progress" });
    await expect(holdCase({ store }, id, "Rita Calder", "void")).rejects.toMatchObject({ code: "refund_in_progress" });
    await expect(refundCase(sdeps(), id, token)).rejects.toMatchObject({ code: "refund_in_progress" });

    const recovered = await recoverRefund(sdeps(), id);
    expect(recovered.state).toBe("Refunded");
    expect(latestIntent(recovered)).toMatchObject({ outcome: "succeeded", confirmedBy: "api_retrieve" });
    expect(latestIntent(recovered)!.attempts.map((a) => `${a.by}:${a.action}:${a.outcome}`)).toEqual(["person:create:unknown", "recovery:lookup:succeeded"]);
    expect(fake.createCalls()).toHaveLength(1); // found by retrieve: nothing re-sent
    expect(fake.liveRefunds()).toHaveLength(1);
    await expect(recoverRefund(sdeps(), id)).rejects.toMatchObject({ code: "no_refund_in_progress" });
  });

  it("request dropped before Stripe saw it → unknown → recovery re-sends the SAME key → exactly one refund", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["drop_before_accept"];
    const after = await refundCase(sdeps(), id, token);
    expect(activeIntent(after)!.outcome).toBe("unknown");
    expect(fake.liveRefunds()).toHaveLength(0);
    const recovered = await recoverRefund(sdeps(), id);
    expect(recovered.state).toBe("Refunded");
    expect(latestIntent(recovered)!.confirmedBy).toBe("api_response");
    const keys = fake.createCalls().map((r) => r.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(fake.liveRefunds()).toHaveLength(1);
  });

  it("a 500 after Stripe executed is UNKNOWN (never 'nothing happened'); recovery finds the refund; one refund", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["500_after_accept"];
    const after = await refundCase(sdeps(), id, token);
    expect(activeIntent(after)).toMatchObject({ outcome: "unknown" });
    expect(activeIntent(after)!.attempts[0].errorCode).toMatch(/^stripe_5/);
    const recovered = await recoverRefund(sdeps(), id);
    expect(recovered.state).toBe("Refunded");
    expect(fake.liveRefunds()).toHaveLength(1);
  });

  it("a cached 500 (Stripe replays it for the key) keeps the outcome unknown and approvals blocked; no refund is invented", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["500_before_accept"];
    await refundCase(sdeps(), id, token);
    const again = await recoverRefund(sdeps(), id);
    expect(again.state).toBe("Approved");
    expect(activeIntent(again)!.outcome).toBe("unknown");
    expect(activeIntent(again)!.attempts.map((a) => a.outcome)).toEqual(["unknown", "unknown"]);
    expect(new Set(fake.createCalls().map((r) => r.idempotencyKey)).size).toBe(1);
    expect(fake.liveRefunds()).toHaveLength(0);
    await expect(approveCase(sdeps(), id, RMAS[1], { approver: "Rita Calder", amountCents: FULL, note: "" })).rejects.toMatchObject({ code: "refund_in_progress" });
  });

  it("recovery whose lookup can't reach Stripe stays unknown and does NOT re-send blind", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["drop_before_accept"];
    await refundCase(sdeps(), id, token);
    fake.listDrops = 1;
    const r = await recoverRefund(sdeps(), id);
    expect(activeIntent(r)!.attempts.at(-1)).toMatchObject({ action: "lookup", outcome: "unknown" });
    expect(activeIntent(r)!.attempts.at(-1)!.errorCode).toMatch(/^lookup_/);
    expect(fake.createCalls()).toHaveLength(1);
  });

  it("confirmed failure (Stripe 400) → failed → Held; a NEW approval gets a NEW intent and key; one refund total", async () => {
    const { id, token } = await approved();
    fake.refundFaults = [{ decline: "charge_disputed" }];
    await expect(refundCase(sdeps(), id, token)).rejects.toMatchObject({ code: "rail_error" });
    const held = (await store.get(id))!;
    expect(held.state).toBe("Held");
    expect(latestIntent(held)).toMatchObject({ outcome: "failed", confirmedBy: "api_response", failure: { code: "charge_disputed" } });
    expect(activeIntent(held)).toBeUndefined();
    const { token: t2 } = await approveCase(sdeps(), id, RMAS[1], { approver: "Rita Calder", amountCents: FULL, note: "re-approved after the decline" });
    const done = await refundCase(sdeps(), id, t2);
    expect(done.state).toBe("Refunded");
    expect(done.refundIntents).toHaveLength(2);
    expect(done.refundIntents![0].idempotencyKey).not.toBe(done.refundIntents![1].idempotencyKey);
    expect(fake.liveRefunds()).toHaveLength(1);
  });

  it("confirmed failure vs cached 500 vs store CAS failure are three different records", async () => {
    const decline = await approved();
    fake.refundFaults = [{ decline: "charge_disputed" }];
    const e1 = await refundCase(sdeps(), decline.id, decline.token).catch((e: ServiceError) => e);
    const cached = await approved();
    fake.refundFaults = ["500_before_accept"];
    const r2 = await refundCase(sdeps(), cached.id, cached.token);
    const cas = await approved();
    const racy: CaseStore = Object.assign(Object.create(store), {
      put: async (c: ReturnCase, v: number) => {
        if (c.refundIntents?.length) throw new VersionConflict(c.id, v, v + 1);
        return store.put(c, v);
      },
    });
    const e3 = await refundCase(sdeps({ store: racy }), cas.id, cas.token).catch((e: ServiceError) => e);

    const s1 = (await store.get(decline.id))!;
    const s3 = (await store.get(cas.id))!;
    expect([(e1 as ServiceError).code, s1.state, latestIntent(s1)!.outcome]).toEqual(["rail_error", "Held", "failed"]);
    expect([r2.state, latestIntent(r2)!.outcome]).toEqual(["Approved", "unknown"]);
    expect([(e3 as ServiceError).code, s3.state, s3.refundIntents ?? []]).toEqual(["intent_not_reserved", "Approved", []]);
  });

  it("Stripe leaves the refund pending → pending (blocked); once Stripe settles it, recovery retrieves → Refunded", async () => {
    const { id, token } = await approved();
    fake.refundFaults = ["pending"];
    const after = await refundCase(sdeps(), id, token);
    expect(activeIntent(after)!.outcome).toBe("pending");
    await expect(approveCase(sdeps(), id, RMAS[1], { approver: "Rita Calder", amountCents: FULL, note: "" })).rejects.toMatchObject({ code: "refund_in_progress" });
    expect((await recoverRefund(sdeps(), id)).state).toBe("Approved"); // still pending at Stripe
    fake.setRefundStatus(activeIntent(after)!.refundId!, "succeeded");
    const done = await recoverRefund(sdeps(), id);
    expect(done.state).toBe("Refunded");
    expect(fake.liveRefunds()).toHaveLength(1);
    expect(fake.createCalls()).toHaveLength(1);
  });

  it("a settled intent never changes outcome; a contradicting answer is recorded for a person, not applied", async () => {
    const { id, token } = await approved();
    const done = await refundCase(sdeps(), id, token);
    const intent = latestIntent(done)!;
    const contradicted = withOutcome(done, intent.id, { outcome: "failed", via: "lookup", code: "refund_failed", message: "late failure" }, "recovery", new Date());
    expect(contradicted.state).toBe("Refunded");
    expect(latestIntent(contradicted)!.outcome).toBe("succeeded");
    expect(latestIntent(contradicted)!.attempts.at(-1)!.detail).toMatch(/a person must review/);
    const repeat = withOutcome(done, intent.id, { outcome: "unknown", via: "create", code: "connection_lost", message: "x" }, "recovery", new Date());
    expect(repeat).toBe(done);
  });
});

describe("Stripe webhook: raw-body signature, persistent dedup, reconcile by retrieve", () => {
  const event = (type: string, object: unknown, id = `evt_${Math.random().toString(36).slice(2, 10)}`, livemode = false) => ({ id, object: "event", type, livemode, created: 1, api_version: "2026-01-01", data: { object } });
  const sign = (payload: string, secret = WH_SECRET) => Stripe.webhooks.generateTestHeaderString({ payload, secret });
  const deliver = (ev: unknown, opts: { secret?: string | undefined; rail?: RefundRail | Error; header?: string | null; body?: string } = {}) => {
    const body = opts.body ?? JSON.stringify(ev);
    const header = opts.header === undefined ? sign(JSON.stringify(ev)) : opts.header;
    return handleStripeWebhook({ store, rail: opts.rail ?? rail, secret: "secret" in opts ? opts.secret : WH_SECRET }, body, header);
  };
  async function unknownIntent(fault: "timeout_after_accept" | "pending" | "drop_before_accept" = "timeout_after_accept") {
    const { id, token } = await approved();
    fake.refundFaults = [fault];
    await refundCase(sdeps(), id, token);
    const c = (await store.get(id))!;
    const refund = fake.refunds.find((r) => r.metadata.rw_intent_id === activeIntent(c)!.id)!;
    return { id, refund, intent: activeIntent(c)! };
  }

  it("refuses: not configured, missing signature, wrong secret, mutated body, live-mode; nothing is written", async () => {
    const { id, refund } = await unknownIntent();
    const before = (await store.get(id))!.version;
    const ev = event("refund.updated", { ...refund });
    expect((await deliver(ev, { secret: undefined })).status).toBe(503);
    expect(await deliver(ev, { header: null })).toMatchObject({ status: 400, body: { error: "missing_signature" } });
    expect(await deliver(ev, { header: sign(JSON.stringify(ev), `whsec_${"z".repeat(32)}`) })).toMatchObject({ status: 400, body: { error: "bad_signature" } });
    const mutated = JSON.stringify({ ...ev, data: { object: { ...refund, metadata: { ...refund.metadata, rw_case_id: "case_someone_else" } } } });
    expect(await deliver(ev, { body: mutated })).toMatchObject({ status: 400, body: { error: "bad_signature" } });
    const live = event("refund.updated", { ...refund }, undefined, true);
    expect(await deliver(live)).toMatchObject({ status: 400, body: { error: "live_mode_event_refused" } });
    expect((await store.get(id))!.version).toBe(before);
  });

  it("a verified event settles an unknown intent from Stripe's RETRIEVED state, not the payload; marked webhook_verified", async () => {
    const { id, refund, intent } = await unknownIntent();
    // The payload claims "failed"; Stripe (retrieve) says succeeded. The retrieve wins.
    const ev = event("refund.updated", { ...refund, status: "failed" });
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    const c = (await store.get(id))!;
    expect(c.state).toBe("Refunded");
    expect(latestIntent(c)).toMatchObject({ id: intent.id, outcome: "succeeded", confirmedBy: "webhook_verified", webhook: { eventId: ev.id, type: "refund.updated" } });
    expect(c.refund!.webhook!.eventId).toBe(ev.id);
    // The Events API payload the rail fetched is still labelled as fetched, distinct from the delivery.
    expect(c.refund!.event?.source).toBe("events_api");
    expect(fake.liveRefunds()).toHaveLength(1);
    expect(fake.createCalls()).toHaveLength(1); // a webhook never re-sends a create
  });

  it("a duplicate delivery (same event id) is acknowledged and ignored, even across a store restart", async () => {
    const { id, refund } = await unknownIntent();
    const ev = event("refund.updated", { ...refund });
    await deliver(ev);
    const attempts = latestIntent((await store.get(id))!)!.attempts.length;
    expect(await deliver(ev)).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(latestIntent((await store.get(id))!)!.attempts).toHaveLength(attempts);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-wh-")), "store.json");
    const s1 = new MemoryCaseStore(file);
    expect(await s1.claimWebhookEvent("evt_restart")).toBe(true);
    const s2 = new MemoryCaseStore(file);
    expect(await s2.claimWebhookEvent("evt_restart")).toBe(false);
    expect(await s2.claimWebhookEvent("")).toBe(false);
  });

  it("events for a foreign charge or case can't mark an unrelated case refunded", async () => {
    const { id, intent } = await unknownIntent("drop_before_accept");
    // A refund on ANOTHER charge whose metadata copies our case and intent ids (e.g. another environment).
    const other = fake.seedCharge(FULL);
    const spoof = fake.foreignRefund(other.chargeId, FULL, { rw_case_id: id, rw_intent_id: intent.id });
    const r1 = await deliver(event("refund.created", spoof));
    expect((r1.body.results as Array<{ ignored?: string }>)[0].ignored).toMatch(/doesn't match/);
    // A charge.refunded for an unrelated charge: its refunds carry none of our intents.
    const unrelated = fake.seedCharge(5000);
    fake.foreignRefund(unrelated.chargeId, 5000);
    const r2 = await deliver(event("charge.refunded", { id: unrelated.chargeId, object: "charge" }));
    expect((r2.body.results as Array<{ ignored?: string }>)[0].ignored).toMatch(/not a ReturnWitness/);
    const c = (await store.get(id))!;
    expect(c.state).toBe("Approved");
    expect(activeIntent(c)!.outcome).toBe("unknown");
  });

  it("out of order: an early 'succeeded' payload while Stripe says pending changes nothing; a later stale event reconciles to the retrieved truth; nothing regresses", async () => {
    const { id, refund } = await unknownIntent("pending");
    const early = event("refund.updated", { ...refund, status: "succeeded" });
    await deliver(early);
    expect(activeIntent((await store.get(id))!)!.outcome).toBe("pending");

    fake.setRefundStatus(refund.id, "succeeded");
    const staleCreated = event("refund.created", { ...refund, status: "pending" });
    await deliver(staleCreated);
    const settled = (await store.get(id))!;
    expect(settled.state).toBe("Refunded");
    expect(latestIntent(settled)!.confirmedBy).toBe("webhook_verified");

    const lateStale = event("refund.updated", { ...refund, status: "pending" });
    await deliver(lateStale);
    const after = (await store.get(id))!;
    expect(after.state).toBe("Refunded");
    expect(latestIntent(after)!.outcome).toBe("succeeded");
    expect(latestIntent(after)!.webhook!.eventId).toBe(lateStale.id);
    expect(fake.liveRefunds()).toHaveLength(1);
  });

  it("a processing failure releases the event claim so Stripe's redelivery is processed", async () => {
    const { id, refund } = await unknownIntent();
    let fail = true;
    const flaky: RefundRail = Object.assign(Object.create(rail), {
      retrieveRefund: async (rid: string) => {
        if (fail) {
          fail = false;
          throw new Error("ETIMEDOUT");
        }
        return rail.retrieveRefund(rid);
      },
    });
    const ev = event("refund.updated", { ...refund });
    expect((await deliver(ev, { rail: flaky })).status).toBe(500);
    expect((await deliver(ev, { rail: flaky })).status).toBe(200);
    expect((await store.get(id))!.state).toBe("Refunded");
    expect((await deliver(ev, { rail: new StripeKeyRefused("no key") })).body).toMatchObject({ duplicate: true });
  });
});

describe("rail classification and guards", () => {
  it("only an explicit 4xx rejection is a confirmed failure", () => {
    const err = (type: string, statusCode?: number, code?: string) => Object.assign(new Error(type), { type, statusCode, code });
    expect(classifyStripeError(err("StripeConnectionError")).outcome).toBe("unknown");
    expect(classifyStripeError(err("StripeAPIError", 500)).outcome).toBe("unknown");
    expect(classifyStripeError(err("StripeRateLimitError", 429)).outcome).toBe("unknown");
    expect(classifyStripeError(err("StripeIdempotencyError", 400)).outcome).toBe("unknown");
    expect(classifyStripeError(err("StripeInvalidRequestError", 409, "lock_timeout")).outcome).toBe("unknown");
    expect(classifyStripeError(new Error("socket hang up")).outcome).toBe("unknown");
    expect(classifyStripeError(err("StripeInvalidRequestError", 400, "amount_too_large"))).toMatchObject({ outcome: "failed", code: "amount_too_large" });
    expect(classifyStripeError(err("StripeCardError", 402, "card_declined")).outcome).toBe("failed");
    expect(classifyStripeError(err("StripeAuthenticationError", 401)).outcome).toBe("failed");
    expect(outcomeOfStatus("succeeded")).toBe("succeeded");
    expect(outcomeOfStatus("requires_action")).toBe("pending");
    expect(outcomeOfStatus("canceled")).toBe("failed");
    expect(outcomeOfStatus(null)).toBe("pending");
  });

  it("non-test keys stay refused; a live-mode charge is refused before any create", async () => {
    expect(() => new StripeTestRail("sk_live_abc", { httpClient: fake.httpClient })).toThrow(StripeKeyRefused);
    expect(() => new StripeTestRail("rk_test_abc", { httpClient: fake.httpClient })).toThrow(StripeKeyRefused);
    const live = fake.seedCharge(FULL, { livemode: true });
    const r = await rail.refund({ intentId: "ri_x", caseId: "case_x", rmaId: "RMA-1", chargeId: live.chargeId, paymentIntentId: live.paymentIntentId, amountCents: 100, approver: "Rita", idempotencyKey: "rw-refund-ri_x" });
    expect(r).toMatchObject({ outcome: "failed", code: "live_charge_refused" });
    const over = fake.seedCharge(1000);
    const r2 = await rail.refund({ intentId: "ri_y", caseId: "case_y", rmaId: "RMA-1", chargeId: over.chargeId, paymentIntentId: over.paymentIntentId, amountCents: 1001, approver: "Rita", idempotencyKey: "rw-refund-ri_y" });
    expect(r2).toMatchObject({ outcome: "failed", code: "over_balance" });
    expect(fake.createCalls()).toHaveLength(0);
  });

  it("no model or agent path can reach approve, refund or recovery", () => {
    const root = path.resolve(__dirname, "..");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [path.join(dir, d.name)] : []));
    const files = [...walk(path.join(root, "lib")), ...walk(path.join(root, "app")), ...walk(path.join(root, "components"))];
    const money = /\b(approveCase|refundCase|recoverRefund)\b/;
    const callers = files.filter((f) => money.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f)).sort();
    expect(callers).toEqual(["app/api/cases/[id]/approve/route.ts", "app/api/cases/[id]/refund/recover/route.ts", "app/api/cases/[id]/refund/route.ts", "lib/engine/service.ts"]);
    // Agent, model and reader code never imports the payment rail or the intent module (ServiceError, the error class, is fine).
    const agentDirs = ["lib/fleet", "lib/meta", "lib/openweights", "lib/learning", "lib/play", "lib/vision"].map((d) => path.join(root, d));
    const leaks = files.filter((f) => agentDirs.some((d) => f.startsWith(d)) && /from "@\/lib\/(payments\/|engine\/refund-intent)/.test(fs.readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  });
});
