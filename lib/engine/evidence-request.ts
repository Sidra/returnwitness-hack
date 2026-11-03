/**
 * Bounded requests for missing evidence (U03). The decision agent may ask a PERSON for one more piece
 * of evidence about a slip line that is not OK: a close-up of the label, a view of the underside, or a
 * spoken observation from the returns lead. App code judges every request; the agent never waits for
 * the answer. The run ends with the case HELD and the request left open as a work item.
 *
 * What a request can't do: approve, clear a hold, or reach the refund. Supplying evidence is a person's
 * action (a typed note for now), bound to the case's current evidence digest; when the evidence the
 * request was asked about has changed, the request is stale and the note is refused. The note is stored
 * as text and never interpreted: "approve / refund now" in it is just words on the record.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvidenceKind, EvidenceRequest, ReturnCase } from "@/lib/domain/case";
import type { ModeLabel, Reconciliation } from "@/lib/domain/schemas";
import type { CaseStore } from "@/lib/store/case-store";
import { VersionConflict } from "@/lib/store/errors";
import { logDecision } from "@/lib/obs/decision-log";
import { ServiceError } from "./service";
import { AGENT_LIMITS, evidenceDigest } from "./agent-guard";

/** An app control on one agent run (the model is told it; app code enforces it). */
export const MAX_EVIDENCE_REQUESTS = AGENT_LIMITS.maxEvidenceRequests;

export const EVIDENCE_KINDS = ["label_closeup", "underside", "spoken_observation"] as const satisfies readonly EvidenceKind[];

export const EVIDENCE_KIND_TEXT: Record<EvidenceKind, string> = {
  label_closeup: "a close-up of the label",
  underside: "a view of the underside",
  spoken_observation: "a spoken observation from the returns lead",
};

/** The request_evidence tool's arguments, strict: any other key, a missing key or an unknown kind is malformed. */
export const EvidenceRequestArgs = z
  .object({
    itemKey: z.string().trim().min(1).max(64),
    kind: z.enum(EVIDENCE_KINDS),
    reason: z.string().trim().min(1).max(200),
    evidence_digest: z.string().min(1).max(64),
  })
  .strict();
export type EvidenceRequestArgs = z.infer<typeof EvidenceRequestArgs>;

export interface EvidenceVerdict {
  accepted: boolean;
  /** A request never changes the case state by itself; the case is already HELD (its line is not OK). */
  effect: "request" | "none";
  reason: string;
}

export interface EvidenceJudgeCtx {
  digest: string;
  recon: Reconciliation;
  /** Requests already accepted in this run. */
  accepted: Array<Pick<EvidenceRequest, "itemKey" | "kind">>;
}

/** App code's judgement of one request_evidence call. Pure, so a replayed run is re-judged the same way. */
export function judgeEvidenceRequest(ctx: EvidenceJudgeCtx, raw: unknown): { verdict: EvidenceVerdict; args?: EvidenceRequestArgs } {
  const parsed = EvidenceRequestArgs.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ");
    return { verdict: { accepted: false, effect: "none", reason: `rejected: malformed request_evidence (${why})` } };
  }
  const a = parsed.data;
  if (a.evidence_digest !== ctx.digest) return { verdict: { accepted: false, effect: "none", reason: `rejected: evidence digest ${a.evidence_digest.slice(0, 16)} doesn't match the case (${ctx.digest})` } };
  const line = ctx.recon.lines.find((l) => l.itemKey === a.itemKey);
  if (!line) return { verdict: { accepted: false, effect: "none", reason: `rejected: "${a.itemKey}" is not a line on this packing slip` } };
  if (line.status === "OK") return { verdict: { accepted: false, effect: "none", reason: `rejected: ${a.itemKey} is already OK; evidence can only be requested for a line that is not OK` } };
  if (ctx.accepted.length >= MAX_EVIDENCE_REQUESTS) return { verdict: { accepted: false, effect: "none", reason: `rejected: at most ${MAX_EVIDENCE_REQUESTS} evidence requests per run` } };
  if (ctx.accepted.some((r) => r.itemKey === a.itemKey && r.kind === a.kind)) return { verdict: { accepted: false, effect: "none", reason: `rejected: ${EVIDENCE_KIND_TEXT[a.kind]} for ${a.itemKey} was already requested in this run` } };
  return {
    verdict: { accepted: true, effect: "request", reason: `accepted: ${EVIDENCE_KIND_TEXT[a.kind]} for ${a.itemKey} (${line.status}) is now an open request for a person; the case stays HELD and the agent doesn't wait for it` },
    args: a,
  };
}

export function newEvidenceRequest(a: EvidenceRequestArgs, by: { model: string; mode: ModeLabel; at: Date; id?: string }): EvidenceRequest {
  return { id: by.id ?? `evr_${randomUUID().slice(0, 8)}`, itemKey: a.itemKey, kind: a.kind, reason: a.reason, digest: a.evidence_digest, status: "open", requestedBy: by.model, mode: by.mode, requestedAt: by.at.toISOString() };
}

/** The case's current evidence digest, the same one the agent was given. Null before reconciliation. */
export const caseDigest = (c: ReturnCase): string | null => (c.reconciliation ? evidenceDigest(c.rmaId, c.reconciliation) : null);

