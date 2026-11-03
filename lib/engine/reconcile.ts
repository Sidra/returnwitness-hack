/**
 * Reconciliation: expected (packing slip) vs observed (tray counter) per line, then a
 * cross-check against a model's answer in which the model can only ever ADD a hold.
 */
import {
  HOLDING_FLAGS,
  type CountResult,
  type LineReason,
  type LineStatus,
  type ModeLabel,
  type ModelReconciliationOutput,
  type PackingSlip,
  type Policy,
  type PolicyHold,
  type Reconciliation,
  type ReconciliationLine,
  type Rma,
} from "@/lib/domain/schemas";

const RANK: Record<LineStatus, number> = { OK: 0, EXTRA: 1, HELD: 2, MISSING: 3 };
export const moreRestrictive = (a: LineStatus, b: LineStatus): LineStatus => (RANK[a] >= RANK[b] ? a : b);

const FLAG_TO_REASON = {
  merged_mask: "merged_mask",
  left_tray: "left_tray",
  label_unreadable: "label_unreadable",
  concept_conflict: "concept_conflict",
  seen_not_placed: "seen_not_placed",
} as const;

const normSerial = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

export function summarize(lines: ReconciliationLine[], rma: Rma, policyHolds: PolicyHold[] = []): Reconciliation["summary"] {
  const expectedCents = lines.reduce((s, l) => s + l.expectedQty * l.unitPriceCents, 0);
  const observedCents = lines.reduce((s, l) => s + Math.min(l.observedQty, l.expectedQty) * l.unitPriceCents, 0);
  const allClear = lines.length > 0 && lines.every((l) => l.status === "OK") && policyHolds.length === 0;
  return { expectedCents, observedCents, heldCents: allClear ? 0 : rma.requestedRefundCents, allClear };
}

export const RETURN_WINDOW_CLAUSE = "1.1";
const DAY_MS = 86_400_000;

