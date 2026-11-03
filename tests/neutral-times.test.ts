/**
 * No run dates on the public site: every timestamp a public page or GET API serves is neutralized on the public profile
 * (lib/public/neutral-times.ts); local runs keep real times.
 */
import { describe, expect, it } from "vitest";
import { neutralizeTimes, neutralTime, publicView } from "@/lib/public/neutral-times";

const now = Date.parse("2026-11-03T20:00:00.000Z");

describe("neutral times", () => {
  it("relative within a day, 'earlier' beyond, 'recorded' with no clock (a prerendered page)", () => {
    expect(neutralTime("2026-11-03T19:48:00.000Z", now)).toBe("12 min ago");
    expect(neutralTime("2026-11-03T16:00:00.000Z", now)).toBe("4 h ago");
    expect(neutralTime("2026-10-27T17:21:41.000Z", now)).toBe("earlier");
    expect(neutralTime("2026-11-03T20:10:00.000Z", now)).toBe("in 10 min");
    expect(neutralTime("2026-10-27T17:21:41.000Z", null)).toBe("recorded");
  });

  it("deep: full timestamps and dates inside strings go; Stripe's api_version and non-date strings stay", () => {
    const out = neutralizeTimes(
      { createdAt: "2026-10-27T17:21:41.000Z", audit: [{ at: "2026-11-03T19:59:30.000Z" }], id: "shift-2026-10-29-bench2", reason: "carrier scan 2026-10-26", event: { api_version: "2026-02-25.clover" }, n: 3, ok: true, text: "BW-CB-55120" },
      now,
    );
    expect(out).toEqual({ createdAt: "earlier", audit: [{ at: "just now" }], id: "shift-earlier-bench2", reason: "carrier scan earlier", event: { api_version: "2026-02-25.clover" }, n: 3, ok: true, text: "BW-CB-55120" });
    expect(JSON.stringify(out)).not.toMatch(/20\d\d-[01]\d-[0-3]\d(?!\.clover)/);
  });

  it("only on the public profile", () => {
    const c = { createdAt: "2026-10-27T17:21:41.000Z" };
    expect(publicView(c, { env: {}, now })).toBe(c);
    expect(publicView(c, { env: { RETURNWITNESS_PUBLIC_DEMO: "1" }, now })).toEqual({ createdAt: "earlier" });
  });
});
