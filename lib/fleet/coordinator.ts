/**
 * The coordinator: fans the shift out to the fleet, merges what comes back, prices the settlement
 * and routes every return to a person. Merging rule (the whole safety story):
 *   - an agent's only line effect is a HOLD; the merge uses `moreRestrictive`, so no agent output
 *     can lower a line's status, and nothing clears a hold the tray counter raised;
 *   - a hold aimed at a line that doesn't exist holds every line (fail closed);
 *   - the proposed refund is `calculateSettlement(...)`'s recommendation, a proposal only: the
 *     outcome type has no approval or refund field, and every outcome `requiresPerson: true`.
 *
 * `runShift(shift, { remove })` removes roles or named agents for the ablation (lib/fleet/ablation.ts);
 * `{ roster }` runs a different roster (the ablation re-checks cut roles that way); `{ recorded }` replays
 * saved live Meta answers for the model roles (lib/fleet/live-merge.ts), which can only add restriction;
 * `{ dispatch }` picks selective dispatch (default: optional specialists run only when the box's evidence calls
 * for them, lib/fleet/dispatch.ts) or always-run; `{ frozen }` replays one frozen set of model-role outputs and
 * computes no model role at all (the frozen-output ablation). Every box records which roles ran or were skipped, and why.
 * Pure and deterministic: no clock, no network, no keys, no file reads (recordings are passed in).
 */
import { POLICY } from "@/data/fixtures";
import type { SeededShift, ShiftReturn } from "@/data/shift";
import { ReasonCode, type Reconciliation, type Rma } from "@/lib/domain/schemas";
import { calculateSettlement, moreRestrictive, summarize } from "@/lib/engine/reconcile";
import { inspectorName, inspectorSpec, runInspector } from "./agents/inspector";
import { labelReaderSpec, runLabelReader } from "./agents/label-reader";
import { damageReaderSpec, runDamageReader } from "./agents/damage-reader";
import { runVoiceNoteReader, voiceNoteReaderSpec } from "./agents/voice-note-reader";
import { runSerialMatcher, serialMatcherSpec } from "./agents/serial-matcher";
import { fraudPatternSpec, runFraudPattern, type FraudInput } from "./agents/fraud-pattern";
import { carrierClaimSpec, runCarrierClaim } from "./agents/carrier-claim";
import { policySpec, runPolicy } from "./agents/policy";
import { restockGraderSpec, runRestockGrader } from "./agents/restock-grader";
import { completeBoxNote, fallbackMessage, messageDrafterSpec, runMessageDrafter } from "./agents/message-drafter";
import { costSpec, runCost } from "./agents/cost";
import type { ReturnCtx, Upstream } from "./context";
import { decide } from "./dispatch";
import { applyRecorded, liveRoleFor } from "./live-merge";
import type {
  AgentResult,
  AgentSpec,
  DispatchEntry,
  DispatchMode,
  FleetLine,
  FrozenOutputs,
  FrozenStep,
  HoldEffect,
  LiveProofData,
  Queue,
  RecordedFleet,
  ReturnOutcome,
  RoleId,
  RouteDecision,
  ShiftRun,
  StepSource,
  UnavailableInfo,
  WorkItem,
} from "./types";

export const coordinatorSpec: AgentSpec = {
  name: "coordinator",
  role: "coordinator",
  kind: "code",
  costPerRunUsd: 0,
  costBasis: "app code",
  scope: "return",
  does: "fans each return out to the fleet, merges most-restrictive-first, prices the settlement and routes it to a person",
};

/** Shipped specialists in the order they run (stage 1 → 4). */
export const SPECIALISTS: AgentSpec[] = [
  labelReaderSpec,
  damageReaderSpec,
  voiceNoteReaderSpec,
  serialMatcherSpec,
  carrierClaimSpec,
  policySpec,
  restockGraderSpec,
  messageDrafterSpec,
  costSpec,
  coordinatorSpec,
];

export const STAGE: Record<RoleId, number> = {
  inspector: 1,
  "label-reader": 1,
  "damage-reader": 1,
  "voice-note-reader": 1,
  "serial-matcher": 2,
  "fraud-pattern-agent": 2,
  "carrier-claim-agent": 2,
  "policy-agent": 3,
  "restock-grader": 4,
  "customer-message-drafter": 4,
  "cost-agent": 4,
  coordinator: 5,
};

