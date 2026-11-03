import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection } from "@/lib/engine/pipeline";
import { approveCase, refundCase } from "@/lib/engine/service";
import { MemoryCaseStore, setStore, VersionConflict, type CaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import type { RailOutcome, RefundRail } from "@/lib/payments/stripe-rail";
import type { ReturnCase } from "@/lib/domain/case";
import { getCorrections, listCorrections, recordCorrection, ReviewerCorrection } from "@/lib/learning/corrections";
import { GET, POST } from "@/app/api/cases/[id]/corrections/route";

// connection() needs a Next request scope; outside one it throws. The route logic is what's under test.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const SECRET = "y".repeat(48);
const NOW = new Date("2026-10-28T18:00:00Z");
let store: MemoryCaseStore;

const inspect = (i: 0 | 1) => runInspection({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" } }, { store, segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
const input = (over: Record<string, unknown> = {}) => ({ itemKey: "camera_body", field: "serial", modelValue: "BW-CB-55I20", humanValue: "BW-CB-55120", reader: "muse-glimmer (fireworks)", cropCaption: "crop of the counted camera_body as it settled in the tray at 2.0 s", person: "Rita Calder", ...over });
const req = (body: unknown) => new Request("http://local/api/cases/x/corrections", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

class FakeRail implements RefundRail {
  readonly mode = "stripe_test" as const;
  calls = 0;
  async ensureCharge(o: { id: string; totalCents: number }) {
    return { orderId: o.id, paymentIntentId: "pi_test", chargeId: "ch_test", amountCents: o.totalCents, receiptUrl: null, created: 0 };
  }
  async refund(a: { amountCents: number }): Promise<RailOutcome> {
    this.calls++;
    return { outcome: "succeeded", via: "create", refund: { refundId: "re_test_1", status: "succeeded", amountCents: a.amountCents, chargeId: "ch_test", paymentIntentId: "pi_test", receiptUrl: null }, fee: { paymentIntentId: "pi_fee", chargeId: "ch_fee", amountCents: 200, receiptUrl: null }, event: null };
  }
  async recover(): Promise<RailOutcome> {
    return { outcome: "unknown", via: "lookup", code: "not_scripted", message: "unused" };
  }
  async retrieveRefund() {
    return null;
  }
  async refundsForCharge() {
    return [];
  }
}

beforeEach(() => {
  store = new MemoryCaseStore(null);
  setStore(store);
});

describe("recordCorrection", () => {
  it("records a validated correction on the case with an audit entry, and lists it", async () => {
    const c = await inspect(1);
    const r = await recordCorrection({ store, now: () => NOW, newId: () => "cor_test1" }, c.id, input());
    expect(r.correction).toEqual({ id: "cor_test1", caseId: c.id, rmaId: c.rmaId, itemKey: "camera_body", field: "serial", modelValue: "BW-CB-55I20", humanValue: "BW-CB-55120", reader: "muse-glimmer (fireworks)", cropCaption: expect.stringContaining("camera_body"), person: "Rita Calder", at: NOW.toISOString() });
    expect(ReviewerCorrection.safeParse(r.correction).success).toBe(true);
    expect(r.case.version).toBe(c.version + 1);
    const last = r.case.audit.at(-1)!;
    expect(last).toMatchObject({ event: "CORRECTION", actor: "person:Rita Calder", from: c.state, to: c.state });
    expect(last.detail).toMatch(/no effect on the refund/);
    expect(await getCorrections({ store }, c.id)).toHaveLength(1);
    await recordCorrection({ store }, c.id, input({ field: "sku", modelValue: null, humanValue: "CK-BODY-01" }));
    expect((await getCorrections({ store }, c.id)).map((x) => x.field)).toEqual(["serial", "sku"]);
  });

  it("refuses an item that isn't on the case (400), bad input (400), no-op corrections (400) and unknown cases (404)", async () => {
    const c = await inspect(1);
    await expect(recordCorrection({ store }, c.id, input({ itemKey: "tripod" }))).rejects.toMatchObject({ code: "unknown_item", status: 400 });
    await expect(recordCorrection({ store }, c.id, input({ humanValue: "  " }))).rejects.toMatchObject({ code: "bad_input", status: 400 });
    await expect(recordCorrection({ store }, c.id, input({ field: "colour" }))).rejects.toMatchObject({ code: "bad_input" });
    await expect(recordCorrection({ store }, c.id, input({ person: "" }))).rejects.toMatchObject({ code: "bad_input" });
    await expect(recordCorrection({ store }, c.id, input({ humanValue: "bw cb 55i20" }))).rejects.toMatchObject({ code: "no_change", status: 400 });
    await expect(recordCorrection({ store }, "case_nope", input())).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(listCorrections((await store.get(c.id))!)).toEqual([]);
  });

  it("a stale expectedVersion is a version conflict; without one a concurrent write is retried", async () => {
    const c = await inspect(1);
    await expect(recordCorrection({ store }, c.id, input({ expectedVersion: c.version - 1 }))).rejects.toBeInstanceOf(VersionConflict);
    // A store that loses the race once: the append is re-read and re-applied, nothing is lost.
    let raced = false;
    const racy: CaseStore = Object.assign(Object.create(store), {
      put: async (x: ReturnCase, v: number) => {
        if (!raced) {
          raced = true;
          const cur = (await store.get(x.id))!;
          await store.put({ ...cur, updatedAt: "2026-10-28T17:59:00Z" }, cur.version);
        }
        return store.put(x, v);
      },
    });
    const r = await recordCorrection({ store: racy }, c.id, input());
    expect(raced).toBe(true);
    expect(r.case.corrections).toHaveLength(1);
    expect(r.case.version).toBe(c.version + 2);
  });

  it("leaves the money state untouched: state, reconciliation, holds, and an issued approval token still refunds", async () => {
    const c = await inspect(1); // complete kit → AwaitingApproval
    expect(c.state).toBe("AwaitingApproval");
    const { token, case: approved } = await approveCase({ store, secret: SECRET }, c.id, RMAS[1], { approver: "Rita Calder", amountCents: RMAS[1].requestedRefundCents, note: "" });
    const { case: corrected } = await recordCorrection({ store }, c.id, input());
    expect(corrected.state).toBe(approved.state);
    expect(corrected.reconciliation).toEqual(approved.reconciliation);
    expect(corrected.holdReasons).toEqual(approved.holdReasons);
    expect(corrected.approval).toEqual(approved.approval);
    const rail = new FakeRail();
    const done = await refundCase({ store, secret: SECRET, rail }, c.id, token);
    expect(done.state).toBe("Refunded");
    expect(rail.calls).toBe(1);
    // ...and a correction after the refund is still just training data.
    const after = await recordCorrection({ store }, c.id, input({ field: "sku", modelValue: "CK-B0DY-01", humanValue: "CK-BODY-01" }));
    expect(after.case.state).toBe("Refunded");
    expect(after.case.refund).toEqual(done.refund);
  });

  it("a held case stays held with the same reasons", async () => {
    const c = await inspect(0); // lens missing → Held
    const { case: x } = await recordCorrection({ store }, c.id, input({ itemKey: "lens", modelValue: null, humanValue: "unreadable" }));
    expect(x.state).toBe("Held");
    expect(x.holdReasons).toEqual(c.holdReasons);
    expect(x.reconciliation).toEqual(c.reconciliation);
  });

  it("cases stored before the field existed still load and accept corrections", async () => {
    const c = await inspect(1);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rw-cor-")), "store.json");
    const legacy = structuredClone(c) as ReturnCase & { corrections?: unknown };
    delete legacy.corrections;
    fs.writeFileSync(file, JSON.stringify({ cases: { [c.id]: legacy }, nonces: [] }));
    const fileStore = new MemoryCaseStore(file);
    const loaded = (await fileStore.get(c.id))!;
    expect("corrections" in loaded).toBe(false);
    expect(listCorrections(loaded)).toEqual([]);
    const r = await recordCorrection({ store: fileStore }, c.id, input());
    expect(r.case.corrections).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cases[c.id].corrections).toHaveLength(1);
  });
});

describe("corrections API route", () => {
  it("POST 201 adds, GET lists", async () => {
    const c = await inspect(1);
    const res = await POST(req(input()), ctx(c.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { correction: { id: string }; case: ReturnCase };
    expect(body.case.corrections).toHaveLength(1);
    const list = await GET(new Request("http://local"), ctx(c.id));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { corrections: Array<{ id: string }> }).corrections.map((x) => x.id)).toEqual([body.correction.id]);
    expect((await GET(new Request("http://local"), ctx("case_missing"))).status).toBe(404);
  });

  it("400 on an unknown item, a non-JSON body and a missing field; 404 on an unknown case; 409 on a stale version", async () => {
    const c = await inspect(1);
    const bad = await POST(req(input({ itemKey: "tripod" })), ctx(c.id));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("unknown_item");
    expect((await POST(req("not json"), ctx(c.id))).status).toBe(400);
    expect((await POST(req({ ...input(), humanValue: undefined }), ctx(c.id))).status).toBe(400);
    expect((await POST(req(input()), ctx("case_missing"))).status).toBe(404);
    const stale = await POST(req(input({ expectedVersion: 0 })), ctx(c.id));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("conflict");
  });
});
