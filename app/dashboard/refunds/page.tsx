import type { Metadata } from "next";
import { Suspense } from "react";
import { RefundList } from "@/components/dash/CaseList";
import { RefundListWithData, loadCases, loadCharges } from "@/components/dash/server-data";
import { caseCounts } from "@/lib/client/cases";

export async function generateMetadata(): Promise<Metadata> {
  const [cases] = await Promise.all([loadCases(), loadCharges()]);
  const n = cases ? caseCounts(cases).refunds : null;
  return { title: n === null ? "Refunds" : `Refunds (${n})` };
}

export default function RefundsPage() {
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">After approval only</span>
          <h1 className="h1">Refunds</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            Every refund here ran in Stripe test mode after a person approved it with a one-time token. Each one also books the $2.00 inspection fee.
          </p>
        </div>
      </div>
      <Suspense fallback={<RefundList />}>
        <RefundListWithData />
      </Suspense>
    </>
  );
}
