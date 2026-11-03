import type { LabelLearningView } from "@/lib/learning/learning-status";

/** "Label reader learning" on /dashboard/evals: real counts, the last switch test, the rule. Server-rendered. */
export function LabelLearning({ v }: { v: LabelLearningView }) {
  return (
    <section className="stack" style={{ gap: 12 }} aria-labelledby="label-learning">
      <div className="stack" style={{ gap: 4 }}>
        <h2 className="h3" id="label-learning">Label reader learning</h2>
        <p className="muted" style={{ margin: 0, maxWidth: "72ch", fontSize: 14 }}>
          The label reader (Muse Glimmer) can be fine-tuned, but a fine-tune is only worth using if it reads serials better on labels it never saw. Its training set is the <strong>{v.setName}</strong>: every row&apos;s truth is the label that was printed or rendered, not a model&apos;s guess. The four serials on the real printed sheet are always held out, so the test runs on the actual labels.
        </p>
      </div>
      <div className="table-wrap">
        <table className="table table-dense">
          <thead>
            <tr>
              <th>Rows</th>
              <th className="num">Train</th>
              <th className="num">Held out</th>
            </tr>
          </thead>
          <tbody>
            {v.sources.map((s) => (
              <tr key={s.source}>
                <td>
                  {s.source} <span className="muted">· {s.label}</span>
                </td>
                <td className="num">{s.train}</td>
                <td className="num">{s.heldout}</td>
              </tr>
            ))}
            <tr>
              <td>
                reviewer corrections <span className="muted">· people correcting live label reads</span>
              </td>
              <td className="num" colSpan={2}>
                {v.corrections == null ? "store unavailable" : `${v.corrections} so far`}
              </td>
            </tr>
            <tr>
              <td>
                <strong>bench label set total</strong>
              </td>
              <td className="num">
                <strong>{v.total.train}</strong>
              </td>
              <td className="num">
                <strong>{v.total.heldout}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: "grid", gap: 4 }}>
        {v.distinctSerials && (
          <li>
            Distinct serials: {v.distinctSerials.train} in training, {v.distinctSerials.heldout} held out (none in both). Held out from the printed sheet: {v.distinctSerials.heldoutReal.join(", ") || "none"}.
          </li>
        )}
        <li>Filmed bench clips: {v.benchNote}.</li>
        <li>Floors (at least 50 training rows, 20 held out): {v.floorsMet == null ? "no set yet" : v.floorsMet ? "met" : "not met"}.</li>
        <li>
          Last base-vs-adapter test: <span className="mono">{v.lastResult}</span>
        </li>
        {v.realLabels && <li>The real printed labels: {v.realLabels}</li>}
        <li>Switch rule {v.rule}</li>
        {v.ceilingFlaw && <li>Why v1 kept the base although the adapter read more: {v.ceilingFlaw}.</li>}
        <li>
          Switch rule {v.ruleV2} <span className="muted">({v.ruleV2Status})</span>
        </li>
        <li>
          Counts from {v.origin === "local" ? "the set generated on this server" : v.origin === "committed" ? "the summary committed with the generator" : "no generated set"}
          .
        </li>
      </ul>
    </section>
  );
}
