/**
 * The agent fleet's contracts. Two rules are enforced by these types, not by convention:
 *   1. An agent's only effect on a packing-slip line is a HOLD (`HoldEffect` has no status field,
 *      so no agent can write OK, and the coordinator merges with `moreRestrictive`).
 *   2. Nothing here can approve or refund. No agent output and no `ReturnOutcome` has an approval,
 *      a token or a refund field; the only path to money stays the person's single-use token
 *      (lib/engine/approval.ts → lib/engine/service.ts). tests/fleet.test.ts checks both.
 * Type-only module: safe to import from client components.
 */
import type { LineStatus } from "@/lib/domain/schemas";
import type { Settlement } from "@/lib/engine/reconcile";

export type RoleId =
  | "inspector"
  | "label-reader"
  | "serial-matcher"
  | "damage-reader"
  | "voice-note-reader"
  | "policy-agent"
  | "fraud-pattern-agent"
  | "carrier-claim-agent"
  | "restock-grader"
  | "customer-message-drafter"
  | "cost-agent"
  | "coordinator";

/** Meta models a "model" role would call on a live, paid run. None is called in this build. */
export type MetaModelId = "muse-spark-1.3" | "muse-wonder-1.0" | "muse-voice-transcribe-1.0";

export interface AgentSpec {
  name: string;
  role: RoleId;
  kind: "code" | "model";
  /** Only for kind "model": the Meta model it would use live. */
  model?: MetaModelId;
  /** Estimated cost of one LIVE run at list price (USD). Code agents: 0. This build spends nothing. */
  costPerRunUsd: number;
  /** How the estimate was made (token budget × list price, or "app code"). */
  costBasis: string;
  /** "return": runs once per return; "shift": runs once across the whole shift. */
  scope: "return" | "shift";
  /** One line: what this agent does. */
  does: string;
  /** Model roles: the token budget behind costPerRunUsd, also used to quote a live run (estimate). */
  budget?: { inTok: number; outTok: number };
}

/** Where a step's result came from. "recorded_live": a saved live Meta answer, replayed; "live_rejected": it failed and app code stood in. */
export type StepSource = "deterministic" | "recorded_live" | "live_rejected";

/**
 * Why a live answer was not used. The step then shows LIVE ANSWER UNAVAILABLE with this reason, and the app-code result
 * stands in under an app-code label (never under a live one). Holds from the app-code result are kept.
 *   malformed: the answer failed its schema or app code's checks on it · wrong_case: it was recorded for another box or role ·
 *   missing_evidence: the box has nothing for this role to read · timeout: the call stalled past the role's time limit ·
 *   call_failed: the call itself failed (no key, refused model, provider error).
 */
export type UnavailableKind = "malformed" | "wrong_case" | "missing_evidence" | "timeout" | "call_failed";
export interface UnavailableInfo {
  kind: UnavailableKind;
  reason: string;
}

/**
 * Dispatch: "selective" runs an optional specialist only when the box's evidence calls for it (lib/fleet/dispatch.ts);
 * "always" runs every role on every box (the comparison baseline). Core roles run in both.
 */
export type DispatchMode = "selective" | "always";

/** What happened to one role on one box: it ran, it was skipped (and why), it was removed (ablation), or its live answer was unavailable. */
export interface DispatchEntry {
  role: RoleId;
  agent: string;
  state: "ran" | "skipped" | "removed" | "unavailable";
  /** One short line: the trigger that fired, or why the role did not run. */
  reason: string;
  /** True when this entry is a model call a live run would make (a model role that ran, or whose live answer was unavailable). */
  modelCall: boolean;
}

/** The proof under a recorded live result: which model answered, how long it took, the provider's request id. */
export interface LiveProofData {
  model: string;
  latencyMs: number;
  requestId?: string;
  recordedAt: string;
  error?: string;
}

export interface TraceStep {
  agent: string;
  role: RoleId;
  stage: number;
  line: string;
  source?: StepSource;
  proof?: LiveProofData;
  /** Set when a live answer existed but was not used (source "live_rejected"). */
  unavailable?: UnavailableInfo;
}

/** One model role's live answer for one box, as saved to data/recordings/fleet/<rmaId>.<role>.json. */
export interface FleetRecording {
  kind: "fleet";
  rmaId: string;
  role: RoleId;
  /** LIVE_META when it was made; replayed later as recorded live Meta output. */
  mode: "LIVE_META";
  model: string;
  latencyMs: number;
  requestId?: string;
  recordedAt: string;
  ok: boolean;
  error?: string;
  /** The model's validated answer (null when the call or the schema failed). */
  output: unknown;
  /** cachedTokens: of inputTokens, how many Meta served from its prompt cache (absent on older recordings). */
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens?: number };
  costUsd: number | null;
  /** Inputs worth keeping for the replay (the voice-note reader keeps the transcript it read). */
  input?: { transcript?: string };
  /** True when the call stalled past the role's time limit and was abandoned (output null, the error says so). */
  timedOut?: boolean;
}

/** Recordings by box, then by role. */
export type RecordedFleet = Record<string, Partial<Record<RoleId, FleetRecording>>>;

/** Reason codes the fleet can put on a line. The counter's and reconcile's codes pass through unchanged. */
export type FleetReasonCode =
  | "count_match"
  | "not_observed"
  | "short_count"
  | "extra_observed"
  | "merged_mask"
  | "left_tray"
  | "label_unreadable"
  | "concept_conflict"
  | "seen_not_placed"
  | "serial_mismatch"
  | "visible_damage"
  | "condition_review"
  | "outside_window"
  | "spoken_claim"
  | "battery_hazard"
  | "repeat_address"
  | "duplicate_serial"
  | "no_count";

