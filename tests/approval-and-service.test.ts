import { beforeEach, describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { issueToken, verifyToken } from "@/lib/engine/approval";
import { canTransition, failClosed, IllegalTransition, transition } from "@/lib/engine/case-machine";
import { runInspection, type PipelineDeps } from "@/lib/engine/pipeline";
import { approveCase, holdCase, refundCase, ServiceError } from "@/lib/engine/service";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { canonicalJson, digestOf } from "@/lib/engine/digest";
import type { IntentRef, RailOutcome, RefundRail } from "@/lib/payments/stripe-rail";
import { assertTestKey, StripeKeyRefused } from "@/lib/payments/stripe-rail";
import type { ReturnCase } from "@/lib/domain/case";
import { judgeProposal } from "@/lib/engine/agent-guard";
import { activeIntent } from "@/lib/engine/refund-intent";

const SECRET = "x".repeat(48);

/** A scripted rail for the token-gate tests (tests/refund-intent.test.ts runs the real rail on a fake Stripe). */
class FakeRail implements RefundRail {
  readonly mode = "stripe_test" as const;
  calls: Array<{ caseId: string; amountCents: number }> = [];
  fail: Error | null = null;
  outcome: RailOutcome | null = null;
  async ensureCharge(o: { id: string; totalCents: number }) {
    return { orderId: o.id, paymentIntentId: "pi_test", chargeId: "ch_test", amountCents: o.totalCents, receiptUrl: null, created: 0 };
  }
  async refund(a: IntentRef): Promise<RailOutcome> {
    if (this.fail) throw this.fail;
    if (this.outcome) return this.outcome;
    this.calls.push({ caseId: a.caseId, amountCents: a.amountCents });
    return {
      outcome: "succeeded",
      via: "create",
      refund: { refundId: `re_test_${this.calls.length}`, status: "succeeded", amountCents: a.amountCents, chargeId: "ch_test", paymentIntentId: "pi_test", receiptUrl: "https://pay.stripe.com/receipts/x" },
      fee: { paymentIntentId: "pi_fee", chargeId: "ch_fee", amountCents: 200, receiptUrl: null },
      event: { id: "evt_1", type: "charge.refunded", created: 1, payload: {}, source: "events_api" },
    };
  }
  async recover(): Promise<RailOutcome> {
    return { outcome: "unknown", via: "lookup", code: "not_scripted", message: "FakeRail doesn't recover" };
  }
  async retrieveRefund() {
    return null;
  }
  async refundsForCharge() {
    return [];
  }
}

let store: MemoryCaseStore;
let rail: FakeRail;
const deps = (): PipelineDeps => ({ store, segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
const inspect = (i: 0 | 1) => runInspection({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" } }, deps());

beforeEach(() => {
  store = new MemoryCaseStore(null);
  rail = new FakeRail();
});

describe("approval token", () => {
  const base = { caseId: "case_1", rmaId: "RMA-1", digest: "d", amountCents: 100, approver: "Rita" };

  it("round-trips", () => {
    const { token } = issueToken(base, SECRET, 1000);
    const v = verifyToken(token, SECRET, "case_1", 2000);
    expect(v.ok && v.payload.amountCents).toBe(100);
  });
  it("rejects a tampered payload", () => {
    const { token } = issueToken(base, SECRET, 1000);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()), amountCents: 999999 })).toString("base64url");
    expect(verifyToken(`${forged}.${sig}`, SECRET, "case_1", 2000)).toEqual({ ok: false, error: "bad_signature" });
  });
  it("rejects the wrong secret, expiry, another case, garbage", () => {
    const { token } = issueToken(base, SECRET, 1000, 5000);
    expect(verifyToken(token, "y".repeat(48), "case_1", 2000)).toEqual({ ok: false, error: "bad_signature" });
    expect(verifyToken(token, SECRET, "case_1", 6000)).toEqual({ ok: false, error: "expired" });
    expect(verifyToken(token, SECRET, "case_2", 2000)).toEqual({ ok: false, error: "wrong_case" });
    expect(verifyToken("nope", SECRET, "case_1", 2000)).toEqual({ ok: false, error: "malformed" });
    expect(verifyToken("", SECRET, "case_1", 2000)).toEqual({ ok: false, error: "malformed" });
  });
  it("refuses fractional or negative amounts", () => {
    expect(() => issueToken({ ...base, amountCents: 10.5 }, SECRET)).toThrow();
    expect(() => issueToken({ ...base, amountCents: -1 }, SECRET)).toThrow();
  });
});

describe("digest", () => {
  it("is key-order independent and value sensitive", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });
});

