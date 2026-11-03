import { json } from "@/lib/api";
import { getStore } from "@/lib/store/case-store";
import { getRail } from "@/lib/payments/stripe-rail";
import { handleStripeWebhook } from "@/lib/payments/webhook";

/**
 * Stripe webhook receiver for a deployed instance. Refuses everything unless
 * RETURNWITNESS_STRIPE_WEBHOOK_SECRET is set; verifies Stripe's signature over the RAW body;
 * dedups event ids in the case store; and reconciles by RETRIEVING the refund, never by trusting
 * the payload (lib/payments/webhook.ts). The bench screen shows the charge.refunded payload the
 * rail fetched from the Events API, so the demo doesn't depend on this endpoint being reachable.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const r = await handleStripeWebhook({ store: getStore(), rail: getRail(), secret: process.env.RETURNWITNESS_STRIPE_WEBHOOK_SECRET }, raw, req.headers.get("stripe-signature"));
  return json(r.body, r.status);
}
