import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { calculateSettlement, crossCheck, crossCheckReaders, reconcile, refundBounds } from "@/lib/engine/reconcile";
import { templateDraft, validateDraft } from "@/lib/engine/decision";
import type { CountResult, ModelReconciliationOutput } from "@/lib/domain/schemas";

const rma = RMAS[0];
const slip = ORDERS[0].slip;
const serial = (k: string) => slip.lines.find((l) => l.itemKey === k)?.serial ?? "";

function count(counts: Record<string, number>, extra: Partial<CountResult> = {}): CountResult {
  return {
    clipId: "c",
    counts,
    arrivals: Object.entries(counts).flatMap(([k, n]) =>
      Array.from({ length: n }, (_, i) => ({ slotId: `${k}-${i}`, itemKey: k, t: 1, frameIndex: 5, bbox: [0.6, 0.2, 0.1, 0.1] as [number, number, number, number], area: 0.01, ...(serial(k) ? { label: { text: serial(k), confidence: 0.9 } } : {}) })),
    ),
    flags: [],
    diagnostics: { framesProcessed: 10, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 },
    ...extra,
  };
}

const allOk: ModelReconciliationOutput = {
  lines: slip.lines.map((l) => ({ itemKey: l.itemKey, observedQty: 1, status: "OK", reasons: [], serialRead: l.serial ?? null })),
  notes: "",
};

describe("reconcile (deterministic)", () => {
  it("all present → every line OK, nothing held", () => {
    const r = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    expect(r.lines.map((l) => l.status)).toEqual(["OK", "OK", "OK"]);
    expect(r.summary).toMatchObject({ allClear: true, heldCents: 0, expectedCents: 34000, observedCents: 34000 });
  });

  it("lens missing → MISSING line, the whole $340 held", () => {
    const r = reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 }));
    const lens = r.lines.find((l) => l.itemKey === "lens")!;
    expect(lens).toMatchObject({ status: "MISSING", missingQty: 1, observedQty: 0 });
    expect(lens.reasons[0].code).toBe("not_observed");
    expect(r.summary).toMatchObject({ allClear: false, heldCents: 34000, observedCents: 23100 });
  });

  it("a holding counter flag makes the line HELD even when the count matches", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 }, { flags: [{ code: "label_unreadable", itemKeys: ["lens"], t: 2, frameIndex: 10, detail: "blurry" }] });
    const lens = reconcile(rma, slip, c).lines.find((l) => l.itemKey === "lens")!;
    expect(lens.status).toBe("HELD");
    expect(lens.reasons.map((r) => r.code)).toContain("label_unreadable");
  });

  it("merged mask with a zero count is HELD (uncertain), not MISSING", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 0 }, { flags: [{ code: "merged_mask", itemKeys: ["camera_body", "battery"], t: 2, frameIndex: 10, detail: "merged" }] });
    const r = reconcile(rma, slip, c);
    expect(r.lines.find((l) => l.itemKey === "battery")!.status).toBe("HELD");
    expect(r.lines.find((l) => l.itemKey === "camera_body")!.status).toBe("HELD");
  });

  it("informational flags (reentry_rebound) don't hold", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 }, { flags: [{ code: "reentry_rebound", itemKeys: ["lens"], t: 2, frameIndex: 10, detail: "put back" }] });
    expect(reconcile(rma, slip, c).summary.allClear).toBe(true);
  });

  it("a serial that doesn't match the packing slip → HELD serial_mismatch", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 });
    c.arrivals.find((a) => a.itemKey === "camera_body")!.label = { text: "BW-CB-99999", confidence: 0.95 };
    const cam = reconcile(rma, slip, c).lines.find((l) => l.itemKey === "camera_body")!;
    expect(cam.status).toBe("HELD");
    expect(cam.reasons.some((r) => r.code === "serial_mismatch")).toBe(true);
  });

  it("serial comparison ignores punctuation and case", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 });
    c.arrivals.find((a) => a.itemKey === "camera_body")!.label = { text: serial("camera_body").toLowerCase().replace(/-/g, " "), confidence: 0.95 };
    expect(reconcile(rma, slip, c).summary.allClear).toBe(true);
  });

  it("over-count → EXTRA, which also blocks a clean approval", () => {
    const r = reconcile(rma, slip, count({ camera_body: 2, lens: 1, battery: 1 }));
    expect(r.lines.find((l) => l.itemKey === "camera_body")!.status).toBe("EXTRA");
    expect(r.summary.allClear).toBe(false);
  });

  it("an item not on the slip becomes an EXTRA line", () => {
    const r = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1, tripod: 1 }));
    expect(r.lines.at(-1)).toMatchObject({ itemKey: "tripod", status: "EXTRA", expectedQty: 0 });
  });

  it("policy 4.3 partial = kit price less each missing component", () => {
    const r = reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 }));
    expect(refundBounds(r, rma)).toEqual({ fullCents: 34000, partialCents: 23100 });
  });
});

