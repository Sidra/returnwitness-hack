/**
 * Structured output on the Meta Model API: the schema it accepts, and reading the answer back.
 *
 * Strict mode refuses (HTTP 400) any object schema that doesn't (a) say `additionalProperties: false` and
 * (b) list EVERY property in `required`; both were found by the first live Muse Spark calls.
 * zod's JSON Schema leaves objects open and lists only required keys, so `strictJsonSchema` closes every
 * object node and makes each optional key required-but-nullable, the standard strict-mode encoding.
 * The model then answers `null` for "not given"; `parseMetaReply` drops a null only where the zod schema has
 * an OPTIONAL key, so a key that is genuinely nullable (an unread serial is `serialText: null`) keeps its null.
 */
import { z } from "zod";

type Node = Record<string, unknown>;

const allowsNull = (n: Node) =>
  n.type === "null" || (Array.isArray(n.type) && n.type.includes("null")) || [n.anyOf, n.oneOf].some((u) => Array.isArray(u) && u.some((b) => (b as Node)?.type === "null"));

export function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (!node || typeof node !== "object") return node;
  const out: Node = {};
  for (const [k, v] of Object.entries(node as Node)) {
    if (k === "properties" || k === "$defs" || k === "definitions") {
      out[k] = Object.fromEntries(Object.entries((v ?? {}) as Node).map(([pk, pv]) => [pk, closeObjects(pv)]));
    } else out[k] = typeof v === "object" ? closeObjects(v) : v;
  }
  const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || "properties" in out;
  if (isObject) {
    out.additionalProperties = false;
    const props = (out.properties ?? {}) as Record<string, Node>;
    const required = new Set((out.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) if (!required.has(key) && !allowsNull(props[key])) props[key] = { anyOf: [props[key], { type: "null" }] };
    out.required = Object.keys(props);
  }
  return out;
}

const zodJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Node;

export function strictJsonSchema(schema: z.ZodType): Node {
  return closeObjects(zodJsonSchema(schema)) as Node;
}

export const metaResponseFormat = (name: string, schema: z.ZodType) => ({
  type: "json_schema" as const,
  json_schema: { name, schema: strictJsonSchema(schema), strict: true },
});

function resolve(node: Node, root: Node): Node {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  return (ref.slice(2).split("/").reduce<unknown>((n, part) => (n as Node | undefined)?.[part], root) as Node | undefined) ?? {};
}

/** Removes `null` at keys the (zod) schema marks optional; everything else is left as the model sent it. */
export function dropNullOptionals(value: unknown, node: Node, root: Node = node): unknown {
  node = resolve(node, root);
  if (Array.isArray(value)) return value.map((v) => dropNullOptionals(v, (node.items as Node) ?? {}, root));
  if (!value || typeof value !== "object") return value;
  const branch = node.properties ? node : ([node.anyOf, node.oneOf].flat().find((b) => b && typeof b === "object" && (resolve(b as Node, root).properties)) as Node | undefined);
  if (!branch) return value;
  const shape = resolve(branch, root);
  const props = (shape.properties ?? {}) as Record<string, Node>;
  const required = new Set((shape.required as string[] | undefined) ?? []);
  const out: Node = {};
  for (const [k, v] of Object.entries(value as Node)) {
    if (v === null && k in props && !required.has(k)) continue;
    out[k] = k in props ? dropNullOptionals(v, props[k], root) : v;
  }
  return out;
}

/** Parse a strict-mode answer against the zod schema it was asked for. */
export function parseMetaReply<T>(schema: z.ZodType<T>, raw: unknown): ReturnType<z.ZodType<T>["safeParse"]> {
  const js = zodJsonSchema(schema);
  return schema.safeParse(dropNullOptionals(raw, js, js));
}
