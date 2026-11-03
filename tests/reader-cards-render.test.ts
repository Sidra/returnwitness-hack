/**
 * Each reader card renders its own answer's shape: the label reader's `legible` is not the auditor's `labelLegible`
 * (a legible Glimmer read once showed as "not legible"), and a reconcile reader (Muse Spark) shows its per-line read.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReaderCards } from "@/components/dash/ReaderCards";
import type { ReaderRun } from "@/lib/domain/case";

const base = { required: false, ok: true, latencyMs: 1000, mode: "LIVE_META" as const };
const text = (runs: ReaderRun[]) => renderToStaticMarkup(createElement(ReaderCards, { runs })).replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "");

describe("reader cards", () => {
  it("the label reader's legible read shows as legible, with the serial and confidence", () => {
    const t = text([{ ...base, reader: "muse-glimmer (modal)", model: "glimmer", mode: "LIVE_OPEN_WEIGHTS", extras: { items: [{ itemKey: "camera_body", serialRead: "BW-CB-55107", skuRead: null, legible: true, confidence: 0.95 }] } }]);
    expect(t).toContain("camera_body · serial BW-CB-55107 · label legible");
    expect(t).toContain("confidence 0.95");
    expect(t).not.toContain("not legible");
  });

  it("the auditor's items keep their own fields", () => {
    const t = text([{ ...base, reader: "muse-spark-open (baseten)", model: "m", mode: "LIVE_OPEN_WEIGHTS", extras: { items: [{ itemKey: "battery", labelLegible: false, visibleDamage: false, standInSuspected: false, note: "blurry" }] } }]);
    expect(t).toContain("battery · label not legible · no damage seen · matches the slip");
  });

  it("a reconcile reader shows its own per-line answer", () => {
    const t = text([{ ...base, reader: "muse-spark-1.3", model: "muse-spark-1.3", lines: [{ itemKey: "camera_body", status: "OK", observedQty: 1, serialRead: "BW-CB-55107" }, { itemKey: "lens", status: "MISSING", observedQty: 0 }] }]);
    expect(t).toContain("camera_body · OK (1) · serial BW-CB-55107");
    expect(t).toContain("lens · MISSING (0)");
  });
});
