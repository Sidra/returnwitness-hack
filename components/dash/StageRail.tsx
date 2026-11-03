"use client";

import type { StageTiming } from "@/lib/domain/case";
import { modeText, type ModeLabel } from "@/lib/domain/schemas";

export type StageView = { state: "idle" | "running" | "done"; ms?: number; mode?: ModeLabel };
export type StageMap = Record<"segment" | "count" | "reconcile" | "draft", StageView>;

export const EMPTY_STAGES: StageMap = { segment: { state: "idle" }, count: { state: "idle" }, reconcile: { state: "idle" }, draft: { state: "idle" } };

const META: Array<{ key: keyof StageMap; n: string; title: string; who: string }> = [
  { key: "segment", n: "01", title: "Segment", who: "SAM 3.1 finds each item, hand and paper" },
  { key: "count", n: "02", title: "Count", who: "app code: one count per item settled in the tray" },
  { key: "reconcile", n: "03", title: "Reconcile", who: "slip vs seen; Muse Spark can only add holds" },
  { key: "draft", n: "04", title: "Draft", who: "Muse Wonder cites the clause; never decides" },
];

/** Real measured time; the fixture step says it replayed a recording rather than pretending to segment. */
export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(2)} ms`;
}
const stageTime = (s: StageView) => (s.mode === "RECORDED_FIXTURE" ? `replayed · ${fmtMs(s.ms ?? 0)}` : fmtMs(s.ms ?? 0));

export function stagesFromTimings(timings: StageTiming[]): StageMap {
  const m: StageMap = { ...EMPTY_STAGES };
  for (const t of timings) if (t.stage in m) m[t.stage as keyof StageMap] = { state: "done", ms: t.ms, mode: t.mode };
  return m;
}

export function StageRail({ stages, realReplay = false }: { stages: StageMap; realReplay?: boolean }) {
  const total = Object.values(stages).reduce((s, v) => s + (v.ms ?? 0), 0);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="stages" role="list" aria-label="Inspection stages">
        {META.map((m) => {
          const s = stages[m.key];
          return (
            <div className="stage" role="listitem" key={m.key} data-state={s.state}>
              <div className="n">{m.n}</div>
              <div className="t">{m.title}</div>
              <div className="ms">{s.state === "done" ? stageTime(s) : s.state === "running" ? "running" : "—"}</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.35 }}>
                {m.who}
              </div>
              {s.mode && (
                <div className="mono muted" style={{ fontSize: 13, marginTop: 4 }}>
                  {modeText(s.mode, realReplay)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {Object.values(stages).every((v) => v.state === "done") && (
        <span className="mono muted" style={{ fontSize: 13 }}>
          End to end: {fmtMs(total)} measured on this server{stages.segment.mode === "RECORDED_FIXTURE" ? " (segmentation replayed from a recording; live SAM 3.1 adds its own time)" : ""}
        </span>
      )}
    </div>
  );
}
