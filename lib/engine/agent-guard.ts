/**
 * The rule that makes the Wonder agent verifiable: app code judges every state change the agent
 * proposes. The agent may only move a case TOWARD HELD. It can never approve: APPROVED requires a
 * person's approval token, which the agent never sees. A proposal about stale evidence (digest
 * mismatch) is rejected. The guard runs in app code on live AND replayed agent runs.
 */
import type { CaseState } from "@/lib/domain/case";
import type { Reconciliation } from "@/lib/domain/schemas";
import { digestOf } from "./digest";

export { AGENT_LIMITS } from "./agent-limits";
import { AGENT_LIMITS } from "./agent-limits";

/** The only tools the agent has. Nothing here approves, clears a hold or refunds; any other name is rejected. */
export const AGENT_TOOLS = ["read_reconciliation", "propose_transition", "request_evidence"] as const;

export function rejectUnknownTool(name: string): GuardVerdict {
  return { accepted: false, effect: "none", reason: `rejected: unknown tool "${name.slice(0, 60)}"; the agent's only tools are ${AGENT_TOOLS.join(", ")}, and none of them can approve or refund` };
}

export type ProposedState = "HELD" | "AWAITING_APPROVAL" | "APPROVED";

export interface Proposal {
  to_state: ProposedState;
  evidence_digest: string;
  reason: string;
}

export interface GuardVerdict {
  accepted: boolean;
  /** What the application does: put the case on hold, or nothing. Never anything else. */
  effect: "hold" | "none";
  reason: string;
}

/** Digest of the evidence the agent reasons over: stable for the same clip, counts and lines. */
export const evidenceDigest = (rmaId: string, recon: Reconciliation) =>
  digestOf({ rmaId, lines: recon.lines.map((l) => ({ k: l.itemKey, e: l.expectedQty, o: l.observedQty, s: l.status, r: l.reasons.map((x) => x.code) })) }).slice(0, 16);

export function judgeProposal(ctx: { state: CaseState; digest: string }, p: Partial<Proposal> | null | undefined): GuardVerdict {
  if (!p || typeof p.to_state !== "string") return { accepted: false, effect: "none", reason: "malformed proposal: no to_state" };
  if (p.to_state === "APPROVED") return { accepted: false, effect: "none", reason: "rejected: APPROVED needs a person's approval token; an agent can never approve or refund" };
  if (p.evidence_digest !== ctx.digest) return { accepted: false, effect: "none", reason: `rejected: evidence digest ${String(p.evidence_digest).slice(0, 16)} doesn't match the case (${ctx.digest})` };
  if (p.to_state === "HELD") {
    if (ctx.state === "Held") return { accepted: true, effect: "none", reason: "accepted: the case is already held" };
    if (ctx.state === "AwaitingApproval" || ctx.state === "Reconciled") return { accepted: true, effect: "hold", reason: "accepted: the agent may always move a case toward HELD" };
    return { accepted: false, effect: "none", reason: `rejected: a case in state ${ctx.state} can't be held by the agent` };
  }
  if (p.to_state === "AWAITING_APPROVAL") {
    if (ctx.state === "AwaitingApproval") return { accepted: true, effect: "none", reason: "accepted: no change (already waiting for a person)" };
    return { accepted: false, effect: "none", reason: `rejected: the agent can only move toward HELD, not from ${ctx.state} to AWAITING_APPROVAL` };
  }
  return { accepted: false, effect: "none", reason: `rejected: unknown state ${String(p.to_state)}` };
}
