"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LiveProof, ModeBadge } from "@/components/ModeBadge";
import { formatCents } from "@/lib/format";
import type { Queue, ReplayAgent, ReplayData } from "@/lib/fleet/types";
import { RMAS } from "@/data/fixtures";
import { misreadsIn } from "@/data/known-misreads";
import { LossNotes } from "./LossNotes";
import styles from "./AgentsAtWork.module.css";

const TICK_MS = 650;
/** Ticks the finished outcome stays on screen before the next box. */
const HOLD_TICKS = 4;

const QUEUE_TEXT: Record<Queue, string> = {
  approve_refund: "Approve refund (a person, single-use token)",
  hold_review: "Hold review",
  fraud_review: "Pattern review",
  carrier_desk: "Carrier desk",
  safety_bin: "Safety bin",
  unsorted: "Unsorted",
};

const usd = (n: number, dp = 4) => `$${n.toFixed(dp)}`;

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * A replay of the seeded shift: the roster on the left, the box being worked on the right. It steps
 * through each return's agent traces on a timer. Nothing here is live; every model role runs as
 * deterministic app code and says so.
 */
export type RoleEffect = { effectClass: "decision" | "artifact_only" | "cost_only" | "none"; usefulBoxes: number; of: number };

/**
 * The ablation label under a role's name. It describes the frozen-output ablation over the whole seeded shift, never the
 * box on screen, and says so; only a role whose removal changes a decision there gets the green label.
 */
const effectText = (e: RoleEffect) =>
  e.effectClass === "decision"
    ? `Shift ablation: removing it changes a decision on ${e.usefulBoxes} of ${e.of} seeded boxes`
    : e.effectClass === "artifact_only"
      ? "Shift ablation: removing it changes no decision, only work a person uses"
      : e.effectClass === "cost_only"
        ? "Shift ablation: removing it changes no decision, only the fees line"
        : "Shift ablation: no effect on the seeded shift";

/**
 * effects: each role's ablation result (lib/fleet/ablation.ts), shown under its name.
 * withheld: recorded answers withheld as false (data/known-misreads.ts); the loss shows beside that box's draft.
 */
