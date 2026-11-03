import type { CountResult, DecisionDraft, ModeLabel, Reconciliation } from "./schemas";

export type CaseState = "Received" | "Counted" | "Reconciled" | "Held" | "AwaitingApproval" | "Approved" | "Refunded";

export type Actor = "system" | `model:${string}` | `person:${string}`;

export interface AuditEntry {
  at: string;
  actor: Actor;
  event: string;
  from: CaseState | null;
  to: CaseState;
  detail: string;
}

export interface StageTiming {
  stage: "listen" | "segment" | "count" | "reconcile" | "draft" | "approve" | "refund";
  ms: number;
  mode: ModeLabel;
  model?: string;
}

export interface StageCost {
  stage: string;
  model: string;
  usd: number;
  basis: string;
}

export interface ApprovalRecord {
  approver: string;
  amountCents: number;
  note: string;
  override: boolean;
  digest: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * What we know about a refund intent's money movement (ADR-005, U08):
 *  - pending:   reserved in the store (and possibly sent), or Stripe accepted it and is settling.
 *  - unknown:   a timeout, dropped connection or 5xx: Stripe may have accepted it. Never "nothing happened".
 *  - succeeded: Stripe's response, a retrieve, or a verified webhook + retrieve says the refund exists.
 *  - failed:    Stripe confirmed it did NOT refund (a 4xx rejection, or a refund in failed/canceled state).
 * pending and unknown block any new approval for the case until recovery settles them.
 */
export type RefundOutcome = "pending" | "unknown" | "succeeded" | "failed";

/** How a settled outcome was established. A webhook alone never settles it: the refund is always retrieved. */
export type RefundConfirmation = "api_response" | "api_retrieve" | "webhook_verified";

export interface RefundAttempt {
  n: number;
  at: string;
  /** person: the approval token's one call; recovery: server-side retry/retrieve of the SAME intent; webhook: a verified event. */
  by: "person" | "recovery" | "webhook";
  /** create: refunds.create with the intent's idempotency key; lookup: found (or not) by retrieve; webhook: a verified delivery. */
  action: "create" | "lookup" | "webhook";
  outcome: RefundOutcome;
  detail: string;
  refundId?: string;
  stripeStatus?: string;
  errorCode?: string;
  eventId?: string;
}

/**
 * A business refund intent: one per approval (case + amount + that approval's nonce). Written to
 * the case store BEFORE Stripe is called, carrying the idempotency key every attempt reuses.
 */
export interface RefundIntent {
  id: string;
  caseId: string;
  amountCents: number;
  approver: string;
  approvalNonce: string;
  digest: string;
  /** The test-mode charge this intent refunds against (fixed at reservation). */
  chargeId: string;
  paymentIntentId: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  outcome: RefundOutcome;
  refundId?: string;
  confirmedBy?: RefundConfirmation;
  /** Set when a signature-verified webhook delivery referenced this intent's refund. */
  webhook?: { eventId: string; type: string; verifiedAt: string };
  failure?: { code: string; message: string };
  attempts: RefundAttempt[];
}

/** A refund call refused because its token was already spent or superseded, or a refund was in flight. */
export interface TokenRejection {
  at: string;
  code: string;
  message: string;
}

export interface RefundRecord {
  refundId: string;
  status: string;
  amountCents: number;
  chargeId: string;
  paymentIntentId: string;
  receiptUrl: string | null;
  createdAt: string;
  livemode: false;
  fee: { paymentIntentId: string; chargeId: string | null; amountCents: number; receiptUrl: string | null } | null;
  /**
   * The charge.refunded event as Stripe's Events API returns it (the same payload a webhook carries).
   * source "events_api": we fetched it ourselves; it is NOT a webhook delivery. Pre-U08 records have no source.
   */
  event: { id: string; type: string; created: number; payload: unknown; source?: "events_api" } | null;
  /** The intent this refund settled, and how that was established. */
  intentId?: string;
  confirmedBy?: RefundConfirmation;
  /** A signature-verified webhook delivery for this refund (distinct from the Events API fetch above). */
  webhook?: { eventId: string; type: string; verifiedAt: string };
  /** The $2.00 inspection fee couldn't be booked; the refund itself still stands. */
  feeError?: string;
}

/** What the decision agent may ask a person for, about one slip line that is not OK (lib/engine/evidence-request.ts). */
export type EvidenceKind = "label_closeup" | "underside" | "spoken_observation";

/** A person's answer to an evidence request. Only a typed note for now (no file upload). */
export interface EvidenceAnswer {
  kind: "typed_note";
  note: string;
  person: string;
  at: string;
  /** The case evidence digest the person answered against (equal to the request's). */
  digest: string;
}

/**
 * An open work item the decision agent left on a held case: "a person should supply this evidence".
 * The agent never waits for it, and it can't approve, clear a hold or refund. It is bound to the
 * evidence digest it was asked about; if the case's evidence changes, the request goes stale.
 */
export interface EvidenceRequest {
  id: string;
  itemKey: string;
  kind: EvidenceKind;
  reason: string;
  digest: string;
  status: "open" | "answered" | "stale";
  /** The model that asked, and how (a live call, or a replay of a recorded live run). */
  requestedBy: string;
  mode: ModeLabel;
  requestedAt: string;
  answer?: EvidenceAnswer;
  /** Why the request was invalidated, when status is "stale". */
  staleDetail?: string;
}

export interface AgentTrace {
  model: string;
  mode: ModeLabel;
  protocol: "tools" | "structured" | "recorded";
  steps: Array<{ kind: string; name?: string; args?: unknown; result?: unknown; verdict?: { accepted: boolean; effect: string; reason: string }; text?: string }>;
  effect: "hold" | "none";
  latencyMs: number;
  /** Meta's id for each completion of a live run (shown on the trace's LIVE proof). */
  requestIds?: string[];
  /** Evidence requests app code accepted during this run (the case keeps their current status). */
  evidenceRequests?: EvidenceRequest[];
  error?: string;
}

export interface DraftRecord {
  draft: DecisionDraft;
  source: "model" | "template";
  mode: ModeLabel;
  model?: string;
  rejected?: { errors: string[] };
  /** The Wonder agent's tool trace (live or replayed), or why it didn't run. */
  agent?: AgentTrace;
  agentNotRun?: string;
}

export interface ReaderRun {
  reader: string;
  model: string;
  provider?: string;
  mode: ModeLabel;
  required: boolean;
  ok: boolean;
  latencyMs: number;
  /** The provider's id for the call (Meta response id), so a LIVE result can be traced to its request. */
  requestId?: string;
  error?: string;
  extras?: unknown;
  /** A replay of a real recorded call: when it was recorded. */
  recordedAt?: string;
  /** What this reader said per line (its own answer, before the most-restrictive merge), for the reader card. */
  lines?: Array<{ itemKey: string; status: string; observedQty: number; serialRead?: string | null }>;
}

/**
 * A person's correction of one model read (lib/learning/corrections.ts validates it). Training
 * data and an audit entry only: it never changes the case's state, reconciliation or money.
 */
export interface ReviewerCorrection {
  id: string;
  caseId: string;
  rmaId: string;
  itemKey: string;
  field: "serial" | "sku" | "present" | "damage";
  /** What the reader said (null when it returned nothing for this field). */
  modelValue: string | null;
  humanValue: string;
  /** Which reader was corrected, e.g. "muse-glimmer (fireworks)". */
  reader: string;
  /** Caption of the crop the reader saw, so the training row can find the same image. */
  cropCaption: string | null;
  person: string;
  at: string;
}

/**
 * What the returns lead said at the bench, transcribed by Muse Voice Transcribe 1.0 (POST /v1/asr/transcribe).
 * It joins the evidence: readers and the decision draft may cite it, but a spoken claim never clears a hold.
 * Seeded demo notes are labelled RECORDED_FIXTURE with a provenance saying so; only a real call is LIVE_META.
 */
export interface VoiceNote {
  transcript: string;
  mode: ModeLabel;
  model: string;
  latencyMs: number;
  audioDurationMs: number;
  /** Meta's sessionId for the transcription request, when live. */
  requestId?: string;
  provenance: string;
  person?: string;
  /** The audio was a synthetic voice reading a scripted note (e.g. for the demo film); the transcription is still real. */
  synthetic?: boolean;
  recordedAt: string;
}

export interface ReturnCase {
  id: string;
  runId: string;
  rmaId: string;
  orderId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  state: CaseState;
  holdReasons: string[];
  clip: { clipId: string; source: "fixture" | "upload" | "camera"; mode: ModeLabel; provenance: string; durationS: number; fps: number; videoUrl?: string; requestIds?: string[] };
  count?: CountResult;
  deterministic?: Reconciliation;
  reconciliation?: Reconciliation;
  disagreements: Array<{ itemKey: string; counter: string; model: string; outcome: string }>;
  /** Every independent reader that ran (or was skipped), for the reader cards. */
  readerRuns?: ReaderRun[];
  draft?: DraftRecord;
  approval?: ApprovalRecord;
  refund?: RefundRecord;
  /** Every refund intent for this case, oldest first (absent on cases stored before U08). */
  refundIntents?: RefundIntent[];
  /** Refund calls refused for a spent/superseded token or an in-flight intent (newest last, capped). */
  tokenRejections?: TokenRejection[];
  timings: StageTiming[];
  costs: StageCost[];
  audit: AuditEntry[];
  /** Reviewer corrections of model reads (absent on cases stored before the learning loop). */
  corrections?: ReviewerCorrection[];
  /** The returns lead's spoken note for this box, if one was recorded. */
  voiceNote?: VoiceNote;
  /** Evidence the decision agent asked a person to supply (work items on a held case). */
  evidenceRequests?: EvidenceRequest[];
}
