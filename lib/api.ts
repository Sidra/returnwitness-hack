import { ServiceError } from "@/lib/engine/service";
import { VersionConflict } from "@/lib/store/case-store";
import { publicView } from "@/lib/public/neutral-times";

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
/** A public GET answer: on the public profile every timestamp is neutralized (no run dates; lib/public/neutral-times.ts). */
export const publicJson = (data: unknown, status = 200) => json(publicView(data, { now: Date.now() }), status);

export function apiError(e: unknown) {
  if (e instanceof ServiceError) return json({ error: e.code, message: e.message }, e.status);
  if (e instanceof VersionConflict) return json({ error: "conflict", message: e.message }, 409);
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: "internal", message }, 500);
}

export async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}
