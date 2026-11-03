import { describe, expect, it } from "vitest";
import { z } from "zod";
import { closeObjects, dropNullOptionals, metaResponseFormat, parseMetaReply, strictJsonSchema } from "@/lib/meta/json-schema";
import { DecisionDraft, ModelReconciliationOutput } from "@/lib/domain/schemas";
import { LIVE_ROLES } from "@/lib/fleet/live-merge";
import { quotesClause, validateDraft } from "@/lib/engine/decision";
import { POLICY, RMAS } from "@/data/fixtures";

// A loose view of a JSON Schema node for assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON Schema is untyped; tests index into it freely
type Schema = Record<string, any>;

/** Every object node in a JSON Schema, however deep. */
function objectNodes(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) node.forEach((n) => objectNodes(n, out));
  else if (node && typeof node === "object") {
    const n = node as Record<string, unknown>;
    if (n.type === "object" || "properties" in n) out.push(n);
    for (const [k, v] of Object.entries(n)) {
      if (k === "properties" || k === "$defs" || k === "definitions") Object.values((v ?? {}) as object).forEach((x) => objectNodes(x, out));
      else if (typeof v === "object") objectNodes(v, out);
    }
  }
  return out;
}

describe("Meta strict structured-output schemas", () => {
  it("zod's input-mode schema leaves objects open, which Meta rejects with a 400 (the bug this guards)", () => {
    const raw = z.toJSONSchema(ModelReconciliationOutput, { target: "draft-7", io: "input" });
    expect(objectNodes(raw).some((n) => n.additionalProperties !== false)).toBe(true);
  });

  const schemas: Array<[string, z.ZodType]> = [
    ["reconciliation (Muse Spark)", ModelReconciliationOutput],
    ["decision_draft (Muse Wonder)", DecisionDraft],
    ...LIVE_ROLES.map((d) => [`${d.schemaName} (fleet ${d.role})`, d.schema] as [string, z.ZodType]),
  ];
  it.each(schemas)("%s: every object node is closed and lists every property as required", (_name, schema) => {
    const nodes = objectNodes(strictJsonSchema(schema));
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.additionalProperties).toBe(false);
      expect([...(n.required as string[])].sort()).toEqual(Object.keys((n.properties ?? {}) as object).sort());
    }
  });

  it("closes objects inside arrays, unions and $defs, keeps required and non-object nodes as they were", () => {
    const s = closeObjects({
      type: "object",
      required: ["a"],
      properties: { a: { type: "array", items: { type: "object", properties: { b: { type: "string" } } } }, u: { anyOf: [{ type: "object", properties: {} }, { type: "null" }] } },
      $defs: { D: { type: "object", properties: { c: { type: "number" } } } },
    }) as Schema;
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["a", "u"]);
    expect(s.properties.a.items.additionalProperties).toBe(false);
    expect(s.properties.a.additionalProperties).toBeUndefined();
    expect(s.properties.u.anyOf[0].additionalProperties).toBe(false);
    expect(s.properties.u.anyOf[1]).toEqual({ type: "null" });
    expect(s.$defs.D.additionalProperties).toBe(false);
  });

  it("an optional key becomes required-but-nullable; a key that already allows null is left alone", () => {
    const S = z.object({ need: z.string(), maybe: z.string().optional(), unread: z.string().nullable() });
    const js = strictJsonSchema(S) as Schema;
    expect(js.required.sort()).toEqual(["maybe", "need", "unread"]);
    expect(js.properties.maybe).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(js.properties.need).toEqual({ type: "string" });
    expect(js.properties.unread.anyOf ?? js.properties.unread.type).toBeDefined();
    expect(JSON.stringify(js.properties.unread)).not.toContain('"anyOf":[{"anyOf"');
  });

  it("parseMetaReply drops null only at optional keys: a nullable key keeps its null", () => {
    const S = z.object({ reads: z.array(z.object({ serialText: z.string().nullable(), note: z.string().optional() })), notes: z.string().optional() });
    const r = parseMetaReply(S, { reads: [{ serialText: null, note: null }, { serialText: "BW-CB-55107", note: "sharp" }], notes: null });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ reads: [{ serialText: null }, { serialText: "BW-CB-55107", note: "sharp" }] });
    // Without the drop, zod refuses the strict-mode answer (the second live Spark failure).
    expect(S.safeParse({ reads: [], notes: null }).success).toBe(false);
  });

  it("parseMetaReply on the real Spark schema: an answer with notes:null parses", () => {
    const keys = Object.keys((strictJsonSchema(ModelReconciliationOutput) as Schema).properties);
    expect(keys).toContain("notes");
    const js = z.toJSONSchema(ModelReconciliationOutput, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    expect(dropNullOptionals({ notes: null, other: 1 }, js)).toEqual({ other: 1 });
  });

  it("parseMetaReply still refuses a wrong answer", () => {
    expect(parseMetaReply(z.object({ n: z.number() }), { n: "three" }).success).toBe(false);
    expect(parseMetaReply(z.object({ n: z.number() }), { n: null }).success).toBe(false);
  });

  it("metaResponseFormat is strict json_schema with the given name", () => {
    const f = metaResponseFormat("decision_draft", DecisionDraft);
    expect(f.type).toBe("json_schema");
    expect(f.json_schema).toMatchObject({ name: "decision_draft", strict: true });
  });
});

