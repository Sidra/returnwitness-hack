/** Read-only check that the Stripe key is a working TEST key. Prints no secrets. */
import Stripe from "stripe";
import { assertTestKey } from "../lib/payments/stripe-rail";

async function main() {
  const s = new Stripe(assertTestKey(process.env.RETURNWITNESS_STRIPE_SECRET_KEY));
  const b = await s.balance.retrieve();
  console.log(`livemode=${b.livemode} available=${JSON.stringify(b.available.map((x) => [x.currency, x.amount]))}`);
  const r = await s.paymentIntents.search({ query: "metadata['rw_kind']:'order_charge'", limit: 1 });
  console.log(`search ok, existing seeded charges: ${r.data.length}`);
}
main().catch((e) => {
  console.error("stripe check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
