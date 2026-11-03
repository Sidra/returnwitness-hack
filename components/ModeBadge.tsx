import { modeText, type ModeLabel } from "@/lib/domain/schemas";

const CLS: Record<ModeLabel, string> = {
  LIVE_META: "mode mode-live",
  LIVE_OPEN_WEIGHTS: "mode mode-live",
  RECORDED_FIXTURE: "mode mode-fixture",
  DETERMINISTIC: "mode mode-det",
};

export interface ReplayOf {
  model?: string;
  /** ISO time the real call was recorded. */
  at: string;
  requestId?: string;
}

/**
 * "RECORDED LIVE RUN · <model> · req <id>": a saved real call, replayed. No date or clock time: the request id traces
 * the call, and a run's time is a build timeline, which public pages don't carry.
 */
export function replayText(r: ReplayOf): string {
  return ["RECORDED LIVE RUN", r.model, r.requestId ? `req ${r.requestId}` : null].filter(Boolean).join(" · ");
}

/**
 * Every result says what produced it. A fixture or fallback is never shown as a live Meta call. A replay of a
 * synthetic scene reads "RECORDED FIXTURE · synthetic scene"; a replay of a real recorded call passes `replay`.
 */
export function ModeBadge({ mode, title, replay, fixture, realReplay = false }: { mode: ModeLabel; title?: string; replay?: ReplayOf; fixture?: string; realReplay?: boolean }) {
  const text = mode === "RECORDED_FIXTURE" && replay ? replayText(replay) : mode === "RECORDED_FIXTURE" && fixture ? `RECORDED FIXTURE · ${fixture}, not a live Meta call` : modeText(mode, realReplay);
  return (
    <span className={CLS[mode]} title={title} style={replay && mode === "RECORDED_FIXTURE" ? { overflowWrap: "anywhere" } : undefined}>
      {text}
    </span>
  );
}

/**
 * The proof line under a LIVE result: which model answered, how long it took, and the provider's request id,
 * so anyone can trace a LIVE badge to a real call. Renders nothing for results that aren't live.
 */
export function LiveProof({ mode, model, ms, requestId }: { mode: ModeLabel; model?: string; ms?: number; requestId?: string }) {
  if (mode !== "LIVE_META" && mode !== "LIVE_OPEN_WEIGHTS") return null;
  const parts = [model, ms != null && ms > 0 ? (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`) : null, requestId ? `request ${requestId}` : null].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className="mono muted live-proof" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
      {parts.join(" · ")}
    </span>
  );
}

export function FixtureLabel({ children }: { children: React.ReactNode }) {
  return <span className="fixture-label">{children}</span>;
}