/**
 * Roles cut from the roster because their ablation changed nothing on the seeded shift (the rule: a role
 * whose removal changes no outcome doesn't ship). The ablation re-runs the shift with each one added back
 * and reports how many boxes change (lib/fleet/ablation.ts), so the cut stays checked, not asserted.
 */
export const CUT_ROLES: Array<{ spec: AgentSpec; why: string }> = [
  {
    spec: fraudPatternSpec,
    why: "No two boxes in this shift come from one address or show a copied serial. The only cross-box finding is the two demo orders (ORD-58227, ORD-58241) listing the same serials, because the demo films one labelled unit; that is an inventory record conflict, a work item, not a hold. Added back, it changes no hold, amount, claim or route; its only effect is that work item on those two boxes.",
  },
];

export function buildRoster(shift: SeededShift): AgentSpec[] {
  return [...SPECIALISTS, ...shift.returns.map((r) => inspectorSpec(r.rma.id))];
}

/** Every role in a roster, once. */
export const rolesOf = (roster: AgentSpec[]): RoleId[] => [...new Set(roster.map((a) => a.role))];

/** Merge holds into lines. Only ever raises a line to HELD (MISSING stays MISSING); a hold on an unknown line holds every line. */
export function applyHolds(lines: FleetLine[], holds: HoldEffect[], by: string): FleetLine[] {
  let out = lines;
  for (const h of holds) {
    const targets = h.itemKey === "*" || !out.some((l) => l.itemKey === h.itemKey) ? out.map((l) => l.itemKey) : [h.itemKey];
    out = out.map((l) => (targets.includes(l.itemKey) ? { ...l, status: moreRestrictive(l.status, "HELD"), reasons: [...l.reasons, { code: h.code, detail: h.detail, by }] } : l));
  }
  return out;
}

const VALID_REASON = new Set<string>(ReasonCode.options);

/** The settlement prices line statuses; reasons that aren't reconcile codes stay on the FleetLine. */
export function toReconciliation(lines: FleetLine[], rma: Rma): Reconciliation {
  const recLines = lines.map((l) => ({
    itemKey: l.itemKey,
    sku: "",
    description: l.description,
    expectedQty: l.expectedQty,
    observedQty: l.observedQty,
    missingQty: l.missingQty,
    status: l.status,
    unitPriceCents: l.unitPriceCents,
    reasons: l.reasons.filter((r) => VALID_REASON.has(r.code)).map((r) => ({ code: r.code as ReasonCode, detail: r.detail })),
  }));
  return { rmaId: rma.id, source: "cross_checked", mode: "DETERMINISTIC", lines: recLines, summary: summarize(recLines, rma) };
}

function noCountLines(ret: ShiftReturn): FleetLine[] {
  return ret.order.slip.lines.map((l) => ({
    itemKey: l.itemKey,
    description: l.description,
    expectedQty: l.qty,
    observedQty: 0,
    missingQty: 0,
    unitPriceCents: l.unitPriceCents,
    status: "HELD",
    reasons: [{ code: "no_count", detail: "no count: the inspector didn't run on this return, so every line is held", by: "coordinator" }],
  }));
}

export const holdReasonsOf = (lines: FleetLine[]) => lines.filter((l) => l.status !== "OK").flatMap((l) => l.reasons.filter((r) => r.code !== "count_match").map((r) => `${l.itemKey}:${r.code}`));

function route(lines: FleetLine[], up: Upstream, late: boolean): RouteDecision {
  const queues: Queue[] = [];
  const clear = lines.every((l) => l.status === "OK") && !late;
  queues.push(clear ? "approve_refund" : "hold_review");
  if ((up.fraud?.flags.length ?? 0) > 0) queues.push("fraud_review");
  if (up.carrierClaim) queues.push("carrier_desk");
  if ((up.voiceReader?.claims ?? []).some((c) => c.kind === "battery_hazard")) queues.push("safety_bin");
  const why = clear
    ? "every line OK: a person approves the refund with a single-use token"
    : `held (${[...new Set(lines.flatMap((l) => (l.status === "OK" ? [] : l.reasons.map((r) => r.code))).filter((c) => !["count_match"].includes(c)))].join(", ") || "late"}): a person reviews`;
  return { queues, why };
}

