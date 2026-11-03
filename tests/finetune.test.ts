import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReturnCase, ReviewerCorrection } from "@/lib/domain/case";
import type { ArchivedCrop } from "@/lib/learning/corrections";
import { GLIMMER_SYSTEM } from "@/lib/openweights/fireworks";
import {
  assertCanSubmit,
  buildDataset,
  datasetCreateRequest,
  datasetUploadRequest,
  IMAGE_TOKEN_ESTIMATE,
  parseFinetuneArgs,
  pollSftJob,
  quoteFineTune,
  rowTokens,
  sftJobRequest,
  sftJobStatusRequest,
  sftPriceFromEnv,
  SpendRefused,
  submitFineTune,
  toJsonl,
  type DatasetRow,
} from "@/lib/learning/finetune";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-ft-"));
const LOG = path.join(tmp, "llm-calls.jsonl");
beforeAll(() => {
  process.env.RETURNWITNESS_LLM_LOG = LOG;
});
beforeEach(() => fs.rmSync(LOG, { force: true }));
const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const GLIMMER = "muse-glimmer (fireworks)";
const CAP = (k: string) => `crop of the counted ${k} as it settled in the tray at 2.0 s`;
let n = 0;
const cor = (caseId: string, over: Partial<ReviewerCorrection>): ReviewerCorrection => ({ id: `cor_${++n}`, caseId, rmaId: "RMA-20419", itemKey: "camera_body", field: "serial", modelValue: "BW-CB-55I20", humanValue: "BW-CB-55120", reader: GLIMMER, cropCaption: CAP("camera_body"), person: "Rita Calder", at: `2026-10-28T18:00:${String(n).padStart(2, "0")}Z`, ...over });
const mkCase = (id: string, corrections: ReviewerCorrection[] | undefined, extrasItems: unknown[] = []): ReturnCase =>
  ({
    id,
    runId: "run",
    rmaId: "RMA-20419",
    orderId: "ORD-58227",
    createdAt: "2026-10-28T17:00:00Z",
    updatedAt: "2026-10-28T17:00:00Z",
    version: 3,
    state: "Held",
    holdReasons: [],
    clip: { clipId: "clip", source: "upload", mode: "LIVE_META", provenance: "", durationS: 10, fps: 5 },
    disagreements: [],
    readerRuns: [{ reader: GLIMMER, model: "m", mode: "LIVE_OPEN_WEIGHTS", required: false, ok: true, latencyMs: 900, extras: { items: extrasItems, confidenceFloor: 0.7 } }],
    timings: [],
    costs: [],
    audit: [],
    ...(corrections ? { corrections } : {}),
  }) as ReturnCase;
const crop = (k: string, data = `data:image/jpeg;base64,${k.toUpperCase()}`): ArchivedCrop => ({ itemKey: k, caption: CAP(k), dataUrl: data });
const archive: Record<string, ArchivedCrop[]> = {};
const loadCrops = (id: string) => archive[id] ?? [];
const answerOf = (r: DatasetRow) => JSON.parse(r.messages[2].content).items[0];

describe("buildDataset", () => {
  it("one row per corrected item: the crop, the inference prompt, and the HUMAN value as the answer", () => {
    archive.c1 = [crop("camera_body"), crop("lens")];
    const c = mkCase("c1", [cor("c1", {})], [{ itemKey: "camera_body", serialRead: "BW-CB-55I20", skuRead: "CK-BODY-01", legible: true, confidence: 0.81, cropCaption: CAP("camera_body") }]);
    const { rows, report } = buildDataset([c], { loadCrops });
    expect(report).toMatchObject({ cases: 1, corrections: 1, labelCorrections: 1, rows: 1, droppedNoImage: 0 });
    const r = rows[0];
    expect(r.messages[0]).toEqual({ role: "system", content: GLIMMER_SYSTEM });
    const parts = r.messages[1].content;
    expect(parts.find((p) => p.type === "image_url")).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,CAMERA_BODY" } });
    expect(JSON.stringify(parts)).not.toContain("BW-CB-55120"); // the expected serial never leaks into the prompt
    // Human serial; the SKU the reviewer left standing is the model's.
    expect(answerOf(r)).toEqual({ itemKey: "camera_body", serialRead: "BW-CB-55120", skuRead: "CK-BODY-01", legible: true, confidence: 1 });
    expect(toJsonl(rows).trim().split("\n")).toHaveLength(1);
  });

  it("latest correction per field wins; serial + SKU fixes merge into one row; 'unreadable' teaches abstention", () => {
    archive.c2 = [crop("lens")];
    const c = mkCase("c2", [
      cor("c2", { itemKey: "lens", field: "serial", humanValue: "BW-LN-80300", cropCaption: CAP("lens") }),
      cor("c2", { itemKey: "lens", field: "sku", modelValue: null, humanValue: "CK-LENS-24105", cropCaption: CAP("lens") }),
      cor("c2", { itemKey: "lens", field: "serial", humanValue: "unreadable", cropCaption: CAP("lens") }),
    ]);
    const { rows } = buildDataset([c], { loadCrops });
    expect(rows).toHaveLength(1);
    expect(answerOf(rows[0])).toEqual({ itemKey: "lens", serialRead: null, skuRead: "CK-LENS-24105", legible: false, confidence: 0 });
  });

  it("skips non-label fields and other readers, drops items with no archived crop, dedupes identical rows", () => {
    archive.c3 = [crop("camera_body")];
    archive.c4 = [crop("camera_body")]; // same image bytes as c3
    const cases = [
      mkCase("c3", [cor("c3", {}), cor("c3", { field: "damage", modelValue: "none", humanValue: "cracked" }), cor("c3", { reader: "muse-spark-1.3", field: "serial" })]),
      mkCase("c4", [cor("c4", {}), cor("c4", { itemKey: "battery", field: "sku", modelValue: "X", humanValue: "CK-BATT-CHG", cropCaption: CAP("battery") })]),
      mkCase("c5", undefined), // stored before corrections existed
    ];
    const { rows, report } = buildDataset(cases, { loadCrops });
    expect(report).toEqual({ cases: 3, corrections: 5, labelCorrections: 3, skippedNonLabel: 2, droppedNoImage: 1, duplicates: 1, rows: 1 });
    expect(rows).toHaveLength(1);
  });

  it("an empty store builds an empty dataset", () => {
    expect(buildDataset([]).report.rows).toBe(0);
    expect(toJsonl([])).toBe("");
  });
});

