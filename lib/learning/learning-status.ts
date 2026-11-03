/**
 * What /dashboard/evals shows under "Label reader learning", from real files and the store:
 *   the bench label set's rows by source and split (the local .data/label-set/manifest.json when this
 *   machine generated it, otherwise the committed data/label-set.manifest.json, labelled as such);
 *   reviewer corrections of label reads in the case store (0 is shown as 0);
 *   the last base-vs-adapter switch decision (.data/finetune/glimmer-decisions.jsonl), or "not run yet".
 */
import fs from "node:fs";
import path from "node:path";
import type { ReturnCase } from "@/lib/domain/case";
import committedManifest from "@/data/label-set.manifest.json";
import committedSwitch from "@/data/glimmer-switch.json";
import { MIN_EXTRA_CORRECT, MIN_HELDOUT_ROWS, MIN_TRAIN_ROWS, SWITCH_MARGIN, SWITCH_RULE_V2_TEXT } from "./glimmer-eval";
import { labelSetDir, type LabelSetManifest } from "./label-set";

export const SWITCH_RULE_LINE = `The fine-tuned adapter is used only if, on at least ${MIN_HELDOUT_ROWS} held-out rows (with at least ${MIN_TRAIN_ROWS} trained on), it beats the base on exact-serial match by at least ${SWITCH_MARGIN * 100} points and ${MIN_EXTRA_CORRECT} rows, with no more false clears; otherwise the base stays.`;
export const NOT_RUN_YET = "not run yet: needs the Glimmer deploy";

/** The committed record of switch tests (data/glimmer-switch.json, scripts/glimmer-switch-summary.ts). */
export interface SwitchHistory {
  v1: {
    ranAt: string;
    adapter: string;
    heldoutRows: number;
    base: { exactSerial: number; falseClears: number; skuMatch: number; skuRows: number };
    adapterMetrics: { exactSerial: number; falseClears: number; skuMatch: number; skuRows: number };
    useAdapter: boolean;
    failed: string[];
    ceilingFlaw: string;
    realPrintedSerials: { views: number; readable: { views: number; base: number; adapter: number }; covered: { views: number; baseTrusted: number; baseFalseClears: number; adapterTrusted: number; adapterAbstained: number } };
  };
  v2: { rule: string; preregisteredAt: string; status: string };
}
export const COMMITTED_SWITCH = committedSwitch as unknown as SwitchHistory;

export function readLabelSetManifest(dir = labelSetDir()): { manifest: LabelSetManifest; origin: "local" | "committed" } | null {
  try {
    return { manifest: JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as LabelSetManifest, origin: "local" };
  } catch {
    const m = committedManifest as unknown as LabelSetManifest;
    return m && typeof m.rows === "number" ? { manifest: m, origin: "committed" } : null;
  }
}

export interface SwitchRecord {
  at: string;
  adapter: string;
  useAdapter: boolean;
  failed: string[];
  base: { exactSerial: number; rows: number; falseClears: { total: number } };
  adapterMetrics: { exactSerial: number; rows: number; falseClears: { total: number } };
}

export function readLastSwitchDecision(file = path.join(process.cwd(), ".data", "finetune", "glimmer-decisions.jsonl")): SwitchRecord | null {
  try {
    // The last v1-shaped record (rule v2 records carry other fields and are shown from their own line).
    const recs = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((s) => s.trim())
      .map((s) => JSON.parse(s) as Partial<SwitchRecord> & { rule?: string })
      .filter((r) => r.rule !== "v2" && typeof r.base?.exactSerial === "number" && typeof r.adapterMetrics?.exactSerial === "number");
    return recs.length ? (recs[recs.length - 1] as SwitchRecord) : null;
  } catch {
    return null;
  }
}

/** Label-read corrections (serial/SKU on a Glimmer card) across the store's cases. */
export const countLabelCorrections = (cases: ReturnCase[]) => cases.reduce((n, c) => n + (c.corrections ?? []).filter((x) => (x.field === "serial" || x.field === "sku") && /glimmer/i.test(x.reader)).length, 0);

