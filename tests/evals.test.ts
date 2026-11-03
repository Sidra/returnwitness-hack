import { describe, expect, it } from "vitest";
import { KIT } from "@/data/kit.config";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { judgeClip, runSyntheticGate } from "@/lib/evals/suite";
import type { CountResult } from "@/lib/domain/schemas";

describe("synthetic gate set, scored with the pre-registered rule", () => {
  const results = runSyntheticGate(counterConfigForKit(KIT));
  it.each(results.map((r) => [r.clipId, r] as const))("%s passes", (_id, r) => {
    expect(r.failures).toEqual([]);
  });
  it("g6 is caught as a merge, g7 as an unreadable label", () => {
    expect(results.find((r) => r.clipId === "g6")!.holdCodes).toContain("merged_mask");
    expect(results.find((r) => r.clipId === "g7")!.holdCodes).toContain("label_unreadable");
  });
  it("g2 and g4 show the fragmentation the tray zone absorbs (2 SAM IDs, 1 arrival)", () => {
    for (const id of ["g2", "g4"]) {
      const lens = results.find((r) => r.clipId === id)!.perItem.find((p) => p.itemKey === "lens")!;
      expect(lens).toMatchObject({ arrivals: 1, samIds: 2 });
    }
  });
});

describe("with the hand-overlap fallback rule on", () => {
  const results = runSyntheticGate({ ...counterConfigForKit(KIT), handBlocksTray: true });
  it.each(results.map((r) => [r.clipId, r] as const))("%s still passes", (_id, r) => {
    expect(r.failures).toEqual([]);
  });
});

describe("the rule itself", () => {
  const base = (counts: Record<string, number>, flags: CountResult["flags"] = []): CountResult => ({ clipId: "x", counts, arrivals: [], flags, diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } });
  const clip = { id: "g1", expected: { a: 1, b: 1 }, acceptHold: [] };
  it("FAILS a double count", () => expect(judgeClip(clip, base({ a: 2, b: 1 })).failures[0]).toMatch(/rule 1/));
  it("FAILS a silent miss", () => expect(judgeClip(clip, base({ a: 1, b: 0 })).failures[0]).toMatch(/rule 2/));
  it("a held miss is not a failure", () => expect(judgeClip(clip, base({ a: 1, b: 0 }, [{ code: "merged_mask", itemKeys: ["b"], t: 0, frameIndex: 0, detail: "" }])).pass).toBe(true));
  it("FAILS g6 at 2 arrivals with no merge flag", () => expect(judgeClip({ id: "g6", expected: { a: 1, b: 1, c: 1 }, acceptHold: [] }, base({ a: 1, b: 1, c: 0 })).failures.join()).toMatch(/rule 3/));
  it("FAILS g5 when the absent item is counted", () => expect(judgeClip({ id: "g5", expected: { a: 1, lens: 0 }, acceptHold: [], mustHold: ["lens"] }, base({ a: 1, lens: 1 })).failures.join()).toMatch(/rule 4/));
});
