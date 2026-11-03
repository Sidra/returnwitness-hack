/** Builds the serialisable replay of a shift for the "Agents at work" page. */
import type { SeededShift } from "@/data/shift";
import type { LineStatus } from "@/lib/domain/schemas";
import type { ReplayData, ShiftRun } from "./types";

const STATUS_RANK: Record<LineStatus, number> = { OK: 0, EXTRA: 1, HELD: 2, MISSING: 3 };

export function toReplay(run: ShiftRun, shift: SeededShift): ReplayData {
  const agents = run.roster.map((a) => {
    const runs = a.scope === "shift" ? (run.outcomes.some((o) => o.agentsRun.includes(a.name)) ? 1 : 0) : run.outcomes.filter((o) => o.agentsRun.includes(a.name)).length;
    return { ...a, runs, shiftUsd: Math.round(runs * a.costPerRunUsd * 1e6) / 1e6 };
  });
  return {
    shiftId: run.shiftId,
    dispatch: run.dispatch,
    label: run.label,
    date: shift.shift.date,
    bench: shift.shift.bench,
    lead: shift.shift.lead,
    agents,
    returns: run.outcomes.map((o) => {
      const ret = shift.returns.find((r) => r.rma.id === o.rmaId)!;
      return {
        rmaId: o.rmaId,
        scenario: o.scenario,
        customer: ret.rma.customer.name,
        hasVoiceNote: Boolean(ret.voiceNote),
        steps: o.traces.map((t) => ({ agent: t.agent, stage: t.stage, line: t.line, ...(t.source ? { source: t.source } : {}), ...(t.proof ? { proof: t.proof } : {}), ...(t.unavailable ? { unavailable: t.unavailable } : {}) })),
        dispatch: o.dispatch.map((d) => ({ agent: d.agent, state: d.state, reason: d.reason, modelCall: d.modelCall })),
        lines: [...o.lines]
          .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])
          .map((l) => ({ itemKey: l.itemKey, description: l.description, status: l.status, reasons: l.status === "OK" ? [] : [...new Set(l.reasons.filter((r) => r.code !== "count_match").map((r) => r.detail))] })),
        proposedRefundCents: o.proposedRefundCents,
        requestedCents: ret.rma.requestedRefundCents,
        recommended: o.settlement.recommended,
        claimCents: o.claim?.claimCents ?? null,
        restock: o.restock ? o.restock.map((r) => `${r.itemKey.replace("_", " ")} ${r.grade} → ${r.channel}`).join(" · ") : null,
        message: o.message.text,
        queues: o.route.queues,
        routeWhy: o.route.why,
        workItems: o.workItems.map((w) => w.text),
        agentCostUsd: o.agentCostUsd,
        segmentationUsd: o.cost?.segmentationUsd ?? 0,
      };
    }),
  };
}
