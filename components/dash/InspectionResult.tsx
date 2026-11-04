"use client";

import Link from "next/link";
import { mmss, useElapsed } from "@/lib/client/time";
import type { RefundConfirmation, ReturnCase } from "@/lib/domain/case";
import type { LineStatus, ReconciliationLine } from "@/lib/domain/schemas";
import { fromFilmedClip, isRealReplay, modeText } from "@/lib/domain/schemas";
import { formatCents, formatCentsExact } from "@/lib/format";
import { POLICY, rmaById, STRIPE_TEST_LABEL, FIXTURE_LABEL } from "@/data/fixtures";
import { ModeBadge } from "@/components/ModeBadge";
import { ApprovalPanel } from "./ApprovalPanel";
import { fmtMs } from "./StageRail";
import { AgentTrace } from "./AgentTrace";
import { ReaderCards } from "./ReaderCards";
import { KnownMisreadsBanner, LossNotes } from "./LossNotes";
import { misreadsFor, misreadsIn } from "@/data/known-misreads";
import { VoiceNoteCard } from "./VoiceNoteCard";
import { CorrectionForm, isLabelReaderRun } from "./CorrectionForm";

const ST_CLASS: Record<LineStatus, string> = { OK: "st st-ok", MISSING: "st st-missing", HELD: "st st-held", EXTRA: "st st-extra" };
const ST_TEXT: Record<LineStatus, string> = { OK: "OK", MISSING: "Missing", HELD: "Held · unclear", EXTRA: "Extra" };
const CONFIRMED_TEXT: Record<RefundConfirmation, string> = { api_response: "Stripe's answer to the create", api_retrieve: "a retrieve from Stripe's API", webhook_verified: "a verified webhook, then a retrieve" };

function LineRow({ l, clipId }: { l: ReconciliationLine; clipId?: string }) {
  return (
    <tr>
      <td>
        <strong>{l.description}</strong>
        <div className="mono muted" style={{ fontSize: 13 }}>
          {l.sku}
        </div>
      </td>
      <td className="num mono">{l.expectedQty}</td>
      <td className="num mono">{l.observedQty}</td>
      <td>
        <span className={ST_CLASS[l.status]}>{ST_TEXT[l.status]}</span>
      </td>
      <td style={{ fontSize: 14 }}>
        {l.reasons.map((r, i) => (
          <div key={i}>
            {r.detail}
            {r.t != null && <span className="mono muted"> · at {r.t.toFixed(1)} s</span>}
            <LossNotes items={misreadsIn(clipId, r.detail, l.itemKey)} />
          </div>
        ))}
      </td>
    </tr>
  );
}

export function StateHeadline({ c }: { c: ReturnCase }) {
  const rma = rmaById(c.rmaId);
  const amount = rma?.requestedRefundCents ?? 0;
  // A reviewer CORRECTION is logged with the same state in and out; it doesn't restart the wait.
  const heldSince = [...c.audit].reverse().find((a) => a.to === "Held" && a.event !== "CORRECTION")?.at;
  const waiting = useElapsed(heldSince ?? c.updatedAt, c.state === "Held" || c.state === "AwaitingApproval");
  return (
    <>
    <div className="held-banner" aria-live="polite">
      <span className="numeral big-num" aria-hidden>
        {formatCents(c.state === "Refunded" && c.refund ? c.refund.amountCents : amount)}
      </span>
      <div className="stack" style={{ gap: 10 }}>
        {c.state === "Held" && <span className="sticker-held lg">HELD</span>}
        {c.state === "AwaitingApproval" && <span className="sticker-ok lg">READY FOR A PERSON</span>}
        {c.state === "Approved" && <span className="sticker-ok lg">APPROVED</span>}
        {c.state === "Refunded" && <span className="sticker-ok lg">REFUNDED · TEST MODE</span>}
        {(c.state === "Received" || c.state === "Counted" || c.state === "Reconciled") && <span className="eyebrow">Inspecting…</span>}
        <span className="sr-only">
          {formatCents(amount)} {c.state}
        </span>
      </div>
    </div>
    {(c.state === "Held" || c.state === "AwaitingApproval") && (
      <p className="countdown" style={{ margin: 0 }}>
        Waiting for a person · {mmss(waiting)} · the refund can&apos;t run by itself
      </p>
    )}
    </>
  );
}

