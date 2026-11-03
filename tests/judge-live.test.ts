import { describe, expect, it } from "vitest";
import { judgeLiveConfig, memoryCounters, reserveJudgeRun } from "@/lib/judge-live";

const on = { RETURNWITNESS_JUDGE_LIVE: "1", META_HACK_API_KEY: "k", RETURNWITNESS_JUDGE_PER_VISITOR_DAY: "2", RETURNWITNESS_JUDGE_DAILY_CAP: "3" } as unknown as NodeJS.ProcessEnv;
const day = new Date("2026-10-30T12:00:00Z");

describe("judge live mode (off unless switched on, capped, killable)", () => {
  it("is off by default, off without a key, and the kill switch wins", () => {
    expect(judgeLiveConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(judgeLiveConfig({ RETURNWITNESS_JUDGE_LIVE: "1" } as unknown as NodeJS.ProcessEnv).reason).toMatch(/no Meta key/);
    expect(judgeLiveConfig({ ...on, RETURNWITNESS_JUDGE_LIVE_KILL: "1" }).enabled).toBe(false);
    expect(judgeLiveConfig(on)).toMatchObject({ enabled: true, perVisitorPerDay: 2, dailyCap: 3 });
  });

  it("clamps caps to safe maximums and ignores junk", () => {
    const c = judgeLiveConfig({ ...on, RETURNWITNESS_JUDGE_PER_VISITOR_DAY: "999", RETURNWITNESS_JUDGE_DAILY_CAP: "-4" });
    expect(c.perVisitorPerDay).toBe(10);
    expect(c.dailyCap).toBe(40);
  });

  it("enforces the per-visitor cap without spending the daily budget on refusals", async () => {
    const store = memoryCounters();
    const cfg = judgeLiveConfig(on);
    expect(await reserveJudgeRun("1.1.1.1", cfg, store, day, "t")).toMatchObject({ ok: true, visitorLeft: 1, dailyLeft: 2 });
    expect(await reserveJudgeRun("1.1.1.1", cfg, store, day, "t")).toMatchObject({ ok: true, visitorLeft: 0 });
    expect(await reserveJudgeRun("1.1.1.1", cfg, store, day, "t")).toMatchObject({ ok: false, reason: "visitor_cap" });
    expect(await store.get("t:judge:2026-10-30:all")).toBe("2");
  });

  it("enforces the daily cap across visitors, and a refused run doesn't count against the visitor", async () => {
    const store = memoryCounters();
    const cfg = judgeLiveConfig(on);
    for (const ip of ["a", "b", "c"]) expect((await reserveJudgeRun(ip, cfg, store, day, "t")).ok).toBe(true);
    expect(await reserveJudgeRun("d", cfg, store, day, "t")).toMatchObject({ ok: false, reason: "daily_cap" });
    expect(await store.get("t:judge:2026-10-30:v:d")).toBe("0");
    // A new UTC day starts fresh.
    expect((await reserveJudgeRun("d", cfg, store, new Date("2026-10-31T00:00:01Z"), "t")).ok).toBe(true);
  });

  it("refuses when off, without a counter store, or when the Redis kill key is set", async () => {
    const store = memoryCounters();
    expect(await reserveJudgeRun("x", judgeLiveConfig({} as NodeJS.ProcessEnv), store, day, "t")).toMatchObject({ ok: false, reason: "off" });
    expect(await reserveJudgeRun("x", judgeLiveConfig(on), null, day, "t")).toMatchObject({ ok: false, reason: "no_store" });
    await store.incr("t:judge:kill", 60);
    expect(await reserveJudgeRun("x", judgeLiveConfig(on), store, day, "t")).toMatchObject({ ok: false, reason: "killed" });
  });
});
