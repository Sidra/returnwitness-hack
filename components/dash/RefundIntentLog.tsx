"use client";

import type { RefundConfirmation, RefundIntent, RefundOutcome, TokenRejection } from "@/lib/domain/case";
import { formatCentsExact } from "@/lib/format";
import { LocalTime } from "@/components/LocalTime";

/** Outcome → status text class (locked tokens): succeeded is ok, failed is held, in-flight is a warning. */
const ST: Record<RefundOutcome, string> = { succeeded: "st st-ok", failed: "st st-held", pending: "st st-warn", unknown: "st st-warn" };
const OUTCOME_TEXT: Record<RefundOutcome, string> = { succeeded: "succeeded", failed: "failed · nothing refunded", pending: "pending at Stripe", unknown: "outcome unknown" };
const CONFIRMED: Record<RefundConfirmation, string> = {
  api_response: "Stripe's answer to the create",
  api_retrieve: "retrieved from Stripe's API",
  webhook_verified: "a signature-verified webhook, then retrieved from Stripe",
};
const BY: Record<string, string> = { person: "approval token", recovery: "recovery", webhook: "webhook" };

const time = (iso: string) => <LocalTime iso={iso} />;

/**
 * Every refund intent for the case and each attempt on it, plus refund calls that were refused.
 * Problem: a timeout can leave a refund half-known. What this shows: which intent moved money,
 * how that was established, and that no retry ever used the person's token twice.
 */
export function RefundIntentLog({ intents, rejections, open }: { intents: RefundIntent[]; rejections: Array<TokenRejection & { local?: boolean }>; open: boolean }) {
  if (!intents.length && !rejections.length) return null;
  return (
    <details open={open || undefined}>
      <summary>
        Refund intents · {intents.length}
        {rejections.length ? ` · ${rejections.length} refused call${rejections.length === 1 ? "" : "s"}` : ""}
      </summary>
      <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
        Each approval reserves one refund intent before Stripe is called. Every retry of an intent reuses its idempotency key, so Stripe can only ever create one refund for it. The person&apos;s token is spent once; recovery never needs it.
      </p>
      <ol className="audit">
        {intents.map((i) => (
          <li key={i.id} className="stack" style={{ gap: 6 }}>
            <span className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <span className="mono" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {i.id} · <span className="tnum">{formatCentsExact(i.amountCents)}</span> · {i.approver}
              </span>
              <span className={ST[i.outcome]}>{OUTCOME_TEXT[i.outcome]}</span>
            </span>
            <span className="mono muted" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
              key {i.idempotencyKey} · charge {i.chargeId}
              {i.refundId ? ` · refund ${i.refundId}` : ""}
            </span>
            {i.confirmedBy && (
              <span className="muted" style={{ fontSize: 13 }}>
                Settled by {CONFIRMED[i.confirmedBy]}.
              </span>
            )}
            {i.webhook && (
              <span className="muted" style={{ fontSize: 13 }}>
                Webhook received and signature-verified: {i.webhook.type} · <span className="mono">{i.webhook.eventId}</span> at {time(i.webhook.verifiedAt)}.
              </span>
            )}
            {i.attempts.length > 0 && (
              <ol className="audit" style={{ paddingLeft: 12 }}>
                {i.attempts.map((a) => (
                  <li key={a.n} style={{ fontSize: 13 }}>
                    <span className="mono">#{a.n}</span> {time(a.at)} · {BY[a.by] ?? a.by} · {a.action} · <span className={ST[a.outcome]}>{a.outcome}</span>
                    <br />
                    <span className="muted">{a.detail}</span>
                  </li>
                ))}
              </ol>
            )}
            {i.attempts.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Reserved; no answer from Stripe recorded yet.</span>}
          </li>
        ))}
        {rejections.map((r, k) => (
          <li key={`rej-${k}`} style={{ fontSize: 13 }}>
            <span className="st st-held">rejected</span> <span className="mono">{r.code}</span> {r.local ? "· this page" : <>· {time(r.at)}</>}
            <br />
            <span className="muted">{r.message}. No money moved for this call.</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
