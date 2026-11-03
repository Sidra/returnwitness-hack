/**
 * The only path from a decision to money:
 *   approve(): a PERSON approves an amount → Approved + a signed, single-use, expiring token
 *              bound to digest(RMA + observation + reconciliation + amount).
 *   refund():  verifies the token → spends its nonce atomically → re-checks the digest against
 *              the case as it is NOW → reserves a REFUND INTENT in the store (with its stable
 *              idempotency key) → only then calls the rail. If the intent can't be reserved,
 *              Stripe is never called.
 *   recover(): server-controlled recovery of an intent whose outcome is pending/unknown: it
 *              retrieves, or re-sends the SAME intent (same key). It never takes a token and can
 *              never create a second refund.
 * Outcomes: succeeded → Refunded; a confirmed failure → Held ("safe to request a new approval");
 * a timeout/5xx → UNKNOWN: the case stays Approved and new approvals and holds are blocked until
 * recovery or a verified webhook settles it.
 */
import type { RefundIntent, ReturnCase } from "@/lib/domain/case";
import type { Rma } from "@/lib/domain/schemas";
import type { CaseStore } from "@/lib/store/case-store";
import { VersionConflict } from "@/lib/store/errors";
import { classifyStripeError, type RailOutcome, type RefundRail } from "@/lib/payments/stripe-rail";
import { orderFor } from "@/data/fixtures";
import { digestOf } from "./digest";
import { issueToken, verifyToken, APPROVAL_TTL_MS } from "./approval";
import { refundBounds } from "./reconcile";
import { canTransition, transition } from "./case-machine";
import { activeIntent, applyOutcome, idempotencyKeyFor, intentIdFor, intentRef, OutcomeNotRecorded } from "./refund-intent";
import { logDecision } from "@/lib/obs/decision-log";

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/** What the token is bound to. Any change to the observation or the reconciliation breaks it. */
export const approvalDigest = (c: ReturnCase, amountCents: number) =>
  digestOf({ caseId: c.id, rmaId: c.rmaId, orderId: c.orderId, count: c.count ?? null, reconciliation: c.reconciliation ?? null, amountCents });

const IN_FLIGHT = "a refund for this case is in flight and its outcome isn't settled (pending or unknown); new approvals and holds are blocked until recovery retrieves it";

export interface ApproveInput {
  approver: string;
  amountCents: number;
  note: string;
  /** Approving more than the policy 4.3 partial on a held case requires an override reason. */
  overrideReason?: string;
}

export async function approveCase(
  deps: { store: CaseStore; secret: string; now?: () => Date },
  caseId: string,
  rma: Rma,
  input: ApproveInput,
): Promise<{ case: ReturnCase; token: string; expiresAt: string }> {
  const now = deps.now?.() ?? new Date();
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  if (activeIntent(c)) throw new ServiceError("refund_in_progress", IN_FLIGHT, 409);
  if (!canTransition(c.state, "APPROVE")) throw new ServiceError("bad_state", `a case in state ${c.state} can't be approved`, 409);
  if (!c.reconciliation || !c.count) throw new ServiceError("incomplete", "the inspection has not finished", 409);
  const approver = input.approver.trim();
  if (!approver) throw new ServiceError("approver_required", "an approver name is required");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ServiceError("bad_amount", "amount must be a positive whole number of cents");

  const { fullCents, partialCents } = refundBounds(c.reconciliation, rma);
  if (input.amountCents > fullCents) throw new ServiceError("over_requested", "amount exceeds the requested refund");
  const clean = c.reconciliation.summary.allClear;
  const override = !clean && input.amountCents > partialCents;
  if (override && (input.overrideReason ?? "").trim().length < 10) {
    throw new ServiceError("override_reason_required", `approving more than the policy 4.3 amount on a held case needs an override reason (10+ characters)`);
  }
  if (!clean && !input.note.trim()) throw new ServiceError("note_required", "a note is required to approve a held return");

  const digest = approvalDigest(c, input.amountCents);
  const { token, payload } = issueToken({ caseId: c.id, rmaId: c.rmaId, digest, amountCents: input.amountCents, approver }, deps.secret, now.getTime(), APPROVAL_TTL_MS);
  let next = transition(
    c,
    { type: "APPROVE", approver, detail: `${approver} approved ${input.amountCents} cents${override ? ` (override: ${input.overrideReason})` : ""}. ${input.note}`.trim() },
    `person:${approver}`,
    now,
  );
  next = {
    ...next,
    approval: {
      approver,
      amountCents: input.amountCents,
      note: input.note,
      override,
      digest,
      nonce: payload.nonce,
      issuedAt: new Date(payload.iat).toISOString(),
      expiresAt: new Date(payload.exp).toISOString(),
    },
  };
  const saved = await deps.store.put(next, c.version);
  logDecision({ caseId: c.id, rmaId: c.rmaId, runId: c.runId, kind: "human_approve", state: saved.state, recommendation: c.draft?.draft.recommendation, approvedCents: input.amountCents, override });
  return { case: saved, token, expiresAt: saved.approval!.expiresAt };
}

