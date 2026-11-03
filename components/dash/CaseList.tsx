"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import { api } from "@/lib/client/api";
import { latestPerRma } from "@/lib/client/cases";
import { formatCentsExact } from "@/lib/format";
import { rmaById, STRIPE_TEST_LABEL } from "@/data/fixtures";
import { LocalTime } from "@/components/LocalTime";

type Charges = Awaited<ReturnType<typeof api.charges>>;

/** `initial` comes from the server render (readable without JavaScript); the client refreshes after first paint. */
export function HeldList({ initial }: { initial?: ReturnCase[] }) {
  const [cases, setCases] = useState<ReturnCase[] | null>(initial ?? null);
  useEffect(() => {
    api.cases().then(setCases).catch(() => setCases([]));
  }, []);
  if (!cases) return <p className="muted">Loading…</p>;
  const held = latestPerRma(cases.filter((c) => c.state === "Held"));
  if (!held.length)
    return (
      <div className="card stack">
        <p style={{ margin: 0 }}>Nothing is held right now.</p>
        <p className="muted" style={{ margin: 0 }}>
          Run RMA-20418 at the <Link href="/dashboard/bench?rma=RMA-20418">bench station</Link> to see a held return.
        </p>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 0 }}>
      {held.map(({ latest: c, runs }) => {
        const notOk = c.reconciliation?.lines.filter((l) => l.status !== "OK") ?? [];
        return (
          <Link key={c.id} href={`/dashboard/cases/${c.id}`} className="card" style={{ textDecoration: "none", display: "grid", gap: 8, marginBottom: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="eyebrow">
                {c.rmaId} · {rmaById(c.rmaId)?.customer.name}
              </span>
              <span className="row" style={{ gap: 12 }}>
                {runs > 1 && <span className="muted" style={{ fontSize: 13 }}>latest of {runs} held runs</span>}
                <span className="sticker-held">HELD</span>
              </span>
            </div>
            <div className="numeral" style={{ fontSize: 44 }}>
              {formatCentsExact(c.reconciliation?.summary.heldCents ?? 0)}
            </div>
            <div style={{ fontSize: 15 }}>
              {notOk.length
                ? notOk.map((l) => `${l.description}: ${l.observedQty} of ${l.expectedQty} seen (${l.status.toLowerCase()})`).join(" · ")
                : c.holdReasons.join(", ")}
            </div>
            <span className="muted" style={{ fontSize: 13 }}>
              {c.draft ? `Draft cites clause ${c.draft.draft.citedClauses.map((x) => x.clauseId).join(", ")}` : ""} · inspected <LocalTime iso={c.createdAt} mode="datetime" />
            </span>
          </Link>
        );
      })}
    </div>
  );
}

export function RefundList({ initial, initialCharges }: { initial?: ReturnCase[]; initialCharges?: Charges }) {
  const [cases, setCases] = useState<ReturnCase[] | null>(initial ?? null);
  const [charges, setCharges] = useState<Charges | null>(initialCharges ?? null);
  useEffect(() => {
    api.cases().then(setCases).catch(() => setCases([]));
    api.charges().then(setCharges).catch((e) => setCharges({ ok: false, error: String(e), charges: [] }));
  }, []);
  const refunded = (cases ?? []).filter((c) => c.refund);
  return (
    <div className="stack" style={{ gap: 28 }}>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="h3">Refunds</h2>
          <span className="fixture-label">{STRIPE_TEST_LABEL}</span>
        </div>
        <div className="table-wrap">
          <table className="table table-dense">
            <thead>
              <tr>
                <th>Refund</th>
                <th>RMA</th>
                <th className="num">Amount</th>
                <th className="num">Fee</th>
                <th>Approved by</th>
                <th>Receipt</th>
              </tr>
            </thead>
            <tbody>
              {refunded.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No refunds yet. Approve the complete kit (RMA-20419) at the bench to run one.
                  </td>
                </tr>
              )}
              {refunded.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link href={`/dashboard/cases/${c.id}`}>{c.refund!.refundId}</Link>
                  </td>
                  <td>{c.rmaId}</td>
                  <td className="num">{formatCentsExact(c.refund!.amountCents)}</td>
                  <td className="num">{c.refund!.fee ? formatCentsExact(c.refund!.fee.amountCents) : "—"}</td>
                  <td>{c.approval?.approver}</td>
                  <td>{c.refund!.receiptUrl ? <a href={c.refund!.receiptUrl} target="_blank" rel="noopener noreferrer">receipt ↗</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="h3">Original charges the refunds run against</h2>
          <span className="fixture-label">[Seeded test-mode charge]</span>
        </div>
        {!charges && <p className="muted">Checking Stripe…</p>}
        {charges && !charges.ok && <p style={{ color: "var(--danger)" }}>Payment rail off: {charges.error}</p>}
        {charges?.ok && (
          <div className="table-wrap">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Payment intent</th>
                  <th>Charge</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {charges.charges.map((ch) => (
                  <tr key={ch.paymentIntentId}>
                    <td>{ch.orderId}</td>
                    <td>{ch.paymentIntentId}</td>
                    <td>{ch.chargeId}</td>
                    <td className="num">{formatCentsExact(ch.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
