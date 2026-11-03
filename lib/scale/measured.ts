/**
 * Measured live calls, summarised per model and job, for the scale arithmetic. Pure: the script
 * (scripts/measured-calls-summary.ts) reads the local call log and writes data/measured-calls.json; the
 * page imports that JSON. Only what the log recorded: counts, latency percentiles of successful calls,
 * and logged cost. Nothing is estimated here.
 */

export interface CallRow {
  at?: string;
  provider?: string;
  model?: string;
  purpose?: string;
  ok?: boolean;
  latencyMs?: number | null;
  costUsd?: number | null;
}

export interface ModelMeasure {
  /** `<model>/<job>`, e.g. "sam-3.1/segment" (one row per concept request). */
  id: string;
  model: string;
  job: string;
  calls: number;
  ok: number;
  latencyMs: { p50: number; p90: number; max: number };
  costUsd: { p50: number; total: number };
}

export interface MeasuredCalls {
  source: string;
  window: { from: string; to: string };
  providers: string[];
  models: ModelMeasure[];
}

/** Nearest-rank percentile of an ascending list; 0 for an empty list. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function summarizeCalls(rows: CallRow[], opts: { since: string; until?: string; source: string; providers?: string[] }): MeasuredCalls {
  const providers = opts.providers ?? ["meta"];
  const from = Date.parse(opts.since);
  const to = opts.until ? Date.parse(opts.until) : Infinity;
  if (!Number.isFinite(from)) throw new Error(`bad --since: ${opts.since}`);
  const inWindow = rows.filter((r) => {
    const t = Date.parse(r.at ?? "");
    return Number.isFinite(t) && t >= from && t <= to && providers.includes(r.provider ?? "") && r.model && r.purpose;
  });
  const groups = new Map<string, CallRow[]>();
  for (const r of inWindow) {
    const job = r.purpose!.split(":")[0];
    const id = `${r.model}/${job}`;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  const models: ModelMeasure[] = [...groups.entries()]
    .map(([id, g]) => {
      const ok = g.filter((r) => r.ok !== false);
      const lat = ok.map((r) => r.latencyMs ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
      const cost = ok.map((r) => r.costUsd ?? 0).sort((a, b) => a - b);
      const [model, job] = id.split("/");
      return {
        id,
        model,
        job,
        calls: g.length,
        ok: ok.length,
        latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90), max: lat.at(-1) ?? 0 },
        costUsd: { p50: round(percentile(cost, 50), 6), total: round(g.reduce((s, r) => s + (r.costUsd ?? 0), 0), 6) },
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const times = inWindow.map((r) => r.at!).sort();
  return { source: opts.source, window: { from: times[0] ?? opts.since, to: times.at(-1) ?? opts.since }, providers, models };
}