describe("calculateSettlement", () => {
  it("lens missing: full hold $340 vs partial $231 refundable / $109 held; partial recommended", () => {
    const st = calculateSettlement(reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 })), rma);
    const o = Object.fromEntries(st.options.map((x) => [x.key, x]));
    expect(o.full_hold).toMatchObject({ refundCents: 0, heldCents: 34000, available: true });
    expect(o.partial).toMatchObject({ refundCents: 23100, heldCents: 10900, clause: "4.3", available: true });
    expect(o.full_refund).toMatchObject({ refundCents: 34000, requiresOverride: true });
    expect(st.recommended).toBe("partial");
  });
  it("complete kit: full refund recommended, no partial", () => {
    const st = calculateSettlement(reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 })), rma);
    expect(st.recommended).toBe("full_refund");
    expect(st.options.find((o) => o.key === "partial")!.available).toBe(false);
    expect(st.options.find((o) => o.key === "full_refund")!.requiresOverride).toBe(false);
  });
  it("an unclear (HELD) line is excluded from the partial and the recommendation is to keep holding", () => {
    const c = count({ camera_body: 1, lens: 1, battery: 1 }, { flags: [{ code: "label_unreadable", itemKeys: ["lens"], t: 2, frameIndex: 10, detail: "blurry" }] });
    const st = calculateSettlement(reconcile(rma, slip, c), rma);
    expect(st.options.find((o) => o.key === "partial")!.refundCents).toBe(23100);
    expect(st.recommended).toBe("full_hold");
  });
  it("everything missing: no partial option", () => {
    const st = calculateSettlement(reconcile(rma, slip, count({ camera_body: 0, lens: 0, battery: 0 })), rma);
    expect(st.options.find((o) => o.key === "partial")!.available).toBe(false);
  });
});

describe("cross-check: a model can raise a hold, never clear one", () => {
  const opts = { rma, slip, modelMode: "LIVE_META" as const, requireModel: true };

  it("model agrees → unchanged, no disagreements", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const x = crossCheck(det, allOk, opts);
    expect(x.reconciliation.summary.allClear).toBe(true);
    expect(x.disagreements).toEqual([]);
  });

  it("model says OK where the counter says MISSING → still MISSING", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 }));
    const x = crossCheck(det, allOk, opts);
    const lens = x.reconciliation.lines.find((l) => l.itemKey === "lens")!;
    expect(lens.status).toBe("MISSING");
    expect(lens.reasons.at(-1)!.detail).toMatch(/can't clear a hold/);
    expect(x.reconciliation.summary.allClear).toBe(false);
  });

  it("model says MISSING where the counter says OK → HELD for a person", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const m: ModelReconciliationOutput = { ...allOk, lines: allOk.lines.map((l) => (l.itemKey === "battery" ? { ...l, observedQty: 0, status: "MISSING" } : l)) };
    const x = crossCheck(det, m, opts);
    expect(x.reconciliation.lines.find((l) => l.itemKey === "battery")!.status).toBe("HELD");
    expect(x.disagreements).toEqual([{ itemKey: "battery", counter: "OK", model: "MISSING", outcome: "HELD" }]);
  });

  it("no model answer when the model is required → every line HELD model_unavailable", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const x = crossCheck(det, null, opts);
    expect(x.reconciliation.lines.every((l) => l.status === "HELD")).toBe(true);
    expect(x.reconciliation.summary.allClear).toBe(false);
  });

  it("no model answer when not required → deterministic result stands", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    expect(crossCheck(det, null, { ...opts, requireModel: false }).reconciliation).toBe(det);
  });

  it("model leaves a line out → that line HELD", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const x = crossCheck(det, { ...allOk, lines: allOk.lines.slice(0, 2) }, opts);
    expect(x.reconciliation.lines.find((l) => l.itemKey === "battery")!.status).toBe("HELD");
  });

  it("model reads a different serial → HELD serial_mismatch", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const m = { ...allOk, lines: allOk.lines.map((l) => (l.itemKey === "lens" ? { ...l, serialRead: "BW-LN-00000" } : l)) };
    expect(crossCheck(det, m, opts).reconciliation.lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");
  });

  it("a required serial the reader couldn't read → HELD label_unreadable", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const m = { ...allOk, lines: allOk.lines.map((l) => (l.itemKey === "camera_body" ? { ...l, serialRead: null } : l)) };
    const cam = crossCheck(det, m, opts).reconciliation.lines.find((l) => l.itemKey === "camera_body")!;
    expect(cam.status).toBe("HELD");
    expect(cam.reasons.some((r) => r.code === "label_unreadable")).toBe(true);
  });

  it("an item without a serial needs no read", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    expect(crossCheck(det, allOk, opts).reconciliation.lines.find((l) => l.itemKey === "battery")!.status).toBe("OK");
  });

  it("two readers fold: the second can add a hold the first didn't, neither can remove one", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 }));
    const second: ModelReconciliationOutput = { ...allOk, lines: allOk.lines.map((l) => (l.itemKey === "camera_body" ? { ...l, status: "HELD", observedQty: 1 } : l)) };
    const x = crossCheckReaders(
      det,
      [
        { reader: "spark", mode: "LIVE_META", output: allOk, required: true },
        { reader: "open-weights", mode: "LIVE_META", output: second, required: false },
      ],
      { rma, slip },
    );
    const st = Object.fromEntries(x.reconciliation.lines.map((l) => [l.itemKey, l.status]));
    expect(st).toEqual({ camera_body: "HELD", lens: "MISSING", battery: "OK" });
    expect(Object.keys(x.perReader)).toEqual(["spark", "open-weights"]);
  });

  it("the combined mode reports the weakest provenance (a replayed answer is never shown as live)", () => {
    const det = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
    const x = crossCheckReaders(det, [{ reader: "spark", mode: "LIVE_META", output: allOk, required: true }, { reader: "recorded", mode: "RECORDED_FIXTURE", output: allOk, required: false }], { rma, slip });
    expect(x.reconciliation.mode).toBe("RECORDED_FIXTURE");
  });
});

