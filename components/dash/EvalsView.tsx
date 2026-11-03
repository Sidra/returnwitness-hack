"use client";

import { useEffect, useState } from "react";

interface Verdict {
  clipId: string;
  pass: boolean;
  failures: string[];
  perItem: Array<{ itemKey: string; expected: number; arrivals: number; samIds: number; held: string[] }>;
  holdCodes: string[];
  note?: string;
  source?: string;
}
interface GateRun {
  runId?: string;
  at?: string;
  verdict?: string;
  notRun?: string[];
  sizes?: string;
  source?: string;
  calibration?: string;
  model?: string;
  clips?: Verdict[];
}
interface EvalsData {
  synthetic: Verdict[];
  real: GateRun[];
  gate?: { live: GateRun | null; rescore: GateRun | null; liveRuns: number; rescores: number; framing: { line?: string } | null };
  learning: { pipelineRuns: number; held: number; approvals: number; overrides: number; manualHolds: number; refunds: number; refundFailures: number; flagCounts: Record<string, number> };
}

/** The registered gate's real result comes first: INCOMPLETE stays INCOMPLETE (scripts/gate/RULE.md), never a PASS. */
function RealGate({ live, rescore, framing, verdictClass }: { live: GateRun | null; rescore: GateRun | null; framing?: string; verdictClass: (v?: string) => string }) {
  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby="real-gate-title">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" id="real-gate-title">
          The registered gate, on the filmed clips
        </h2>
        {live && <span className="mode mode-fixture">RECORDED LIVE RUN · Meta · {live.model ?? "sam-3.1"}</span>}
      </div>
      {!live ? (
        <p className="muted" style={{ margin: 0 }}>Not run yet: no filmed gate clip has been scored.</p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 17 }}>
            <span className={verdictClass(live.verdict)}>{live.verdict}</span>{" "}
            {live.notRun?.length ? <>not run as registered: {live.notRun.join(", ")} not filmed (scripts/gate/RULE.md). Scored at the item-size estimates, as registered.</> : <>every registered clip scored.</>}
          </p>
          <div className="table-wrap">
            <table className="table table-dense" aria-label="Real gate run, per clip">
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>Per item: arrivals / expected (SAM IDs)</th>
                  <th>Holds</th>
                  <th>Clip result</th>
                </tr>
              </thead>
              <tbody>
                {(live.clips ?? []).map((v) => (
                  <tr key={v.clipId}>
                    <td>{v.clipId}</td>
                    <td>{v.perItem.map((p) => `${p.itemKey} ${p.arrivals}/${p.expected}${p.samIds ? ` (${p.samIds})` : ""}`).join(" · ")}</td>
                    <td>{v.holdCodes.join(", ") || "—"}</td>
                    <td>
                      <span className={v.pass ? "st st-ok" : "st st-held"}>{v.pass ? "scored correctly" : "scored wrong"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rescore && (
            <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: "80ch" }}>
              Calibrated re-score (recorded SAM output, no model call): <span className={verdictClass(rescore.verdict)}>{rescore.verdict}</span>, g1 is the calibration clip and is not scored. {rescore.calibration?.replace(/ at commit \S+/, "")}
            </p>
          )}
          {framing && (
            <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: "80ch" }}>
              Framing: {framing}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** `part`: "real" = the registered gate on the filmed clips; "rest" = the synthetic clips and the learning loop (shown after the A/B). */
export function EvalsView({ part }: { part: "real" | "rest" }) {
  const [d, setD] = useState<EvalsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/evals", { cache: "no-store" })
      .then((r) => r.json())
      .then(setD)
      .catch((e) => setErr(String(e)));
  }, []);
  if (err) return <p style={{ color: "var(--danger)" }}>{err}</p>;
  if (!d) return <p className="muted">Scoring the clip set…</p>;
  const passed = d.synthetic.filter((v) => v.pass).length;
  const live = d.gate?.live ?? null;
  const rescore = d.gate?.rescore ?? null;
  const verdictClass = (v?: string) => (v === "PASS" ? "st st-ok" : v === "FAIL" ? "st st-held" : "st st-warn");
  if (part === "real")
    return (
      <div className="stack" style={{ gap: 16 }}>
        <RealGate live={live} rescore={rescore} framing={d.gate?.framing?.line} verdictClass={verdictClass} />
        <div className="kpis">
          <div className="kpi">
            <div className="v">{live ? live.verdict : "—"}</div>
            <div className="k">{live ? `the registered gate on the filmed clips: ${live.notRun?.length ? `not run as registered, ${live.notRun.join(", ")} not filmed` : "every registered clip scored"}` : "real gate run: not run yet"}</div>
          </div>
          <div className="kpi">
            <div className="v">{d.gate?.liveRuns ?? 0}</div>
            <div className="k">live gate run{d.gate?.liveRuns === 1 ? "" : "s"} (SAM 3.1 on the filmed clips){d.gate?.rescores ? `, plus ${d.gate.rescores} re-score${d.gate.rescores === 1 ? "" : "s"} of its recordings (no model call)` : ""}</div>
          </div>
        </div>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 32 }}>
      <div className="kpis">
        <div className="kpi">
          <div className="v">
            {passed}/{d.synthetic.length}
          </div>
          <div className="k">synthetic clips (built from the kit file, not filmed) pass the same rule</div>
        </div>
        <div className="kpi">
          <div className="v">{d.learning.pipelineRuns}</div>
          <div className="k">inspections logged for learning</div>
        </div>
        <div className="kpi">
          <div className="v">{d.learning.overrides}</div>
          <div className="k">approvals that overrode the draft amount</div>
        </div>
      </div>

      <section className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="h3">Tray counter vs the gate rule, on synthetic clips</h2>
          <span className="mode mode-det">DETERMINISTIC · app code, no model</span>
        </div>
        <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
          Each row is a synthetic version of one gate clip, scored with the PASS/FAIL rule committed before any real run (scripts/gate/RULE.md). &ldquo;SAM IDs&rdquo; shows how many raw track IDs the segmenter gave that item; the tray zone still counts it once.
        </p>
        <div className="table-wrap">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>Clip</th>
                <th>What happens</th>
                <th>Per item: arrivals / expected (SAM IDs)</th>
                <th>Holds</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {d.synthetic.map((v) => (
                <tr key={v.clipId}>
                  <td>{v.clipId}</td>
                  <td>{v.note}</td>
                  <td>{v.perItem.map((p) => `${p.itemKey} ${p.arrivals}/${p.expected}${p.samIds ? ` (${p.samIds})` : ""}`).join(" · ")}</td>
                  <td>{v.holdCodes.join(", ") || "—"}</td>
                  <td>
                    <span className={v.pass ? "st st-ok" : "st st-held"}>{v.pass ? "PASS" : "FAIL"}</span>
                    {v.failures.length > 0 && <div style={{ fontSize: 13 }}>{v.failures.join("; ")}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="fixture-label">Synthetic clips built from the kit file, not filmed. The real gate result is the section above.</span>
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">What people did with the drafts (the learning loop)</h2>
        <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
          Every inspection result and every human decision is appended to a decision log. Overrides and manual holds are the signal for tuning the counter&apos;s thresholds and the drafting prompt.
        </p>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><td>Inspections</td><td className="num">{d.learning.pipelineRuns}</td></tr>
              <tr><td>Held by the system</td><td className="num">{d.learning.held}</td></tr>
              <tr><td>Approved by a person</td><td className="num">{d.learning.approvals}</td></tr>
              <tr><td>Approved above the policy amount (override)</td><td className="num">{d.learning.overrides}</td></tr>
              <tr><td>Put back on hold by a person</td><td className="num">{d.learning.manualHolds}</td></tr>
              <tr><td>Refunds run (test mode)</td><td className="num">{d.learning.refunds}</td></tr>
              <tr><td>Refund attempts that failed and were held</td><td className="num">{d.learning.refundFailures}</td></tr>
              <tr><td>Counter flags raised</td><td className="num mono" style={{ fontSize: 13 }}>{Object.entries(d.learning.flagCounts).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
