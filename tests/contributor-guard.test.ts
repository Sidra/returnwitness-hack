import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { assertNotContributor, RETIRED_CONTRIBUTOR_FLAG, isContributorModel, metaConfig } from "@/lib/meta/config";
import { sparkReconcile, type ReaderEvidence } from "@/lib/meta/readers";
import { openWeightAudit, openWeightConfig } from "@/lib/openweights/auditor";

// Refusals are logged like any failed call; keep them out of the real call log.
beforeAll(() => {
  process.env.RETURNWITNESS_LLM_LOG = path.join(os.tmpdir(), `rw-guard-${process.pid}.jsonl`);
});

const ev: ReaderEvidence = {
  rma: RMAS[1],
  slip: ORDERS[1].slip,
  policy: POLICY,
  count: { clipId: "c", counts: { camera_body: 1, lens: 1, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } },
  images: [{ caption: "crop lens", dataUrl: "data:image/png;base64,AA==" }],
};
// Nothing listens here: if a guard let a call through, the test would see a connection error, not a refusal.
const DEAD = "http://127.0.0.1:9/v1";

describe("contributor-mode guard", () => {
  it("recognises contributor variants by id, case-insensitively", () => {
    expect(isContributorModel("muse-spark-1.3-contributor")).toBe(true);
    expect(isContributorModel("Muse-Wonder-Contributor")).toBe(true);
    expect(isContributorModel("muse-spark-1.3")).toBe(false);
  });

  it("always throws on a contributor id; the retired opt-in flag changes nothing", () => {
    expect(() => assertNotContributor("sam-3.1-contributor")).toThrow(/refused model .*contributor/);
    expect(() => assertNotContributor("muse-spark-1.3-contributor")).toThrow(/never uses them/);
    process.env[RETIRED_CONTRIBUTOR_FLAG] = "1";
    try {
      expect(() => assertNotContributor("muse-spark-1.3-contributor")).toThrow();
    } finally {
      delete process.env[RETIRED_CONTRIBUTOR_FLAG];
    }
    expect(() => assertNotContributor("sam-3.1")).not.toThrow();
    expect(() => assertNotContributor("muse-spark-1.3")).not.toThrow();
  });

  it("metaConfig lists configured contributor ids as refused, even with the retired flag", () => {
    const env = { META_MODEL_SPARK: "muse-spark-1.3-contributor" } as unknown as NodeJS.ProcessEnv;
    expect(metaConfig(env).refusedModels).toEqual(["muse-spark-1.3-contributor"]);
    expect(metaConfig({ ...env, [RETIRED_CONTRIBUTOR_FLAG]: "1" }).refusedModels).toEqual(["muse-spark-1.3-contributor"]);
    expect(metaConfig({} as NodeJS.ProcessEnv).refusedModels).toEqual([]);
  });

  it("the Spark reader refuses before any network call and returns no reading", async () => {
    const cfg = { ...metaConfig({ META_HACK_API_KEY: "k", META_MODEL_SPARK: "muse-spark-1.3-contributor" } as unknown as NodeJS.ProcessEnv), baseURL: DEAD };
    const r = await sparkReconcile(ev, cfg);
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/refused model "muse-spark-1.3-contributor"/);
  });

  it("the open-weight auditor refuses a contributor model too", async () => {
    const cfg = { ...openWeightConfig({ RETURNWITNESS_OPENWEIGHT_PROVIDER: "baseten", BASETEN_API_KEY: "k" } as unknown as NodeJS.ProcessEnv), baseURL: DEAD, model: "meta-models/muse-spark-open-contributor" };
    const r = await openWeightAudit(ev, cfg);
    expect(r.output).toBeNull();
    expect(r.error).toMatch(/refused model/);
  });
});
