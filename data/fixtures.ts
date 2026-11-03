/**
 * [Seeded merchant order & RMA fixture]: the store, customer, orders, RMAs, packing slips
 * and return policy a real merchant would connect. Every value derives from kit.config.ts,
 * so changing the kit changes all of it. The UI labels all of this as seeded.
 */
import { KIT, KIT_TOTAL_CENTS } from "./kit.config";
import type { PackingSlip, Policy, Rma } from "@/lib/domain/schemas";

export const FIXTURE_LABEL = "[Seeded merchant order & RMA fixture]";
export const CHARGE_LABEL = "[Seeded test-mode charge]";
export const STRIPE_TEST_LABEL = "[Stripe test mode — no real funds moved]";

export const MERCHANT = {
  id: "merch_brindlewood",
  name: KIT.merchantName,
  returnsLead: "Rita Calder",
  bench: "Bench 2",
};

export const lensItem = KIT.items.find((i) => i.key === "lens") ?? KIT.items[1];

export const POLICY: Policy = {
  id: "pol_brindlewood_returns",
  merchant: KIT.merchantName,
  version: "2026.3",
  effective: "2026-09-01",
  clauses: [
    { id: "1.1", title: "Return window", text: "Items may be returned within 30 days of delivery." },
    { id: "2.1", title: "Condition", text: "Items must be returned in resalable condition with all accessories and packaging inserts." },
    { id: "3.1", title: "Inspection", text: "Every return routed to an inspection bench is opened on camera before any refund is issued." },
    { id: "4.1", title: "Kits", text: "Each component of a kit is listed as its own line on the packing slip." },
    { id: "4.2", title: "Complete kits", text: "A kit is refunded in full only when every component listed on the packing slip is returned." },
    {
      id: "4.3",
      title: "Incomplete kits",
      text: "When a kit component is missing, the refund is held for review. A reviewer may approve a partial refund equal to the kit price less the list price of each missing component.",
    },
    { id: "4.4", title: "Serialised components", text: "A serialised component must carry the serial recorded on the packing slip." },
    {
      id: "5.1",
      title: "Holds are not denials",
      text: "A held refund is not a denial. The customer is told what was not observed and may respond within 14 days.",
    },
    { id: "6.1", title: "Refund method", text: "Approved refunds are issued to the original payment method." },
  ],
};

export const policyText = (p: Policy = POLICY) => p.clauses.map((c) => `${c.id} ${c.title}. ${c.text}`).join("\n");

function slipFor(orderId: string, which: "complete" | "missingCase"): PackingSlip {
  return {
    orderId,
    shippedAt: "2026-10-02T17:20:00Z",
    lines: KIT.items.map((i) => ({
      itemKey: i.key,
      sku: i.sku,
      description: i.name,
      qty: 1,
      unitPriceCents: i.unitPriceCents,
      requiresSerial: i.requiresSerial,
      ...(i.requiresSerial ? { serial: i.serials[which] } : {}),
    })),
  };
}

export interface OrderFixture {
  id: string;
  customer: { name: string; email: string };
  totalCents: number;
  slip: PackingSlip;
}

export const ORDERS: OrderFixture[] = [
  {
    id: "ORD-58213",
    customer: { name: "Darius Okoro", email: "darius.okoro@example.com" },
    totalCents: KIT_TOTAL_CENTS,
    slip: slipFor("ORD-58213", "missingCase"),
  },
  {
    id: "ORD-58227",
    customer: { name: "Esme Quill", email: "esme.quill@example.com" },
    totalCents: KIT_TOTAL_CENTS,
    slip: slipFor("ORD-58227", "complete"),
  },
  {
    id: "ORD-58241",
    customer: { name: "Selma Ashdown", email: "selma.ashdown@example.com" },
    totalCents: KIT_TOTAL_CENTS,
    slip: slipFor("ORD-58241", "complete"),
  },
];

export const RMAS: Rma[] = [
  {
    id: "RMA-20418",
    orderId: "ORD-58213",
    customer: ORDERS[0].customer,
    reason: "Changed my mind. Everything is in the box.",
    requestedRefundCents: KIT_TOTAL_CENTS,
    createdAt: "2026-10-20T15:04:00Z",
    clipId: "d1-rma-20418-lens-missing",
    scenario: `${lensItem.name} missing`,
  },
  {
    id: "RMA-20419",
    orderId: "ORD-58227",
    customer: ORDERS[1].customer,
    reason: "Bought a different model.",
    requestedRefundCents: KIT_TOTAL_CENTS,
    createdAt: "2026-10-21T10:41:00Z",
    clipId: "d2-rma-20419-complete",
    scenario: "complete kit",
  },
  {
    id: "RMA-20420",
    orderId: "ORD-58241",
    customer: ORDERS[2].customer,
    reason: "Duplicate gift.",
    requestedRefundCents: KIT_TOTAL_CENTS,
    createdAt: "2026-10-22T09:12:00Z",
    clipId: "d3-camera-reboxed",
    scenario: "complete kit, camera body covered and re-boxed",
  },
];

export const orderFor = (orderId: string) => ORDERS.find((o) => o.id === orderId);
export const rmaById = (id: string) => RMAS.find((r) => r.id === id);
