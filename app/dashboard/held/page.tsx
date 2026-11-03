import type { Metadata } from "next";
import { Suspense } from "react";
import { HeldList } from "@/components/dash/CaseList";
import { HeldListWithData, loadCases } from "@/components/dash/server-data";
import { caseCounts } from "@/lib/client/cases";

export async function generateMetadata(): Promise<Metadata> {
  const cases = await loadCases();
  const held = cases ? caseCounts(cases).held : null;
  return { title: held === null ? "Held returns" : `Held returns (${held})` };
}

export default function HeldPage() {
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Waiting for a person</span>
          <h1 className="h1">Held returns</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            A hold is not a denial. Each one carries the timestamped evidence a person needs to approve a partial refund, keep holding, or attach to a dispute response.
          </p>
        </div>
      </div>
      <Suspense fallback={<HeldList />}>
        <HeldListWithData />
      </Suspense>
    </>
  );
}
