/** Shared Redis (Upstash, provisioned through the Vercel Marketplace) when its env vars are present. */
import { Redis } from "@upstash/redis";

const g = globalThis as unknown as { __rwKv?: Redis | null };

export function kv(): Redis | null {
  if (g.__rwKv !== undefined) return g.__rwKv;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  g.__rwKv = url && token ? new Redis({ url, token, automaticDeserialization: false }) : null;
  return g.__rwKv;
}