describe("state machine", () => {
  it("only a person can approve", async () => {
    const c = await inspect(1);
    expect(c.state).toBe("AwaitingApproval");
    expect(() => transition(c, { type: "APPROVE", approver: "x", detail: "" }, "system")).toThrow(IllegalTransition);
    expect(() => transition(c, { type: "APPROVE", approver: "x", detail: "" }, "model:muse-wonder-1.0")).toThrow(IllegalTransition);
  });
  it("Refunded is terminal; Received can't jump to Approved", () => {
    expect(canTransition("Refunded", "HOLD")).toBe(false);
    expect(canTransition("Refunded", "ERROR")).toBe(false);
    expect(canTransition("Received", "APPROVE")).toBe(false);
    expect(canTransition("Reconciled", "REFUNDED")).toBe(false);
  });
  it("failClosed turns any thrown error into HELD with the reason", async () => {
    const c = await inspect(1);
    const out = await failClosed(c, "draft", async () => {
      throw new Error("boom");
    });
    expect(out.state).toBe("Held");
    expect(out.holdReasons).toContain("draft_error");
    expect(out.audit.at(-1)!.detail).toMatch(/boom/);
  });
});

describe("pipeline on the two seeded scenes (fixture mode)", () => {
  it("RMA-20418: lens missing → Held, $340 held, template draft cites 4.2", async () => {
    const c = await inspect(0);
    expect(c.state).toBe("Held");
    expect(c.count!.counts).toEqual({ camera_body: 1, lens: 0, battery: 1 });
    expect(c.reconciliation!.summary.heldCents).toBe(34000);
    expect(c.reconciliation!.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(c.draft!.source).toBe("template");
    expect(c.draft!.draft.citedClauses[0].clauseId).toBe("4.2");
    expect(c.clip.mode).toBe("RECORDED_FIXTURE");
    expect(c.timings.map((t) => t.stage)).toEqual(["segment", "count", "reconcile", "draft"]);
    // The segmenter re-issued the camera's ID; the counter still counted it once.
    expect(c.count!.diagnostics.rawTrackIdsPerItem.camera_body).toBe(2);
    expect(c.audit.map((a) => a.to)).toEqual(["Received", "Counted", "Reconciled", "Held"]);
  });

  it("RMA-20419: complete (lens picked up and put back) → AwaitingApproval, counted once", async () => {
    const c = await inspect(1);
    expect(c.state).toBe("AwaitingApproval");
    expect(c.count!.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(c.count!.flags.map((f) => f.code)).toContain("reentry_rebound");
    expect(c.draft!.draft.recommendation).toBe("APPROVE_FULL");
  });

  it("RMA-20420 (d3): camera covered and re-boxed, SAM gives it 3 IDs, counted once → AwaitingApproval", async () => {
    const c = await runInspection({ rma: RMAS[2], slip: ORDERS[2].slip, policy: POLICY, clip: { clipId: RMAS[2].clipId, source: "fixture" } }, deps());
    expect(c.count!.diagnostics.rawTrackIdsPerItem.camera_body).toBe(3);
    expect(c.count!.counts.camera_body).toBe(1);
    expect(c.state).toBe("AwaitingApproval");
  });

  it("a required reader that returns nothing holds even a complete kit", async () => {
    const d = deps();
    d.readers = [{ name: "spark", required: true, read: async () => ({ output: null, mode: "LIVE_META", model: "muse-spark-1.3", latencyMs: 5, error: "timeout" }) }];
    const c = await runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, d);
    expect(c.state).toBe("Held");
    expect(c.reconciliation!.lines.every((l) => l.reasons.some((r) => r.code === "model_unavailable"))).toBe(true);
  });

  it("a model draft that misquotes the policy is rejected and the template is used", async () => {
    const d = deps();
    d.agent = async () => ({ model: "muse-wonder-1.0", mode: "LIVE_META", protocol: "tools", steps: [], effect: "none", draft: { recommendation: "APPROVE_FULL", proposedRefundCents: 34000, citedClauses: [{ clauseId: "4.2", quote: "refund everything" }], rationale: "fine" }, latencyMs: 3 });
    const c = await runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, d);
    expect(c.draft!.source).toBe("template");
    expect(c.draft!.rejected!.errors.join()).toMatch(/verbatim/);
  });

  it("an agent HOLD proposal accepted by the guard puts a clean case on hold (actor = the model)", async () => {
    const d = deps();
    d.agent = async (ctx) => {
      const verdict = judgeProposal({ state: ctx.state, digest: ctx.digest }, { to_state: "HELD", evidence_digest: ctx.digest, reason: "charger label looks re-taped" });
      return { model: "muse-wonder-1.0", mode: "LIVE_META", protocol: "tools", steps: [{ kind: "guard", args: { to_state: "HELD", evidence_digest: ctx.digest, reason: "charger label looks re-taped" }, verdict }], effect: verdict.effect, draft: null, latencyMs: 1 };
    };
    const c = await runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, d);
    expect(c.state).toBe("Held");
    expect(c.holdReasons).toContain("agent_hold");
    expect(c.audit.at(-1)!.actor).toBe("model:muse-wonder-1.0");
    expect(c.draft!.agent!.steps[0].verdict!.accepted).toBe(true);
  });

  it("an agent that proposes APPROVED changes nothing (and the case still needs a person)", async () => {
    const d = deps();
    d.agent = async (ctx) => {
      const verdict = judgeProposal({ state: ctx.state, digest: ctx.digest }, { to_state: "APPROVED", evidence_digest: ctx.digest, reason: "looks fine" });
      return { model: "muse-wonder-1.0", mode: "LIVE_META", protocol: "tools", steps: [{ kind: "guard", verdict }], effect: verdict.effect, draft: null, latencyMs: 1 };
    };
    const c = await runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, d);
    expect(c.state).toBe("AwaitingApproval");
    expect(c.draft!.agent!.steps[0].verdict!.accepted).toBe(false);
  });

  it("a segmenter that throws leaves the case HELD, never approved", async () => {
    const d = deps();
    d.segmenter = { name: "broken", mode: "LIVE_META", segment: async () => Promise.reject(new Error("503 from api.meta.ai")) };
    const c = await runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, d);
    expect(c.state).toBe("Held");
    expect(c.holdReasons).toContain("pipeline_error");
    expect((await store.get(c.id))!.state).toBe("Held");
  });

  it("emits stage events in order", async () => {
    const d = deps();
    const ev: string[] = [];
    d.onStage = (e) => ev.push(`${e.stage}:${e.status}`);
    await runInspection({ rma: RMAS[0], slip: ORDERS[0].slip, policy: POLICY, clip: { clipId: RMAS[0].clipId, source: "fixture" } }, d);
    expect(ev).toEqual(["segment:start", "segment:end", "count:start", "count:end", "reconcile:start", "reconcile:end", "draft:start", "draft:end", "done:end"]);
  });
});

