/**
 * A gate run on fewer clips than the rule registers is never a PASS (RULE.md, addendum), and a clip is
 * found by its stem whatever container it was saved in (.mov from the phone, .mp4 after a conversion).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/gate/manifest.json";
import { gateVerdict } from "@/lib/evals/suite";
import { findClip } from "@/lib/vision/prepare-clip";
import { KIT } from "@/data/kit.config";

const ALL = manifest.clips.map((c) => c.id);
const ok = (id: string) => ({ clipId: id, pass: true });
const bad = (id: string) => ({ clipId: id, pass: false });
const rule = fs.readFileSync(path.join(__dirname, "..", "scripts", "gate", "RULE.md"), "utf8");

describe("gate verdict against the registered clips", () => {
  it("every registered clip scored and passing: PASS", () => {
    expect(gateVerdict(ALL.map(ok), ALL)).toEqual({ verdict: "PASS", notRun: [] });
  });

  it("only g0 and g1 filmed, both passing: INCOMPLETE, naming the rest", () => {
    const r = gateVerdict([ok("g0"), ok("g1")], ALL);
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.notRun).toEqual(["g2", "g3", "g4", "g5", "g6", "g7", "g8"]);
  });

  it("a FAIL on any scored clip is a FAIL, partial or not", () => {
    expect(gateVerdict([ok("g0"), bad("g1")], ALL).verdict).toBe("FAIL");
    expect(gateVerdict(ALL.map((id) => (id === "g6" ? bad(id) : ok(id))), ALL).verdict).toBe("FAIL");
  });

  it("calibrated re-score with only g0 left to score: INCOMPLETE, not PASS on one clip", () => {
    const registered = ALL.filter((id) => id !== "g1");
    expect(gateVerdict([ok("g0")], registered)).toEqual({ verdict: "INCOMPLETE", notRun: ["g2", "g3", "g4", "g5", "g6", "g7", "g8"] });
  });

  it("nothing scored is never a PASS", () => {
    expect(gateVerdict([], ALL).verdict).toBe("INCOMPLETE");
    expect(gateVerdict([], []).verdict).toBe("INCOMPLETE");
  });

  it("the rule's dated addendum says so", () => {
    expect(rule).toMatch(/## Addendum/);
    expect(rule).toMatch(/INCOMPLETE/);
  });

  it("the item words chosen on g1 are registered in a second addendum, and kit.config uses them", () => {
    expect(rule).toMatch(/## Addendum 2: item words chosen on g1/);
    expect(rule).toMatch(/per-SKU store config/);
    expect(Object.fromEntries(KIT.items.map((i) => [i.key, i.samConcept]))).toEqual({ camera_body: "mint green object", lens: "camera lens", battery: "battery" });
    // People and the illustration still see the product's generic name.
    expect(KIT.items.map((i) => i.genericName)).toEqual(["film camera", "camera lens", "battery charger"]);
  });
});

describe("findClip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-clips-"));
  fs.writeFileSync(path.join(dir, "g1-clean.mp4"), "");
  fs.writeFileSync(path.join(dir, "d2-rma-20419-complete.MOV"), "");

  it("finds a converted .mp4 when the manifest names .mov", () => {
    expect(findClip(dir, "g1-clean.mov")).toBe(path.join(dir, "g1-clean.mp4"));
  });

  it("finds by bare stem, any case of extension", () => {
    // macOS volumes are usually case-insensitive, so either spelling may come back; both open the same file.
    expect(findClip(dir, "d2-rma-20419-complete")?.toLowerCase()).toBe(path.join(dir, "d2-rma-20419-complete.mov").toLowerCase());
  });

  it("missing clip: null", () => {
    expect(findClip(dir, "g5-missing-lens.mov")).toBeNull();
  });
});
