/**
 * Runs the demo against a server (default: local dev) and appends ONE run record to evidence.json:
 * counts, held amounts, stage timings and modes, the Stripe refund + fee ids. Every number in the
 * pitch, README and video is quoted from the `current.demo` run.
 *   npx tsx scripts/record-demo-run.ts [baseUrl]
 */
import { appendRun, gitHash } from "../lib/obs/evidence";
import type { ReturnCase } from "../lib/domain/case";

const base = process.argv[2] ?? "http://localhost:3700";

async function inspect(rmaId: string): Promise<ReturnCase> {
  const res = await fetch(`${base}/api/inspections`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rmaId }) });
  const text = await res.text();
  const m = /event: case\ndata: (.*)\n/.exec(text);
  if (!m) throw new Error(`no case for ${rmaId}: ${text.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.message ?? r.status}`);
  return j as T;
}

async function main() {
  const held = await inspect("RMA-20418");
  const clean = await inspect("RMA-20419");
  const { token } = await post<{ token: string }>(`/api/cases/${clean.id}/approve`, { approver: "Rita Calder", amountCents: 34000, note: "" });
  const { case: refunded } = await post<{ case: ReturnCase }>(`/api/cases/${clean.id}/refund`, { token });
  const replay = await fetch(`${base}/api/cases/${clean.id}/refund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  // The held kit settled under clause 4.3: refund what was seen, keep the missing lens's value held.
  const partialApprove = await post<{ token: string }>(`/api/cases/${held.id}/approve`, { approver: "Rita Calder", amountCents: 23100, note: "partial under clause 4.3: zoom lens not returned" });
  const { case: partial } = await post<{ case: ReturnCase }>(`/api/cases/${held.id}/refund`, { token: partialApprove.token });
  const at = new Date().toISOString();
  const summarize = (c: ReturnCase) => ({
    caseId: c.id,
    rmaId: c.rmaId,
    state: c.state,
    counts: c.count?.counts,
    rawTrackIdsPerItem: c.count?.diagnostics.rawTrackIdsPerItem,
    lines: c.reconciliation?.lines.map((l) => ({ item: l.itemKey, expected: l.expectedQty, seen: l.observedQty, status: l.status })),
    heldCents: c.reconciliation?.summary.heldCents,
    draft: c.draft && { recommendation: c.draft.draft.recommendation, source: c.draft.source, clauses: c.draft.draft.citedClauses.map((x) => x.clauseId) },
    timings: c.timings,
    segmentationMode: c.clip.mode,
  });
  const run = {
    runId: `demo_${at.replace(/[:.]/g, "-")}`,
    kind: "demo" as const,
    at,
    gitHash: gitHash(),
    mode: held.clip.mode,
    summary: {
      base,
      heldCents: held.reconciliation?.summary.heldCents,
      heldState: held.state,
      refundId: refunded.refund?.refundId,
      refundCents: refunded.refund?.amountCents,
      feeCents: refunded.refund?.fee?.amountCents,
      feePaymentIntent: refunded.refund?.fee?.paymentIntentId,
      webhookEvent: refunded.refund?.event?.type ?? null,
      replayStatus: replay.status,
      partialRefundId: partial.refund?.refundId,
      partialRefundCents: partial.refund?.amountCents,
      partialHeldCents: (held.reconciliation?.summary.heldCents ?? 0) - (partial.refund?.amountCents ?? 0),
    },
    details: { held: summarize(held), partial: { refundId: partial.refund?.refundId, amountCents: partial.refund?.amountCents, state: partial.state, approver: partial.approval?.approver, note: partial.approval?.note }, refunded: { ...summarize(refunded), refund: refunded.refund && { ...refunded.refund, event: refunded.refund.event ? { id: refunded.refund.event.id, type: refunded.refund.event.type } : null } } },
  };
  appendRun(run);
  console.log(JSON.stringify(run.summary, null, 2));
}

main().catch((e) => {
  console.error(`record-demo-run: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