describe("quoteFineTune", () => {
  const rows = (() => {
    archive.q = [crop("camera_body")];
    return buildDataset([mkCase("q", [cor("q", {})])], { loadCrops }).rows;
  })();

  it("no price → estUsd null with the reason", () => {
    const q = quoteFineTune(rows, { epochs: 2, usdPerMTok: null });
    expect(q.estUsd).toBeNull();
    expect(q.basis).toMatch(/price not set/);
    expect(q.trainingTokens).toBe(q.datasetTokens * 2);
  });

  it("tokens = chars/4 + a per-image constant; price math is per 1M training tokens", () => {
    const t = rowTokens(rows[0]);
    expect(t).toBeGreaterThan(IMAGE_TOKEN_ESTIMATE);
    const textOnly: DatasetRow = { messages: [{ role: "system", content: "abcd" }, { role: "user", content: [{ type: "text", text: "abcdefgh" }] }, { role: "assistant", content: "ab" }] };
    expect(rowTokens(textOnly)).toBe(Math.ceil(14 / 4));
    const q = quoteFineTune(rows, { epochs: 3, usdPerMTok: 4 });
    expect(q.estUsd).toBe(Math.round(((t * 3) / 1_000_000) * 4 * 100) / 100);
    expect(q.basis).toMatch(/\$4\/1M/);
    expect(() => quoteFineTune(rows, { epochs: 0, usdPerMTok: 4 })).toThrow(/epochs/);
  });

  it("the price comes only from FIREWORKS_SFT_USD_PER_MTOK", () => {
    expect(sftPriceFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(sftPriceFromEnv({ FIREWORKS_SFT_USD_PER_MTOK: "abc" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(sftPriceFromEnv({ FIREWORKS_SFT_USD_PER_MTOK: "0" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(sftPriceFromEnv({ FIREWORKS_SFT_USD_PER_MTOK: "3.5" } as unknown as NodeJS.ProcessEnv)).toBe(3.5);
  });
});

describe("Fireworks request builders", () => {
  it("produce the documented control-plane URLs and bodies", () => {
    expect(datasetCreateRequest("code-happy-sf-fyvhjz", "rw-labels-1", 12)).toEqual({ method: "POST", url: "https://api.fireworks.ai/v1/accounts/code-happy-sf-fyvhjz/datasets", json: { datasetId: "rw-labels-1", dataset: { displayName: "rw-labels-1", exampleCount: "12", userUploaded: {} } } });
    const up = datasetUploadRequest("acct", "rw-labels-1", '{"a":1}\n');
    expect(up.url).toBe("https://api.fireworks.ai/v1/accounts/acct/datasets/rw-labels-1:upload");
    expect(up.form?.get("file")).toBeInstanceOf(Blob);
    expect(sftJobRequest("acct", { datasetId: "d1", baseModel: "accounts/fireworks/models/glimmer", epochs: 2, outputModelId: "out1", displayName: "x" })).toEqual({
      method: "POST",
      url: "https://api.fireworks.ai/v1/accounts/acct/supervisedFineTuningJobs",
      json: { displayName: "x", dataset: "accounts/acct/datasets/d1", baseModel: "accounts/fireworks/models/glimmer", epochs: 2, outputModel: "accounts/acct/models/out1" },
    });
    expect(sftJobStatusRequest("acct", "accounts/acct/supervisedFineTuningJobs/job9")).toEqual({ method: "GET", url: "https://api.fireworks.ai/v1/accounts/acct/supervisedFineTuningJobs/job9" });
  });
});

describe("submit gates and job flow", () => {
  archive.s = [crop("camera_body")];
  const rows = buildDataset([mkCase("s", [cor("s", {})])], { loadCrops }).rows;
  const priced = quoteFineTune(rows, { epochs: 1, usdPerMTok: 5 });
  const unpriced = quoteFineTune(rows, { epochs: 1, usdPerMTok: null });
  const cfg = { apiKey: "fw-test", accountId: "acct", model: "accounts/fireworks/models/glimmer" };
  const never = (() => {
    throw new Error("network must not be touched");
  }) as unknown as typeof fetch;

  it("refuses without --confirm-spend, without a price, without credentials or rows, before any request", async () => {
    await expect(submitFineTune({ rows, quote: priced, confirmSpend: false, cfg, fetch: never })).rejects.toThrow(/--confirm-spend/);
    await expect(submitFineTune({ rows, quote: unpriced, confirmSpend: true, cfg, fetch: never })).rejects.toThrow(/no price/);
    await expect(submitFineTune({ rows, quote: priced, confirmSpend: true, cfg: { ...cfg, accountId: null }, fetch: never })).rejects.toThrow(/FIREWORKS_ACCOUNT_ID/);
    await expect(submitFineTune({ rows, quote: priced, confirmSpend: true, cfg: { ...cfg, model: null }, fetch: never })).rejects.toThrow(/FIREWORKS_GLIMMER_MODEL/);
    await expect(submitFineTune({ rows: [], quote: priced, confirmSpend: true, cfg, fetch: never })).rejects.toBeInstanceOf(SpendRefused);
    expect(() => assertCanSubmit({ rows, quote: priced, confirmSpend: true, cfg })).not.toThrow();
    expect(logged()).toHaveLength(0);
  });

  it("CLI: quote is the default; --submit alone does not confirm spend", () => {
    expect(parseFinetuneArgs([])).toEqual({ mode: "quote", confirmSpend: false, epochs: 3, out: null, poll: false });
    expect(parseFinetuneArgs(["--submit"])).toMatchObject({ mode: "submit", confirmSpend: false });
    expect(parseFinetuneArgs(["--submit", "--confirm-spend", "--epochs", "2"])).toMatchObject({ mode: "submit", confirmSpend: true, epochs: 2 });
    expect(() => parseFinetuneArgs(["--yes"])).toThrow(/unknown argument/);
    expect(() => parseFinetuneArgs(["--epochs", "0"])).toThrow(/epochs/);
  });

  it("announces the spend first, then dataset → upload → job; logs finetune_submit; polls to a terminal state", async () => {
    const calls: Array<{ method: string; url: string; auth: string | null }> = [];
    const order: string[] = [];
    const fake = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ method: String(init?.method), url: u, auth: new Headers(init?.headers).get("authorization") });
      order.push("fetch");
      if (u.endsWith("/supervisedFineTuningJobs")) return new Response(JSON.stringify({ name: "accounts/acct/supervisedFineTuningJobs/job1", state: "JOB_STATE_CREATING" }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await submitFineTune({ rows, quote: priced, confirmSpend: true, cfg, fetch: fake, now: () => new Date("2026-10-28T18:30:00Z"), announce: (l) => order.push(`announce:${l}`) });
    expect(order[0]).toMatch(/^announce:About to spend ≈ \$/);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v1/accounts/acct/datasets",
      `POST /v1/accounts/acct/datasets/${r.datasetId}:upload`,
      "POST /v1/accounts/acct/supervisedFineTuningJobs",
    ]);
    expect(calls.every((c) => c.auth === "Bearer fw-test")).toBe(true);
    expect(r).toMatchObject({ jobName: "accounts/acct/supervisedFineTuningJobs/job1", outputModelId: "rw-glimmer-labels-202610281830" });
    expect(r.datasetId).toMatch(/^rw-labels-202610281830-[0-9a-f]{8}$/);
    const rec = logged()[0];
    expect(rec).toMatchObject({ provider: "fireworks", purpose: "finetune_submit", ok: true, costUsd: null });
    expect(rec.input).toContain(String(priced.estUsd));

    const states = ["JOB_STATE_RUNNING", "JOB_STATE_RUNNING", "JOB_STATE_COMPLETED"];
    const seen: string[] = [];
    const poll = (async () => new Response(JSON.stringify({ state: states.shift() }), { status: 200 })) as unknown as typeof fetch;
    const done = await pollSftJob({ accountId: "acct", apiKey: "k" }, r.jobName, { fetch: poll, sleep: async () => {}, onState: (s) => seen.push(s) });
    expect(done.state).toBe("JOB_STATE_COMPLETED");
    expect(seen).toEqual(["JOB_STATE_RUNNING", "JOB_STATE_RUNNING", "JOB_STATE_COMPLETED"]);
  });

  it("a rejected job create surfaces the error and is logged as failed", async () => {
    const fake = (async (url: RequestInfo | URL) => (String(url).endsWith("/supervisedFineTuningJobs") ? new Response('{"error":"base model not tunable"}', { status: 400 }) : new Response("{}", { status: 200 }))) as typeof fetch;
    await expect(submitFineTune({ rows, quote: priced, confirmSpend: true, cfg, fetch: fake })).rejects.toThrow(/400: .*not tunable/);
    expect(logged()[0]).toMatchObject({ purpose: "finetune_submit", ok: false });
  });
});
