/**
 * CaseStore on Upstash Redis, so every serverless instance sees the same cases (ADR-003).
 * - put(): version check + write in ONE Lua script (atomic compare-and-set).
 * - consumeNonce(): SET NX, atomic across instances: a token can be spent exactly once.
 * - claimWebhookEvent(): SET NX on the Stripe event id: a delivery is processed once.
 * Records expire after 14 days (public demo data, keeps the free tier small).
 */
import type { Redis } from "@upstash/redis";
import type { ReturnCase } from "@/lib/domain/case";
import type { CaseStore } from "./case-store";
import { VersionConflict } from "./errors";

const TTL_S = 14 * 24 * 3600;
const PREFIX = process.env.RETURNWITNESS_KV_PREFIX || "rw";
const caseKey = (id: string) => `${PREFIX}:case:${id}`;
const INDEX = `${PREFIX}:cases`;
const nonceKey = (n: string) => `${PREFIX}:nonce:${n}`;
const webhookKey = (id: string) => `${PREFIX}:whevt:${id}`;
/** Stripe redelivers for up to 3 days; keep processed event ids well past that. */
const WEBHOOK_TTL_S = 30 * 24 * 3600;

const PUT_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = tonumber(cjson.decode(cur)['version']) or 0 end
if v ~= tonumber(ARGV[1]) then return {0, v} end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[5]))
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
return {1, v}
`;

export class RedisCaseStore implements CaseStore {
  readonly kind = "upstash-redis";
  constructor(private readonly r: Redis) {}

  async get(id: string) {
    const raw = await this.r.get<string>(caseKey(id));
    return raw ? (JSON.parse(raw) as ReturnCase) : null;
  }

  async list() {
    const ids = (await this.r.zrange<string[]>(INDEX, 0, 199, { rev: true })) ?? [];
    if (!ids.length) return [];
    const raws = await this.r.mget<(string | null)[]>(...ids.map(caseKey));
    const out = raws.filter((x): x is string => Boolean(x)).map((x) => JSON.parse(x) as ReturnCase);
    // Drop index entries whose record expired.
    const gone = ids.filter((_, i) => !raws[i]);
    if (gone.length) await this.r.zrem(INDEX, ...gone);
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async put(c: ReturnCase, expectedVersion: number) {
    const stored: ReturnCase = { ...c, version: expectedVersion + 1 };
    const res = (await this.r.eval(PUT_SCRIPT, [caseKey(c.id), INDEX], [String(expectedVersion), JSON.stringify(stored), String(Date.parse(c.createdAt) || Date.now()), c.id, String(TTL_S)])) as [number, number];
    if (!res || Number(res[0]) !== 1) throw new VersionConflict(c.id, expectedVersion, Number(res?.[1] ?? -1));
    return stored;
  }

  async consumeNonce(nonce: string) {
    if (!nonce) return false;
    const ok = await this.r.set(nonceKey(nonce), "1", { nx: true, ex: TTL_S });
    return ok === "OK";
  }

  async claimWebhookEvent(eventId: string) {
    if (!eventId) return false;
    const ok = await this.r.set(webhookKey(eventId), "1", { nx: true, ex: WEBHOOK_TTL_S });
    return ok === "OK";
  }

  async releaseWebhookEvent(eventId: string) {
    await this.r.del(webhookKey(eventId));
  }

  async reset() {
    const ids = (await this.r.zrange<string[]>(INDEX, 0, -1)) ?? [];
    if (ids.length) await this.r.del(...ids.map(caseKey));
    await this.r.del(INDEX);
  }
}
