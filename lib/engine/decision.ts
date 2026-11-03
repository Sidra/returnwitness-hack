/**
 * Decision drafts. A draft recommends and cites the policy clause it relied on; it never
 * authorises anything and never changes a case's state. A model draft that cites a clause
 * that doesn't exist, misquotes one, proposes more than the RMA, or recommends anything but
 * HOLD while a line isn't OK is rejected and replaced by the deterministic template.
 */
import { DecisionDraft, type Policy, type Reconciliation, type Rma } from "@/lib/domain/schemas";
import { refundBounds } from "./reconcile";
import { formatCents } from "@/lib/format";

const squash = (s: string) => s.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();

/**
 * A clause quote is verbatim when it is part of the clause text. Models are shown clauses as "<id> <Title>. <text>"
 * (policyText), and Muse Wonder quoted them as "<Title>. <text>" and as "<id> <Title>. <text>" in the first live
 * runs, so that leading label is allowed; the quote must still carry clause text: a bare label cites nothing.
 */
export function quotesClause(quote: string, clause: { id?: string; title: string; text: string }): boolean {
  let q = squash(quote);
  if (clause.id && q.startsWith(`${squash(clause.id)} `)) q = q.slice(clause.id.length).trim();
  const title = squash(`${clause.title}.`);
  if (q.startsWith(title)) q = q.slice(title.length).trim();
  return q.length > 0 && squash(clause.text).includes(q);
}

export interface DraftCheck {
  ok: boolean;
  errors: string[];
}

export function validateDraft(raw: unknown, ctx: { policy: Policy; recon: Reconciliation; rma: Rma; voiceNote?: string }): DraftCheck & { draft?: DecisionDraft } {
  const parsed = DecisionDraft.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const d = parsed.data;
  const errors: string[] = [];
  for (const c of d.citedClauses) {
    const clause = ctx.policy.clauses.find((x) => x.id === c.clauseId);
    if (!clause) errors.push(`cites clause ${c.clauseId}, which is not in policy ${ctx.policy.version}`);
    else if (!quotesClause(c.quote, clause)) errors.push(`quote for clause ${c.clauseId} is not verbatim policy text`);
  }
  if (d.citedVoiceNote != null) {
    if (!ctx.voiceNote) errors.push("quotes a voice note, but no voice note was recorded for this box");
    else if (!d.citedVoiceNote.trim() || !squash(ctx.voiceNote).includes(squash(d.citedVoiceNote))) errors.push("voice-note quote is not verbatim transcript text");
  }
  if (d.proposedRefundCents > ctx.rma.requestedRefundCents) errors.push("proposes more than the RMA's requested refund");
  if (!ctx.recon.summary.allClear && d.recommendation !== "HOLD") errors.push(`recommends ${d.recommendation} while a line is not OK; only HOLD is allowed`);
  if (ctx.recon.summary.allClear && d.recommendation === "APPROVE_PARTIAL") errors.push("recommends a partial refund on a complete return");
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], draft: d };
}

const clause = (policy: Policy, id: string) => {
  const c = policy.clauses.find((x) => x.id === id);
  if (!c) throw new Error(`policy ${policy.id} has no clause ${id}`);
  return { clauseId: c.id, quote: c.text };
};

/** Below: the deterministic draft, used when no model draft is available or a model draft fails validation. */
/** First sentence of a transcript (≤ 200 chars), for a short verbatim quote. */
export function noteQuote(transcript: string): string {
  const t = transcript.trim().replace(/\s+/g, " ");
  const m = /^(.{1,200}?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 200);
}

/** The deterministic draft, plus the returns lead's note quoted verbatim when there is one. */
export function templateDraft(ctx: { policy: Policy; recon: Reconciliation; rma: Rma; voiceNote?: string }): DecisionDraft {
  const base = baseTemplateDraft(ctx);
  if (!ctx.voiceNote?.trim()) return base;
  const quote = noteQuote(ctx.voiceNote);
  return { ...base, citedVoiceNote: quote, rationale: `${base.rationale} The returns lead's note at the bench (transcribed): "${quote}"` };
}

function baseTemplateDraft(ctx: { policy: Policy; recon: Reconciliation; rma: Rma }): DecisionDraft {
  const { recon, rma, policy } = ctx;
  const { partialCents } = refundBounds(recon, rma);
  const missing = recon.lines.filter((l) => l.status === "MISSING");
  const held = recon.lines.filter((l) => l.status === "HELD" || l.status === "EXTRA");
  const lineNotes = recon.lines
    .filter((l) => l.status !== "OK")
    .map((l) => ({ itemKey: l.itemKey, note: `${l.description}: ${l.status}. ${l.reasons.map((r) => r.detail).join("; ")}` }));

  if (recon.summary.allClear) {
    return {
      recommendation: "APPROVE_FULL",
      proposedRefundCents: rma.requestedRefundCents,
      citedClauses: [clause(policy, "4.2")],
      rationale: `Every component on the packing slip was seen settling in the tray. Under clause 4.2 the kit qualifies for a full refund of ${formatCents(rma.requestedRefundCents)}, once a person approves.`,
      lineNotes,
    };
  }
  const windowHold = recon.policyHolds?.find((h) => h.code === "outside_return_window");
  if (windowHold && !missing.length && !held.length) {
    return {
      recommendation: "HOLD",
      proposedRefundCents: rma.requestedRefundCents,
      citedClauses: [clause(policy, windowHold.clauseId), clause(policy, "5.1")],
      rationale: `Every component was seen, but the ${windowHold.detail}. Hold the ${formatCents(rma.requestedRefundCents)} refund until a person confirms the delivery date; if it was in time, they can approve the full amount with that reason on the record. Under clause 5.1 a hold is not a denial.`,
      lineNotes,
    };
  }
  if (missing.length && !held.length) {
    const names = missing.map((l) => l.description.toLowerCase()).join(", ");
    return {
      recommendation: "HOLD",
      proposedRefundCents: partialCents,
      citedClauses: [clause(policy, "4.2"), clause(policy, "4.3")],
      rationale: `The ${names} ${missing.length > 1 ? "were" : "was"} not observed, so the kit is incomplete and clause 4.2 rules out a full refund. Hold the ${formatCents(rma.requestedRefundCents)} refund. Under clause 4.3 a reviewer may approve a partial refund of ${formatCents(partialCents)}.`,
      lineNotes,
    };
  }
  return {
    recommendation: "HOLD",
    proposedRefundCents: partialCents,
    citedClauses: [clause(policy, "3.1"), clause(policy, "5.1")],
    rationale: `The inspection could not settle ${held.map((l) => l.description.toLowerCase()).join(", ")}${missing.length ? ` and found ${missing.map((l) => l.description.toLowerCase()).join(", ")} missing` : ""}. Hold the refund for a person to look at the evidence. Under clause 5.1 a hold is not a denial.`,
    lineNotes,
  };
}