type OrderRef = { id: string; totalCents: number; customerEmail: string };

export interface RefundDeps {
  store: CaseStore;
  secret: string;
  rail: RefundRail | Error;
  now?: () => Date;
  /** The case's order (defaults to the seeded fixture order), so the rail can make sure its test charge exists. */
  order?: OrderRef;
}

const MAX_REJECTIONS = 20;

/**
 * Record a refused token action on the case so it stays visible after a reload. Only for tokens
 * whose signature verified for THIS case (garbage can't write), best-effort, never blocks the refusal.
 */
async function rejectWith(store: CaseStore, c: ReturnCase, code: string, message: string, status: number, now: Date): Promise<never> {
  const entry = { at: now.toISOString(), code, message };
  // Append-only note: on a version conflict (e.g. the winning click's write) re-read and append again.
  let cur: ReturnCase | null = c;
  for (let i = 0; i < 4 && cur; i++) {
    try {
      await store.put({ ...cur, tokenRejections: [...(cur.tokenRejections ?? []), entry].slice(-MAX_REJECTIONS) }, cur.version);
      break;
    } catch (e) {
      if (!(e instanceof VersionConflict)) break;
      cur = await store.get(c.id).catch(() => null);
    }
  }
  throw new ServiceError(code, message, status);
}