/** The window in days, read from the policy's clause 1.1 ("… within 30 days of delivery."). Null if absent. */
export function returnWindowDays(policy: Policy): number | null {
  const c = policy.clauses.find((x) => x.id === RETURN_WINDOW_CLAUSE);
  const m = c ? /(\d+)\s*days?/i.exec(c.text) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Clause 1.1 counts from DELIVERY, and only the ship date is on record. A return opened more than the window
 * after shipping MAY be late (it is certainly late only if delivery was instant), so it HOLDS for a person to
 * check the delivery date; it is never refused here. Within the window counted from shipping, it's in time.
 */
export function returnWindowHold(rma: Rma, slip: PackingSlip, policy: Policy): PolicyHold | null {
  const limit = returnWindowDays(policy);
  const shipped = Date.parse(slip.shippedAt);
  const opened = Date.parse(rma.createdAt);
  if (limit == null || !Number.isFinite(shipped) || !Number.isFinite(opened)) return null;
  const days = Math.floor((opened - shipped) / DAY_MS);
  if (days <= limit) return null;
  return {
    code: "outside_return_window",
    clauseId: RETURN_WINDOW_CLAUSE,
    detail: `return opened ${days} days after the order shipped (${slip.shippedAt.slice(0, 10)} → ${rma.createdAt.slice(0, 10)}); clause ${RETURN_WINDOW_CLAUSE} allows ${limit} days from delivery, and the delivery date isn't on record, so a person checks it`,
  };
}

/** Deterministic reconciliation from the counter (and, given the policy, the return window). */
export function reconcile(rma: Rma, slip: PackingSlip, count: CountResult, policy?: Policy): Reconciliation {
  const lines: ReconciliationLine[] = slip.lines.map((sl) => {
    const observed = count.counts[sl.itemKey] ?? 0;
    const reasons: LineReason[] = [];
    let status: LineStatus;

    const holding = count.flags.filter((f) => HOLDING_FLAGS.has(f.code) && f.itemKeys.includes(sl.itemKey));
    for (const f of holding) {
      reasons.push({ code: FLAG_TO_REASON[f.code as keyof typeof FLAG_TO_REASON], detail: f.detail, t: f.t, ...(f.bbox ? { bbox: f.bbox } : {}) });
    }

    // Serial check on the best label read for this item.
    const arrival = count.arrivals.find((a) => a.itemKey === sl.itemKey && a.label);
    if (sl.requiresSerial && sl.serial && arrival?.label && !holding.some((f) => f.code === "label_unreadable")) {
      if (normSerial(arrival.label.text) !== normSerial(sl.serial)) {
        reasons.push({ code: "serial_mismatch", detail: `label reads "${arrival.label.text}", packing slip says "${sl.serial}"`, t: arrival.t, bbox: arrival.bbox });
      }
    }

    if (observed === sl.qty) {
      status = "OK";
      if (reasons.length === 0) reasons.push({ code: "count_match", detail: `${observed} of ${sl.qty} seen settling in the tray` });
    } else if (observed < sl.qty) {
      status = "MISSING";
      reasons.unshift({
        code: observed === 0 ? "not_observed" : "short_count",
        detail: observed === 0 ? `0 of ${sl.qty} seen in the tray during this clip` : `${observed} of ${sl.qty} seen in the tray`,
      });
    } else {
      status = "EXTRA";
      reasons.unshift({ code: "extra_observed", detail: `${observed} counted, ${sl.qty} expected` });
    }
    // Anything unresolved makes the line HELD (uncertain), which is not the same as MISSING.
    if (reasons.some((r) => r.code !== "count_match" && r.code !== "not_observed" && r.code !== "short_count" && r.code !== "extra_observed")) {
      status = "HELD";
    }

    return {
      itemKey: sl.itemKey,
      sku: sl.sku,
      description: sl.description,
      expectedQty: sl.qty,
      observedQty: observed,
      missingQty: Math.max(0, sl.qty - observed),
      status,
      reasons,
      unitPriceCents: sl.unitPriceCents,
    };
  });

  // Counted items that aren't on the slip at all.
  for (const [key, n] of Object.entries(count.counts)) {
    if (n > 0 && !slip.lines.some((l) => l.itemKey === key)) {
      lines.push({
        itemKey: key,
        sku: "—",
        description: key,
        expectedQty: 0,
        observedQty: n,
        missingQty: 0,
        status: "EXTRA",
        reasons: [{ code: "extra_observed", detail: `${n} counted, not on the packing slip` }],
        unitPriceCents: 0,
      });
    }
  }

  const late = policy ? returnWindowHold(rma, slip, policy) : null;
  const policyHolds = late ? [late] : [];
  return { rmaId: rma.id, source: "deterministic", mode: "DETERMINISTIC", lines, ...(policyHolds.length ? { policyHolds } : {}), summary: summarize(lines, rma, policyHolds) };
}

export interface CrossCheckResult {
  reconciliation: Reconciliation;
  disagreements: Array<{ itemKey: string; counter: LineStatus; model: LineStatus | "absent"; outcome: LineStatus }>;
}

/**
 * Merge the counter's reconciliation with a model's. Most restrictive wins per line; a model
 * that says OK where the counter doesn't is ignored, a model that disagrees with an OK line
 * raises a HOLD, and a missing/invalid model answer holds every line when the model is required.
 */
export function crossCheck(
  det: Reconciliation,
  model: ModelReconciliationOutput | null,
  opts: { rma: Rma; slip: PackingSlip; modelMode: ModeLabel; requireModel: boolean; readsSerials?: boolean; reader?: string },
): CrossCheckResult {
  const readsSerials = opts.readsSerials ?? true;
  const disagreements: CrossCheckResult["disagreements"] = [];
  if (!model) {
    if (!opts.requireModel) return { reconciliation: det, disagreements };
    const lines = det.lines.map((l) => ({
      ...l,
      status: moreRestrictive(l.status, "HELD"),
      reasons: [...l.reasons, { code: "model_unavailable" as const, detail: "the reconciliation model gave no valid answer; held until a person checks" }],
    }));
    for (const l of det.lines) disagreements.push({ itemKey: l.itemKey, counter: l.status, model: "absent", outcome: moreRestrictive(l.status, "HELD") });
    return { reconciliation: { ...det, source: "cross_checked", mode: opts.modelMode, lines, summary: summarize(lines, opts.rma, det.policyHolds) }, disagreements };
  }

  const lines = det.lines.map((l) => {
    const m = model.lines.find((x) => x.itemKey === l.itemKey);
    if (!m) {
      const outcome = moreRestrictive(l.status, "HELD");
      disagreements.push({ itemKey: l.itemKey, counter: l.status, model: "absent", outcome });
      return { ...l, status: outcome, reasons: [...l.reasons, { code: "model_unavailable" as const, detail: "the model's answer left this line out" }] };
    }
    const reasons = [...l.reasons];
    let status = l.status;
    const slipLine = opts.slip.lines.find((s) => s.itemKey === l.itemKey);
    if (readsSerials && slipLine?.requiresSerial && l.observedQty > 0 && !m.serialRead?.trim()) {
      status = moreRestrictive(status, "HELD");
      reasons.push({ code: "label_unreadable", detail: "the reader could not read this item's serial label" });
    } else if (m.serialRead && slipLine?.serial && normSerial(m.serialRead) !== normSerial(slipLine.serial)) {
      status = moreRestrictive(status, "HELD");
      reasons.push({ code: "serial_mismatch", detail: `model read serial "${m.serialRead}", packing slip says "${slipLine.serial}"` });
    }
    if (m.status !== l.status || m.observedQty !== l.observedQty) {
      let outcome: LineStatus;
      if (l.status === "OK") outcome = "HELD"; // the model can raise a hold on a clean line
      else outcome = moreRestrictive(l.status, m.status === "OK" ? l.status : m.status); // but never clear one
      status = moreRestrictive(status, outcome);
      disagreements.push({ itemKey: l.itemKey, counter: l.status, model: m.status, outcome: status });
      const who = opts.reader ?? "model";
      if (m.status !== "OK" && m.reasons.length) {
        // Keep the reader's own reasons (e.g. "visible damage") so the person sees why it raised the hold.
        for (const r of m.reasons) reasons.push({ code: r.code, detail: r.detail.startsWith(who) ? r.detail : `${who}: ${r.detail}` });
      } else {
        reasons.push({
          code: "model_disagrees",
          detail:
            m.status === "OK" && l.status !== "OK"
              ? `${who} said OK (${m.observedQty}); the counter's ${l.status} stands: a model can't clear a hold`
              : `${who} said ${m.status} (${m.observedQty} seen); counter said ${l.status} (${l.observedQty}). Held for a person.`,
        });
      }
    }
    return { ...l, status, reasons };
  });

  return { reconciliation: { ...det, source: "cross_checked", mode: opts.modelMode, lines, summary: summarize(lines, opts.rma, det.policyHolds) }, disagreements };
}

export interface SettlementOption {
  key: "full_hold" | "partial" | "full_refund";
  refundCents: number;
  heldCents: number;
  clause: string;
  label: string;
  /** Only a person can pick this, and full_refund on a held case needs an override reason. */
  requiresOverride: boolean;
  available: boolean;
  why: string;
}

export interface Settlement {
  requestedCents: number;
  missingCents: number;
  unclearCents: number;
  options: SettlementOption[];
  recommended: SettlementOption["key"];
}

/**
 * The settlement a person chooses from, priced from the packing-slip lines:
 *   full_hold    keep the whole refund on hold (clause 4.2 / 5.1)
 *   partial      refund the kit price less every line that isn't OK (clause 4.3)
 *   full_refund  everything (only clean returns, or a held one with an override reason)
 * The system recommends; it never picks.
 */
export function calculateSettlement(recon: Reconciliation, rma: Rma): Settlement {
  const requested = rma.requestedRefundCents;
  const missingCents = recon.lines.reduce((s, l) => s + (l.status === "MISSING" ? l.missingQty * l.unitPriceCents : 0), 0);
  const unclearCents = recon.lines.reduce((s, l) => s + (l.status === "HELD" || l.status === "EXTRA" ? Math.max(1, l.expectedQty) * l.unitPriceCents : 0), 0);
  const notOk = Math.min(requested, missingCents + unclearCents);
  const clean = recon.summary.allClear;
  const options: SettlementOption[] = [
    {
      key: "full_hold",
      refundCents: 0,
      heldCents: requested,
      clause: clean ? "5.1" : "4.2",
      label: "Keep the full refund on hold",
      requiresOverride: false,
      available: true,
      why: "Nothing is refunded; the customer is told what wasn't observed and can respond (clause 5.1).",
    },
    {
      key: "partial",
      refundCents: requested - notOk,
      heldCents: notOk,
      clause: "4.3",
      label: "Refund what was seen, hold the rest",
      requiresOverride: false,
      available: !clean && notOk > 0 && notOk < requested,
      why: unclearCents ? "Kit price less every line that is missing or unclear." : "Kit price less the list price of each missing component (clause 4.3).",
    },
    {
      key: "full_refund",
      refundCents: requested,
      heldCents: 0,
      clause: "4.2",
      label: clean ? "Refund in full" : "Refund in full anyway (override)",
      requiresOverride: !clean,
      available: true,
      why: clean ? "Every component on the packing slip was seen (clause 4.2)." : "Overrides the hold; needs a written reason on the record.",
    },
  ];
  // Never recommend an option the person can't pick: with nothing clear in the tray, partial is unavailable.
  const partialOpen = options.find((o) => o.key === "partial")!.available;
  return { requestedCents: requested, missingCents, unclearCents, options, recommended: clean ? "full_refund" : missingCents && !unclearCents && partialOpen ? "partial" : "full_hold" };
}

/** What a person may approve: the full refund, or the settlement's partial amount. */
export function refundBounds(recon: Reconciliation, rma: Rma): { fullCents: number; partialCents: number } {
  const st = calculateSettlement(recon, rma);
  return { fullCents: st.requestedCents, partialCents: st.options.find((o) => o.key === "partial")!.refundCents };
}

/**
 * A reader is any independent model that re-reads the evidence and returns the
 * reconciliation contract (Muse Spark today; a second reader on Meta open weights can be
 * added later). Readers are folded in one at a time, so each can only raise holds.
 */
export interface ReaderAnswer {
  reader: string;
  mode: ModeLabel;
  output: ModelReconciliationOutput | null;
  required: boolean;
  /** False for readers that don't read serial labels (their null serialRead isn't a hold). */
  readsSerials?: boolean;
}

export function crossCheckReaders(det: Reconciliation, readers: ReaderAnswer[], ctx: { rma: Rma; slip: PackingSlip }): CrossCheckResult & { perReader: Record<string, CrossCheckResult["disagreements"]> } {
  let current = det;
  const all: CrossCheckResult["disagreements"] = [];
  const perReader: Record<string, CrossCheckResult["disagreements"]> = {};
  for (const r of readers) {
    const res = crossCheck(current, r.output, { ...ctx, modelMode: r.mode, requireModel: r.required, readsSerials: r.readsSerials, reader: r.reader });
    perReader[r.reader] = res.disagreements;
    all.push(...res.disagreements);
    current = res.reconciliation;
  }
  // The result's mode is the weakest provenance among readers that answered.
  const order: ModeLabel[] = ["RECORDED_FIXTURE", "LIVE_OPEN_WEIGHTS", "LIVE_META", "DETERMINISTIC"];
  const answered = readers.filter((r) => r.output).map((r) => r.mode);
  const mode = answered.length ? order.find((m) => answered.includes(m))! : det.mode;
  return { reconciliation: { ...current, mode }, disagreements: all, perReader };
}
