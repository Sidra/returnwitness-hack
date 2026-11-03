import Link from "next/link";
import measuredJson from "@/data/measured-calls.json";
import { DEFAULT_PARAMS, shiftCapacity, type SourceKind } from "@/lib/scale/capacity";
import type { MeasuredCalls } from "@/lib/scale/measured";
import styles from "./ScaleSection.module.css";

const measured = measuredJson as MeasuredCalls;

const KIND_TEXT: Record<SourceKind, string> = { measured: "measured", assumption: "assumption", fixture: "seeded fixture", config: "configured", target: "planning target" };
const usd = (n: number, d = 2) => `$${n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * "How it scales": a PLANNING PROJECTION of one shift at 500 returns, from model calls measured on a synthetic preflight
 * clip plus labelled assumptions. It sits below the measured flow, smaller than any measured number, and every input
 * keeps its source in the "Projection inputs" details.
 */
export function ScaleSection() {
  const c = shiftCapacity(measured);
  const p = DEFAULT_PARAMS;
  const m = (model: string) => measured.models.find((x) => x.model === model)!;
  const rows: Array<{ k: string; v: string; kind: SourceKind; note: string }> = [
    { k: "SAM 3.1, one concept", v: `${secs(m("sam-3.1").latencyMs.p90)} p90 · ${usd(m("sam-3.1").costUsd.p50, 3)}`, kind: "measured", note: `${m("sam-3.1").ok} calls` },
    { k: "Muse Spark 1.3 reader", v: `${secs(m("muse-spark-1.3").latencyMs.p90)} p90 · ${usd(m("muse-spark-1.3").costUsd.p50, 3)}`, kind: "measured", note: `${m("muse-spark-1.3").ok} successful of ${m("muse-spark-1.3").calls} (two returned 400s, since fixed)` },
    { k: "Muse Wonder 1.0 agent run", v: `${secs(m("muse-wonder-1.0").latencyMs.p90)} p90 · ${usd(m("muse-wonder-1.0").costUsd.p50, 3)}`, kind: "measured", note: `${m("muse-wonder-1.0").ok} runs, tool loop included` },
    { k: "Muse Voice Transcribe", v: `${secs(m("muse-voice-transcribe-1.0").latencyMs.p90)} p90 · ${usd(m("muse-voice-transcribe-1.0").costUsd.p50, 4)}`, kind: "measured", note: "runs while the box is unpacked, off the critical path" },
    ...Object.entries({
      "Returns a day": [p.returnsPerDay, String(p.returnsPerDay.value)],
      Shift: [p.shiftHours, `${p.shiftHours.value} h`],
      "Busiest hour": [p.peakFactor, `${p.peakFactor.value}× average`],
      "Clip length": [p.clipSeconds, `${p.clipSeconds.value} s`],
      "SAM concepts per box": [p.samConcepts, String(p.samConcepts.value)],
      "Bench time per box": [p.benchSecondsPerBox, `${p.benchSecondsPerBox.value} s`],
      "Boxes held": [p.heldShare, `${Math.round(p.heldShare.value * 100)}%`],
      "Review a hold": [p.reviewSecondsPerHold, `${p.reviewSecondsPerHold.value} s`],
      "Approve a clean box": [p.approveSecondsPerClean, `${p.approveSecondsPerClean.value} s`],
    } as const).map(([k, [inp, v]]) => ({ k, v, kind: inp.kind, note: inp.note })),
  ];

  return (
    <section id="scale" className="container section" aria-labelledby="scale-title" style={{ scrollMarginTop: 72 }}>
      <div className="rule-top" style={{ paddingTop: 24 }}>
        <div className="stack" style={{ gap: 24 }}>
          <div className="stack">
            <span className="eyebrow">Planning projection · not a measurement</span>
            <h2 className="h2" id="scale-title">
              Planning projection: one shift at {p.returnsPerDay.value} returns a day
            </h2>
            <p className="lead" style={{ maxWidth: "70ch" }}>
              Arithmetic, not observed throughput: no bench has run this load. Model time and cost come from measured live Meta calls on a synthetic preflight clip;
              the people side is assumption. On the filmed clips SAM 3.1 took 14.8 s and 20.8 s (the flow above), slower than the preflight clip, so the SAM
              time in this projection is optimistic.
            </p>
          </div>

          <div className={styles.projected}>
            <span className={styles.tag}>Projected</span>
            <div className="kpis">
              <div className="kpi">
                <div className="v">{c.peakBoxesPerHour}</div>
                <div className="k">boxes in the busiest hour ({c.avgBoxesPerHour} on average), assumed</div>
              </div>
              <div className="kpi">
                <div className="v">{Math.round(c.modelPathSeconds.total)} s</div>
                <div className="k">clip end → decision draft, p90 on the preflight clip (SAM {c.modelPathSeconds.segment.toFixed(1)} s · Spark {c.modelPathSeconds.readers.toFixed(1)} s · Wonder {c.modelPathSeconds.agent.toFixed(1)} s)</div>
              </div>
              <div className="kpi">
                <div className="v">{c.boxesInFlightPeak.toFixed(1)}</div>
                <div className="k">boxes with models running at once at the peak (Little&apos;s law)</div>
              </div>
              <div className="kpi">
                <div className="v">{Math.round(c.callsPerMinutePeak)}</div>
                <div className="k">Meta calls a minute at the peak ({c.callsPerBox} per box)</div>
              </div>
              <div className="kpi">
                <div className="v">{c.benchesNeeded}</div>
                <div className="k">benches staffed in the busiest hour</div>
              </div>
              <div className="kpi">
                <div className="v">{Math.round(c.peopleHoursPerDay)} h</div>
                <div className="k">people time a day (unpacking, reviewing holds, approving), assumed rates</div>
              </div>
              <div className="kpi">
                <div className="v">{usd(c.usdPerBox.total)}</div>
                <div className="k">
                  Meta cost per box at list price (SAM {usd(c.usdPerBox.segment)} · Wonder {usd(c.usdPerBox.agent)} · Spark {usd(c.usdPerBox.reader)})
                </div>
              </div>
              <div className="kpi">
                <div className="v">{usd(c.usdPerDay, 0)}</div>
                <div className="k">Meta cost a day ({usd(c.usdPer30Days, 0)} per 30 days)</div>
              </div>
            </div>
          </div>

          <div className="cols-2">
            <div className="stack" style={{ gap: 10 }}>
              <h3 className="h3">What the projection says</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 16 }} className="stack">
                <li>
                  In the projection the draft is ready about {Math.round(c.modelPathSeconds.total)} s after the clip ends, inside the {p.benchSecondsPerBox.value} s assumed to unpack the next box, so a bench would not wait on a model:{" "}
                  <strong>the projected bottleneck is {c.bottleneck}</strong>.
                </li>
                <li>Two or three boxes in flight and about {Math.round(c.callsPerMinutePeak)} calls a minute is a small load; each box is independent, so in the projection benches add linearly.</li>
                <li>Wonder is the slowest and the costliest model step per box; SAM grows with clip length (billed per frame, 50-frame minimum per request).</li>
                <li>
                  The fleet&apos;s app-code roles cost nothing to scale; see <Link href="/dashboard/agents">Agents at work</Link> for the per-role projection.
                </li>
              </ul>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <h3 className="h3">When something breaks</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 16 }} className="stack">
                <li>A required model call fails, times out or answers out of shape: the box lands in Held, and nothing refunds by default. An optional reader that fails adds nothing. On the filmed run the fleet&apos;s policy agent timed out on both boxes and app code stood in; Glimmer timed out on d2 and added no hold; the boxes were held for other reasons (d1 the missing lens, d2 the false stand-in flag).</li>
                <li>SAM 3.1 has a second path on open weights (Modal); it is switched on for local runs, not on the public site.</li>
                <li>A queue backs up: boxes wait as Held or awaiting approval. The cost of falling behind is a slower refund, never a wrong one.</li>
              </ul>
            </div>
          </div>

          <details className={styles.details}>
            <summary>Projection inputs: every value and where it comes from</summary>
            <div className="stack" style={{ gap: 8, marginTop: 12, minWidth: 0 }}>
              <p className="muted" style={{ margin: 0, fontSize: 14 }} id="scale-inputs">
                Measured: {measured.source}.
              </p>
              <div className="table-wrap">
                <table className="table scale-table" aria-describedby="scale-inputs">
                  <thead>
                    <tr>
                      <th scope="col">Input</th>
                      <th scope="col">Value</th>
                      <th scope="col">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.k}>
                        <td>
                          <strong style={{ fontSize: 15 }}>{r.k}</strong>
                          <div className="muted" style={{ fontSize: 14 }}>
                            {r.note}
                          </div>
                          <span className={`scale-kind scale-kind-${r.kind} scale-kind-inline`}>{KIND_TEXT[r.kind]}</span>
                        </td>
                        <td className="mono" style={{ fontSize: 14 }}>
                          {r.v}
                        </td>
                        <td>
                          <span className={`scale-kind scale-kind-${r.kind}`}>{KIND_TEXT[r.kind]}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: "80ch" }}>
                The measured calls were on a synthetic 25-frame clip, and SAM&apos;s cost is scaled by billed frames. On the filmed bench clips SAM 3.1 took 14.8 s (a 21 s clip) and 20.8 s (a 27 s clip), all concepts in parallel, so the SAM time here is optimistic; these figures aren&apos;t recomputed from the filmed run yet (scripts/measured-calls-summary.ts).
              </p>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