/** The only thing an agent may do to a line: put it on hold, with a reason. `itemKey: "*"` = every line. */
export interface HoldEffect {
  itemKey: string;
  code: FleetReasonCode;
  detail: string;
}

export interface WorkItem {
  by: string;
  text: string;
}

export interface AgentResult<O> {
  output: O;
  /** One short line for the replay: what this agent did on this return. */
  trace: string;
  holds: HoldEffect[];
  workItems: WorkItem[];
}

export interface FleetLine {
  itemKey: string;
  description: string;
  expectedQty: number;
  observedQty: number;
  missingQty: number;
  unitPriceCents: number;
  status: LineStatus;
  reasons: Array<{ code: FleetReasonCode; detail: string; by: string }>;
}

export interface CarrierClaimDraft {
  carrier: string;
  tracking: string;
  exceptionScan: string | null;
  evidence: string[];
  /** Clip timestamps of the damage crops, as photo references. */
  photoRefs: string[];
  damagedItems: Array<{ itemKey: string; valueCents: number }>;
  claimCents: number;
  status: "draft · a person files it";
}

export type RestockGrade = "A" | "B" | "C" | "recycle";
export interface RestockLine {
  itemKey: string;
  grade: RestockGrade;
  channel: string;
  recoveryCents: number;
  why: string;
}

export interface CostLedger {
  /** Estimated live model cost of the agents that ran on this return (USD, list price). */
  agentUsd: number;
  /** Estimated live segmentation cost (SAM 3.1 frames × concepts × list price). */
  segmentationUsd: number;
  /** The processing fee on the original charge, which a refund does not return (cents). */
  processingFeeLostCents: number;
  returnLabelCents: number;
  /** Merchant cost of this return excluding the refund itself (cents, rounded). */
  totalCents: number;
}

export type Queue = "approve_refund" | "hold_review" | "fraud_review" | "carrier_desk" | "safety_bin" | "unsorted";

export interface RouteDecision {
  queues: Queue[];
  why: string;
}

export interface ReturnOutcome {
  rmaId: string;
  scenario: string;
  lines: FleetLine[];
  /** `${itemKey}:${code}` for every non-OK reason. */
  holdReasons: string[];
  settlement: Settlement;
  /** The settlement's recommended amount: a proposal for a person, never an instruction. */
  proposedRefundCents: number;
  claim: CarrierClaimDraft | null;
  restock: RestockLine[] | null;
  message: { text: string; by: string };
  cost: CostLedger | null;
  route: RouteDecision;
  workItems: WorkItem[];
  /** Names of the agents that ran on this return, in order. */
  agentsRun: string[];
  /** Every role in the roster on this box: ran, skipped (with the reason), removed, or live answer unavailable. */
  dispatch: DispatchEntry[];
  /** Estimated live cost of those agents (USD). Excluded from ablation comparisons. */
  agentCostUsd: number;
  traces: TraceStep[];
  /** Always true: every outcome goes to a person. */
  requiresPerson: true;
}

export interface ShiftRun {
  shiftId: string;
  label: string;
  outcomes: ReturnOutcome[];
  roster: AgentSpec[];
  removed: string[];
  dispatch: DispatchMode;
  /** Every model role's step on every box as this run produced it (or why it didn't run): freeze it for the ablation. */
  frozen: FrozenOutputs;
}

/** One model role's step on one box, frozen: its result (deterministic, recorded live, or app code standing in) or why it didn't run. */
export type FrozenStep =
  | { ran: true; result: AgentResult<unknown>; source: StepSource; proof?: LiveProofData; unavailable?: UnavailableInfo }
  | { ran: false; reason: string };

/** Frozen model-role steps by box, then by role. */
export type FrozenOutputs = Record<string, Partial<Record<RoleId, FrozenStep>>>;

/** What the "Agents at work" replay needs, built on the server from a ShiftRun (serialisable). */
export interface ReplayReturn {
  rmaId: string;
  scenario: string;
  customer: string;
  hasVoiceNote: boolean;
  steps: Array<{ agent: string; stage: number; line: string; source?: StepSource; proof?: LiveProofData; unavailable?: UnavailableInfo }>;
  /** Which roles ran on this box and which were skipped, with the reason. */
  dispatch: Array<{ agent: string; state: DispatchEntry["state"]; reason: string; modelCall: boolean }>;
  lines: Array<{ itemKey: string; description: string; status: LineStatus; reasons: string[] }>;
  proposedRefundCents: number;
  requestedCents: number;
  recommended: string;
  claimCents: number | null;
  restock: string | null;
  message: string;
  queues: Queue[];
  routeWhy: string;
  workItems: string[];
  agentCostUsd: number;
  segmentationUsd: number;
}

export interface ReplayAgent extends AgentSpec {
  /** Runs across the shift (a shift-scope agent runs once). */
  runs: number;
  /** runs × costPerRunUsd: the estimated live cost for the whole shift. */
  shiftUsd: number;
}

export interface ReplayData {
  shiftId: string;
  dispatch: DispatchMode;
  label: string;
  date: string;
  bench: string;
  lead: string;
  agents: ReplayAgent[];
  returns: ReplayReturn[];
}
