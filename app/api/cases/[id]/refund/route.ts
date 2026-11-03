import { refundCase } from "@/lib/engine/service";
import { latestIntent } from "@/lib/engine/refund-intent";
import { getStore } from "@/lib/store/case-store";
import { getRail } from "@/lib/payments/stripe-rail";
import { approvalSecret, orderFor } from "@/lib/runtime";
import { apiError, json, readJson } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

/**
 * Unreachable without a valid approval token. Stripe test mode only. 200 = refunded; 202 = the
 * refund intent is pending or its outcome is unknown (recovery settles it; new approvals blocked).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "money");
  if (limited) return limited;
  const { id } = await params;
  const b = await readJson<{ token: string }>(req);
  try {
    const store = getStore();
    const c = await store.get(id);
    if (!c) return json({ error: "not_found", message: `case ${id} not found` }, 404);
    const order = orderFor(c.orderId);
    const done = await refundCase(
      { store, secret: approvalSecret(), rail: getRail(), order: order && { id: order.id, totalCents: order.totalCents, customerEmail: order.customer.email } },
      id,
      String(b.token ?? ""),
    );
    const outcome = latestIntent(done)?.outcome ?? null;
    return json({ case: done, outcome }, outcome === "pending" || outcome === "unknown" ? 202 : 200);
  } catch (e) {
    return apiError(e);
  }
}