describe("approve → refund (the only path to money)", () => {
  const sdeps = () => ({ store, secret: SECRET, rail });

  it("the refund endpoint refuses without a token", async () => {
    const c = await inspect(1);
    await expect(refundCase(sdeps(), c.id, "")).rejects.toMatchObject({ code: "token_malformed" });
    expect(rail.calls).toEqual([]);
  });

  it("complete kit: approve full → refund once → Refunded with the re_ id and fee", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    const done = await refundCase(sdeps(), c.id, token);
    expect(done.state).toBe("Refunded");
    expect(done.refund).toMatchObject({ refundId: "re_test_1", amountCents: 34000, livemode: false });
    expect(done.refund!.fee!.amountCents).toBe(200);
    expect(rail.calls).toEqual([{ caseId: c.id, amountCents: 34000 }]);
  });

  it("a token can be spent exactly once", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await refundCase(sdeps(), c.id, token);
    await expect(refundCase(sdeps(), c.id, token)).rejects.toBeInstanceOf(ServiceError);
    expect(rail.calls).toHaveLength(1);
  });

  it("an expired token refunds nothing", async () => {
    const c = await inspect(1);
    const t0 = new Date("2026-11-01T10:00:00Z");
    const { token } = await approveCase({ ...sdeps(), now: () => t0 }, c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await expect(refundCase({ ...sdeps(), now: () => new Date(t0.getTime() + 11 * 60_000) }, c.id, token)).rejects.toMatchObject({ code: "token_expired" });
    expect(rail.calls).toEqual([]);
  });

  it("a token for one case can't refund another", async () => {
    const a = await inspect(1);
    const b = await inspect(1);
    const { token } = await approveCase(sdeps(), a.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await expect(refundCase(sdeps(), b.id, token)).rejects.toMatchObject({ code: "token_wrong_case" });
  });

  it("if the observation changes after approval, the refund is refused and the case is HELD again", async () => {
    const c = await inspect(1);
    const { token, case: approved } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    const tampered: ReturnCase = { ...approved, count: { ...approved.count!, counts: { ...approved.count!.counts, lens: 2 } } };
    await store.put(tampered, approved.version);
    await expect(refundCase(sdeps(), c.id, token)).rejects.toMatchObject({ code: "digest_mismatch" });
    expect((await store.get(c.id))!.state).toBe("Held");
    expect(rail.calls).toEqual([]);
  });

  it("a held case can't be approved for the full amount without an override reason", async () => {
    const c = await inspect(0);
    await expect(approveCase(sdeps(), c.id, RMAS[0], { approver: "Rita", amountCents: 34000, note: "customer called" })).rejects.toMatchObject({ code: "override_reason_required" });
  });

  it("a held case needs a note; the policy 4.3 partial is allowed with one", async () => {
    const c = await inspect(0);
    await expect(approveCase(sdeps(), c.id, RMAS[0], { approver: "Rita", amountCents: 23100, note: "" })).rejects.toMatchObject({ code: "note_required" });
    const { token } = await approveCase(sdeps(), c.id, RMAS[0], { approver: "Rita", amountCents: 23100, note: "partial under 4.3, lens not returned" });
    const done = await refundCase(sdeps(), c.id, token);
    expect(done.refund!.amountCents).toBe(23100);
  });

  it("approving needs a name and a sane amount", async () => {
    const c = await inspect(1);
    await expect(approveCase(sdeps(), c.id, RMAS[1], { approver: " ", amountCents: 34000, note: "" })).rejects.toMatchObject({ code: "approver_required" });
    await expect(approveCase(sdeps(), c.id, RMAS[1], { approver: "M", amountCents: 0, note: "" })).rejects.toMatchObject({ code: "bad_amount" });
    await expect(approveCase(sdeps(), c.id, RMAS[1], { approver: "M", amountCents: 34001, note: "" })).rejects.toMatchObject({ code: "over_requested" });
  });

  it("a CONFIRMED rail failure refunds nothing and puts the case on HOLD: safe to request a new approval", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    rail.outcome = { outcome: "failed", via: "create", code: "charge_already_refunded", message: "Charge has already been refunded." };
    await expect(refundCase(sdeps(), c.id, token)).rejects.toMatchObject({ code: "rail_error" });
    const after = (await store.get(c.id))!;
    expect(after.state).toBe("Held");
    expect(after.holdReasons).toContain("refund_rail_error");
    expect(after.refundIntents!.at(-1)!.outcome).toBe("failed");
    // A new approval is allowed after a confirmed failure.
    await expect(approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "re-approved after Stripe declined" })).resolves.toBeTruthy();
  });

  it("a connection reset is NOT a failure: the outcome is unknown, the case stays Approved and new approvals/holds are blocked", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    rail.fail = new Error("stripe: connection reset");
    const after = await refundCase(sdeps(), c.id, token);
    expect(after.state).toBe("Approved");
    expect(activeIntent(after)!.outcome).toBe("unknown");
    await expect(holdCase({ store }, c.id, "Rita", "void it")).rejects.toMatchObject({ code: "refund_in_progress" });
    await expect(refundCase(sdeps(), c.id, token)).rejects.toMatchObject({ code: "refund_in_progress" });
  });

  it("no rail configured → HELD with the reason", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await expect(refundCase({ store, secret: SECRET, rail: new StripeKeyRefused("not a test key") }, c.id, token)).rejects.toMatchObject({ code: "rail_unavailable" });
    expect((await store.get(c.id))!.state).toBe("Held");
  });

  it("re-approval supersedes the earlier token", async () => {
    const c = await inspect(1);
    const first = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await holdCase({ store }, c.id, "Rita", "want to re-check the charger");
    await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "checked" });
    await expect(refundCase(sdeps(), c.id, first.token)).rejects.toMatchObject({ code: "token_superseded" });
  });

  it("a person can put an approved case back on hold, which voids the token", async () => {
    const c = await inspect(1);
    const { token } = await approveCase(sdeps(), c.id, RMAS[1], { approver: "Rita", amountCents: 34000, note: "" });
    await holdCase({ store }, c.id, "Rita", "box was damaged");
    await expect(refundCase(sdeps(), c.id, token)).rejects.toMatchObject({ code: "bad_state" });
  });
});

describe("stripe rail guard", () => {
  it("refuses anything that isn't a test key", () => {
    expect(() => assertTestKey(undefined)).toThrow(StripeKeyRefused);
    expect(() => assertTestKey("sk_live_abc")).toThrow(/test-mode/);
    expect(() => assertTestKey("rk_test_abc")).toThrow();
    expect(assertTestKey("sk_test_abc")).toBe("sk_test_abc");
  });
});

describe("store", () => {
  it("optimistic version check and single-use nonces", async () => {
    const c = await inspect(1);
    await expect(store.put(c, c.version - 1)).rejects.toThrow(/changed/);
    expect(await store.consumeNonce("n1")).toBe(true);
    expect(await store.consumeNonce("n1")).toBe(false);
    expect(await store.consumeNonce("")).toBe(false);
  });
});
