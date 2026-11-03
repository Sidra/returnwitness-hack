/**
 * Replaying a recorded live answer inside the coordinator. Pure: no network, no file reads.
 * A recording only ever adds restriction: holds and work items are the union of the deterministic
 * result and the live one, and each role's `combine` keeps the more restrictive output. A recording
 * that failed (call error, schema failure, an answer app code rejects) leaves the deterministic
 * result in place, with the error on the step.
 */
import { combineDefault, type LiveRoleDef, type ReturnCtx } from "./context";
import { labelReaderLive } from "./agents/label-reader";
import { damageReaderLive } from "./agents/damage-reader";
import { voiceNoteReaderLive } from "./agents/voice-note-reader";
import { carrierClaimLive } from "./agents/carrier-claim";
import { policyLive } from "./agents/policy";
import { restockGraderLive } from "./agents/restock-grader";
import { messageDrafterLive } from "./agents/message-drafter";
import type { AgentResult, FleetRecording, LiveProofData, RoleId, StepSource, UnavailableInfo, UnavailableKind } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each role has its own output/answer types
export type AnyLiveRole = LiveRoleDef<any, any>;

/** Every model role's live definition, in run order. */
export const LIVE_ROLES: AnyLiveRole[] = [labelReaderLive, damageReaderLive, voiceNoteReaderLive, carrierClaimLive, policyLive, restockGraderLive, messageDrafterLive];
export const liveRoleFor = (role: RoleId): AnyLiveRole | undefined => LIVE_ROLES.find((d) => d.role === role);

export interface MergedStep<O> {
  result: AgentResult<O>;
  source: StepSource;
  proof?: LiveProofData;
  /** Set when the live answer was not used: the app-code result stands in, labelled as app code. */
  unavailable?: UnavailableInfo;
}

/** How a failed call's error reads as an unavailable kind. */
export function unavailableKindOf(rec: Pick<FleetRecording, "error" | "timedOut">): UnavailableKind {
  if (rec.timedOut || /\btime(d)? ?out\b|timeout/i.test(rec.error ?? "")) return "timeout";
  if (/schema validation failed|rejected/i.test(rec.error ?? "")) return "malformed";
  return "call_failed";
}

export interface ApplyOptions {
  /** Set when the box has nothing for this role to read (lib/fleet/dispatch.ts): a live answer for it is rejected. */
  missingEvidence?: string | null;
}

/**
 * Combine a deterministic result with a recorded live answer for the same role and box. A recording is rejected (the
 * app-code result stands in, holds kept, and the step says LIVE ANSWER UNAVAILABLE with the reason) when the call failed or
 * stalled, the answer is malformed, it was recorded for another box or role, or the box has no evidence for the role.
 */
export function applyRecorded<O>(def: LiveRoleDef<O, unknown>, det: AgentResult<O>, rec: FleetRecording, ctx: ReturnCtx, opts: ApplyOptions = {}): MergedStep<O> {
  const proof: LiveProofData = { model: rec.model, latencyMs: rec.latencyMs, recordedAt: rec.recordedAt, ...(rec.requestId ? { requestId: rec.requestId } : {}) };
  const fallback = (kind: UnavailableKind, error: string): MergedStep<O> => ({
    result: { ...det, trace: `live answer not used (${error}); app code: ${det.trace}` },
    source: "live_rejected",
    proof: { ...proof, error },
    unavailable: { kind, reason: error },
  });
  if (rec.rmaId !== ctx.ret.rma.id) return fallback("wrong_case", `answer recorded for ${rec.rmaId}, not ${ctx.ret.rma.id}`);
  if (rec.role !== def.role) return fallback("wrong_case", `answer recorded for the ${rec.role}, not the ${def.role}`);
  if (opts.missingEvidence) return fallback("missing_evidence", `missing evidence: ${opts.missingEvidence}`);
  if (!rec.ok || rec.output == null) return fallback(unavailableKindOf(rec), rec.error ?? "no answer");
  const parsed = def.schema.safeParse(rec.output);
  if (!parsed.success) return fallback("malformed", "schema validation failed");
  let live: AgentResult<O>;
  try {
    live = def.toResult(parsed.data, ctx);
  } catch (e) {
    return fallback("malformed", e instanceof Error ? e.message : String(e));
  }
  const combined = (def.combine ?? combineDefault)(det, live);
  return { result: combined, source: "recorded_live", proof };
}
