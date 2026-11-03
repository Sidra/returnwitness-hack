import type { Metadata } from "next";
import { Suspense } from "react";
import { CaseRecord } from "@/components/dash/CaseRecord";

export const metadata: Metadata = { title: "Inspection record" };

export default function CasePage() {
  return (
    <Suspense fallback={<p className="muted">Loading the record…</p>}>
      <CaseRecord />
    </Suspense>
  );
}
