"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BenchStation } from "@/components/dash/BenchStation";

function Inner() {
  const q = useSearchParams();
  return <BenchStation initialRma={q.get("rma") ?? undefined} />;
}

export function BenchFromQuery() {
  return (
    <Suspense fallback={<p className="muted">Loading the bench…</p>}>
      <Inner />
    </Suspense>
  );
}
