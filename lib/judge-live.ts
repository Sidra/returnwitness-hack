/**
 * Judge live mode: lets a visitor to the public site run ONE seeded return through live Muse Spark 1.3 +
 * Muse Wonder 1.0 (the recorded segmentation stays; uploads stay off). OFF unless Sidra switches it on.
 *   RETURNWITNESS_JUDGE_LIVE=1            turns it on (also needs the Meta key on that server)
 *   RETURNWITNESS_JUDGE_LIVE_KILL=1       hard off, wins over everything
 *   <prefix>:judge:kill = "1" in Redis    instant off without a redeploy
 *   RETURNWITNESS_JUDGE_PER_VISITOR_DAY   live runs per visitor per UTC day (default 3, max 10)
 *   RETURNWITNESS_JUDGE_DAILY_CAP         live runs for everyone per UTC day (default 40, max 200)
 * Caps are enforced in shared Redis. On a serverless deploy without Redis it refuses: a cap that can't be
 * counted across instances can't be on. Locally (not Vercel) an in-memory counter is used.
 */
import { kv } from "@/lib/store/kv";

export interface JudgeLiveConfig {
  enabled: boolean;
  perVisitorPerDay: number;
  dailyCap: number;
  reason: string;
}

const clampInt = (v: string | undefined, dflt: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

export function judgeLiveConfig(env: NodeJS.ProcessEnv = process.env): JudgeLiveConfig {
  const perVisitorPerDay = clampInt(env.RETURNWITNESS_JUDGE_PER_VISITOR_DAY, 3, 10);
  const dailyCap = clampInt(env.RETURNWITNESS_JUDGE_DAILY_CAP, 40, 200);
  const base = { perVisitorPerDay, dailyCap };
  if (env.RETURNWITNESS_JUDGE_LIVE_KILL === "1") return { ...base, enabled: false, reason: "kill switch set (RETURNWITNESS_JUDGE_LIVE_KILL=1)" };
  if (env.RETURNWITNESS_JUDGE_LIVE !== "1") return { ...base, enabled: false, reason: "off (RETURNWITNESS_JUDGE_LIVE is not 1)" };
  if (!env.META_HACK_API_KEY?.trim()) return { ...base, enabled: false, reason: "on, but no Meta key on this server" };
  return { ...base, enabled: true, reason: `on: ${perVisitorPerDay} live runs per visitor per day, ${dailyCap} per day in total` };
}

/** The counters the caps need; Redis in production, a Map locally and in tests. */
export interface CounterStore {
  incr(key: string, ttlSeconds: number): Promise<number>;
  decr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

export function memoryCounters(): CounterStore {
  const m = new Map<string, number | string>();
  return {
    incr: async (k) => {
      const n = (Number(m.get(k)) || 0) + 1;
      m.set(k, n);
      return n;
    },
    decr: async (k) => {
      const n = (Number(m.get(k)) || 0) - 1;
      m.set(k, n);
      return n;
    },
    get: async (k) => (m.has(k) ? String(m.get(k)) : null),
  };
}

const g = globalThis as unknown as { __rwJudgeMem?: CounterStore };

export function defaultCounters(env: NodeJS.ProcessEnv = process.env): CounterStore | null {
  const r = kv();
  if (r)
    return {
      incr: async (k, ttl) => {
        const n = await r.incr(k);
        if (n === 1) await r.expire(k, ttl);
        return n;
      },
      decr: (k) => r.decr(k),
      get: async (k) => {
        const v = await r.get<string | number>(k);
        return v == null ? null : String(v);
      },
    };
  if (env.VERCEL) return null;
  g.__rwJudgeMem ??= memoryCounters();
  return g.__rwJudgeMem;
}

export type JudgeReservation = { ok: true; visitorLeft: number; dailyLeft: number } | { ok: false; reason: "off" | "killed" | "no_store" | "visitor_cap" | "daily_cap"; message: string };

/** Reserves one live run for this visitor, or says plainly why not. Counts are per UTC day. */
export async function reserveJudgeRun(visitor: string, cfg: JudgeLiveConfig = judgeLiveConfig(), store: CounterStore | null = defaultCounters(), now: Date = new Date(), prefix = process.env.RETURNWITNESS_KV_PREFIX || "rw"): Promise<JudgeReservation> {
  if (!cfg.enabled) return { ok: false, reason: "off", message: `Live runs are off on this site (${cfg.reason}). The seeded returns replay their recorded results.` };
  if (!store) return { ok: false, reason: "no_store", message: "Live runs need the shared counter store to enforce the daily cap; it isn't configured here." };
  if ((await store.get(`${prefix}:judge:kill`)) === "1") return { ok: false, reason: "killed", message: "Live runs were switched off for today." };
  const day = now.toISOString().slice(0, 10);
  const ttl = 60 * 60 * 26;
  const vKey = `${prefix}:judge:${day}:v:${visitor}`;
  const dKey = `${prefix}:judge:${day}:all`;
  const v = await store.incr(vKey, ttl);
  if (v > cfg.perVisitorPerDay) {
    await store.decr(vKey);
    return { ok: false, reason: "visitor_cap", message: `You've used today's ${cfg.perVisitorPerDay} live runs. The seeded returns still replay their recorded results.` };
  }
  const d = await store.incr(dKey, ttl);
  if (d > cfg.dailyCap) {
    await store.decr(dKey);
    await store.decr(vKey);
    return { ok: false, reason: "daily_cap", message: `Today's ${cfg.dailyCap} live runs are used up. The seeded returns still replay their recorded results.` };
  }
  return { ok: true, visitorLeft: cfg.perVisitorPerDay - v, dailyLeft: cfg.dailyCap - d };
}