export interface RunShiftOptions {
  /** Role ids or agent names to leave out (ablation). */
  remove?: Iterable<string>;
  /** Run this roster instead of the shipped one (e.g. with a cut role added back). */
  roster?: AgentSpec[];
  /** Saved live Meta answers by box and role, replayed on top of the deterministic results. */
  recorded?: RecordedFleet;
  /** "selective" (default, shipped): optional specialists run only when the box's evidence calls for them. "always": every role on every box. */
  dispatch?: DispatchMode;
  /**
   * Replay these model-role steps instead of running any model role (the frozen-output ablation): a model role runs on a
   * box exactly when it has a frozen result there, and that result is used as is. Code roles (inspector, serial matcher,
   * merge, settlement, routing, cost) still run, on the frozen outputs.
   */
  frozen?: FrozenOutputs;
  /** Called every time a model role's result is actually computed (never for a frozen step). Tests count calls with it. */
  onModelRun?: (role: RoleId, rmaId: string) => void;
}

export function runShift(shift: SeededShift, opts: RunShiftOptions = {}): ShiftRun {
  const removed = new Set(opts.remove ?? []);
  const roster = opts.roster ?? buildRoster(shift);
  const mode: DispatchMode = opts.dispatch ?? "selective";
  const inRoster = new Set(roster.map((a) => a.name));
  const on = (spec: AgentSpec) => inRoster.has(spec.name) && !removed.has(spec.role) && !removed.has(spec.name);
  const coordOn = on(coordinatorSpec);
  const policy = POLICY;

  type State = {
    ret: ShiftReturn;
    up: Upstream;
    traces: ReturnOutcome["traces"];
    holds: Array<{ by: string; holds: HoldEffect[] }>;
    work: WorkItem[];
    ran: AgentSpec[];
    dispatch: Map<string, DispatchEntry>;
    frozen: Partial<Record<RoleId, FrozenStep>>;
  };
  // A box run live may carry a transcript the seeded box doesn't (the lead spoke while filming): replay it too.
  const withRecordedNote = (ret: ShiftReturn): ShiftReturn => {
    const rec = opts.recorded?.[ret.rma.id]?.["voice-note-reader"];
    if (ret.voiceNote || !rec?.input?.transcript) return ret;
    return { ...ret, voiceNote: { transcript: rec.input.transcript, mode: "RECORDED_FIXTURE", model: "muse-voice-transcribe-1.0", latencyMs: 0, audioDurationMs: 0, provenance: "recorded live transcription (Muse Voice Transcribe), replayed", recordedAt: rec.recordedAt } };
  };
  const states: State[] = shift.returns.map((ret) => ({ ret: withRecordedNote(ret), up: {}, traces: [], holds: [], work: [], ran: [], dispatch: new Map(), frozen: {} }));
  const ctxOf = (s: State, extra: Partial<ReturnCtx> = {}): ReturnCtx => ({ ret: s.ret, settings: shift.settings, policy, up: s.up, ...extra });
  const note = (s: State, spec: AgentSpec, state: DispatchEntry["state"], reason: string) =>
    s.dispatch.set(spec.name, { role: spec.role, agent: spec.name, state, reason, modelCall: spec.kind === "model" && (state === "ran" || state === "unavailable") });
  const record = <O,>(s: State, spec: AgentSpec, r: AgentResult<O>, source?: StepSource, proof?: LiveProofData, unavailable?: UnavailableInfo) => {
    s.traces.push({ agent: spec.name, role: spec.role, stage: STAGE[spec.role], line: r.trace, ...(source ? { source } : {}), ...(proof ? { proof } : {}), ...(unavailable ? { unavailable } : {}) });
    if (r.holds.length) s.holds.push({ by: spec.name, holds: r.holds });
    s.work.push(...r.workItems);
    s.ran.push(spec);
  };
  /** A code role: runs on every box when it is on. */
  const code = <O,>(s: State, spec: AgentSpec, run: () => AgentResult<O>): AgentResult<O> | undefined => {
    if (!on(spec)) {
      note(s, spec, "removed", "removed from the roster (ablation)");
      return undefined;
    }
    const r = run();
    record(s, spec, r);
    note(s, spec, "ran", "core: runs on every box (app code)");
    return r;
  };

  /**
   * A model role's step. Frozen: the frozen result or skip, nothing computed. Otherwise dispatch decides; when the role
   * runs, the deterministic result is combined with a recorded live answer if one exists (a rejected answer leaves the
   * app-code result, holds included, and marks the step unavailable with the reason).
   */
  const model = <O,>(s: State, spec: AgentSpec, ctx: ReturnCtx, run: () => AgentResult<O>): AgentResult<O> | undefined => {
    const rmaId = s.ret.rma.id;
    if (!on(spec)) {
      note(s, spec, "removed", "removed from the roster (ablation)");
      return undefined;
    }
    let step: FrozenStep;
    let reason: string;
    if (opts.frozen) {
      step = opts.frozen[rmaId]?.[spec.role] ?? { ran: false, reason: "no output in the frozen set for this box" };
      reason = step.ran ? `frozen output (${step.source === "recorded_live" ? "recorded live" : step.source === "live_rejected" ? "live answer unavailable, app code" : "app code"})` : step.reason;
    } else {
      const d = decide(spec.role, ctx, mode);
      reason = d.reason;
      if (!d.run) step = { ran: false, reason: d.reason };
      else {
        opts.onModelRun?.(spec.role, rmaId);
        const det = run();
        const rec = opts.recorded?.[rmaId]?.[spec.role];
        const def = liveRoleFor(spec.role);
        if (!rec || !def) step = { ran: true, result: det, source: "deterministic" };
        else {
          const m = applyRecorded(def, det, rec, ctx, { missingEvidence: d.missingEvidence });
          const result = m.unavailable ? { ...m.result, workItems: [...m.result.workItems, { by: spec.name, text: `${spec.name}: live answer unavailable (${m.unavailable.reason}); the app-code result stands in, check it before acting` }] } : m.result;
          step = { ran: true, result, source: m.source, ...(m.proof ? { proof: m.proof } : {}), ...(m.unavailable ? { unavailable: m.unavailable } : {}) };
        }
      }
    }
    s.frozen[spec.role] = step;
    if (!step.ran) {
      note(s, spec, "skipped", reason);
      return undefined;
    }
    record(s, spec, step.result, spec.kind === "model" ? step.source : undefined, step.proof, step.unavailable);
    note(s, spec, step.unavailable ? "unavailable" : "ran", step.unavailable ? `live answer unavailable (${step.unavailable.reason}); app code stands in` : reason);
    return step.result as AgentResult<O>;
  };

  // Stage 1: per-return readers. Without the coordinator nothing fans out: only the inspectors run.
  for (const s of states) {
    const insp = inspectorSpec(s.ret.rma.id);
    const r = code(s, insp, () => runInspector(ctxOf(s)));
    if (r) s.up.inspector = r.output;
    if (!coordOn) continue;
    s.up.labelReader = model(s, labelReaderSpec, ctxOf(s), () => runLabelReader(ctxOf(s)))?.output;
    s.up.damageReader = model(s, damageReaderSpec, ctxOf(s), () => runDamageReader(ctxOf(s)))?.output;
    s.up.voiceReader = model(s, voiceNoteReaderSpec, ctxOf(s), () => runVoiceNoteReader(ctxOf(s)))?.output;
  }

  // Stage 2: the shift-wide pattern agent (code, only when it is in the roster), then per-return matchers and claims.
  if (coordOn && inRoster.has(fraudPatternSpec.name)) {
    if (!on(fraudPatternSpec)) for (const s of states) note(s, fraudPatternSpec, "removed", "removed from the roster (ablation)");
    else {
      const inputs: FraudInput[] = states.map((s) => ({ ret: s.ret, inspector: s.up.inspector, labelReader: s.up.labelReader }));
      const res = runFraudPattern(inputs);
      for (const s of states) {
        const r = res.get(s.ret.rma.id)!;
        s.up.fraud = r.output;
        record(s, fraudPatternSpec, r);
        note(s, fraudPatternSpec, "ran", "core: runs once across the shift (app code)");
      }
    }
  }

  const outcomes: ReturnOutcome[] = states.map((s) => {
    const { ret } = s;
    if (coordOn) {
      const sm = code(s, serialMatcherSpec, () => runSerialMatcher({ ...ctxOf(s), shiftReturns: shift.returns }));
      if (sm) s.up.serialMatcher = sm.output;
      const claim = model(s, carrierClaimSpec, ctxOf(s), () => runCarrierClaim(ctxOf(s)));
      if (claim) s.up.carrierClaim = claim.output;
    }

    // Merge stages 1–2.
    let lines = s.up.inspector ? s.up.inspector.lines : noCountLines(ret);
    for (const h of s.holds) lines = applyHolds(lines, h.holds, h.by);

    // Stage 3: policy on the merged findings.
    if (coordOn) {
      const r = model(s, policySpec, ctxOf(s, { lines }), () => runPolicy(ctxOf(s, { lines })));
      if (r) {
        s.up.policy = r.output;
        lines = applyHolds(lines, r.holds, policySpec.name);
      }
    }

    const settlement = calculateSettlement(toReconciliation(lines, ret.rma), ret.rma);
    const proposedRefundCents = settlement.options.find((o) => o.key === settlement.recommended)!.refundCents;
    const late = s.up.policy?.late ?? false;
    const complete = lines.length > 0 && lines.every((l) => l.status === "OK") && !late;

    // Stage 4: artifacts.
    let restock: ReturnOutcome["restock"] = null;
    let message: ReturnOutcome["message"] = { text: fallbackMessage(ret.rma.id), by: "fallback template (no drafter ran)" };
    let cost: ReturnOutcome["cost"] = null;
    if (coordOn) {
      const rs = model(s, restockGraderSpec, ctxOf(s, { lines }), () => runRestockGrader(ctxOf(s, { lines })));
      if (rs) {
        s.up.restock = rs.output;
        restock = rs.output;
      }
      const md = model(s, messageDrafterSpec, ctxOf(s, { lines, settlement }), () => runMessageDrafter(ctxOf(s, { lines, settlement })));
      if (md) message = { text: md.output.text, by: messageDrafterSpec.name };
      else if (complete && !s.up.carrierClaim) message = { text: completeBoxNote(ctxOf(s)), by: "app-code note for a complete box (no drafter run)" };
      const c = code(s, costSpec, () => runCost(ctxOf(s, { lines, settlement, ran: [...s.ran, costSpec, coordinatorSpec].map((a) => ({ name: a.name, costPerRunUsd: a.costPerRunUsd })) })));
      if (c) cost = c.output;
    }

    const routed: RouteDecision = coordOn ? route(lines, s.up, late) : { queues: ["unsorted"], why: "no coordinator: nothing was fanned out, merged or routed; the inspector's count went straight to the queue" };
    if (coordOn) {
      s.traces.push({ agent: coordinatorSpec.name, role: "coordinator", stage: STAGE.coordinator, line: `merged ${s.holds.reduce((t, h) => t + h.holds.length, 0)} hold(s) from ${s.holds.length} agent(s) → ${routed.queues.join(" + ")}; proposes ${(proposedRefundCents / 100).toFixed(2)} USD for a person` });
      s.ran.push(coordinatorSpec);
      note(s, coordinatorSpec, "ran", "core: merges, prices and routes every box (app code)");
    } else {
      note(s, coordinatorSpec, "removed", "removed from the roster (ablation)");
    }

    // One entry per role on this box, in roster order (its own inspector first).
    const own = inspectorSpec(ret.rma.id);
    const dispatch: DispatchEntry[] = [own, ...roster.filter((a) => a.role !== "inspector")].map(
      (a) => s.dispatch.get(a.name) ?? { role: a.role, agent: a.name, state: on(a) ? "skipped" : "removed", reason: on(a) ? "no coordinator: nothing was fanned out" : "removed from the roster (ablation)", modelCall: false },
    );

    return {
      rmaId: ret.rma.id,
      scenario: ret.scenario,
      lines,
      holdReasons: holdReasonsOf(lines),
      settlement,
      proposedRefundCents,
      claim: s.up.carrierClaim ?? null,
      restock,
      message,
      cost,
      route: routed,
      workItems: s.work,
      agentsRun: s.ran.map((a) => a.name),
      dispatch,
      agentCostUsd: Math.round(s.ran.reduce((t, a) => t + a.costPerRunUsd, 0) * 1e6) / 1e6,
      traces: s.traces,
      requiresPerson: true as const,
    };
  });

  const frozen: FrozenOutputs = Object.fromEntries(states.map((s) => [s.ret.rma.id, s.frozen]));
  return { shiftId: shift.shift.id, label: shift.label, outcomes, roster, removed: [...removed], dispatch: mode, frozen };
}

/** Freeze one set of model-role outputs: the steps a run produced, to replay in the frozen-output ablation. */
export const freezeOutputs = (run: ShiftRun): FrozenOutputs => run.frozen;

export { inspectorName };