export async function refundCase(deps: RefundDeps, caseId: string, token: string): Promise<ReturnCase> {
  const now = deps.now?.() ?? new Date();
  const v = verifyToken(token, deps.secret, caseId, now.getTime());
  if (!v.ok) throw new ServiceError(`token_${v.error}`, `approval token rejected: ${v.error}`, 403);
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  if (c.state !== "Approved" || !c.approval) return rejectWith(deps.store, c, "bad_state", `a case in state ${c.state} can't be refunded`, 409, now);
  if (v.payload.nonce !== c.approval.nonce) return rejectWith(deps.store, c, "token_superseded", "this approval was replaced by a newer one", 403, now);
  if (activeIntent(c)) return rejectWith(deps.store, c, "refund_in_progress", `${IN_FLIGHT}; the token was already spent on it`, 409, now);

  // Spend the nonce BEFORE any money moves: a replay can never refund twice.
  if (!(await deps.store.consumeNonce(v.payload.nonce))) return rejectWith(deps.store, c, "token_used", "approval token already used", 403, now);

  const digestNow = approvalDigest(c, v.payload.amountCents);
  if (digestNow !== v.payload.digest || digestNow !== c.approval.digest) {
    const held = transition(c, { type: "HOLD", reasons: ["approval_digest_mismatch"], detail: "the evidence changed after approval; re-review required" }, "system", now);
    await deps.store.put(held, c.version);
    throw new ServiceError("digest_mismatch", "the case changed after it was approved; it is held again", 409);
  }

  const failClosed = async (reason: string, detail: string, kindDetail: string) => {
    const held = transition(c, { type: "ERROR", reason, detail }, "system", now);
    await deps.store.put(held, c.version).catch(() => {});
    logDecision({ caseId: c.id, rmaId: c.rmaId, runId: c.runId, kind: "refund_failed", state: held.state, detail: kindDetail });
  };

  if (deps.rail instanceof Error) {
    await failClosed("refund_rail_unavailable", deps.rail.message, deps.rail.message);
    throw new ServiceError("rail_unavailable", `refund rail unavailable: ${deps.rail.message}`, 503);
  }
  const rail = deps.rail;

  // The original test-mode charge the intent refunds against. No refund is sent here.
  const fixture = orderFor(c.orderId);
  const order = deps.order ?? (fixture ? { id: fixture.id, totalCents: fixture.totalCents, customerEmail: fixture.customer.email } : undefined);
  if (!order) {
    await failClosed("refund_rail_error", `no order ${c.orderId} to refund against; nothing was sent to Stripe`, "no order");
    throw new ServiceError("rail_error", `refund failed: no order ${c.orderId}; nothing was sent to Stripe`, 502);
  }
  let charge: { chargeId: string; paymentIntentId: string };
  try {
    charge = await rail.ensureCharge(order);
    if (!charge.chargeId || !charge.paymentIntentId) throw new Error("the seeded charge has no charge id");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failClosed("refund_rail_error", `couldn't prepare the original charge, so no refund was sent: ${msg}`, msg);
    throw new ServiceError("rail_error", `refund failed before anything was sent to Stripe: ${msg}`, 502);
  }

  // Reserve the intent in the store BEFORE Stripe. A conflicting write that leaves this approval
  // intact (e.g. a rejected double-click being noted) is retried; anything else aborts.
  const intentId = intentIdFor(c.id, v.payload.amountCents, v.payload.nonce);
  const at = now.toISOString();
  const intent: RefundIntent = {
    id: intentId,
    caseId: c.id,
    amountCents: v.payload.amountCents,
    approver: v.payload.approver,
    approvalNonce: v.payload.nonce,
    digest: v.payload.digest,
    chargeId: charge.chargeId,
    paymentIntentId: charge.paymentIntentId,
    idempotencyKey: idempotencyKeyFor(intentId),
    createdAt: at,
    updatedAt: at,
    outcome: "pending",
    attempts: [],
  };
  let base = c;
  let reserved: ReturnCase | null = null;
  for (let i = 0; i < 4 && !reserved; i++) {
    const stillValid = base.state === "Approved" && base.approval?.nonce === v.payload.nonce && !activeIntent(base) && approvalDigest(base, v.payload.amountCents) === v.payload.digest;
    if (!stillValid) break;
    try {
      reserved = await deps.store.put(
        {
          ...base,
          updatedAt: at,
          refundIntents: [...(base.refundIntents ?? []), intent],
          audit: [...base.audit, { at, actor: "system", event: "REFUND_INTENT", from: base.state, to: base.state, detail: `refund intent ${intentId} reserved for ${intent.amountCents} cents against ${intent.chargeId} (idempotency key ${intent.idempotencyKey}) before calling Stripe` }],
        },
        base.version,
      );
    } catch (e) {
      if (!(e instanceof VersionConflict)) throw new ServiceError("store_unavailable", `the refund intent couldn't be saved, so nothing was sent to Stripe: ${e instanceof Error ? e.message : String(e)}`, 503);
      const fresh = await deps.store.get(caseId).catch(() => null);
      if (!fresh) break;
      base = fresh;
    }
  }
  if (!reserved) throw new ServiceError("intent_not_reserved", "the case changed while the refund intent was being reserved, so nothing was sent to Stripe. Request a new approval.", 409);

  let r: RailOutcome;
  try {
    r = wellFormed(await rail.refund(intentRef(reserved, intent)), "create");
  } catch (e) {
    // A rail that throws instead of classifying: only an explicit 4xx counts as "no refund".
    r = { ...classifyStripeError(e), via: "create" };
  }
  const saved = await record(deps.store, reserved, intentId, r, "person", now);
  if (r.outcome === "failed") throw new ServiceError("rail_error", `refund failed: Stripe confirmed nothing was refunded (${r.code}: ${r.message}). Safe to request a new approval.`, 502);
  return saved;
}