describe("decision drafts: cite the clause, never authorise", () => {
  const held = reconcile(rma, slip, count({ camera_body: 1, lens: 0, battery: 1 }));
  const clean = reconcile(rma, slip, count({ camera_body: 1, lens: 1, battery: 1 }));
  const c42 = POLICY.clauses.find((c) => c.id === "4.2")!;

  it("template on a missing lens: HOLD, cites 4.2 and 4.3 verbatim, proposes the partial", () => {
    const d = templateDraft({ policy: POLICY, recon: held, rma });
    expect(d.recommendation).toBe("HOLD");
    expect(d.citedClauses.map((c) => c.clauseId)).toEqual(["4.2", "4.3"]);
    expect(d.proposedRefundCents).toBe(23100);
    expect(validateDraft(d, { policy: POLICY, recon: held, rma }).ok).toBe(true);
  });

  it("template on a complete kit: APPROVE_FULL citing 4.2, still needs a person", () => {
    const d = templateDraft({ policy: POLICY, recon: clean, rma });
    expect(d).toMatchObject({ recommendation: "APPROVE_FULL", proposedRefundCents: 34000 });
    expect(d.rationale).toMatch(/once a person approves/);
  });

  it("rejects a draft citing a clause that doesn't exist", () => {
    const v = validateDraft({ recommendation: "HOLD", proposedRefundCents: 0, citedClauses: [{ clauseId: "9.9", quote: "x" }], rationale: "r" }, { policy: POLICY, recon: held, rma });
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/9\.9/);
  });

  it("rejects a misquoted clause", () => {
    const v = validateDraft({ recommendation: "HOLD", proposedRefundCents: 0, citedClauses: [{ clauseId: "4.2", quote: "kits are always refunded" }], rationale: "r" }, { policy: POLICY, recon: held, rma });
    expect(v.errors.join()).toMatch(/not verbatim/);
  });

  it("accepts a verbatim quote with different whitespace and curly quotes", () => {
    const quote = `  ${c42.text.replace(/ /g, "  ")}`;
    expect(validateDraft({ recommendation: "HOLD", proposedRefundCents: 0, citedClauses: [{ clauseId: "4.2", quote }], rationale: "r" }, { policy: POLICY, recon: held, rma }).ok).toBe(true);
  });

  it("rejects APPROVE while a line is not OK, whatever the model says", () => {
    const v = validateDraft({ recommendation: "APPROVE_FULL", proposedRefundCents: 34000, citedClauses: [{ clauseId: "4.2", quote: c42.text }], rationale: "r" }, { policy: POLICY, recon: held, rma });
    expect(v.errors.join()).toMatch(/only HOLD/);
  });

  it("rejects proposing more than the RMA", () => {
    const v = validateDraft({ recommendation: "APPROVE_FULL", proposedRefundCents: 99999, citedClauses: [{ clauseId: "4.2", quote: c42.text }], rationale: "r" }, { policy: POLICY, recon: clean, rma });
    expect(v.errors.join()).toMatch(/more than/);
  });

  it("rejects a malformed draft (no citation)", () => {
    expect(validateDraft({ recommendation: "HOLD", proposedRefundCents: 0, citedClauses: [], rationale: "r" }, { policy: POLICY, recon: held, rma }).ok).toBe(false);
  });
});

