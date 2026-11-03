/**
 * Selective dispatch vs always-run, over a whole shift. Both modes run the same boxes (recorded live answers replayed where
 * they exist); always-run is the reference. Reported: the work selective skips, the findings always-run made that selective
 * did not (holds, claims, drafts: restock grades, notes, work items), the holds selective added that always-run doesn't
 * have, and each mode's model calls, latency and cost. A miss is listed box by box; nothing is netted away.
 *
 * Latency and cost are estimates unless a recording says otherwise: a replayed live call uses its recorded latency and
 * cost; any other model call uses the role's token-budget cost at list price and the p50 latency measured on the
 * preflight's Meta calls of the same model (data/measured-calls.json: different prompts, so a proxy). A box's latency is
 * its critical path: roles in one stage run in parallel, stages run in sequence. Code roles count as 0 ms.
 * Pure: no clock, no network.
 */
import measured from "@/data/measured-calls.json";
import type { SeededShift } from "@/data/shift";
import { buildRoster, runShift, STAGE } from "./coordinator";
import type { AgentSpec, DispatchMode, MetaModelId, RecordedFleet, ReturnOutcome, RoleId, ShiftRun } from "./types";

/** p50 latency (ms) per Meta model, measured on the preflight's calls; fixed fallbacks if the file lacks a model. */
export const LATENCY_P50_MS: Record<Exclude<MetaModelId, "muse-voice-transcribe-1.0">, number> = {
  "muse-spark-1.3": measured.models.find((m) => m.model === "muse-spark-1.3")?.latencyMs.p50 ?? 14_000,
  "muse-wonder-1.0": measured.models.find((m) => m.model === "muse-wonder-1.0")?.latencyMs.p50 ?? 30_000,
};
export const LATENCY_BASIS = `p50 of the preflight's measured Meta calls (${measured.source.split(":")[0]}): Muse Spark ${(LATENCY_P50_MS["muse-spark-1.3"] / 1000).toFixed(1)} s, Muse Wonder ${(LATENCY_P50_MS["muse-wonder-1.0"] / 1000).toFixed(1)} s per call; different prompts from the fleet roles, so an estimate; a replayed live call uses its recorded latency`;

export interface ModeStats {
  mode: DispatchMode;
  /** Role runs on all boxes (code and model roles, inspectors included). */
  roleRuns: number;
  /** Model-role runs: the calls a live run would make. */
  modelCalls: number;
  /** Role runs this mode skipped (role × box), and how many of them were model calls. */
  skipped: number;
  skippedModelCalls: number;
  /** Estimated live cost of the model calls (USD at list price; recorded cost where a live call was replayed). */
  costUsd: number;
  /** Σ latency of every model call (seconds of model time). */
  modelSeconds: number;
  /** Average per-box critical path (ms). */
  latencyPerBoxMs: number;
  held: number;
  proposedRefundCents: number;
  claims: number;
  claimCents: number;
}

export interface Finding {
  rmaId: string;
  kind: "hold" | "claim" | "restock" | "note" | "work_item";
  detail: string;
}

export interface RoleDispatch {
  role: RoleId;
  kind: AgentSpec["kind"];
  ranSelective: number;
  ranAlways: number;
  skipped: number;
  /** One skip reason, as an example of what the trigger saw. */
  example: string | null;
}

export interface DispatchComparison {
  shiftId: string;
  label: string;
  returns: number;
  selective: ModeStats;
  always: ModeStats;
  /** Findings always-run made and selective did not. */
  missed: { holds: Finding[]; claims: Finding[]; drafts: Finding[] };
  /** Holds selective has that always-run doesn't (counted as false holds: always-run is the reference). */
  addedFalseHolds: Finding[];
  /** Σ proposed refund, selective − always-run (0 when selective proposes exactly what always-run does). */
  refundDeltaCents: number;
  byRole: RoleDispatch[];
  latencyBasis: string;
}

const holdsOf = (o: ReturnOutcome) => o.lines.filter((l) => l.status !== "OK").flatMap((l) => [...new Set(l.reasons.filter((r) => r.code !== "count_match").map((r) => r.code))].map((c) => `${l.itemKey}:${c}`));