export interface LabelLearningView {
  setName: string;
  origin: "local" | "committed" | null;
  generatedAt: string | null;
  sources: Array<{ source: "sheet" | "render" | "bench"; label: string; train: number; heldout: number }>;
  total: { train: number; heldout: number };
  distinctSerials: { train: number; heldout: number; heldoutReal: string[] } | null;
  benchNote: string;
  floorsMet: boolean | null;
  corrections: number | null;
  lastResult: string;
  rule: string;
  /** v1's result on the real printed labels, readable and covered views reported separately. */
  realLabels: string | null;
  ceilingFlaw: string | null;
  ruleV2: string;
  ruleV2Status: string;
}

const SOURCE_LABEL = { sheet: "printed sheet crops", render: "re-rendered label design, new seeded serials", bench: "filmed bench clips" } as const;

export function labelLearningView(i: { manifest: LabelSetManifest | null; origin: "local" | "committed" | null; corrections: number | null; last: SwitchRecord | null; history?: SwitchHistory | null }): LabelLearningView {
  const m = i.manifest;
  const sources = (["sheet", "render", "bench"] as const).map((s) => ({ source: s, label: SOURCE_LABEL[s], train: m?.bySource[s]?.train ?? 0, heldout: m?.bySource[s]?.heldout ?? 0 }));
  const h = i.history === undefined ? COMMITTED_SWITCH : i.history;
  // A local decision log (this machine ran the test) wins; otherwise the committed record of v1.
  const last: SwitchRecord | null =
    i.last ?? (h ? { at: h.v1.ranAt, adapter: h.v1.adapter, useAdapter: h.v1.useAdapter, failed: h.v1.failed, base: { exactSerial: h.v1.base.exactSerial, rows: h.v1.heldoutRows, falseClears: { total: h.v1.base.falseClears } }, adapterMetrics: { exactSerial: h.v1.adapterMetrics.exactSerial, rows: h.v1.heldoutRows, falseClears: { total: h.v1.adapterMetrics.falseClears } } } : null);
  const r = h?.v1.realPrintedSerials;
  const realLabels = r
    ? `${r.views} held-out views of the 4 real printed serials. Readable (${r.readable.views}): base ${r.readable.base}/${r.readable.views}, adapter ${r.readable.adapter}/${r.readable.views} (its miss is an abstention, not a wrong read). Covered by a finger or paper (${r.covered.views}): the base trusted ${r.covered.baseTrusted} reads anyway (${r.covered.baseFalseClears} a false clear), the adapter abstained on ${r.covered.adapterAbstained}/${r.covered.views}.`
    : null;
  const lastResult = last
    ? `${last.useAdapter ? `adapter ${last.adapter} switched in` : `kept the base (${last.failed[0] ?? "rule not met"})`}: base ${last.base.exactSerial}/${last.base.rows} exact serials, ${last.base.falseClears.total} false clears; adapter ${last.adapterMetrics.exactSerial}/${last.adapterMetrics.rows}, ${last.adapterMetrics.falseClears.total} false clears`
    : NOT_RUN_YET;
  return {
    setName: m?.name ?? "bench label set · truth from the printed label design",
    origin: i.origin,
    generatedAt: m?.generatedAt ?? null,
    sources,
    total: { train: m?.train ?? 0, heldout: m?.heldout ?? 0 },
    distinctSerials: m?.distinctSerials ?? null,
    benchNote: m ? (m.bench.clipsFound.length ? `clips used: ${m.bench.clipsFound.join(", ")}` : "no filmed clip with a SAM recording yet; rows are added when d1–d3 land") : "not generated yet (scripts/build-label-set.ts)",
    floorsMet: m ? m.floorProblems.length === 0 : null,
    corrections: i.corrections,
    lastResult,
    rule: `v1 (used for this test): ${SWITCH_RULE_LINE}`,
    realLabels,
    ceilingFlaw: h?.v1.ceilingFlaw ?? null,
    ruleV2: SWITCH_RULE_V2_TEXT,
    ruleV2Status: h ? `pre-registered ${h.v2.preregisteredAt}; ${h.v2.status}` : "pre-registered; not yet run",
  };
}
