import { formatCents } from "@/lib/format";
import type { DispatchComparison as Comparison, Finding } from "@/lib/fleet/compare-dispatch";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Group findings by box: "RMA-30107: camera body C → Refurbish or parts; lens B → …". */
function byBox(fs: Finding[]): Array<[string, string[]]> {
  const m = new Map<string, string[]>();
  for (const f of fs) m.set(f.rmaId, [...(m.get(f.rmaId) ?? []), f.detail]);
  return [...m.entries()];
}

/** Selective dispatch vs always-run over the seeded shift (lib/fleet/compare-dispatch.ts). Server-rendered; deterministic. */
export function DispatchComparison({ c }: { c: Comparison }) {
  const s = c.selective;
  const a = c.always;
  const missedTotal = c.missed.holds.length + c.missed.claims.length + c.missed.drafts.length;
  const restockBoxes = new Set(c.missed.drafts.filter((d) => d.kind === "restock").map((d) => d.rmaId)).size;
  const rows: Array<[string, string, string]> = [
    ["Model calls a live run would make", String(s.modelCalls), String(a.modelCalls)],
    ["Role runs skipped (all were model calls)", `${s.skipped}`, `${a.skipped}`],
    ["Estimated live model cost, whole shift", `$${s.costUsd.toFixed(3)}`, `$${a.costUsd.toFixed(3)}`],
    ["Model time, every call added up", `${Math.round(s.modelSeconds)} s`, `${Math.round(a.modelSeconds)} s`],
    ["Latency per box (critical path)", secs(s.latencyPerBoxMs), secs(a.latencyPerBoxMs)],
    ["Boxes held for a person", `${s.held} of ${c.returns}`, `${a.held} of ${c.returns}`],
    ["Proposed refunds (a person decides)", formatCents(s.proposedRefundCents), formatCents(a.proposedRefundCents)],
    ["Carrier claims drafted", `${s.claims} (${formatCents(s.claimCents)})`, `${a.claims} (${formatCents(a.claimCents)})`],
  ];
  if (s.skipped !== s.skippedModelCalls) rows[1][0] = `Role runs skipped (${s.skippedModelCalls} of them model calls)`;
  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby="dispatch-title" id="dispatch">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="h3" id="dispatch-title">
          Selective dispatch vs running every agent on every box
        </h2>
        <span className="fixture-label">{c.label} · cost and latency are estimates</span>
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 15 }}>
        An optional specialist runs on a box only when that box&apos;s evidence calls for it: the voice-note reader when there is a note, the carrier-claim agent when there is damage or transit evidence, the label reader when a serial read is close to the bar, the policy agent near the window or on a hold, the restock grader on a complete box or an item to divert now, the drafter when there is a hold to explain. Counting, serial matching, the damage read, the arithmetic and the merge run on every box. Always-run is the reference.
      </p>
      <div className="table-wrap">
        <table className="table table-dense" aria-label="Selective dispatch (shipped) vs always-run">
          <thead>
            <tr>
              <th>Over the shift</th>
              <th className="num">Selective</th>
              <th className="num">Always</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, sv, av]) => (
              <tr key={k}>
                <td style={{ whiteSpace: "normal", minWidth: 130 }}>{k}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {sv}
                </td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {av}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, maxWidth: "80ch" }}>
        <li>
          Findings always-run made that selective missed:{" "}
          <span className={c.missed.holds.length || c.missed.claims.length ? "st st-held" : missedTotal ? "st st-warn" : "st st-ok"}>
            {c.missed.holds.length} holds · {c.missed.claims.length} claims · {c.missed.drafts.length} drafts
          </span>
        </li>
        <li>
          Holds selective added that always-run doesn&apos;t have: <span className={c.addedFalseHolds.length ? "st st-held" : "st st-ok"}>{c.addedFalseHolds.length}</span>
        </li>
      </ul>
      {missedTotal > 0 && (
        <details>
          <summary style={{ fontSize: 14 }}>
            What selective missed: {c.missed.holds.length ? `${c.missed.holds.length} hold(s), ` : ""}
            {c.missed.claims.length ? `${c.missed.claims.length} claim(s), ` : ""}
            {c.missed.drafts.length} draft(s){restockBoxes ? `, incl. restock grades on ${restockBoxes} held boxes` : ""}
          </summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 14 }}>
            {byBox([...c.missed.holds, ...c.missed.claims, ...c.missed.drafts]).map(([id, ds]) => (
              <li key={id}>
                <span className="mono">{id}</span>: {ds.join("; ")}
              </li>
            ))}
          </ul>
          {restockBoxes > 0 && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: 14, maxWidth: "72ch" }}>
              The restock grader waits on a held box until a person decides; these grades are drafts that come later, not holds or money. They are still counted as missed.
            </p>
          )}
        </details>
      )}
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, maxWidth: "80ch" }}>
        {c.byRole
          .filter((r) => r.skipped > 0)
          .map((r) => (
            <li key={r.role}>
              <strong>{r.role}</strong> ran on {r.ranSelective} of {r.ranAlways} boxes; e.g. skipped: {r.example}
            </li>
          ))}
      </ul>
      <span className="fixture-label">Latency: {c.latencyBasis}. Cost: token-budget estimates at Meta list price. Nothing on this page called a model.</span>
    </section>
  );
}
