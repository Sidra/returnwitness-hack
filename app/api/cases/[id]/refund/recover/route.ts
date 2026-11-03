import { recoverRefund } from "@/lib/engine/service";
import { latestIntent } from "@/lib/engine/refund-intent";
import { getStore } from "@/lib/store/case-store";
import { getRail } from "@/lib/payments/stripe-rail";
import { apiError, json } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

/**
 * Server-controlled recovery of a refund intent whose outcome is pending or unknown. Takes no
 * token and no amount: it retrieves the intent's refund, or re-sends the SAME intent with the
 * same idempotency key, so it can never create a second refund.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "money");
  if (limited) return limited;
  const { id } = await params;
  try {
    const done = await recoverRefund({ store: getStore(), rail: getRail() }, id);
    const outcome = latestIntent(done)?.outcome ?? null;
    return json({ case: done, outcome }, outcome === "pending" || outcome === "unknown" ? 202 : 200);
  } catch (e) {
    return apiError(e);
  }
}
