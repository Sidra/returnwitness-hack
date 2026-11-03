import type { Metadata } from "next";
import { Suspense } from "react";
import { LabelLearningWithData } from "@/components/dash/server-data";
import { EvalsView } from "@/components/dash/EvalsView";
import { EvalsSummary } from "@/components/dash/EvalsSummary";
import { latestGate } from "@/lib/evals/real-gate";
import { AblationTable } from "@/components/dash/AblationTable";
import { SEEDED_SHIFT } from "@/data/shift";
import { runAblation } from "@/lib/fleet/ablation";
import { loadFleetRecordings } from "@/lib/fleet/live";
import { SafetyPrice, SameInputAb } from "@/components/dash/SameInputAb";
import { KIT } from "@/data/kit.config";
import { armAPromptSha256, loadLatestAbReport } from "@/lib/evals/same-input-ab";
import { runStressSweep } from "@/lib/evals/stress";
import { counterConfigForKit } from "@/lib/vision/counter-config";

export const metadata: Metadata = { title: "Evals" };

export default function EvalsPage() {
  // Deterministic: the seeded shift and its ablation are computed at build time.
  const stress = runStressSweep({ cfg: counterConfigForKit(KIT), seeds: 20 }).summary;
  const ab = loadLatestAbReport();
  const ablation = runAblation(SEEDED_SHIFT, { recorded: loadFleetRecordings(SEEDED_SHIFT.returns.map((r) => r.rma.id)) });
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Is the count right?</span>
          <h1 className="h1">Evals</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "64ch" }}>
            The counter is judged against labelled clips with a rule written down before any run, every human decision feeds back in, and every agent in the fleet has to change a result to stay.
          </p>
        </div>
      </div>
      <div className="stack" style={{ gap: 32 }}>
        {/* Real results first (the registered gate, then the same-input A/B), synthetic clips and the sweep after them. */}
        <EvalsSummary gate={latestGate().live} ab={ab} />
        <EvalsView part="real" />
        <SameInputAb report={ab} promptSha256={armAPromptSha256()} />
        <EvalsView part="rest" />
        <SafetyPrice stress={stress} ab={ab} />
        <Suspense fallback={<p className="muted">Counting the label reader&apos;s training rows…</p>}>
          <LabelLearningWithData />
        </Suspense>
        <AblationTable report={ablation} />
      </div>
    </>
  );
}
