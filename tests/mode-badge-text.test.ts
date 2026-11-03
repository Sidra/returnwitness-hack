import { describe, expect, it } from "vitest";
import { replayText } from "@/components/ModeBadge";
import { MODE_TEXT } from "@/lib/domain/schemas";

describe("mode labels say what produced a result", () => {
  it("a replayed synthetic scene says so, and never says LIVE", () => {
    expect(MODE_TEXT.RECORDED_FIXTURE).toBe("RECORDED FIXTURE · synthetic scene, not a live Meta call");
    expect(MODE_TEXT.RECORDED_FIXTURE).not.toMatch(/LIVE ·/);
  });

  it("a replay of a real recorded call names the model and the request id, never the run's date or time", () => {
    expect(replayText({ model: "muse-spark-1.3", at: "2026-10-29T18:24:05.000Z", requestId: "resp_abc" })).toBe("RECORDED LIVE RUN · muse-spark-1.3 · req resp_abc");
    expect(replayText({ at: "2026-10-29T18:24:05.000Z" })).toBe("RECORDED LIVE RUN");
    expect(replayText({ model: "m", at: "not a date" })).toBe("RECORDED LIVE RUN · m");
  });
});
