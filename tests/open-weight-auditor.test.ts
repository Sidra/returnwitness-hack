import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { auditToReconciliation, cropItemKey, openWeightAudit, openWeightConfig, OPEN_WEIGHT_NOT_RUN, parseAuditReply } from "@/lib/openweights/auditor";
import { crossCheckReaders, reconcile } from "@/lib/engine/reconcile";
import type { CountResult } from "@/lib/domain/schemas";
import type { ReaderEvidence } from "@/lib/meta/readers";

const rma = RMAS[1];
const slip = ORDERS[1].slip;
const count = (counts: Record<string, number>): CountResult => ({
  clipId: "c",
  counts,
  arrivals: [],
  flags: [],
  diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 },
});
const ev = (c: CountResult): ReaderEvidence => ({ rma, slip, policy: POLICY, count: c, images: [] });
const clean = { items: slip.lines.map((l) => ({ itemKey: l.itemKey, labelLegible: true, visibleDamage: false, standInSuspected: false, note: "" })) };

describe("OpenWeightAuditor", () => {
  it("not configured → not run, labelled, never blocks", async () => {
    const cfg = openWeightConfig({} as NodeJS.ProcessEnv);
    expect(cfg.provider).toBeNull();
    const r = await openWeightAudit(ev(count({ camera_body: 1, lens: 1, battery: 1 })), cfg);
    expect(r.output).toBeNull();
    expect(r.error).toContain(OPEN_WEIGHT_NOT_RUN);
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const x = crossCheckReaders(det, [{ reader: "muse-spark-open", mode: "LIVE_META", output: null, required: false, readsSerials: false }], { rma, slip });
    expect(x.reconciliation.summary.allClear).toBe(true);
  });

  it("baseten switch picks the hackathon model id", () => {
    const cfg = openWeightConfig({ RETURNWITNESS_OPENWEIGHT_PROVIDER: "baseten", BASETEN_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ provider: "baseten", model: "meta-models/muse-spark-open-1026", baseURL: "https://inference.baseten.co/v1" });
  });

  it("a clean audit changes nothing; its null serial reads don't hold serial lines", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 });
    const det = reconcile(rma, slip, c);
    const x = crossCheckReaders(det, [{ reader: "muse-spark-open", mode: "LIVE_META", output: auditToReconciliation(clean, ev(c)), required: false, readsSerials: false }], { rma, slip });
    expect(x.reconciliation.summary.allClear).toBe(true);
  });

  it("visible damage or a suspected stand-in raises a HELD line with the audit's own reason", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 });
    const audit = { items: clean.items.map((i) => (i.itemKey === "lens" ? { ...i, standInSuspected: true, note: "barrel is a mug handle shape" } : i)) };
    const det = reconcile(rma, slip, c);
    const x = crossCheckReaders(det, [{ reader: "muse-spark-open", mode: "LIVE_META", output: auditToReconciliation(audit, ev(c)), required: false, readsSerials: false }], { rma, slip });
    const lens = x.reconciliation.lines.find((l) => l.itemKey === "lens")!;
    expect(lens.status).toBe("HELD");
    expect(lens.reasons.some((r) => r.code === "stand_in_suspected" && r.detail.includes("mug handle"))).toBe(true);
  });

  it("an audit can never clear a missing line", () => {
    const c = count({ camera_body: 1, lens: 0, battery: 1 });
    const det = reconcile(rma, slip, c);
    const x = crossCheckReaders(det, [{ reader: "muse-spark-open", mode: "LIVE_META", output: auditToReconciliation(clean, ev(c)), required: false, readsSerials: false }], { rma, slip });
    expect(x.reconciliation.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
  });
});

