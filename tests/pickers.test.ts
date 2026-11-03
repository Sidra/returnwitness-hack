import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection } from "@/lib/engine/pipeline";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";

// Rule: every picker visibly changes the output, or it's a FAIL. The bench's RMA picker drives the clip replay,
// the counter's arrivals, the raw SAM track ids beside them, the reconciliation and the draft.
describe("bench RMA picker: each seeded return gives a visibly different result", () => {
  it("the three RMAs differ in what the screen shows", async () => {
    const shown = await Promise.all(
      ([0, 1, 2] as const).map(async (i) => {
        const c = await runInspection({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" } }, { store: new MemoryCaseStore(null), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
        return {
          state: c.state,
          lines: c.reconciliation!.lines.map((l) => `${l.itemKey}:${l.status}`).join(","),
          arrivals: c.count!.arrivals.map((a) => `${a.itemKey}@${a.t}`).join(","),
          rawIds: JSON.stringify(c.count!.diagnostics.rawTrackIdsPerItem),
          draft: c.draft!.draft.recommendation,
        };
      }),
    );
    expect(new Set(shown.map((s) => JSON.stringify(s))).size).toBe(3);
    // The hero differs in the decision itself, not just the replay.
    expect(shown[0].state).not.toBe(shown[1].state);
    // d2 and d3 are both complete; what the screen shows still differs (arrival timing and SAM's raw ids).
    expect(shown[1].arrivals === shown[2].arrivals && shown[1].rawIds === shown[2].rawIds).toBe(false);
  });
});