export function AgentsAtWork({ data, effects = {}, withheld = [] }: { data: ReplayData; effects?: Record<string, RoleEffect>; withheld?: Array<{ rmaId: string; role: string; why: string }> }) {
  const [pos, setPos] = useState({ idx: 0, step: 0 });
  // Reduced motion → start paused (the person steps through by hand). The server renders paused.
  const reduce = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
  const [chosen, setChosen] = useState<boolean | null>(null);
  const playing = chosen ?? !reduce;
  const { idx, step } = pos;
  const n = data.returns.length;

  const ret = data.returns[idx];
  // The filmed clip behind this box, if any: recorded live answers on it carry their known misreads as losses.
  const clipId = RMAS.find((r) => r.id === ret?.rmaId)?.clipId;
  const last = ret.steps.length;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setPos((p) => (p.step < data.returns[p.idx].steps.length + HOLD_TICKS ? { ...p, step: p.step + 1 } : { idx: (p.idx + 1) % n, step: 0 }));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, data.returns, n]);

  const go = (d: number) => setPos((p) => ({ idx: (p.idx + d + n) % n, step: 0 }));
  const finish = () => setPos((p) => ({ ...p, step: data.returns[p.idx].steps.length + HOLD_TICKS }));

  const specialists = data.agents.filter((a) => a.role !== "inspector");
  const inspectors = data.agents.filter((a) => a.role === "inspector");
  const counts = useMemo(() => ({ code: data.agents.filter((a) => a.kind === "code").length, model: data.agents.filter((a) => a.kind === "model").length }), [data.agents]);
  const shiftUsd = data.agents.reduce((s, a) => s + a.shiftUsd, 0);
  const liveBoxes = data.returns.filter((r) => r.steps.some((x) => x.source === "recorded_live")).length;
  const done = step >= last;
  const held = ret.lines.some((l) => l.status !== "OK");
  const ranHere = ret.dispatch.filter((d) => d.state === "ran");
  const skippedHere = ret.dispatch.filter((d) => d.state === "skipped" || d.state === "removed");
  const unavailableHere = ret.dispatch.filter((d) => d.state === "unavailable");
  const modelCallsHere = ret.dispatch.filter((d) => d.modelCall).length;

  const now = (a: ReplayAgent): { text: string; active: boolean; state: "active" | "done" | "queued" | "idle" } => {
    const k = ret.steps.findIndex((s) => s.agent === a.name);
    if (k === -1) {
      if (a.role === "inspector") {
        const own = data.returns.findIndex((r) => `inspector-${r.rmaId.toLowerCase()}` === a.name);
        return own < idx ? { text: "done: its box is in the queue", active: false, state: "done" } : { text: "waiting for its box", active: false, state: "idle" };
      }
      const d = ret.dispatch.find((x) => x.agent === a.name);
      return { text: d ? `${d.state === "removed" ? "removed" : "skipped"}: ${d.reason}` : "not run on this box", active: false, state: "idle" };
    }
    if (k === step - 1) return { text: ret.steps[k].line, active: true, state: "active" };
    if (k < step) return { text: ret.steps[k].line, active: false, state: "done" };
    return { text: "queued", active: false, state: "queued" };
  };

  /** How this agent's result on the current box was produced. */
  const sourceOf = (a: ReplayAgent) => ret.steps.find((x) => x.agent === a.name);

  const kindCell = (a: ReplayAgent) => {
    if (a.kind !== "model") return <span>code</span>;
    const stepNow = sourceOf(a);
    if (stepNow?.source === "recorded_live" && stepNow.proof) {
      return (
        <div className="stack" style={{ gap: 4 }}>
          <span className="mode mode-live" title="A live Meta answer saved when this box ran live, replayed here">
            recorded live Meta output
          </span>
          <LiveProof mode="LIVE_META" model={stepNow.proof.model} ms={stepNow.proof.latencyMs} requestId={stepNow.proof.requestId} />
        </div>
      );
    }
    if (stepNow?.source === "live_rejected") {
      return (
        <div className="stack" style={{ gap: 4 }}>
          <span className="mode mode-fallback" title="A live answer existed but was rejected; the result shown is app code">
            live answer unavailable
          </span>
          <ModeBadge mode="DETERMINISTIC" title={`The live answer was not used. The result shown is app code. Live it calls ${a.model}.`} />
          <span className="muted" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
            {stepNow.unavailable?.reason ?? stepNow.proof?.error ?? "error"}; app code stands in, holds kept
          </span>
        </div>
      );
    }
    if (!stepNow) {
      return (
        <span className="muted" style={{ fontSize: 13 }}>
          model role, not called on this box (live: {a.model})
        </span>
      );
    }
    return (
      <div className="stack" style={{ gap: 4 }}>
        <ModeBadge mode="DETERMINISTIC" title={`On this box the role ran as app code. Live it calls ${a.model}.`} />
        <span className="muted" style={{ fontSize: 13 }}>live: {a.model}</span>
      </div>
    );
  };

  const row = (a: ReplayAgent) => {
    const st = now(a);
    return (
      <tr key={a.name} aria-selected={st.active ? "true" : undefined} data-state={st.state}>
        <td style={{ minWidth: 160 }}>
          <div style={{ fontWeight: 700 }}>{a.name}</div>
          <div className="muted" style={{ fontSize: 14, fontFamily: "var(--font-body)", whiteSpace: "normal" }}>
            {a.does}
          </div>
          {effects[a.role] && <div className={effects[a.role].effectClass === "decision" ? `${styles.effect} ${styles.effectDecision}` : styles.effect}>{effectText(effects[a.role])}</div>}
        </td>
        <td style={{ minWidth: 150, whiteSpace: "normal" }}>{kindCell(a)}</td>
        <td style={{ minWidth: 200, whiteSpace: "normal" }}>
          <span
            className={st.state === "active" ? "st st-warn" : st.state === "done" ? "" : "muted"}
            style={st.state === "active" ? { textTransform: "none", letterSpacing: 0, fontWeight: 700, whiteSpace: "normal" } : undefined}
          >
            {st.state === "active" ? "▶ " : ""}
            {st.text}
          </span>
        </td>
      </tr>
    );
  };

  return (
    <section className="stack" style={{ gap: 16 }} aria-labelledby="replay-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 className="h3" id="replay-title">
            The shift, replayed: {data.bench}
          </h2>
          <span className="fixture-label">
            {data.label} · replay of the seeded shift, not a live bench · {data.dispatch === "selective" ? "selective dispatch" : "always-run"}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {liveBoxes > 0 && (
            <span className="mode mode-live" title="Saved live Meta answers, replayed; every other result is app code">
              recorded live Meta output · {liveBoxes} box{liveBoxes > 1 ? "es" : ""}
            </span>
          )}
          <ModeBadge mode="DETERMINISTIC" title="Every result without a recorded live answer runs as deterministic app code. No model is called on this page." />
        </div>
      </div>

      <div className="row" role="group" aria-label="Replay controls">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setChosen(!playing)} aria-pressed={playing}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => go(-1)}>
          ◀ Previous box
        </button>
        <button type="button" className="btn btn-sm" onClick={() => go(1)}>
          Next box ▶
        </button>
        <button type="button" className="btn btn-sm" onClick={finish} disabled={done}>
          Show outcome
        </button>
        <span className="mono" style={{ fontSize: 13 }}>
          Box {idx + 1} of {n} · {ret.rmaId} · step {Math.min(step, last)} of {last}
        </span>
      </div>
      <div aria-hidden="true" style={{ height: 4, background: "var(--hair)" }}>
        <div style={{ height: 4, width: `${((idx + Math.min(step, last) / last) / n) * 100}%`, background: "var(--accent)" }} />
      </div>

      <section className="card stack" style={{ gap: 12 }} aria-label={`Box ${ret.rmaId}`}>
        <div className="stack" style={{ gap: 2 }}>
          <span className="eyebrow">
            {ret.rmaId} · {ret.customer}
          </span>
          <strong style={{ fontSize: 17 }}>{ret.scenario}</strong>
        </div>
        <details>
          <summary className={styles.summary}>
            {ranHere.length + unavailableHere.length} of {ret.dispatch.length} roles ran ({modelCallsHere} model call{modelCallsHere === 1 ? "" : "s"}) · {skippedHere.length} skipped
            {unavailableHere.length ? ` · ${unavailableHere.length} live answer${unavailableHere.length > 1 ? "s" : ""} unavailable` : ""}
          </summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 14 }}>
            {[...unavailableHere, ...skippedHere].map((d) => (
              <li key={d.agent} style={{ overflowWrap: "anywhere" }}>
                <span className="mono">{d.agent}</span> <span className={d.state === "unavailable" ? "st st-held" : "muted"}>{d.state}</span>: {d.reason}
              </li>
            ))}
            {ranHere.length > 0 && (
              <li className="muted" style={{ overflowWrap: "anywhere" }}>
                ran: {ranHere.map((d) => d.agent).join(", ")}
              </li>
            )}
          </ul>
        </details>
        <div className="cols-2" style={{ gap: 24 }}>
          <ol className="audit" aria-label="Agent trace">
            {ret.steps.map((s, k) => (
              <li key={s.agent} style={{ opacity: k < step ? 1 : 0.35, fontWeight: k === step - 1 ? 700 : 400 }}>
                <span className="mono" style={{ fontSize: 13 }}>
                  {s.stage} · {s.agent}
                </span>
                <div style={{ fontSize: 15 }}>{k < step ? s.line : "…"}</div>
                {k < step && <LossNotes items={misreadsIn(clipId, s.line)} />}
                {k < step && s.source === "recorded_live" && s.proof && (
                  <div className="row" style={{ gap: 6 }}>
                    <span className="fixture-label">recorded live Meta output</span>
                    <LiveProof mode="LIVE_META" model={s.proof.model} ms={s.proof.latencyMs} requestId={s.proof.requestId} />
                  </div>
                )}
                {k < step && s.source === "live_rejected" && (
                  <div className="row" style={{ gap: 6 }}>
                    <span className="mode mode-fallback">live answer unavailable · {s.unavailable?.kind.replace("_", " ") ?? "rejected"}</span>
                    <span className="muted" style={{ fontSize: 13 }}>app-code result shown</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {!done ? (
            <p className="muted" style={{ margin: 0 }}>
              The coordinator merges the findings and routes the box once every agent has reported.
            </p>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <div>{held ? <span className="sticker-held">HELD FOR A PERSON</span> : <span className="sticker-ok">READY FOR A PERSON TO APPROVE</span>}</div>
              <table className="table">
                <tbody>
                  {ret.lines.map((l) => (
                    <tr key={l.itemKey}>
                      <td>
                        {l.description}
                        {l.reasons.slice(0, 2).map((r) => (
                          <div key={r} className="muted" style={{ fontSize: 14 }}>
                            {r}
                            <LossNotes items={misreadsIn(clipId, r, l.itemKey)} />
                          </div>
                        ))}
                      </td>
                      <td>
                        <span className={l.status === "OK" ? "st st-ok" : l.status === "EXTRA" ? "st st-extra" : "st st-held"}>{l.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="receipt receipt-wrap">
                <dl>
                  <dt>Proposed refund</dt>
                  <dd>
                    {formatCents(ret.proposedRefundCents)} of {formatCents(ret.requestedCents)} ({ret.recommended.replace("_", " ")}) · a proposal; only a person&apos;s token moves money
                  </dd>
                  <dt>Carrier claim</dt>
                  <dd>{ret.claimCents === null ? "none" : `draft for ${formatCents(ret.claimCents)}, a person files it`}</dd>
                  <dt>Restock</dt>
                  <dd>{ret.restock ?? "not graded"}</dd>
                  <dt>Routed to</dt>
                  <dd>{ret.queues.map((q) => QUEUE_TEXT[q]).join(" + ")}</dd>
                  <dt>Agent cost</dt>
                  <dd>
                    {usd(ret.agentCostUsd + ret.segmentationUsd)} est. live (segmentation {usd(ret.segmentationUsd)})
                  </dd>
                </dl>
              </div>
              {ret.workItems.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                  {ret.workItems.map((w) => (
                    <li key={w}>
                      {w}
                      <LossNotes items={misreadsIn(clipId, w)} />
                    </li>
                  ))}
                </ul>
              )}
              <div className="well" style={{ whiteSpace: "pre-line", fontSize: 15 }}>
                <span className="eyebrow">Customer note (draft, a person sends it)</span>
                <div style={{ marginTop: 6 }}>{ret.message}</div>
                {withheld
                  .filter((w) => w.rmaId === ret.rmaId)
                  .map((w) => (
                    <p key={w.role} className="loss-note" style={{ margin: "8px 0 0", fontSize: 14, whiteSpace: "normal" }}>
                      <span className="loss-tag">Loss</span> {w.role}: the recorded live answer for this box was withheld, {w.why}. The note above is the app-code draft.
                    </p>
                  ))}
              </div>
            </div>
          )}
        </div>
      </section>
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <div className="table-wrap">
          <table className="table table-dense" aria-label="Agent roster">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Kind</th>
                <th>Doing now ({ret.rmaId})</th>
              </tr>
            </thead>
            <tbody>
              {specialists.map(row)}
              <tr>
                <th colSpan={3} style={{ paddingTop: 16, whiteSpace: "normal" }}>
                  Inspector · one code path, run once per box ({inspectors.length} runs in the shift)
                </th>
              </tr>
              {inspectors.filter((a) => a.name === `inspector-${ret.rmaId.toLowerCase()}`).map(row)}
              <tr>
                <td colSpan={3} className="muted" style={{ whiteSpace: "normal", fontFamily: "var(--font-body)", fontSize: 14 }}>
                  The other {inspectors.length - 1} inspector names are the same code path on the other boxes, not separate agents.
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ whiteSpace: "normal" }}>
                  {counts.code} code · {counts.model} model roles · {data.agents.length} names in the shift (the per-box inspectors are one code path) ({liveBoxes ? `recorded live Meta output on ${liveBoxes} box${liveBoxes > 1 ? "es" : ""}, app code elsewhere` : "app code on every box: no live run recorded yet"})
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <details className={styles.costs}>
        <summary className={styles.summary}>Role cost at Meta list price (an estimate; this replay called no model and spent $0)</summary>
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="table table-dense" aria-label="Estimated live cost per role">
            <thead>
              <tr>
                <th>Role</th>
                <th className="num">Per run</th>
                <th className="num">Runs in the shift</th>
                <th className="num">Shift (est. live)</th>
              </tr>
            </thead>
            <tbody>
              {specialists.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td className="num">{a.kind === "model" ? usd(a.costPerRunUsd) : "app code"}</td>
                  <td className="num">{a.runs}</td>
                  <td className="num">{a.kind === "model" ? usd(a.shiftUsd) : "$0"}</td>
                </tr>
              ))}
              <tr>
                <td>inspector (one code path)</td>
                <td className="num">app code</td>
                <td className="num">{inspectors.reduce((x, a) => x + a.runs, 0)}</td>
                <td className="num">$0</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Whole shift, if every dispatched model role ran live</td>
                <td className="num">
                  <strong>{usd(shiftUsd)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <span className="fixture-label">Costs are what a live run would cost at Meta list price (token budgets in lib/fleet/agents). This replay called no model and spent $0.</span>
      </details>
    </section>
  );
}
