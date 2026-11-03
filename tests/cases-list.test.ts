import { describe, expect, it } from "vitest";
import type { ReturnCase } from "@/lib/domain/case";
import { latestPerRma } from "@/lib/client/cases";

const c = (id: string, rmaId: string, createdAt: string) => ({ id, rmaId, createdAt }) as ReturnCase;

describe("latestPerRma", () => {
  it("keeps one entry per RMA: the newest run, with the run count", () => {
    const out = latestPerRma([
      c("a", "RMA-20418", "2026-10-27T10:00:00Z"),
      c("b", "RMA-20418", "2026-10-27T12:00:00Z"),
      c("c", "RMA-20419", "2026-10-27T11:00:00Z"),
      c("d", "RMA-20418", "2026-10-27T09:00:00Z"),
    ]);
    expect(out.map((e) => [e.latest.id, e.runs])).toEqual([
      ["b", 3],
      ["c", 1],
    ]);
  });

  it("returns nothing for no cases", () => {
    expect(latestPerRma([])).toEqual([]);
  });
});
