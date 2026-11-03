/**
 * Frozen-output ablation. One run of the shift (shipped dispatch, recorded live answers replayed where they exist)
 * freezes every model role's output on every box. Then each role is removed in turn and the shift is replayed on the
 * frozen outputs: no other model role is re-run (the coordinator computes no model role when given a frozen set; the
 * report counts model runs during the ablation and it must be 0). Code roles (inspector, serial matcher, the restrictive
 * merge, the settlement arithmetic, routing, cost) do re-run on the frozen outputs, as they would in production.
 * So each row measures a role's DIRECT effect; an effect that would only appear by re-running a downstream model role
 * isn't counted (that would need new model calls). Same inputs → same report.
 *
 * Effects are compared per box and reported separately by type:
 *   hold (line statuses + reason codes) · amount (the proposed refund) · claim (a carrier claim and its amount) ·
 *   route (queues) · artifact (restock grades, the customer note, work items) · cost (the merchant's fees ledger).
 * Useful effects are hold, amount, claim and route: they change what a person is asked to decide or where the box goes.
 * An artifact-only change (a draft disappearing) is not a money or loss-prevented effect, and a role's own model cost
 * disappearing is not an effect at all (agentCostUsd is never compared; the role's own runs and cost are reported beside
 * the effects). The roster rule (Sidra's): a role whose removal changes NOTHING is cut. A role that changes only an
 * artifact a person uses (the customer note, a restock grade) or only the fees line stays, labelled by its effect type
 * ("artifact only", "fees only"); only a role with no effect of any type is flagged for cutting.
 */
import type { SeededShift } from "@/data/shift";
import { buildRoster, CUT_ROLES, rolesOf, runShift } from "./coordinator";
import type { AgentSpec, DispatchMode, FrozenOutputs, RecordedFleet, ReturnOutcome, RoleId, ShiftRun, StepSource } from "./types";

export const EFFECTS = ["hold", "amount", "claim", "route", "artifact", "cost"] as const;
export type Effect = (typeof EFFECTS)[number];
/** Effects that change a decision a person makes or where the box goes. */
export const USEFUL_EFFECTS: readonly Effect[] = ["hold", "amount", "claim", "route"];

const holdSig = (o: ReturnOutcome) => JSON.stringify(o.lines.map((l) => [l.itemKey, l.status, [...new Set(l.reasons.map((r) => r.code))].sort()]));
const SIG: Record<Effect, (o: ReturnOutcome) => string> = {
  hold: holdSig,
  amount: (o) => String(o.proposedRefundCents),
  claim: (o) => (o.claim ? `${o.claim.claimCents}|${o.claim.damagedItems.map((d) => d.itemKey).join(",")}` : "none"),
  route: (o) => o.route.queues.join("+"),
  artifact: (o) => JSON.stringify([o.restock ? o.restock.map((r) => [r.itemKey, r.grade, r.channel, r.recoveryCents]) : "none", o.message.text, [...new Set(o.workItems.map((w) => w.text))].sort()]),
  // The fees ledger, never the agents' own model-cost estimate (removing any model role lowers that by construction).
  cost: (o) => (o.cost ? `${o.cost.segmentationUsd}|${o.cost.processingFeeLostCents}|${o.cost.returnLabelCents}` : "none"),
};

/** Which effect types differ between two outcomes of the same box. Traces, sources, dispatch and agentCostUsd are ignored. */
export function effectsOf(full: ReturnOutcome, without: ReturnOutcome): Effect[] {
  return EFFECTS.filter((e) => SIG[e](full) !== SIG[e](without));
}

export type EffectClass = "decision" | "artifact_only" | "cost_only" | "none";
/** decision: at least one useful effect · artifact_only / cost_only: changes only drafts / only the fees ledger · none. */
export function classifyEffects(effects: Iterable<Effect>): EffectClass {
  const s = new Set(effects);
  if (USEFUL_EFFECTS.some((e) => s.has(e))) return "decision";
  if (s.has("artifact")) return "artifact_only";
  if (s.has("cost")) return "cost_only";
  return "none";
}

const recovery = (o: ReturnOutcome) => (o.restock ?? []).reduce((s, r) => s + r.recoveryCents, 0);
const holdKeys = (o: ReturnOutcome) => new Set(o.lines.filter((l) => l.status !== "OK").flatMap((l) => l.reasons.filter((r) => r.code !== "count_match").map((r) => `${o.rmaId}:${l.itemKey}:${r.code}`)));

