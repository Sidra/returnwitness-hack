/**
 * One run record for every number. Outward docs may only quote dollar figures derivable from the
 * kit file and the price list, and Stripe ids that exist in evidence.json.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { INSPECTION_FEE_CENTS } from "@/lib/payments/stripe-rail";
import { readEvidence } from "@/lib/obs/evidence";
import { WALKER } from "@/lib/play/scenarios";
import measuredJson from "@/data/measured-calls.json";
import { shiftCapacity } from "@/lib/scale/capacity";
import type { MeasuredCalls } from "@/lib/scale/measured";
import { MODAL_GPU_USD_PER_HOUR, quoteColdInspection, quoteGlimmerFineTune } from "@/lib/learning/glimmer-eval";

const root = path.resolve(__dirname, "..");
// The outward docs this checkout has: markdown at the root and one folder down (hidden folders, dependencies, build
// output, the data/eval/label folders and *-log.md diaries aside; deeper folders hold decision records, not outward copy).
const SKIP = new Set(["node_modules", "data", "gate", "evals", "labels", "modal", "tests", "public"]);
const docs = fs.readdirSync(root, { withFileTypes: true }).flatMap((e) =>
  e.isFile() && e.name.endsWith(".md") ? [e.name] : e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) ? fs.readdirSync(path.join(root, e.name)).filter((f) => f.endsWith(".md") && !/-log\.md$/.test(f)).map((f) => `${e.name}/${f}`) : [],
);

const cents = (n: number) => [`$${(n / 100).toFixed(2)}`, `$${n % 100 === 0 ? n / 100 : (n / 100).toFixed(2)}`];
const lens = KIT.items.find((i) => i.key === "lens")!;
const measured = measuredJson as MeasuredCalls;
const cap = shiftCapacity(measured);
const callUsd = (model: string) => measured.models.find((m) => m.model === model)!.costUsd.p50;
const allowed = new Set<string>([
  ...cents(KIT_TOTAL_CENTS),
  ...KIT.items.flatMap((i) => cents(i.unitPriceCents)),
  ...cents(KIT_TOTAL_CENTS - lens.unitPriceCents), // policy 4.3 partial
  ...cents(INSPECTION_FEE_CENTS),
  "$0.00", "$0", // the full-hold option refunds nothing
  // Meta list prices (per 1M tokens / per 1k frames) and the SAM arithmetic: 75 frames × 6 concepts × $0.20/1k
  "$0.20", "$1.25", "$4.25", "$4.00", "$20.00", "$0.09", "$0.15", "$0.045",
  // /play/walker's illustrative loan record (lib/play/scenarios.ts): part prices, the deposit, and deposit less one tip.
  ...WALKER.items.flatMap((i) => cents(i.unitPriceCents)),
  ...cents(WALKER.rma.requestedRefundCents),
  ...cents(WALKER.rma.requestedRefundCents - WALKER.items[1].unitPriceCents),
  // Logged live-call costs (data/measured-calls.json) and the scale arithmetic on them (lib/scale/capacity.ts).
  `$${callUsd("muse-spark-1.3").toFixed(3)}`,
  `$${callUsd("muse-wonder-1.0").toFixed(3)}`,
  `$${(0.09 + callUsd("muse-spark-1.3") + callUsd("muse-wonder-1.0")).toFixed(2)}`, // per inspection at the pricing page's 15 s clip
  `$${cap.usdPerBox.total.toFixed(2)}`,
  `$${Math.round(cap.usdPerDay)}`,
  // Example routing rule on /onboarding ("kits over $150 go to the bench"): a setting, not a measurement.
  "$150",
  // Modal L40S list price and the Muse Glimmer quotes, computed by lib/learning/glimmer-eval.ts (estimates, labelled so in the docs).
  `$${MODAL_GPU_USD_PER_HOUR.L40S}`,
  `$${quoteColdInspection().usd.toFixed(2)}`,
  `$${quoteGlimmerFineTune({ trainRows: 160, heldoutRows: 40, epochs: 3 }).usd.toFixed(2)}`,
]);

describe("evidence drift", () => {
  it("the current demo run record matches the kit", () => {
    const ev = readEvidence(path.join(root, "evidence.json"));
    const id = ev.current.demo;
    if (!id) return; // no run recorded yet
    const run = ev.runs.find((r) => r.runId === id)!;
    expect(run.summary.heldCents).toBe(KIT_TOTAL_CENTS);
    expect(run.summary.refundCents).toBe(KIT_TOTAL_CENTS);
    expect(run.summary.feeCents).toBe(INSPECTION_FEE_CENTS);
    expect(run.summary.replayStatus).not.toBe(200);
    if (run.summary.partialRefundCents !== undefined) {
      expect(run.summary.partialRefundCents).toBe(KIT_TOTAL_CENTS - lens.unitPriceCents);
      expect(run.summary.partialHeldCents).toBe(lens.unitPriceCents);
    }
  });

  it.each(docs)("%s quotes only derivable dollar figures", (f) => {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    const found = [...text.matchAll(/\$\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
    const stray = [...new Set(found.filter((x) => !allowed.has(x)))];
    expect(stray).toEqual([]);
  });

  it.each(docs)("%s quotes only Stripe ids from evidence.json", (f) => {
    const text = fs.readFileSync(path.join(root, f), "utf8");
    const ev = JSON.stringify(readEvidence(path.join(root, "evidence.json")));
    const ids = [...text.matchAll(/\b(re|pi|ch|evt)_[A-Za-z0-9]{10,}/g)].map((m) => m[0]);
    expect(ids.filter((i) => !ev.includes(i))).toEqual([]);
  });
});