describe("OpenWeightAuditor on Baseten: schema not enforced there, so we validate (one retry, fail closed)", () => {
  const cfg = openWeightConfig({ RETURNWITNESS_OPENWEIGHT_PROVIDER: "baseten", BASETEN_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
  const crop = (k: string) => ({ caption: `crop of the counted ${k} as it settled in the tray at 2.0 s (read any serial label exactly)`, dataUrl: "data:image/jpeg;base64,AA==" });
  const evCrops = (keys: string[]): ReaderEvidence => ({ ...ev(count({ camera_body: 1, lens: 1, battery: 1 })), images: [{ caption: "key frame", dataUrl: "data:image/jpeg;base64,AA==" }, ...keys.map(crop)] });
  const good = (k: string, over: Record<string, unknown> = {}) => JSON.stringify({ itemKey: k, labelLegible: true, visibleDamage: false, standInSuspected: false, note: "", ...over });
  type Req = { messages: Array<{ role: string; content: unknown }> };
  /** A fake chat client: `answers(itemKey, attempt)` decides each reply; records every request. */
  const fake = (answers: (k: string, attempt: number) => string | Error, delayMs = 0) => {
    const calls: Array<{ k: string; attempt: number; req: Req; at: number }> = [];
    const t0 = Date.now();
    return {
      calls,
      client: {
        chat: {
          completions: {
            create: async (req: Req) => {
              const text = JSON.stringify(req.messages[1].content);
              const k = /Item key: (\w+)/.exec(text)![1];
              const attempt = req.messages.filter((m) => m.role === "assistant").length + 1;
              calls.push({ k, attempt, req, at: Date.now() - t0 });
              if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
              const a = answers(k, attempt);
              if (a instanceof Error) throw a;
              return { choices: [{ message: { content: a, reasoning_content: "thinking" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
            },
          },
        },
      },
    };
  };

  it("cropItemKey reads the item from the caption; non-crop images are ignored", () => {
    expect(cropItemKey(crop("lens").caption)).toBe("lens");
    expect(cropItemKey("key frame 3")).toBeNull();
  });

  it("parseAuditReply: extra keys, missing keys, wrong item and no JSON are each refused with a reason", () => {
    expect(parseAuditReply(good("lens"), "lens").ok).toBe(true);
    expect(parseAuditReply(good("lens", { verdict: "fine" }), "lens")).toMatchObject({ ok: false });
    expect(parseAuditReply(JSON.stringify({ itemKey: "lens", labelLegible: true }), "lens")).toMatchObject({ ok: false });
    expect(parseAuditReply(good("battery"), "lens")).toMatchObject({ ok: false, problem: expect.stringMatching(/expected "lens"/) });
    expect(parseAuditReply("the lens looks fine", "lens")).toMatchObject({ ok: false, problem: "no JSON object in the reply" });
  });

  it("the answer's five keys and a filled example are in the system prompt (Baseten won't enforce response_format)", async () => {
    const f = fake((k) => good(k));
    await openWeightAudit(evCrops(["lens"]), cfg, { client: f.client as never });
    const sys = String(f.calls[0].req.messages[0].content);
    for (const k of ["itemKey", "labelLegible", "visibleDamage", "standInSuspected", "note"]) expect(sys).toContain(`"${k}"`);
    expect(sys).toContain('{"itemKey":"lens","labelLegible":true');
    expect(sys).not.toContain('"$schema"');
  });

  it("a reply that echoes a JSON Schema is named as such and retried with the example (first real clip, smoke g1)", async () => {
    const schemaEcho = JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { itemKey: { type: "string" } } });
    expect(parseAuditReply(schemaEcho, "lens")).toEqual({ ok: false, problem: "the reply is a JSON Schema, not an answer" });
    const f = fake((k, attempt) => (attempt === 1 ? schemaEcho : good(k)));
    const r = await openWeightAudit(evCrops(["lens"]), cfg, { client: f.client as never });
    expect(f.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(JSON.stringify(f.calls[1].req.messages.at(-1))).toMatch(/JSON Schema, not an answer.*with your own values/);
    expect(r.error).toBeUndefined();
  });

  it("a malformed first reply gets ONE corrective retry that names the problem; a valid retry is used", async () => {
    const f = fake((k, attempt) => (attempt === 1 ? "Sure! {itemKey: lens}" : good(k, { visibleDamage: true, note: "scratch on the barrel" })));
    const r = await openWeightAudit(evCrops(["lens"]), cfg, { client: f.client as never });
    expect(f.calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(JSON.stringify(f.calls[1].req.messages.at(-1))).toMatch(/was not a valid answer/);
    const lens = r.output!.lines.find((l) => l.itemKey === "lens")!;
    expect(lens.status).toBe("HELD");
    expect(lens.reasons[0]).toMatchObject({ code: "visible_damage" });
  });

  it("still malformed after the retry → that item HOLDS (model_unavailable); never more than 2 calls per crop", async () => {
    const f = fake((k) => (k === "lens" ? good("battery") : good(k)));
    const r = await openWeightAudit(evCrops(["camera_body", "lens", "battery"]), cfg, { client: f.client as never });
    expect(f.calls.filter((c) => c.k === "lens")).toHaveLength(2);
    expect(f.calls.filter((c) => c.k !== "lens")).toHaveLength(2);
    const lens = r.output!.lines.find((l) => l.itemKey === "lens")!;
    expect(lens).toMatchObject({ status: "HELD", reasons: [{ code: "model_unavailable" }] });
    expect(r.output!.lines.filter((l) => l.itemKey !== "lens").every((l) => l.status === "OK")).toBe(true);
    expect((r.extras as { unanswered: string[] }).unanswered).toEqual(["lens"]);
  });

  it("no valid answer for any crop (errors or junk) → not run, no output to merge", async () => {
    const junk = await openWeightAudit(evCrops(["lens", "battery"]), cfg, { client: fake(() => "{}").client as never });
    expect(junk.output).toBeNull();
    expect(junk.error).toMatch(/no valid open-weight answer for any crop after one retry each/);
    const down = await openWeightAudit(evCrops(["lens"]), cfg, { client: fake(() => new Error("503 upstream")).client as never });
    expect(down.output).toBeNull();
    expect(down.error).toMatch(/503 upstream/);
  });

  it("crops are sent in parallel, and the timing is reported per crop", async () => {
    const f = fake((k) => good(k), 60);
    const r = await openWeightAudit(evCrops(["camera_body", "lens", "battery"]), cfg, { client: f.client as never });
    expect(Math.max(...f.calls.map((c) => c.at))).toBeLessThan(40); // all three started before the first answered
    const t = (r.extras as { timing: { wallMs: number; perCrop: Array<{ ms: number; attempts: number; ok: boolean }> } }).timing;
    expect(t.perCrop).toHaveLength(3);
    expect(t.wallMs).toBeLessThan(60 * 3);
  });
});