export interface RoleAblation {
  role: RoleId;
  agents: string[];
  kind: AgentSpec["kind"];
  model?: string;
  /** Boxes with any effect (useful or not). */
  returnsChanged: number;
  changedRmas: string[];
  byEffect: Record<Effect, number>;
  /** Boxes with at least one useful effect (hold, amount, claim, route). */
  usefulBoxes: number;
  effectClass: EffectClass;
  /** No effect of ANY type on this shift (not even an artifact or the fees line): flagged for cutting. */
  flaggedForCut: boolean;
  /** Σ (proposed refund without the role − with it). Positive: money that would have been proposed without this role. */
  refundDeltaCents: number;
  /** Σ (claim cents without − with). Negative: claims lost without this role. */
  claimDeltaCents: number;
  /** Σ (estimated resale recovery without − with): an artifact estimate, not money. */
  recoveryDeltaCents: number;
  /** Holds (box:line:code) present with the role and gone without it, and the reverse. */
  holdsLost: number;
  holdsAdded: number;
  /** The role's own runs in the frozen set and their estimated live cost: what it costs, never counted as an effect. */
  ownRuns: number;
  ownCostUsd: number;
  examples: Array<{ rmaId: string; effects: Effect[]; refundWith: number; refundWithout: number }>;
}

export interface AblationReport {
  shiftId: string;
  label: string;
  method: "frozen-output";
  /** The dispatch mode the outputs were frozen under. */
  dispatch: DispatchMode;
  agents: number;
  /** Where the frozen model-role steps came from. */
  frozenSources: Record<StepSource, number>;
  /** Model roles computed to freeze the outputs (one pass), and during all the removals (must be 0). */
  modelRunsToFreeze: number;
  modelRunsDuringAblation: number;
  roles: RoleAblation[];
  /** Each inspector removed on its own: how many returns changed, and whether only its own. */
  inspectorInstances: Array<{ name: string; rmaId: string; returnsChanged: number; onlyOwnReturn: boolean }>;
  baseline: { returns: number; proposedRefundCents: number; requestedCents: number; held: number; claims: number; claimCents: number; recoveryCents: number };
  /** Shipped roles whose removal changes nothing of any type: flagged for cutting. */
  flagged: RoleId[];
  /** Shipped roles that stay although they change no decision: their removal changes only artifacts or fees. */
  artifactOrFeesOnly: RoleId[];
  /** Shipped roles whose removal changed nothing at all (not even an artifact). */
  noEffect: RoleId[];
  /**
   * Roles already cut from the roster, re-checked by adding each back on the frozen outputs: boxes it would change at all,
   * and boxes with a useful effect (0 = the cut holds: it would add no hold, amount, claim or route change).
   */
  cutRoles: Array<{ role: RoleId; name: string; why: string; returnsChangedWhenAdded: number; usefulBoxesWhenAdded: number; effectClassWhenAdded: EffectClass }>;
}

export interface AblationOptions {
  recorded?: RecordedFleet;
  dispatch?: DispatchMode;
  /** Called for every model-role computation (freeze pass and ablation). Tests count with it. */
  onModelRun?: (role: RoleId, rmaId: string) => void;
}

function compare(base: ShiftRun, without: ShiftRun) {
  return base.outcomes.map((o, i) => ({ o, w: without.outcomes[i], effects: effectsOf(o, without.outcomes[i]) }));
}

