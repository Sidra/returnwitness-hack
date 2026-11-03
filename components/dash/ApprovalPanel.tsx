"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import type { Rma } from "@/lib/domain/schemas";
import { calculateSettlement, type SettlementOption } from "@/lib/engine/reconcile";
import { formatCents, formatCentsExact } from "@/lib/format";
import { MERCHANT, STRIPE_TEST_LABEL } from "@/data/fixtures";
import { api, ApiError } from "@/lib/client/api";
import { mmss } from "@/lib/client/time";
import { useStoredValue } from "@/lib/client/storage";
import { RefundIntentLog } from "./RefundIntentLog";

/** How often the page asks the server to settle an in-flight intent, and for how long. */
const RECOVER_EVERY_MS = 15_000;
const RECOVER_TRIES = 8;

/**
 * The human gate. Before approval the refund button is disabled. Approving issues a single-use
 * token (10 min) held only in this page's memory; the refund call spends it. A page reload
 * loses the token by design: put the case back on hold and approve again.
 * If Stripe's answer is lost (timeout, 5xx), the refund intent's outcome is UNKNOWN: the panel
 * says so, blocks new approvals, and asks the server to recover the SAME intent (no token).
 * Parents render it with key={case.id}, so switching cases starts fresh.
 */
export function ApprovalPanel({ c, rma, onCase }: { c: ReturnCase; rma: Rma; onCase: (c: ReturnCase) => void }) {
  const settlement = useMemo(() => (c.reconciliation ? calculateSettlement(c.reconciliation, rma) : null), [c.reconciliation, rma]);
  const clean = Boolean(c.reconciliation?.summary.allClear);
  const [storedApprover, saveApprover] = useStoredValue("rw-approver", MERCHANT.returnsLead);
  const [approverEdit, setApprover] = useState<string | null>(null);
  const approver = approverEdit ?? storedApprover;
  const [choice, setChoice] = useState<SettlementOption["key"]>(settlement?.recommended ?? "full_hold");
  const [note, setNote] = useState("");
  const [override, setOverride] = useState("");
  const [token, setToken] = useState<{ token: string; expiresAt: string } | null>(null);
  // After a refund this page still holds the token it spent, so a person can watch the server refuse a second use.
  const [spentToken, setSpentToken] = useState<string | null>(null);
  const [reuse, setReuse] = useState<{ status: number; code: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const [now, setNow] = useState(() => Date.now());
  /** Refund calls refused in this page (kept even after the case refreshes, so a refusal never silently disappears). */
  const [localRejections, setLocalRejections] = useState<Array<{ at: string; code: string; message: string; local: true }>>([]);

  const intents = useMemo(() => c.refundIntents ?? [], [c.refundIntents]);
  const active = intents.find((i) => i.outcome === "pending" || i.outcome === "unknown");
  const last = intents.at(-1);
  const serverRejections = c.tokenRejections ?? [];
  const rejections = [...serverRejections, ...localRejections.filter((l) => !serverRejections.some((s) => s.code === l.code && s.message === l.message))];

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [token]);

  // While an intent is in flight, ask the server to recover it (retrieve, or re-send the SAME intent).
  const activeId = active?.id;
  const onCaseRef = useRef(onCase);
  useEffect(() => {
    onCaseRef.current = onCase;
  }, [onCase]);
  useEffect(() => {
    if (!activeId) return;
    let tries = 0;
    const id = setInterval(() => {
      if (++tries > RECOVER_TRIES) return clearInterval(id);
      api.recover(c.id).then((x) => onCaseRef.current(x)).catch(() => {});
    }, RECOVER_EVERY_MS);
    return () => clearInterval(id);
  }, [activeId, c.id]);

  const picked = settlement?.options.find((o) => o.key === choice);
  const amount = picked?.refundCents ?? 0;
  const secondsLeft = token ? Math.max(0, Math.floor((Date.parse(token.expiresAt) - now) / 1000)) : 0;
  const needsOverride = Boolean(picked?.requiresOverride);

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const approve = () =>
    run("approve", async () => {
      saveApprover(approver);
      const r = await api.approve(c.id, { approver, amountCents: amount, note, overrideReason: needsOverride ? override : undefined });
      setToken({ token: r.token, expiresAt: r.expiresAt });
      onCase(r.case);
    });

  const refund = () =>
    run("refund", async () => {
      if (!token) return;
      try {
        // 200 = refunded; 202 = pending/unknown, and the returned case says which. The token is spent either way.
        const done = await api.refund(c.id, token.token);
        setSpentToken(token.token);
        setToken(null);
        onCase(done);
      } catch (e) {
        setToken(null);
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          setLocalRejections((xs) => [...xs, { at: new Date().toISOString(), code: e.code, message: e.message, local: true }]);
        }
        // Show the case as the server left it (held on a confirmed failure, still approved on a refusal).
        api.case(c.id).then(onCase).catch(() => {});
        throw e;
      }
    });

  // The same single-use token, sent again: the server's real answer is shown as it comes back (never assumed).
  const reuseToken = () =>
    run("reuse", async () => {
      if (!spentToken) return;
      try {
        await api.refund(c.id, spentToken);
        setReuse({ status: 200, code: "accepted", message: "the server accepted a second use (this should never happen)" });
      } catch (e) {
        if (e instanceof ApiError) setReuse({ status: e.status, code: e.code, message: e.message });
        else throw e;
      }
      api.case(c.id).then(onCase).catch(() => {});
    });

  const recover = () =>
    run("recover", async () => {
      onCase(await api.recover(c.id));
    });

  const keepHolding = () =>
    run("keep", async () => {
      saveApprover(approver);
      const done = await api.hold(c.id, approver, note.trim() || "kept the full refund on hold (clause 5.1)");
      onCase(done);
    });

  const hold = () =>
    run("hold", async () => {
      const done = await api.hold(c.id, approver, holdReason || "voided approval to re-check");
      setToken(null);
      setHoldReason("");
      onCase(done);
    });

  // A refunded case recorded before refund intents existed has nothing more to show than its receipt.
  if (c.state === "Refunded" && !intents.length && !rejections.length) return null;

  const refundLabel = `Run refund ${formatCentsExact(c.approval?.amountCents ?? amount)}`;

  return (
    <section className="card stack" style={{ gap: 16 }} aria-label="Approval and refund">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 className="h3">{c.state === "Refunded" ? "Refund settled" : active ? "Refund in flight: outcome being recovered" : c.state === "Approved" ? "Approved: run the refund" : "A person decides"}</h3>
        <span className="fixture-label">{STRIPE_TEST_LABEL}</span>
      </div>

      {c.state === "Held" && last?.outcome === "failed" && (
        <div className="clause" role="status">
          <span className="clause-id">STRIPE CONFIRMED NO REFUND</span> {last.failure?.message ?? "Stripe rejected the refund."} Nothing was refunded by intent{" "}
          <span className="mono">{last.id}</span>. <strong>Safe to request a new approval.</strong>
        </div>
      )}

      {(c.state === "Held" || c.state === "AwaitingApproval") && (
        <>
          {settlement && (
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="eyebrow" style={{ marginBottom: 8 }}>
                Settlement · the person chooses
              </legend>
              <div className="settle-grid">
                {settlement.options
                  .filter((o) => o.available)
                  .map((o) => (
                    <label key={o.key} className="settle-opt" data-picked={choice === o.key || undefined}>
                      <input type="radio" name={`settle-${c.id}`} checked={choice === o.key} onChange={() => setChoice(o.key)} className="sr-only" />
                      <span className="row" style={{ justifyContent: "space-between" }}>
                        <span className="eyebrow">clause {o.clause}</span>
                        {settlement.recommended === o.key && <span className="mode">recommended</span>}
                      </span>
                      <strong>{o.label}</strong>
                      <span className="tnum" style={{ fontSize: 15 }}>
                        Refund <strong>{formatCentsExact(o.refundCents)}</strong> · hold <strong>{formatCentsExact(o.heldCents)}</strong>
                      </span>
                      <span className="muted" style={{ fontSize: 13 }}>{o.why}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
          )}
          <div className="row" style={{ gap: 16, alignItems: "flex-end" }}>
            <label className="field" style={{ minWidth: 200, flex: "1 1 200px" }}>
              Approver
              <input className="input" value={approver} onChange={(e) => setApprover(e.target.value)} autoComplete="name" aria-describedby="approver-note" />
            </label>
          </div>
          <p id="approver-note" className="muted" style={{ margin: 0, fontSize: 13 }}>
            In this prototype the approver is a typed name; staff sign-in and roles are a production step. The approval still issues a single-use,
            evidence-bound token, and nothing else reaches the refund.
          </p>
          {!clean && (
            <label className="field">
              Note for the record (required on a held return)
              <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. customer confirmed the lens was never shipped back; partial under 4.3" />
            </label>
          )}
          {needsOverride && (
            <label className="field">
              Override reason (10+ characters)
              <input className="input" value={override} onChange={(e) => setOverride(e.target.value)} />
            </label>
          )}
          <div className="row">
            {choice === "full_hold" ? (
              <button type="button" className="btn btn-primary" onClick={keepHolding} disabled={busy !== null || !approver.trim()}>
                {busy === "keep" ? "Saving…" : `Keep ${formatCents(settlement?.requestedCents ?? 0)} on hold`}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={approve} disabled={busy !== null || !approver.trim() || amount <= 0 || (!clean && !note.trim()) || (needsOverride && override.trim().length < 10)}>
                {busy === "approve" ? "Approving…" : `Approve ${formatCents(amount)}${clean ? "" : choice === "partial" ? ` · hold ${formatCents(picked?.heldCents ?? 0)}` : " (override)"}`}
              </button>
            )}
            <button type="button" className="btn" disabled title="The refund needs a person's approval first" aria-disabled="true">
              Refund · needs a person&apos;s approval
            </button>
          </div>
          {c.state === "Held" && (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Or leave it held: the customer is told what wasn&apos;t observed and can respond (clause 5.1). A hold is not a denial.
            </p>
          )}
        </>
      )}

      {c.state === "Approved" && (
        <>
          <p style={{ margin: 0 }}>
            Approved by <strong>{c.approval?.approver}</strong> for <strong className="tnum">{formatCentsExact(c.approval?.amountCents ?? 0)}</strong>
            {c.approval?.override ? " (override)" : ""}.
          </p>
          {active ? (
            <div className="clause stack" role="status" aria-live="polite" style={{ gap: 8 }}>
              <span>
                <span className="clause-id">{active.outcome === "unknown" ? "OUTCOME UNKNOWN · RECOVERING" : "PENDING AT STRIPE"}</span>{" "}
                {active.outcome === "unknown"
                  ? "Stripe's answer to this refund was lost (a timeout or a server error), so Stripe may have accepted it. Nothing is assumed: the server retrieves the refund, or re-sends the same intent with the same idempotency key, so it can't refund twice."
                  : `Stripe accepted refund ${active.refundId ?? ""} and is settling it.`}{" "}
                <strong>New approvals and holds are blocked until the outcome is known.</strong>
              </span>
              <div className="row">
                <button type="button" className="btn btn-sm" onClick={recover} disabled={busy !== null}>
                  {busy === "recover" ? "Checking Stripe…" : "Check Stripe again"}
                </button>
                <span className="countdown">The approval token was spent once; recovery doesn&apos;t need it.</span>
              </div>
            </div>
          ) : token ? (
            <div className="row">
              <button type="button" className="btn btn-accent" onClick={refund} disabled={busy !== null || secondsLeft === 0}>
                {busy === "refund" ? "Refunding in Stripe test mode…" : refundLabel}
              </button>
              <span className="countdown" aria-live="polite">
                One-time approval token · expires in {mmss(secondsLeft)}
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              The one-time approval token lives only in the page that approved it. To refund from here, void this approval and approve again.
            </p>
          )}
          {!active && (
            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="field" style={{ flex: "1 1 260px" }}>
                Reason to void (optional)
                <input className="input" value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
              </label>
              <button type="button" className="btn" onClick={hold} disabled={busy !== null || !approver.trim()}>
                {busy === "hold" ? "Holding…" : "Void approval · hold again"}
              </button>
            </div>
          )}
        </>
      )}

      {c.state === "Refunded" && c.refund && (
        <p style={{ margin: 0 }}>
          <span className="st st-ok">refunded once</span> {c.refund.refundId} for <strong className="tnum">{formatCentsExact(c.refund.amountCents)}</strong>. The receipt is below.
        </p>
      )}

      {c.state === "Refunded" && spentToken && !reuse && (
        <div className="row" style={{ alignItems: "center" }}>
          <button type="button" className="btn" onClick={reuseToken} disabled={busy !== null}>
            {busy === "reuse" ? "Sending…" : "Send the same token again"}
          </button>
          <span className="muted" style={{ fontSize: 14 }}>This page still holds the token it just spent. The server should refuse it.</span>
        </div>
      )}
      {reuse && (
        <div className={reuse.status === 200 ? "reuse-state reuse-bad" : "reuse-state"} role="status" aria-live="polite">
          <span className="reuse-code">{reuse.status === 200 ? "ACCEPTED" : `REFUSED · HTTP ${reuse.status}`}</span>
          <strong>{reuse.status === 200 ? "A second use went through." : "The same token, a second time: refused."}</strong>
          <span>
            <span className="mono">{reuse.code}</span>: {reuse.message}. {reuse.status === 200 ? "" : "No money moved. The refusal is recorded in the case's refund log."}
          </span>
        </div>
      )}

      <RefundIntentLog intents={intents} rejections={rejections} open={Boolean(active) || rejections.length > 0} />

      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger)", fontWeight: 600 }}>
          {error}
        </p>
      )}
    </section>
  );
}