describe("clause quotes (Muse Wonder quotes clauses the way it is shown them: '<Title>. <text>')", () => {
  const c43 = POLICY.clauses.find((c) => c.id === "4.3")!;
  it("accepts the body, a part of it, and the title-prefixed form", () => {
    expect(quotesClause(c43.text, c43)).toBe(true);
    expect(quotesClause(c43.text.split(". ")[0], c43)).toBe(true);
    expect(quotesClause(`${c43.title}. ${c43.text}`, c43)).toBe(true);
    expect(quotesClause(`${c43.id} ${c43.title}. ${c43.text}`, c43)).toBe(true); // the policyText line, as the second live run quoted it
    expect(quotesClause(`“${c43.title}.   ${c43.text.toUpperCase()}”`.replace(/[“”]/g, ""), c43)).toBe(true);
  });
  it("refuses a bare title, an empty quote, and an invented sentence", () => {
    expect(quotesClause(`${c43.title}.`, c43)).toBe(false);
    expect(quotesClause(`${c43.id} ${c43.title}.`, c43)).toBe(false);
    expect(quotesClause(`4.2 ${c43.title}. ${c43.text}`, c43)).toBe(false); // labelled as another clause: refused
    expect(quotesClause("   ", c43)).toBe(false);
    expect(quotesClause(`${c43.title}. Refunds are always issued in full.`, c43)).toBe(false);
    expect(quotesClause(`${c43.text} Refunds are always issued in full.`, c43)).toBe(false);
  });
  it("the live Wonder draft from the first preflight now validates (title-prefixed quotes of 4.3 and 5.1)", () => {
    const c51 = POLICY.clauses.find((c) => c.id === "5.1")!;
    const draft = {
      recommendation: "HOLD",
      proposedRefundCents: 0,
      citedClauses: [
        { clauseId: "4.3", quote: `${c43.title}. ${c43.text}` },
        { clauseId: "5.1", quote: `${c51.title}. ${c51.text}` },
      ],
      rationale: "Every component was observed 0 of 1, so the case is held until a person checks.",
      lineNotes: [{ itemKey: "camera_body", note: "MISSING: 0 of 1 seen in the tray." }],
    };
    const recon = { summary: { allClear: false } } as never;
    expect(validateDraft(draft, { policy: POLICY, recon, rma: RMAS[1] })).toMatchObject({ ok: true });
  });
});

describe("Muse Wonder's read_reconciliation tool shows clauses structured", () => {
  it("returns {clauseId, title, text} per clause, so the quotable text is its own field", async () => {
    const { readReconciliationTool } = await import("@/lib/meta/wonder-agent");
    const out = readReconciliationTool({ rma: RMAS[1], state: "Held", digest: "d", recon: { lines: [], summary: { allClear: false } }, policy: POLICY } as never);
    expect(out.policy).toEqual(POLICY.clauses.map((c) => ({ clauseId: c.id, title: c.title, text: c.text })));
  });
});