export function InspectionResult({ c, onCase, compact = false }: { c: ReturnCase; onCase: (c: ReturnCase) => void; compact?: boolean }) {
  const rma = rmaById(c.rmaId);
  const recon = c.reconciliation;
  const realReplay = isRealReplay(c.clip.provenance);
  // The filmed run's known misreads belong only to a case decided on that run, not to a synthetic scene of the same RMA.
  const misreadClip = fromFilmedClip(c.clip) ? c.clip.clipId : undefined;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">
            {c.rmaId} · {rma?.customer.name} · order {c.orderId}
          </span>
          <span className="fixture-label">{FIXTURE_LABEL}</span>
        </div>
        {!compact && (
          <Link href={`/dashboard/cases/${c.id}`} className="btn btn-sm">
            Open inspection record
          </Link>
        )}
      </div>

      <StateHeadline c={c} />
      <KnownMisreadsBanner items={misreadsFor(misreadClip)} />

      {c.state === "Held" && c.holdReasons.some((r) => r.endsWith("_error") || r.includes("unavailable")) && (
        <div className="clause" role="alert">
          <span className="clause-id">FAIL-CLOSED</span> Something in the pipeline failed, so the return was held rather than guessed:{" "}
          {c.audit
            .filter((a) => a.event === "ERROR")
            .map((a) => a.detail)
            .join("; ")}
        </div>
      )}

      {recon && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 className="h3">Packing slip vs what the camera saw</h3>
            <ModeBadge mode={recon.mode} realReplay={realReplay} title={recon.source === "cross_checked" ? "counter + independent model reader, most restrictive wins" : "tray counter in app code"} />
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Expected</th>
                  <th className="num">Seen</th>
                  <th>Status</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {recon.lines.map((l) => (
                  <LineRow key={l.itemKey} l={l} clipId={misreadClip} />
                ))}
              </tbody>
            </table>
          </div>
          {recon.policyHolds?.map((h) => (
            <div className="clause" key={h.code}>
              <span className="clause-id">CLAUSE {h.clauseId} · RETURN WINDOW · HELD</span> The {h.detail}.
            </div>
          ))}
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Held: <strong className="tnum">{formatCentsExact(recon.summary.heldCents)}</strong> · seen value {formatCentsExact(recon.summary.observedCents)} of {formatCentsExact(recon.summary.expectedCents)}
            {c.disagreements.length > 0 && <> · {c.disagreements.length} model disagreement(s) resolved toward a hold</>}
          </p>
        </div>
      )}

      {c.draft && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 className="h3">Decision draft · {c.draft.draft.recommendation.replace("_", " ").toLowerCase()}</h3>
            <span className="row" style={{ gap: 8 }}>
              <ModeBadge mode={c.draft.mode} realReplay={realReplay} />
              <span className="fixture-label">{c.draft.source === "template" ? "template draft (no model)" : `drafted by ${c.draft.model}`}</span>
            </span>
          </div>
          <p style={{ margin: 0, maxWidth: "70ch" }}>{c.draft.draft.rationale}</p>
          <LossNotes items={misreadsIn(misreadClip, c.draft.draft.rationale)} />
          {c.draft.draft.citedClauses.map((cc) => {
            const cl = POLICY.clauses.find((x) => x.id === cc.clauseId);
            return (
              <div className="clause" key={cc.clauseId}>
                <span className="clause-id">CLAUSE {cc.clauseId}</span> {cl?.title ? <strong>{cl.title}.</strong> : null} &ldquo;{cc.quote}&rdquo;
              </div>
            );
          })}
          {c.draft.rejected && (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              The model&apos;s draft was rejected ({c.draft.rejected.errors.join("; ")}), so the template draft is shown.
            </p>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            A draft never moves money. Only a person&apos;s approval does.
          </p>
        </div>
      )}

      {c.voiceNote && <VoiceNoteCard note={c.voiceNote} cited={c.draft?.draft.citedVoiceNote} />}
      {c.readerRuns && c.readerRuns.length > 0 && <ReaderCards runs={c.readerRuns} clipId={misreadClip} />}

      {c.readerRuns?.some(isLabelReaderRun) && <CorrectionForm c={c} onCase={onCase} />}

      {c.draft && <AgentTrace draft={c.draft} c={c} onCase={onCase} />}

      {recon && rma && <ApprovalPanel key={`${c.id}-${c.reconciliation?.summary.allClear}`} c={c} rma={rma} onCase={onCase} />}

      {c.refund && (
        <div className="receipt stack" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 className="h3">Refund receipt</h3>
            <span className="fixture-label">{STRIPE_TEST_LABEL}</span>
          </div>
          <dl>
            <dt>Refund</dt>
            <dd>{c.refund.refundId}</dd>
            <dt>Amount</dt>
            <dd>{formatCentsExact(c.refund.amountCents)}</dd>
            <dt>Status</dt>
            <dd>{c.refund.status}</dd>
            <dt>Original charge</dt>
            <dd>
              {c.refund.chargeId} <span className="muted">[Seeded test-mode charge]</span>
            </dd>
            <dt>Payment intent</dt>
            <dd>{c.refund.paymentIntentId}</dd>
            {c.refund.fee && (
              <>
                <dt>Inspection fee</dt>
                <dd>
                  {formatCentsExact(c.refund.fee.amountCents)} · {c.refund.fee.paymentIntentId}
                </dd>
              </>
            )}
            <dt>Approved by</dt>
            <dd>{c.approval?.approver}</dd>
            {c.refund.intentId && (
              <>
                <dt>Refund intent</dt>
                <dd>
                  {c.refund.intentId}
                  {c.refund.confirmedBy && <span className="muted"> · settled by {CONFIRMED_TEXT[c.refund.confirmedBy]}</span>}
                </dd>
              </>
            )}
            <dt>Webhook</dt>
            <dd>
              {c.refund.webhook ? (
                <>
                  received and signature-verified · {c.refund.webhook.type} · {c.refund.webhook.eventId}
                </>
              ) : (
                <span className="muted">no verified webhook delivery recorded for this refund</span>
              )}
            </dd>
            {c.refund.feeError && (
              <>
                <dt>Inspection fee</dt>
                <dd>not booked: {c.refund.feeError} (the refund stands)</dd>
              </>
            )}
          </dl>
          <div className="row">
            {c.refund.receiptUrl && (
              <a className="btn btn-sm" href={c.refund.receiptUrl} target="_blank" rel="noopener noreferrer">
                Stripe receipt ↗
              </a>
            )}
          </div>
          {c.refund.event ? (
            <details>
              <summary>
                Event payload, retrieved via the Events API · {c.refund.event.type} · {c.refund.event.id}
              </summary>
              <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
                Fetched from Stripe&apos;s Events API: the same payload Stripe delivers to a webhook endpoint, but this copy was retrieved, not received as a webhook.
              </p>
              <pre className="json">{JSON.stringify(c.refund.event.payload, null, 2)}</pre>
            </details>
          ) : (
            <p className="muted" style={{ fontSize: 14, margin: 0 }}>
              The charge.refunded event hadn&apos;t appeared in Stripe&apos;s Events API yet.
            </p>
          )}
        </div>
      )}

      {!compact && c.timings.length > 0 && (
        <p className="mono muted" style={{ fontSize: 13, margin: 0 }}>
          {c.timings.map((t) => `${t.stage} ${fmtMs(t.ms)} · ${modeText(t.mode, isRealReplay(c.clip.provenance))}`).join("  ·  ")}
        </p>
      )}
    </div>
  );
}
