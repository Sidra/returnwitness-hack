import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { RmaQueue } from "@/components/dash/RmaQueue";
import { RmaQueueWithData, loadCases } from "@/components/dash/server-data";
import { caseCounts } from "@/lib/client/cases";

export async function generateMetadata(): Promise<Metadata> {
  const cases = await loadCases();
  const held = cases ? caseCounts(cases).held : null;
  return { title: held ? `RMA queue (${held} held)` : "RMA queue" };
}

export default function DashboardPage() {
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Brindlewood Camera Co. · returns</span>
          <h1 className="h1">RMA queue</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
            Held returns come first. Nothing here refunds by itself: every refund needs a person&apos;s approval at the bench or in the inspection record.
          </p>
        </div>
        <Link href="/dashboard/bench" className="btn btn-primary">
          Open the bench station
        </Link>
      </div>
      <Suspense fallback={<RmaQueue />}>
        <RmaQueueWithData />
      </Suspense>
    </>
  );
}
