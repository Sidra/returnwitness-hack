import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GLIMMER_SYSTEM } from "@/lib/openweights/fireworks";
import { applyRecipe, GLIMMER_RECIPES, parseGlimmerEvalArgs, reasoningTarget, type TrainingLine } from "@/lib/learning/glimmer-eval";

const line = (answer: Record<string, unknown>): TrainingLine => ({
  messages: [
    { role: "system", content: GLIMMER_SYSTEM },
    { role: "user", content: [{ type: "text", text: "crop of the counted lens (read any serial label exactly)" }] },
    { role: "assistant", content: JSON.stringify({ items: [{ itemKey: "lens", ...answer }] }) },
  ],
  meta: {
    rowId: "r1",
    caseId: "c1",
    itemKey: "lens",
    truth: { serial: null, sku: null, serialUnreadable: false },
    expected: { serial: null, sku: null, requiresSerial: true },
    split: "train",
    seed: 1729,
    fraction: 0.2,
  },
});
const legible = { serialRead: "BW-LN-80311", skuRead: "CK-LENS-24105", legible: true, confidence: 1 };
const covered = { serialRead: null, skuRead: "CK-LENS-24105", legible: false, confidence: 0 };

describe("Glimmer fine-tune recipe v2 (reasoning targets), written before any v2 row is scored", () => {
  it("both recipes: no sample packing, no GRPO; only v2 adds reasoning targets", () => {
    expect(GLIMMER_RECIPES.v1).toMatchObject({ reasoningTargets: false, samplePacking: false, grpo: false });
    expect(GLIMMER_RECIPES.v2).toMatchObject({ reasoningTargets: true, samplePacking: false, grpo: false });
  });

  it("the rationale states only what the answer says: the serial and part number for a legible label", () => {
    const r = reasoningTarget(legible);
    expect(r).toContain("B W - L N - 8 0 3 1 1");
    expect(r).toContain("CK-LENS-24105");
    expect(r).toMatch(/not the brand name/);
    expect(r).not.toMatch(/null/);
  });

  it("a covered serial: the rationale abstains and never names a serial", () => {
    const r = reasoningTarget(covered);
    expect(r).toMatch(/don't guess a serial: serialRead is null, legible is false, confidence 0/);
    expect(r).not.toMatch(/BW-/);
    expect(reasoningTarget({ ...covered, skuRead: null })).not.toMatch(/part number/);
  });

  it("applyRecipe: v1 leaves the row untouched; v2 adds reasoning_content and keeps the JSON answer as the content", () => {
    const l = line(legible);
    expect(applyRecipe(l, "v1")).toBe(l);
    const v2 = applyRecipe(l, "v2");
    expect(v2.messages[2].content).toBe(l.messages[2].content);
    expect(v2.messages[2].reasoning_content).toBe(reasoningTarget(legible));
    expect(l.messages[2].reasoning_content).toBeUndefined(); // not mutated
    expect(() => applyRecipe({ ...l, messages: [l.messages[0], l.messages[1], { role: "assistant", content: '{"items":[]}' }] }, "v2")).toThrow(/no item/);
  });

  it("--recipe parses v1|v2 and refuses anything else; default v1", () => {
    expect(parseGlimmerEvalArgs(["export"]).recipe).toBe("v1");
    expect(parseGlimmerEvalArgs(["export", "--recipe", "v2"]).recipe).toBe("v2");
    expect(() => parseGlimmerEvalArgs(["export", "--recipe", "grpo"])).toThrow(/v1 or v2/);
  });

  it("the Modal trainer passes reasoning_content to the chat template and names the recipe (Python, functions run directly)", () => {
    const py = `
import ast, json, sys
src = open(sys.argv[1]).read()
mod = ast.parse(src)
fns = [n for n in mod.body if isinstance(n, ast.FunctionDef) and n.name in ("to_hf_messages", "recipe_of")]
ns = {}
exec(compile(ast.Module(body=fns, type_ignores=[]), "glimmer_finetune", "exec"), ns)
rows = json.loads(sys.argv[2])
hf = ns["to_hf_messages"](rows[0]["messages"], True)
hf_prompt = ns["to_hf_messages"](rows[0]["messages"], False)
out = {"asst": hf[-1], "prompt_roles": [m["role"] for m in hf_prompt], "recipe_v2": ns["recipe_of"]([rows[0]]), "recipe_v1": ns["recipe_of"]([rows[1]])}
try:
    ns["recipe_of"]([rows[0], rows[1]])
    out["mixed"] = "accepted"
except ValueError as e:
    out["mixed"] = str(e)
print(json.dumps(out))
`;
    const v2 = applyRecipe(line(legible), "v2");
    const v1 = line(covered);
    const text = (m: TrainingLine["messages"]) => m.map((x) => (x.role === "user" ? { ...x, content: [{ type: "text", text: "crop" }] } : x));
    let stdout: string;
    try {
      stdout = execFileSync("python3", ["-I", "-c", py, path.join(__dirname, "..", "modal", "glimmer_finetune.py"), JSON.stringify([{ messages: text(v2.messages) }, { messages: text(v1.messages) }])], { encoding: "utf8" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // no python3 on this machine
      throw e;
    }
    const out = JSON.parse(stdout) as { asst: { role: string; reasoning_content?: string }; prompt_roles: string[]; recipe_v2: string; recipe_v1: string; mixed: string };
    expect(out.asst).toMatchObject({ role: "assistant", reasoning_content: reasoningTarget(legible) });
    expect(out.prompt_roles).toEqual(["system", "user"]);
    expect(out.recipe_v2).toBe("v2-reasoning-targets");
    expect(out.recipe_v1).toBe("v1-answer-only");
    expect(out.mixed).toMatch(/mixed recipes/);
  });
});