/** A rail answer we can't read proves nothing either way: it is unknown, never success or failure. */
function wellFormed(r: RailOutcome | null | undefined, via: RailOutcome["via"]): RailOutcome {
  const ok =
    r &&
    (((r.outcome === "succeeded" || r.outcome === "pending") && typeof r.refund?.refundId === "string" && r.refund.refundId.length > 0) ||
      ((r.outcome === "failed" || r.outcome === "unknown") && typeof r.code === "string"));
  return ok ? r : { outcome: "unknown", via, code: "malformed_rail_outcome", message: "the refund rail returned an answer without a readable outcome" };
}

/** Persist a rail outcome; log the decision. A store failure here leaves the intent pending for recovery. */
async function record(store: CaseStore, c: ReturnCase, intentId: string, r: RailOutcome, by: "person" | "recovery", now: Date): Promise<ReturnCase> {
  let saved: ReturnCase;
  try {
    saved = await applyOutcome(store, c.id, intentId, r, by, now);
  } catch (e) {
    if (!(e instanceof OutcomeNotRecorded)) throw e;
    throw new ServiceError("refund_record_pending", `Stripe answered (${r.outcome}) but the result couldn't be saved: ${e.message}. The intent stays pending; recovery will retrieve it, and new approvals stay blocked.`, 503);
  }
  const base = { caseId: c.id, rmaId: c.rmaId, runId: c.runId, state: saved.state };
  if (r.outcome === "succeeded") logDecision({ ...base, kind: "refund", approvedCents: r.refund.amountCents, detail: `${by}:${r.via}` });
  else if (r.outcome === "failed") logDecision({ ...base, kind: "refund_failed", detail: `${r.code}: ${r.message}` });
  else logDecision({ ...base, kind: "refund_unknown", detail: `${r.outcome} ${r.outcome === "unknown" ? r.code : r.refund.status}` });
  return saved;
}

/**
 * Settle an intent whose outcome is pending or unknown. Takes no token: it can only retrieve the
 * intent's refund or re-send the SAME create (same idempotency key, amount and charge).
 */
export async function recoverRefund(deps: { store: CaseStore; rail: RefundRail | Error; now?: () => Date }, caseId: string): Promise<ReturnCase> {
  const now = deps.now?.() ?? new Date();
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  const intent = activeIntent(c);
  if (!intent) throw new ServiceError("no_refund_in_progress", "no refund intent is waiting on an outcome for this case", 409);
  if (deps.rail instanceof Error) throw new ServiceError("rail_unavailable", `refund rail unavailable: ${deps.rail.message}; the outcome stays unknown and new approvals stay blocked`, 503);
  let r: RailOutcome;
  try {
    r = wellFormed(await deps.rail.recover(intentRef(c, intent)), "lookup");
  } catch (e) {
    r = { ...classifyStripeError(e), via: "lookup" };
    // A recovery that blew up without an answer proves nothing either way.
    if (r.outcome === "failed") r = { outcome: "unknown", via: "lookup", code: r.code, message: r.message };
  }
  return record(deps.store, c, intent.id, r, "recovery", now);
}

export async function holdCase(deps: { store: CaseStore; now?: () => Date }, caseId: string, person: string, reason: string): Promise<ReturnCase> {
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  if (!person.trim() || !reason.trim()) throw new ServiceError("bad_input", "a name and a reason are required");
  // Voiding an approval whose refund may already have happened would be a lie: settle it first.
  if (activeIntent(c)) throw new ServiceError("refund_in_progress", IN_FLIGHT, 409);
  if (!canTransition(c.state, "HOLD")) throw new ServiceError("bad_state", `a case in state ${c.state} can't be held`, 409);
  const next = transition(c, { type: "HOLD", reasons: ["held_by_person"], detail: `${person}: ${reason}` }, `person:${person.trim()}`, deps.now?.() ?? new Date());
  const saved = await deps.store.put({ ...next, approval: undefined }, c.version);
  logDecision({ caseId: c.id, rmaId: c.rmaId, runId: c.runId, kind: "human_hold", state: saved.state, detail: reason });
  return saved;
}
