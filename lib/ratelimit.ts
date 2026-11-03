/**
 * Per-IP limits on the public deploy (Upstash, sliding window), so nobody can hammer the Stripe
 * test API or the shared store. Without Redis (local) there is no limit. If the limiter itself
 * errors, the request is allowed: the endpoints behind it are already fail-closed and test-mode.
 */
import { Ratelimit } from "@upstash/ratelimit";
import { kv } from "@/lib/store/kv";
import { json } from "@/lib/api";

type Bucket = "inspect" | "money";
const LIMITS: Record<Bucket, { n: number; window: `${number} m` }> = {
  inspect: { n: 30, window: "1 m" },
  money: { n: 10, window: "1 m" },
};

const g = globalThis as unknown as { __rwRl?: Partial<Record<Bucket, Ratelimit>> };

function limiter(b: Bucket): Ratelimit | null {
  const r = kv();
  if (!r) return null;
  g.__rwRl ??= {};
  g.__rwRl[b] ??= new Ratelimit({ redis: r, limiter: Ratelimit.slidingWindow(LIMITS[b].n, LIMITS[b].window), prefix: `${process.env.RETURNWITNESS_KV_PREFIX || "rw"}:rl:${b}`, ephemeralCache: new Map(), timeout: 1500 });
  return g.__rwRl[b]!;
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";

/** Returns a 429 response when the caller is over the limit, otherwise null. */
export async function rateLimited(req: Request, b: Bucket): Promise<Response | null> {
  const l = limiter(b);
  if (!l) return null;
  try {
    const { success, reset } = await l.limit(clientIp(req));
    if (success) return null;
    const retry = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
    return new Response(JSON.stringify({ error: "rate_limited", message: `Too many requests. Try again in ${retry} s.` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(retry) } });
  } catch {
    return null;
  }
}

export { json };
