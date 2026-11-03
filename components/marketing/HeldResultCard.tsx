import { ModeBadge, FixtureLabel } from "@/components/ModeBadge";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { FIXTURE_LABEL, MERCHANT, POLICY, RMAS } from "@/data/fixtures";
import { formatCents } from "@/lib/format";

/**
 * A static mock of the held result for RMA-20418. The seen/expected counts mirror the
 * recorded fixture (lens not observed); it is labelled as a fixture, never as a live call.
 */
export function HeldResultCard() {
  const rma = RMAS[0];
  const clause = POLICY.clauses.find((c) => c.id === "4.2");
  return (
    <article className="card" aria-labelledby="held-card-title">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="eyebrow">The packing-slip rule, as a diagram (not the recorded run)</span>
          <h3 className="h3" id="held-card-title">
            <span className="mono">{rma.id}</span> · {KIT.kitName}
          </h3>
          <span className="muted" style={{ fontSize: 14 }}>
            {MERCHANT.name} · {MERCHANT.bench} · order {rma.orderId}
          </span>
        </div>
        <span className="sticker-held">HELD</span>
      </div>

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="table">
          <caption className="sr-only">Expected versus seen settling in the tray, per packing-slip line</caption>
          <thead>
            <tr>
              <th scope="col">Packing-slip line</th>
              <th scope="col" className="num">Seen / expected</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {KIT.items.map((item) => {
              const missing = item.key === "lens";
              return (
                <tr key={item.key}>
                  <td>
                    <strong>{item.name}</strong>
                    <div className="muted mono" style={{ fontSize: 13 }}>{item.sku} · {formatCents(item.unitPriceCents)}</div>
                  </td>
                  <td className="num mono">{missing ? "0" : "1"}/1</td>
                  <td>
                    <span className={`st ${missing ? "st-missing" : "st-ok"}`}>{missing ? "MISSING" : "OK"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
        <span className="muted" style={{ fontSize: 14 }}>Refund requested ({formatCents(KIT_TOTAL_CENTS)})</span>
        <strong className="mono">{formatCents(rma.requestedRefundCents)} held</strong>
      </div>

      {clause && (
        <div className="clause" style={{ marginTop: 16 }}>
          <div className="clause-id">CLAUSE {clause.id} · {clause.title.toUpperCase()}</div>
          <p style={{ margin: "4px 0 0" }}>&ldquo;{clause.text}&rdquo;</p>
        </div>
      )}

      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <ModeBadge mode="RECORDED_FIXTURE" />
        <FixtureLabel>{FIXTURE_LABEL}</FixtureLabel>
      </div>
    </article>
  );
}