export function runAblation(shift: SeededShift, opts: AblationOptions = {}): AblationReport {
  const dispatch = opts.dispatch ?? "selective";
  let runs = 0;
  const onModelRun = (role: RoleId, rmaId: string) => {
    runs++;
    opts.onModelRun?.(role, rmaId);
  };
  const roster = buildRoster(shift);
  // 1. Freeze: one pass computes every model role once (recorded live answers replayed where they exist).
  const source = runShift(shift, { recorded: opts.recorded, dispatch, onModelRun });
  const modelRunsToFreeze = runs;
  const frozen: FrozenOutputs = source.frozen;
  // 2. Replay on the frozen outputs (the baseline every removal is compared to), then remove each role.
  const replay = (o: { remove?: string[]; roster?: AgentSpec[] } = {}) => runShift(shift, { ...o, frozen, dispatch, onModelRun });
  const base = replay();

  const frozenSources: Record<StepSource, number> = { deterministic: 0, recorded_live: 0, live_rejected: 0 };
  for (const roles of Object.values(frozen)) for (const st of Object.values(roles)) if (st?.ran) frozenSources[st.source]++;

  const roles: RoleAblation[] = rolesOf(roster).map((role) => {
    const cmp = compare(base, replay({ remove: [role] }));
    const agents = roster.filter((a) => a.role === role);
    const byEffect = Object.fromEntries(EFFECTS.map((e) => [e, cmp.filter((c) => c.effects.includes(e)).length])) as Record<Effect, number>;
    const changed = cmp.filter((c) => c.effects.length);
    const all = new Set(cmp.flatMap((c) => c.effects));
    const effectClass = classifyEffects(all);
    let holdsLost = 0;
    let holdsAdded = 0;
    for (const c of cmp) {
      const a = holdKeys(c.o);
      const b = holdKeys(c.w);
      holdsLost += [...a].filter((k) => !b.has(k)).length;
      holdsAdded += [...b].filter((k) => !a.has(k)).length;
    }
    const ownRuns = base.outcomes.reduce((s, o) => s + o.dispatch.filter((d) => d.role === role && (d.state === "ran" || d.state === "unavailable")).length, 0);
    return {
      role,
      agents: agents.map((a) => a.name),
      kind: agents[0].kind,
      ...(agents[0].model ? { model: agents[0].model } : {}),
      returnsChanged: changed.length,
      changedRmas: changed.map((c) => c.o.rmaId),
      byEffect,
      usefulBoxes: cmp.filter((c) => c.effects.some((e) => USEFUL_EFFECTS.includes(e))).length,
      effectClass,
      flaggedForCut: changed.length === 0,
      refundDeltaCents: cmp.reduce((s, c) => s + (c.w.proposedRefundCents - c.o.proposedRefundCents), 0),
      claimDeltaCents: cmp.reduce((s, c) => s + ((c.w.claim?.claimCents ?? 0) - (c.o.claim?.claimCents ?? 0)), 0),
      recoveryDeltaCents: cmp.reduce((s, c) => s + (recovery(c.w) - recovery(c.o)), 0),
      holdsLost,
      holdsAdded,
      ownRuns,
      ownCostUsd: Math.round(ownRuns * agents[0].costPerRunUsd * 1e6) / 1e6,
      examples: changed.slice(0, 3).map((c) => ({ rmaId: c.o.rmaId, effects: c.effects, refundWith: c.o.proposedRefundCents, refundWithout: c.w.proposedRefundCents })),
    };
  });

  const inspectorInstances = roster
    .filter((a) => a.role === "inspector")
    .map((a) => {
      const changed = compare(base, replay({ remove: [a.name] })).filter((c) => c.effects.length);
      const rmaId = a.name.replace("inspector-", "").toUpperCase();
      return { name: a.name, rmaId, returnsChanged: changed.length, onlyOwnReturn: changed.every((c) => c.o.rmaId === rmaId) };
    });

  const cutRoles = CUT_ROLES.map((c) => {
    const cmp = compare(base, replay({ roster: [...roster, c.spec] }));
    return {
      role: c.spec.role,
      name: c.spec.name,
      why: c.why,
      returnsChangedWhenAdded: cmp.filter((x) => x.effects.length).length,
      usefulBoxesWhenAdded: cmp.filter((x) => x.effects.some((e) => USEFUL_EFFECTS.includes(e))).length,
      effectClassWhenAdded: classifyEffects(cmp.flatMap((x) => x.effects)),
    };
  });

  return {
    shiftId: base.shiftId,
    label: base.label,
    method: "frozen-output",
    dispatch,
    agents: roster.length,
    frozenSources,
    modelRunsToFreeze,
    modelRunsDuringAblation: runs - modelRunsToFreeze,
    roles,
    inspectorInstances,
    baseline: {
      returns: base.outcomes.length,
      proposedRefundCents: base.outcomes.reduce((s, o) => s + o.proposedRefundCents, 0),
      requestedCents: shift.returns.reduce((s, r) => s + r.rma.requestedRefundCents, 0),
      held: base.outcomes.filter((o) => o.lines.some((l) => l.status !== "OK")).length,
      claims: base.outcomes.filter((o) => o.claim).length,
      claimCents: base.outcomes.reduce((s, o) => s + (o.claim?.claimCents ?? 0), 0),
      recoveryCents: base.outcomes.reduce((s, o) => s + recovery(o), 0),
    },
    flagged: roles.filter((r) => r.flaggedForCut).map((r) => r.role),
    artifactOrFeesOnly: roles.filter((r) => r.effectClass === "artifact_only" || r.effectClass === "cost_only").map((r) => r.role),
    noEffect: roles.filter((r) => r.returnsChanged === 0).map((r) => r.role),
    cutRoles,
  };
}