function stats(run: ShiftRun, roster: AgentSpec[], recorded?: RecordedFleet): ModeStats {
  const spec = new Map(roster.map((a) => [a.name, a]));
  let roleRuns = 0;
  let modelCalls = 0;
  let skipped = 0;
  let skippedModelCalls = 0;
  let costUsd = 0;
  let modelMs = 0;
  let pathMs = 0;
  for (const o of run.outcomes) {
    const stageMax = new Map<number, number>();
    for (const d of o.dispatch) {
      const a = spec.get(d.agent);
      if (d.state === "skipped") {
        skipped++;
        if (a?.kind === "model") skippedModelCalls++;
        continue;
      }
      if (d.state === "removed") continue;
      roleRuns++;
      if (!d.modelCall || !a?.model) continue;
      modelCalls++;
      // A replayed live call (used or rejected) was really made: its recorded latency and cost stand in for the estimates.
      const proof = o.traces.find((t) => t.agent === d.agent)?.proof;
      const recCost = proof ? recorded?.[o.rmaId]?.[d.role]?.costUsd : null;
      const ms = proof && proof.latencyMs > 0 ? proof.latencyMs : (LATENCY_P50_MS[a.model as keyof typeof LATENCY_P50_MS] ?? 0);
      costUsd += recCost ?? a.costPerRunUsd;
      modelMs += ms;
      const st = STAGE[d.role];
      stageMax.set(st, Math.max(stageMax.get(st) ?? 0, ms));
    }
    pathMs += [...stageMax.values()].reduce((s, x) => s + x, 0);
  }
  const n = run.outcomes.length || 1;
  return {
    mode: run.dispatch,
    roleRuns,
    modelCalls,
    skipped,
    skippedModelCalls,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    modelSeconds: Math.round(modelMs / 100) / 10,
    latencyPerBoxMs: Math.round(pathMs / n),
    held: run.outcomes.filter((o) => o.lines.some((l) => l.status !== "OK")).length,
    proposedRefundCents: run.outcomes.reduce((s, o) => s + o.proposedRefundCents, 0),
    claims: run.outcomes.filter((o) => o.claim).length,
    claimCents: run.outcomes.reduce((s, o) => s + (o.claim?.claimCents ?? 0), 0),
  };
}

/** Compare two runs of the same shift (selective vs always-run). Pure: usable on a hand-built shift in tests. */
export function compareRuns(selective: ShiftRun, always: ShiftRun, recorded?: RecordedFleet): DispatchComparison {
  const roster = selective.roster;
  const missed: DispatchComparison["missed"] = { holds: [], claims: [], drafts: [] };
  const addedFalseHolds: Finding[] = [];
  always.outcomes.forEach((a, i) => {
    const s = selective.outcomes[i];
    const id = a.rmaId;
    const ah = holdsOf(a);
    const sh = new Set(holdsOf(s));
    for (const h of ah) if (!sh.has(h)) missed.holds.push({ rmaId: id, kind: "hold", detail: h.replace(":", " · ") });
    for (const h of sh) if (!ah.includes(h)) addedFalseHolds.push({ rmaId: id, kind: "hold", detail: h.replace(":", " · ") });
    if (a.claim && (!s.claim || s.claim.claimCents < a.claim.claimCents)) missed.claims.push({ rmaId: id, kind: "claim", detail: `${a.claim.carrier} claim draft for ${(a.claim.claimCents / 100).toFixed(2)} USD` });
    const sr = new Set((s.restock ?? []).map((r) => `${r.itemKey}|${r.grade}|${r.channel}`));
    for (const r of a.restock ?? []) if (!sr.has(`${r.itemKey}|${r.grade}|${r.channel}`)) missed.drafts.push({ rmaId: id, kind: "restock", detail: `${r.itemKey.replace("_", " ")} ${r.grade} → ${r.channel}` });
    if (a.message.text !== s.message.text) missed.drafts.push({ rmaId: id, kind: "note", detail: `customer note differs (always-run: ${a.message.by}; selective: ${s.message.by})` });
    const sw = new Set(s.workItems.map((w) => w.text));
    for (const w of a.workItems) if (!sw.has(w.text)) missed.drafts.push({ rmaId: id, kind: "work_item", detail: w.text });
  });
  const byRole: RoleDispatch[] = [...new Set(roster.filter((a) => a.role !== "inspector").map((a) => a.role))].map((role) => {
    const ran = (run: ShiftRun) => run.outcomes.filter((o) => o.dispatch.some((d) => d.role === role && (d.state === "ran" || d.state === "unavailable"))).length;
    const skips = selective.outcomes.flatMap((o) => o.dispatch.filter((d) => d.role === role && d.state === "skipped"));
    return { role, kind: roster.find((a) => a.role === role)!.kind, ranSelective: ran(selective), ranAlways: ran(always), skipped: skips.length, example: skips[0]?.reason ?? null };
  });
  return {
    shiftId: selective.shiftId,
    label: selective.label,
    returns: selective.outcomes.length,
    selective: stats(selective, roster, recorded),
    always: stats(always, roster, recorded),
    missed,
    addedFalseHolds,
    refundDeltaCents: selective.outcomes.reduce((s, o) => s + o.proposedRefundCents, 0) - always.outcomes.reduce((s, o) => s + o.proposedRefundCents, 0),
    byRole,
    latencyBasis: LATENCY_BASIS,
  };
}

/** Run the shift both ways and compare. */
export function compareDispatch(shift: SeededShift, opts: { recorded?: RecordedFleet; roster?: AgentSpec[] } = {}): DispatchComparison {
  const roster = opts.roster ?? buildRoster(shift);
  const selective = runShift(shift, { recorded: opts.recorded, roster, dispatch: "selective" });
  const always = runShift(shift, { recorded: opts.recorded, roster, dispatch: "always" });
  return compareRuns(selective, always, opts.recorded);
}
