"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import { isRealReplay } from "@/lib/domain/schemas";
import { RMAS, MERCHANT } from "@/data/fixtures";
import { formatCents, formatCentsExact } from "@/lib/format";
import { api } from "@/lib/client/api";
import { LocalTime } from "@/components/LocalTime";
import styles from "./RmaQueue.module.css";

const STATE_CLASS: Record<string, string> = { Held: "st st-held", Refunded: "st st-ok", Approved: "st st-ok", AwaitingApproval: "st st-warn" };
const STATE_TEXT: Record<string, string> = { Held: "HELD", Refunded: "REFUNDED", Approved: "APPROVED", AwaitingApproval: "NEEDS A PERSON", Received: "INSPECTING", Counted: "INSPECTING", Reconciled: "INSPECTING" };

/**
 * Exception-first RMA queue: held returns first, then ones waiting for a person, then the rest.
 * Keyboard: ↑/↓ (or j/k) move, Enter inspects at the bench, O opens the latest record.
 */
export function RmaQueue({ initial }: { initial?: ReturnCase[] }) {
  const router = useRouter();
  const [cases, setCases] = useState<ReturnCase[] | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const tableRef = useRef<HTMLTableElement>(null);

  const load = useCallback(() => api.cases().then(setCases).catch((e) => setError(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const latest = new Map<string, ReturnCase>();
    for (const c of cases ?? []) if (!latest.has(c.rmaId)) latest.set(c.rmaId, c);
    const rank = (c?: ReturnCase) => (!c ? 2 : c.state === "Held" ? 0 : c.state === "AwaitingApproval" || c.state === "Approved" ? 1 : c.state === "Refunded" ? 3 : 2);
    return RMAS.map((r) => ({ rma: r, c: latest.get(r.id) })).sort((a, b) => rank(a.c) - rank(b.c));
  }, [cases]);

  const kpis = useMemo(() => {
    const cs = cases ?? [];
    const latest = new Map<string, ReturnCase>();
    for (const c of cs) if (!latest.has(c.rmaId)) latest.set(c.rmaId, c);
    const held = [...latest.values()].filter((c) => c.state === "Held");
    return {
      inspected: cs.length,
      heldCents: held.reduce((s, c) => s + (c.reconciliation?.summary.heldCents ?? 0), 0),
      waiting: [...latest.values()].filter((c) => c.state === "AwaitingApproval" || c.state === "Approved").length,
      refundedCents: cs.filter((c) => c.refund).reduce((s, c) => s + (c.refund?.amountCents ?? 0), 0),
    };
  }, [cases]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      setSel((s) => Math.min(rows.length - 1, s + 1));
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      router.push(`/dashboard/bench?rma=${rows[sel].rma.id}`);
    } else if ((e.key === "o" || e.key === "O") && rows[sel].c) {
      router.push(`/dashboard/cases/${rows[sel].c!.id}`);
    }
  };

  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="kpis">
        <div className="kpi">
          <div className="v" style={{ color: kpis.heldCents ? "var(--danger)" : undefined }}>{formatCents(kpis.heldCents)}</div>
          <div className="k">held right now, waiting for a person</div>
        </div>
        <div className="kpi">
          <div className="v">{kpis.waiting}</div>
          <div className="k">clean returns waiting for approval</div>
        </div>
        <div className="kpi">
          <div className="v">{kpis.inspected}</div>
          <div className="k">inspections run on this server</div>
        </div>
        <div className="kpi">
          <div className="v">{formatCents(kpis.refundedCents)}</div>
          <div className="k">refunded after approval (Stripe test mode)</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="h3">Returns routed to {MERCHANT.bench}</h2>
          <span className="row muted" style={{ fontSize: 13, gap: 10 }}>
            <span><span className="kbd">↑</span> <span className="kbd">↓</span> move</span>
            <span><span className="kbd">⏎</span> inspect</span>
            <span><span className="kbd">O</span> open record</span>
          </span>
        </div>
        <div className="table-wrap">
          <table ref={tableRef} className={`table table-dense mobile-stack-table ${styles.queue}`} tabIndex={0} onKeyDown={onKey} aria-label="RMA queue. Use arrow keys to move, Enter to inspect.">
            <thead>
              <tr>
                <th>RMA</th>
                <th>Customer</th>
                <th>Order</th>
                <th className="num">Requested</th>
                <th>Status</th>
                <th className="num">Held</th>
                <th>Last inspection</th>
                <th className={styles.mobileOnly}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ rma, c }, i) => (
                <tr key={rma.id} aria-selected={i === sel} onClick={() => setSel(i)} onDoubleClick={() => router.push(`/dashboard/bench?rma=${rma.id}`)} data-state={c?.state ?? "none"}>
                  <td data-label="RMA" className={styles.rma}>
                    <Link href={`/dashboard/bench?rma=${rma.id}`}>{rma.id}</Link>
                  </td>
                  <td data-label="Customer" className={styles.customer}>{rma.customer.name}</td>
                  <td data-label="Order" className={styles.secondary}>{rma.orderId}</td>
                  <td data-label="Requested" className={`num ${styles.amount}`}>{formatCentsExact(rma.requestedRefundCents)}</td>
                  <td data-label="Status" className={styles.status}>{c ? <span className={STATE_CLASS[c.state] ?? "st"}>{STATE_TEXT[c.state] ?? c.state}</span> : <span className="st muted">NOT INSPECTED</span>}</td>
                  <td data-label="Held" className={`num ${styles.amount}`}>{c?.reconciliation ? formatCentsExact(c.reconciliation.summary.heldCents) : "—"}</td>
                  <td data-label="Last inspection" className={styles.secondary}>{c ? <Link href={`/dashboard/cases/${c.id}`}><LocalTime iso={c.createdAt} mode="datetime" /></Link> : "—"}</td>
                  <td data-label="" className={`${styles.mobileOnly} ${styles.action}`}>
                    {c ? (
                      <Link href={`/dashboard/cases/${c.id}`} className="btn btn-sm btn-primary" aria-label={`Open record for ${rma.id}`}>
                        Open record
                      </Link>
                    ) : (
                      <Link href={`/dashboard/bench?rma=${rma.id}`} className="btn btn-sm" aria-label={`Inspect ${rma.id} at the bench`}>
                        Inspect at the bench
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="fixture-label">[Seeded merchant order &amp; RMA fixture] · inspections listed are real runs on this server</span>
        {error && <p role="alert" style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}
      </div>

      {cases && cases.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <h2 className="h3">All inspections</h2>
          <div className="table-wrap">
            <table className={`table table-dense mobile-stack-table ${styles.runs}`}>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>RMA</th>
                  <th>State</th>
                  <th>Lines</th>
                  <th>Segmentation</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} onClick={() => router.push(`/dashboard/cases/${c.id}`)}>
                    <td data-label="Run">
                      <Link href={`/dashboard/cases/${c.id}`}>{c.id}</Link>
                    </td>
                    <td data-label="RMA">{c.rmaId}</td>
                    <td data-label="State">
                      <span className={STATE_CLASS[c.state] ?? "st"}>{STATE_TEXT[c.state] ?? c.state}</span>
                    </td>
                    <td data-label="Lines">{c.reconciliation?.lines.map((l) => `${l.observedQty}/${l.expectedQty}`).join(" · ") ?? "—"}</td>
                    <td data-label="Segmentation">{c.clip.mode === "LIVE_META" ? "RECORDED LIVE RUN · Meta" : c.clip.mode === "LIVE_OPEN_WEIGHTS" ? "RECORDED LIVE RUN · open weights" : isRealReplay(c.clip.provenance) ? "replay of a recorded real run" : "recorded fixture · synthetic scene"}</td>
                    <td data-label="When"><LocalTime iso={c.createdAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
