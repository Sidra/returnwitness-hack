import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level, so equal values always hash equally. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const digestOf = (v: unknown) => sha256(canonicalJson(v));