export const listEvidenceRequests = (c: ReturnCase): EvidenceRequest[] => c.evidenceRequests ?? [];

export async function getEvidenceRequests(deps: { store: CaseStore }, caseId: string): Promise<{ requests: EvidenceRequest[]; digest: string | null }> {
  const c = await deps.store.get(caseId);
  if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
  return { requests: listEvidenceRequests(c), digest: caseDigest(c) };
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** What a person sends to answer one open request. */
export const SupplyEvidenceInput = z.object({
  requestId: text(64),
  /** A typed note (no file upload yet). Stored verbatim, never interpreted. */
  note: text(1000),
  person: text(80),
  /** The evidence digest the person was looking at; it must be the case's current one. */
  evidenceDigest: text(64),
});
export type SupplyEvidenceInput = z.input<typeof SupplyEvidenceInput>;

/**
 * A person answers an open evidence request with a typed note. The answer binds to the case's current
 * evidence digest. It changes nothing but the request's status and the audit trail: the state, the hold
 * reasons, any approval and the refund are untouched, so the existing hold stays for a person to resolve.
 *
 * - request asked about evidence that has since changed → the request is marked stale (persisted) and the note refused (409)
 * - the person's view is stale (digest ≠ the case's) → refused (409), the request stays open
 * - request already answered or stale, or the case already approved/refunded → refused (409)
 */
export async function supplyEvidence(
  deps: { store: CaseStore; now?: () => Date },
  caseId: string,
  input: unknown,
): Promise<{ case: ReturnCase; request: EvidenceRequest }> {
  const parsed = SupplyEvidenceInput.safeParse(input);
  if (!parsed.success) throw new ServiceError("bad_input", `invalid evidence: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}`, 400);
  const inp = parsed.data;

  for (let attempt = 0; ; attempt++) {
    const c = await deps.store.get(caseId);
    if (!c) throw new ServiceError("not_found", `case ${caseId} not found`, 404);
    const reqs = listEvidenceRequests(c);
    const r = reqs.find((x) => x.id === inp.requestId);
    if (!r) throw new ServiceError("unknown_request", `no evidence request ${inp.requestId} on case ${caseId}`, 404);
    if (r.status !== "open") throw new ServiceError("request_closed", `evidence request ${r.id} is ${r.status}; only an open request can be answered`, 409);
    if (c.state === "Approved" || c.state === "Refunded") throw new ServiceError("case_closed", `case ${caseId} is ${c.state}; a person already resolved it`, 409);
    const digest = caseDigest(c);
    const at = (deps.now?.() ?? new Date()).toISOString();
    const actor = `person:${inp.person}` as const;

    let next: ReturnCase;
    let outcome: "answered" | "stale";
    if (!digest || digest !== r.digest) {
      // The evidence the agent asked about is gone: invalidate the request rather than attach an answer to different evidence.
      const staleDetail = `the case evidence changed (digest ${r.digest} → ${digest ?? "none"}) after the request was made`;
      const stale: EvidenceRequest = { ...r, status: "stale", staleDetail };
      next = { ...c, updatedAt: at, evidenceRequests: reqs.map((x) => (x.id === r.id ? stale : x)), audit: [...c.audit, { at, actor, event: "EVIDENCE_STALE", from: c.state, to: c.state, detail: `${inp.person} tried to answer evidence request ${r.id} (${r.itemKey}), but ${staleDetail}; the request is invalidated and the hold stays` }] };
      outcome = "stale";
    } else {
      if (inp.evidenceDigest !== digest) throw new ServiceError("stale_view", `you answered against evidence digest ${inp.evidenceDigest}, but the case is at ${digest}; reload the case`, 409);
      const answered: EvidenceRequest = { ...r, status: "answered", answer: { kind: "typed_note", note: inp.note, person: inp.person, at, digest } };
      next = {
        ...c,
        updatedAt: at,
        evidenceRequests: reqs.map((x) => (x.id === r.id ? answered : x)),
        // Same state in and out: the note is evidence on the record, not a decision.
        audit: [...c.audit, { at, actor, event: "EVIDENCE_SUPPLIED", from: c.state, to: c.state, detail: `${inp.person} answered evidence request ${r.id} (${EVIDENCE_KIND_TEXT[r.kind]} for ${r.itemKey}) with a typed note; the hold stays for a person to resolve (no approval, no refund)` }],
      };
      outcome = "answered";
    }
    let saved: ReturnCase;
    try {
      saved = await deps.store.put(next, c.version);
    } catch (e) {
      if (!(e instanceof VersionConflict) || attempt >= 2) throw e;
      continue;
    }
    const request = listEvidenceRequests(saved).find((x) => x.id === r.id)!;
    logDecision({ caseId: c.id, rmaId: c.rmaId, runId: c.runId, kind: outcome === "answered" ? "evidence_supplied" : "evidence_stale", state: saved.state, detail: `${r.id} ${r.itemKey} ${r.kind}` });
    if (outcome === "stale") throw new ServiceError("stale_request", `evidence request ${r.id} is stale: ${request.staleDetail}`, 409);
    return { case: saved, request };
  }
}
