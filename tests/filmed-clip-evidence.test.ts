/**
 * A case decided on the synthetic scene of an RMA is not the filmed run of that RMA. Stored cases from before the
 * filmed run's recordings existed once showed the filmed run's SAM tracks and its readers' known misreads (a "toy
 * truck" the readers never said on that case). The filmed run's evidence is shown only on a case decided on it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { CaseSummary } from "@/components/dash/CaseSummary";
import { runInspection } from "@/lib/engine/pipeline";
import { buildPacket } from "@/lib/engine/evidence-packet";
import { fromFilmedClip } from "@/lib/domain/schemas";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";

const inspectD1 = () =>
  runInspection({ rma: RMAS[0], slip: ORDERS[0].slip, policy: POLICY, clip: { clipId: RMAS[0].clipId, source: "fixture" } }, { store: new MemoryCaseStore(), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
const asFilmedReplay = <T extends { clip: { provenance?: string } }>(c: T): T => ({ ...c, clip: { ...c.clip, provenance: "replay of live SAM 3.1 call, 6 concepts in parallel" } });
const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ");

describe("the filmed run's evidence stays on the cases decided on it", () => {
  it("fromFilmedClip: a live run or a replay of one, never a synthetic scene", () => {
    expect(fromFilmedClip({ mode: "LIVE_META" })).toBe(true);
    expect(fromFilmedClip({ mode: "LIVE_OPEN_WEIGHTS" })).toBe(true);
    expect(fromFilmedClip({ mode: "RECORDED_FIXTURE", provenance: "replay of live SAM 3.1 call" })).toBe(true);
    expect(fromFilmedClip({ mode: "RECORDED_FIXTURE", provenance: "synthetic scene: kraft paper, camera body, charger" })).toBe(false);
    expect(fromFilmedClip({ mode: "RECORDED_FIXTURE" })).toBe(false);
    expect(fromFilmedClip(undefined)).toBe(false);
  });

  it("a synthetic-scene case of RMA-20418 shows no known-misreads banner; the same RMA replayed from the filmed run does", async () => {
    const c = await inspectD1();
    expect(c.clip.provenance).toMatch(/^synthetic scene/);
    const synthetic = text(renderToStaticMarkup(createElement(CaseSummary, { c, requestedCents: 34000 })));
    expect(synthetic).not.toMatch(/Known misreads/);
    expect(synthetic).not.toMatch(/toy/);
    const filmed = text(renderToStaticMarkup(createElement(CaseSummary, { c: asFilmedReplay(c), requestedCents: 34000 })));
    expect(filmed).toMatch(/Known misreads on this clip, kept as losses/);
    expect(filmed).toMatch(/real compact film camera/);
  });

  it("the evidence packet lists the filmed run's misreads only for a case decided on the filmed run", async () => {
    const c = await inspectD1();
    const ctx = { rma: RMAS[0], slip: ORDERS[0].slip, policy: POLICY };
    expect(buildPacket(c, ctx).limitations.join(" ")).not.toMatch(/Known misread/);
    expect(buildPacket(asFilmedReplay(c), ctx).limitations.join(" ")).toMatch(/Known misread \(a loss\)/);
  });
});
