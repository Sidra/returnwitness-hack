import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/gate/manifest.json";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { metaResponseFormat } from "@/lib/meta/json-schema";
import { PRICES } from "@/lib/obs/llm-log";
import {
  abClips,
  abQuote,
  ArmAReply,
  armAPromptSha256,
  armAUserText,
  armBDecision,
  armTotals,
  runArmA,
  scoreDecision,
  truthOf,
  type AbRow,
} from "@/lib/evals/same-input-ab";
import type { MetaConfig } from "@/lib/meta/config";

const prereg = fs.readFileSync(path.join(__dirname, "..", "evals", "AB-SAME-INPUT-PREREG.md"), "utf8");

describe("same-input A/B: pre-registration", () => {
  it("the frozen Arm A prompt is the one the pre-registration names (sha256)", () => {
    expect(prereg).toContain(armAPromptSha256());
  });

  it("12 clips: g0–g8 from the manifest, then d1–d3; truth matches the manifest and the RMAs", () => {
    const clips = abClips(manifest);
    expect(clips.map((c) => c.id)).toEqual(["g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "d1", "d2", "d3"]);
    const truth = Object.fromEntries(clips.map((c) => [c.id, truthOf(c)]));
    expect(truth).toEqual({
      g0: "must_hold", g1: "complete", g2: "complete", g3: "complete", g4: "complete", g5: "must_hold",
      g6: "hold_acceptable", g7: "hold_acceptable", g8: "complete", d1: "must_hold", d2: "complete", d3: "complete",
    });
    expect(clips.find((c) => c.id === "d1")!.file).toBe(RMAS[0].clipId);
    expect(clips.find((c) => c.id === "d2")!.file).toBe(RMAS[1].clipId);
    expect(clips.find((c) => c.id === "d3")!.file).toBe(RMAS[2].clipId);
  });
});

describe("same-input A/B: scoring", () => {
  it("every cell of the pre-registered table", () => {
    expect(scoreDecision("hold", "must_hold")).toBe("correct_hold");
    expect(scoreDecision("refund", "must_hold")).toBe("wrong_refund");
    expect(scoreDecision("hold", "hold_acceptable")).toBe("accepted_hold");
    expect(scoreDecision("refund", "hold_acceptable")).toBe("correct_refund");
    expect(scoreDecision("hold", "complete")).toBe("false_hold");
    expect(scoreDecision("refund", "complete")).toBe("correct_refund");
    for (const t of ["must_hold", "hold_acceptable", "complete"] as const) expect(scoreDecision(null, t)).toBe("no_answer");
  });

  it("Arm B: Held = hold, AwaitingApproval = refund recommended, a stalled case = no answer (never a refund)", () => {
    expect(armBDecision("Held")).toBe("hold");
    expect(armBDecision("AwaitingApproval")).toBe("refund");
    for (const s of ["Received", "Counted", "Reconciled", "Approved", "Refunded"] as const) expect(armBDecision(s)).toBeNull();
  });

  it("totals count every loss; a no-answer is neither a hold nor a refund", () => {
    const row = (a: AbRow["armA"]["outcome"], b: AbRow["armB"]["outcome"]): AbRow => ({
      clipId: "x",
      truth: "complete",
      armA: { decision: null, outcome: a, missingItemKeys: [], reason: null, latencyMs: 0 },
      armB: { decision: null, outcome: b, state: null, holdCodes: [], source: "test" },
    });
    const rows = [row("wrong_refund", "correct_hold"), row("false_hold", "false_hold"), row("no_answer", "correct_refund"), row("correct_refund", "accepted_hold")];
    expect(armTotals(rows, "armA")).toEqual({ clips: 4, wrongRefunds: 1, falseHolds: 1, noAnswer: 1, correct: 1 });
    expect(armTotals(rows, "armB")).toEqual({ clips: 4, wrongRefunds: 0, falseHolds: 1, noAnswer: 0, correct: 3 });
  });
});

describe("same-input A/B: Arm A request", () => {
  it("the reply schema is strict and Meta-compatible (no extra keys, refund|hold only)", () => {
    expect(ArmAReply.safeParse({ complete: true, decision: "refund", missingItemKeys: [], reason: "all three seen" }).success).toBe(true);
    expect(ArmAReply.safeParse({ complete: true, decision: "approve", missingItemKeys: [], reason: "x" }).success).toBe(false);
    expect(ArmAReply.safeParse({ complete: true, decision: "hold", missingItemKeys: [], reason: "x", refundCents: 1 }).success).toBe(false);
    const rf = metaResponseFormat("kit_decision", ArmAReply) as unknown as { json_schema: { strict: boolean; schema: { additionalProperties: boolean } } };
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema.additionalProperties).toBe(false);
  });

  it("the text carries the policy, the RMA and the slip, and nothing the pipeline computed", () => {
    const t = armAUserText(RMAS[0], ORDERS[0].slip, POLICY);
    expect(t).toContain(POLICY.id);
    expect(t).toContain(RMAS[0].reason);
    for (const l of ORDERS[0].slip.lines) expect(t).toContain(l.itemKey);
    expect(t).not.toMatch(/TRAY COUNTER|arrivals|VOICE NOTE/i);
  });

  it("no live key (or the public profile): no call, no answer", async () => {
    const cfg = { apiKey: undefined, publicDemo: false, models: { spark: "muse-spark-1.3" } } as unknown as MetaConfig;
    const r = await runArmA({ rma: RMAS[0], slip: ORDERS[0].slip, policy: POLICY, images: [], clipId: "d1" }, cfg);
    expect(r).toMatchObject({ decision: null, reply: null, error: "no live Meta key in this profile" });
    const pub = await runArmA({ rma: RMAS[0], slip: ORDERS[0].slip, policy: POLICY, images: [], clipId: "d1" }, { ...cfg, apiKey: "k", publicDemo: true } as MetaConfig);
    expect(pub.decision).toBeNull();
  });

  it("quote: 12 Arm A calls, 9 Spark + 9 Wonder for Arm B on the gate clips, no new SAM", () => {
    const q = abQuote({ gateClips: 9, allClips: 12, prices: { spark: PRICES["muse-spark-1.3"], wonder: PRICES["muse-wonder-1.0"] } });
    expect(q.calls).toEqual({ armASpark: 12, armBSpark: 9, armBWonderRuns: 9, sam: 0 });
    expect(q.usd.total).toBeCloseTo(q.usd.armA + q.usd.armB, 6);
    expect(prereg).toContain(`≈ $${q.usd.total.toFixed(2)}`);
    expect(abQuote({ gateClips: 0, allClips: 3, prices: { spark: PRICES["muse-spark-1.3"], wonder: PRICES["muse-wonder-1.0"] } }).usd.armB).toBe(0);
  });
});

describe("same-input A/B: the evals panel (server render)", () => {
  it("before the run: pre-registered, no numbers; after: every loss row stays, a pipeline wrong refund is the headline", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SameInputAb, SafetyPrice } = await import("@/components/dash/SameInputAb");
    const before = renderToStaticMarkup(createElement(SameInputAb, { report: null, promptSha256: armAPromptSha256() }));
    expect(before).toContain("PRE-REGISTERED · not run yet");
    expect(before).not.toMatch(/Wrong refunds<\/th>/);

    const mk = (clipId: string, truth: AbRow["truth"], a: AbRow["armA"]["outcome"], b: AbRow["armB"]["outcome"]): AbRow => ({
      clipId,
      truth,
      armA: { decision: a === "no_answer" ? null : a.includes("refund") ? "refund" : "hold", outcome: a, missingItemKeys: [], reason: "r", latencyMs: 1 },
      armB: { decision: b.includes("refund") ? "refund" : "hold", outcome: b, state: b.includes("refund") ? "AwaitingApproval" : "Held", holdCodes: [], source: "t" },
    });
    const rows = [mk("d1", "must_hold", "wrong_refund", "correct_hold"), mk("g5", "must_hold", "correct_hold", "wrong_refund"), mk("g1", "complete", "no_answer", "false_hold")];
    const report = { version: "same-input-ab/1", runId: "ab_t", at: "2026-11-01T18:00:00.000Z", gitHash: "abc1234", promptSha256: armAPromptSha256(), model: "muse-spark-1.3", rows, totals: { armA: armTotals(rows, "armA"), armB: armTotals(rows, "armB") }, costUsd: { armA: 0.04, armB: 0.2 } } as const;
    const after = renderToStaticMarkup(createElement(SameInputAb, { report, promptSha256: armAPromptSha256() }));
    expect(after).toContain("RECORDED LIVE RUN · Meta (SAM 3.1, Spark, Wonder) + open-weight auditor (Baseten) + Glimmer (Modal)");
    expect(after).not.toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(after.match(/WRONG REFUND/g)).toHaveLength(2);
    expect(after).toContain("false hold");
    expect(after).toContain("no answer");
    const safety = renderToStaticMarkup(createElement(SafetyPrice, { stress: { runs: 10, pass: 10, missedItems: 0, overCounts: 0, falseHolds: 2, wrongCounts: 0, completeKitRuns: 8, worstForCustomers: null, worstForMoney: null }, ab: report }));
    expect(safety).toContain("25.0% of 8 complete-kit runs");
    // The filmed clips' numbers live in the A/B, under its own badge, never under the synthetic sweep's.
    expect(safety).not.toContain("filmed clips (");
    expect(safety).toContain("not this sweep");
    // Both arms in the A/B headline, and the non-uniform pipeline arm stated.
    const text = after.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "");
    expect(text).toContain("Muse Spark alone 1/3 correct");
    expect(text).toContain("the pipeline 1/3");
    expect(after).toContain("was not run the same way on every clip");
  });

  it("four filmed clips: the rest listed as not filmed, g1 marked, totals with and without g1", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { SameInputAb } = await import("@/components/dash/SameInputAb");
    const row = (clipId: string, truth: AbRow["truth"], b: AbRow["armB"]["outcome"]): AbRow => ({
      clipId,
      truth,
      armA: { decision: "hold", outcome: truth === "must_hold" ? "correct_hold" : "false_hold", missingItemKeys: [], reason: "r", latencyMs: 1 },
      armB: { decision: b.includes("refund") ? "refund" : "hold", outcome: b, state: b.includes("refund") ? "AwaitingApproval" : "Held", holdCodes: [], source: "t" },
    });
    const rows = [row("g0", "must_hold", "correct_hold"), row("g1", "complete", "false_hold"), row("d1", "must_hold", "correct_hold"), row("d2", "complete", "correct_refund")];
    const rest = rows.filter((r) => r.clipId !== "g1");
    const report = {
      version: "same-input-ab/1", runId: "ab_t4", at: "2026-11-03T20:00:00.000Z", gitHash: "abc1234", promptSha256: armAPromptSha256(), model: "muse-spark-1.3", rows,
      totals: { armA: armTotals(rows, "armA"), armB: armTotals(rows, "armB") }, costUsd: { armA: 0.02, armB: 0.1 },
      notFilmed: ["g2", "g3", "g4", "g5", "g6", "g7", "g8", "d3"] as string[], calibrationClip: "g1",
      totalsWithoutCalibration: { armA: armTotals(rest, "armA"), armB: armTotals(rest, "armB") },
    } as const;
    const html = renderToStaticMarkup(createElement(SameInputAb, { report, promptSha256: armAPromptSha256() }));
    expect(html).toContain("Not filmed, so not scored: g2, g3, g4, g5, g6, g7, g8, d3");
    expect(html).toContain("can&#x27;t give a rate");
    expect(html).toContain("calibration clip: the pipeline&#x27;s item sizes were measured on it");
    expect(html).toContain("Pipeline, without g1");
    expect(report.totalsWithoutCalibration.armB).toMatchObject({ clips: 3, falseHolds: 0, wrongRefunds: 0 });
    expect(report.totals.armB).toMatchObject({ clips: 4, falseHolds: 1 });
    expect(prereg).toMatch(/## Addendum/);
  });
});