describe("settlement recommendation is always an available option", () => {
  it("an empty tray (everything missing) recommends holding, not an unavailable partial", async () => {
    const { calculateSettlement, reconcile } = await import("@/lib/engine/reconcile");
    const { ORDERS, RMAS } = await import("@/data/fixtures");
    const empty = { clipId: "empty", counts: { camera_body: 0, lens: 0, battery: 0 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } };
    const st = calculateSettlement(reconcile(RMAS[1], ORDERS[1].slip, empty), RMAS[1]);
    expect(st.options.find((o) => o.key === "partial")!.available).toBe(false);
    expect(st.recommended).toBe("full_hold");
    for (const counts of [{ camera_body: 1, lens: 0, battery: 1 }, { camera_body: 1, lens: 1, battery: 1 }]) {
      const s = calculateSettlement(reconcile(RMAS[1], ORDERS[1].slip, { ...empty, counts }), RMAS[1]);
      expect(s.options.find((o) => o.key === s.recommended)!.available).toBe(true);
    }
  });
});

describe("return window (clause 1.1) is a case-level hold for a person", () => {
  const counts = { camera_body: 1, lens: 1, battery: 1 };
  const base = { clipId: "w", counts, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } };
  it("reads the limit from the clause, holds only past it (counted from shipping), and never touches the lines", async () => {
    const { reconcile, returnWindowDays, returnWindowHold, calculateSettlement } = await import("@/lib/engine/reconcile");
    const { ORDERS, POLICY, RMAS } = await import("@/data/fixtures");
    expect(returnWindowDays(POLICY)).toBe(30);
    const slip = ORDERS[1].slip;
    const at = (days: number) => ({ ...RMAS[1], createdAt: new Date(Date.parse(slip.shippedAt) + days * 86_400_000).toISOString() });
    expect(returnWindowHold(at(30), slip, POLICY)).toBeNull(); // the 30th day is still in time
    const late = returnWindowHold(at(31), slip, POLICY);
    expect(late).toMatchObject({ code: "outside_return_window", clauseId: "1.1" });
    expect(late!.detail).toMatch(/delivery date isn't on record/);
    const onTime = reconcile(at(10), slip, base, POLICY);
    const lateRecon = reconcile(at(43), slip, base, POLICY);
    expect(onTime.summary.allClear).toBe(true);
    expect(lateRecon.lines).toEqual(onTime.lines);
    expect(lateRecon.summary.allClear).toBe(false);
    const st = calculateSettlement(lateRecon, at(43));
    expect(st.recommended).toBe("full_hold");
    expect(st.options.find((o) => o.key === "full_refund")!.requiresOverride).toBe(true);
    // Without the policy (older callers), nothing changes.
    expect(reconcile(at(43), slip, base).summary.allClear).toBe(true);
  });

  it("a model reader can't clear a window hold", async () => {
    const { reconcile, crossCheckReaders } = await import("@/lib/engine/reconcile");
    const { ORDERS, POLICY, RMAS } = await import("@/data/fixtures");
    const slip = ORDERS[1].slip;
    const rma = { ...RMAS[1], createdAt: new Date(Date.parse(slip.shippedAt) + 50 * 86_400_000).toISOString() };
    const det = reconcile(rma, slip, base, POLICY);
    const allOk = { lines: det.lines.map((l) => ({ itemKey: l.itemKey, observedQty: l.expectedQty, status: "OK" as const, reasons: [], serialRead: l.itemKey === "camera_body" || l.itemKey === "lens" ? (slip.lines.find((s) => s.itemKey === l.itemKey)?.serial ?? null) : null })) };
    const x = crossCheckReaders(det, [{ reader: "muse-spark-1.3", mode: "LIVE_META", output: allOk as never, required: true }], { rma, slip });
    expect(x.reconciliation.policyHolds?.[0]?.code).toBe("outside_return_window");
    expect(x.reconciliation.summary.allClear).toBe(false);
  });

  it("the template draft holds and cites clause 1.1 when every item is present but the window may be past", async () => {
    const { reconcile } = await import("@/lib/engine/reconcile");
    const { templateDraft, validateDraft } = await import("@/lib/engine/decision");
    const { ORDERS, POLICY, RMAS } = await import("@/data/fixtures");
    const slip = ORDERS[1].slip;
    const rma = { ...RMAS[1], createdAt: new Date(Date.parse(slip.shippedAt) + 45 * 86_400_000).toISOString() };
    const recon = reconcile(rma, slip, base, POLICY);
    const d = templateDraft({ policy: POLICY, recon, rma });
    expect(d.recommendation).toBe("HOLD");
    expect(d.citedClauses.map((c) => c.clauseId)).toContain("1.1");
    expect(validateDraft(d, { policy: POLICY, recon, rma }).ok).toBe(true);
  });
});
