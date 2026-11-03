/**
 * The approval panel tells the truth about a refund intent (server render, no browser): an unknown
 * outcome says it's recovering and that new approvals are blocked, hides the approve/void actions,
 * a confirmed failure says it's safe to re-approve, and a refused token call stays listed.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection } from "@/lib/engine/pipeline";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { ApprovalPanel } from "@/components/dash/ApprovalPanel";
import type { RefundIntent, ReturnCase } from "@/lib/domain/case";

const base = async (): Promise<ReturnCase> =>
  runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, { store: new MemoryCaseStore(null), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });

const intent = (over: Partial<RefundIntent>): RefundIntent => ({
  id: "ri_abc123",
  caseId: "case_x",
  amountCents: 34000,
  approver: "Rita Calder",
  approvalNonce: "n",
  digest: "d",
  chargeId: "ch_1",
  paymentIntentId: "pi_1",
  idempotencyKey: "rw-refund-ri_abc123",
  createdAt: "2026-10-29T10:00:00.000Z",
  updatedAt: "2026-10-29T10:00:01.000Z",
  outcome: "unknown",
  attempts: [{ n: 1, at: "2026-10-29T10:00:01.000Z", by: "person", action: "create", outcome: "unknown", detail: "outcome unknown (connection_lost)", errorCode: "connection_lost" }],
  ...over,
});

const render = (c: ReturnCase) => renderToStaticMarkup(createElement(ApprovalPanel, { c, rma: RMAS[1], onCase: () => {} }));

describe("ApprovalPanel shows the refund intent's outcome", () => {
  it("unknown: 'outcome unknown, recovering, new approvals blocked', the attempt history, and no void/refund buttons", async () => {
    const c = await base();
    const html = render({ ...c, state: "Approved", approval: { approver: "Rita Calder", amountCents: 34000, note: "", override: false, digest: "d", nonce: "n", issuedAt: c.createdAt, expiresAt: c.createdAt }, refundIntents: [intent({})] });
    expect(html).toContain("OUTCOME UNKNOWN · RECOVERING");
    expect(html).toContain("New approvals and holds are blocked until the outcome is known.");
    expect(html).toContain("Check Stripe again");
    expect(html).toContain("rw-refund-ri_abc123");
    expect(html).toContain("connection_lost");
    expect(html).not.toContain("Void approval");
    expect(html).not.toContain("Run refund");
  });

  it("confirmed failure: held, 'safe to request a new approval', and the approve form is back", async () => {
    const c = await base();
    const failed = intent({ outcome: "failed", confirmedBy: "api_response", failure: { code: "charge_disputed", message: "declined: charge_disputed" } });
    const html = render({ ...c, state: "Held", refundIntents: [failed] });
    expect(html).toContain("STRIPE CONFIRMED NO REFUND");
    expect(html).toContain("Safe to request a new approval.");
    expect(html).toMatch(/>Approve \$/);
    expect(html).toContain("failed · nothing refunded");
  });

  it("refunded: the settled intent, how it was confirmed (webhook vs API), and a refused second token call stay visible", async () => {
    const c = await base();
    const ok = intent({ outcome: "succeeded", refundId: "re_1", confirmedBy: "webhook_verified", webhook: { eventId: "evt_9", type: "refund.updated", verifiedAt: "2026-10-29T10:01:00.000Z" } });
    const html = render({
      ...c,
      state: "Refunded",
      refund: { refundId: "re_1", status: "succeeded", amountCents: 34000, chargeId: "ch_1", paymentIntentId: "pi_1", receiptUrl: null, createdAt: c.createdAt, livemode: false, fee: null, event: null, intentId: "ri_abc123", confirmedBy: "webhook_verified" },
      refundIntents: [ok],
      tokenRejections: [{ at: "2026-10-29T10:02:00.000Z", code: "bad_state", message: "a case in state Refunded can't be refunded" }],
    });
    expect(html).toContain("Refund settled");
    expect(html).toContain("refunded once");
    expect(html).toContain("Webhook received and signature-verified");
    expect(html).toContain("evt_9");
    expect(html).toContain("rejected");
    expect(html).toContain("bad_state");
  });

  it("a refunded case from before refund intents renders nothing extra (its receipt is enough)", async () => {
    const c = await base();
    const html = render({ ...c, state: "Refunded" });
    expect(html).toBe("");
  });
});
