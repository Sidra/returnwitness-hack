/**
 * No run dates or clock times on the public site. The public profile (RETURNWITNESS_PUBLIC_DEMO=1, the Vercel deploy)
 * serves data that carries real timestamps: cases recorded on the store, recorded model runs, the seeded shift. A date
 * there is a build timeline, so every object handed to a public page or a public GET API goes through `publicView`
 * first: a full timestamp becomes a neutral relative label ("12 min ago", "earlier"), a date inside a longer string
 * becomes "earlier". Local runs (not the public profile) keep their real times.
 *
 * Only the serialization boundary changes: the store, the engine and every POST answer (approval tokens, their
 * expiry) keep exact times, so nothing that computes with a time is affected.
 */
const ISO_FULL = /^20\d\d-[01]\d-[0-3]\d(?:[T ][0-9:.]+(?:Z|[+-]\d\d:?\d\d)?)?$/;
const ISO_INSIDE = /(?<![0-9])20\d\d-[01]\d-[0-3]\d(?:T[0-9:.]+Z)?(?![0-9])/g;
/** Vendor identifiers that look like dates but date nothing of mine (Stripe's API version, e.g. "2026-02-25.clover"). */
const KEEP_KEYS = new Set(["api_version"]);

export const publicProfile = (env: Record<string, string | undefined> = process.env) => env.RETURNWITNESS_PUBLIC_DEMO === "1";

/**
 * A timestamp as a neutral label: how long ago (or how soon) within a day, otherwise "earlier". With no clock (`now`
 * null: a page prerendered at build, where a relative time would be frozen anyway) it is just "recorded".
 */
export function neutralTime(iso: string, now: number | null): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  if (now == null) return "recorded";
  const d = now - t;
  const mins = Math.floor(Math.abs(d) / 60_000);
  if (d < 0) return mins < 1 ? "in a moment" : mins < 60 ? `in ${mins} min` : "later";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`;
  return "earlier";
}

/** Deep copy with every timestamp neutralized (pure; exported for tests). */
export function neutralizeTimes<T>(value: T, now: number | null): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      if (key && KEEP_KEYS.has(key)) return v;
      if (ISO_FULL.test(v)) return neutralTime(v, now);
      return v.replace(ISO_INSIDE, "earlier");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * What a public page or public GET API may serve: neutralized on the public profile, untouched elsewhere. Pass the
 * request's clock (`now: Date.now()`) only where the route is dynamic; a prerendered page leaves it out.
 */
export function publicView<T>(value: T, opts: { now?: number | null; env?: Record<string, string | undefined> } = {}): T {
  return publicProfile(opts.env ?? process.env) ? neutralizeTimes(value, opts.now ?? null) : value;
}
