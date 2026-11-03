import type { ReturnCase } from "@/lib/domain/case";

/** One entry per RMA: the newest run, plus how many runs of that RMA there are (re-running a demo RMA adds a run). */
export function latestPerRma(cases: ReturnCase[]): Array<{ latest: ReturnCase; runs: number }> {
  const by = new Map<string, { latest: ReturnCase; runs: number }>();
  for (const c of cases) {
    const e = by.get(c.rmaId);
    if (!e) by.set(c.rmaId, { latest: c, runs: 1 });
    else by.set(c.rmaId, { latest: c.createdAt > e.latest.createdAt ? c : e.latest, runs: e.runs + 1 });
  }
  return [...by.values()].sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}

/** The sidebar badges: held RMAs (one per RMA) and refunded runs. */
export const caseCounts = (cases: ReturnCase[]) => ({
  held: latestPerRma(cases.filter((c) => c.state === "Held")).length,
  refunds: cases.filter((c) => c.state === "Refunded").length,
});
