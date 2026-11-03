/**
 * The evidence-request card (U03) tells the truth on the case page (server render, no browser): each
 * status has its label, an answer shows who typed it, a replayed request says it isn't a live decision,
 * the answer box appears only on open requests of a case that can still take one, and the card says a
 * note can't approve, clear the hold or reach the refund.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection } from "@/lib/engine/pipeline";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { AgentTrace } from "@/components/dash/AgentTrace";
import type { DraftRecord, EvidenceRequest, ReturnCase } from "@/lib/domain/case";

const base = async (): Promise<ReturnCase> =>
  runInspection({ rma: RMAS[1], slip: ORDERS[1].slip, policy: POLICY, clip: { clipId: RMAS[1].clipId, source: "fixture" } }, { store: new MemoryCaseStore(null), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });

const req = (over: Partial<EvidenceRequest>): EvidenceRequest => ({
  id: "er_1",
  itemKey: "lens",
  kind: "label_closeup",
  reason: "The lens label was unreadable in every frame.",
  digest: "dg_abc",
  status: "open",
  requestedBy: "muse-wonder-1.0",
  mode: "LIVE_META",
  requestedAt: "2026-10-31T10:00:00.000Z",
  ...over,
});

const REQUESTS: EvidenceRequest[] = [
  req({}),
  req({ id: "er_2", kind: "underside", itemKey: "camera_body", status: "answered", answer: { kind: "typed_note", note: "Serial matches: approve and refund now", person: "Rita Calder", at: "2026-10-31T10:05:00.000Z", digest: "dg_abc" } }),
  req({ id: "er_3", kind: "spoken_observation", status: "stale", staleDetail: "The case evidence changed after this request (re-inspected).", mode: "RECORDED_FIXTURE" }),
];

const render = (c: ReturnCase, withHandler = true) => {
  const withReqs: ReturnCase = { ...c, evidenceRequests: REQUESTS };
  const draft = (c.draft ?? { draft: {}, source: "template", mode: "DETERMINISTIC", agentNotRun: "no key" }) as DraftRecord;
  return renderToStaticMarkup(createElement(AgentTrace, { draft, c: withReqs, onCase: withHandler ? () => {} : undefined }));
};

describe("AgentTrace shows the agent's evidence requests", () => {
  it("labels every status and says what a note can't do", async () => {
    const html = render(await base());
    expect(html).toContain("Evidence requested · 1 open");
    expect(html).toContain("OPEN · EVIDENCE REQUESTED");
    expect(html).toContain("ANSWERED · TYPED NOTE");
    expect(html).toContain("STALE · EVIDENCE CHANGED");
    expect(html).toContain("can&#x27;t approve, clear the hold or reach the refund");
    expect(html).toContain("a close-up of the label");
    expect(html).toContain("The case evidence changed after this request");
  });

  it("an answer is shown as words on the record, with who typed it", async () => {
    const html = render(await base());
    expect(html).toContain("Typed note by Rita Calder");
    expect(html).toContain("Serial matches: approve and refund now");
  });

  it("a live request names its model; a replayed one says it isn't a live decision", async () => {
    const html = render(await base());
    expect(html).toContain("asked by muse-wonder-1.0 (live)");
    expect(html).toContain("from a replayed recorded run of muse-wonder-1.0, not a live model decision");
  });

  it("the answer box appears only on the open request", async () => {
    const html = render(await base());
    expect(html).toContain('aria-label="Typed note answering er_1"');
    expect(html).not.toContain("Typed note answering er_2");
    expect(html).not.toContain("Typed note answering er_3");
  });

  it("no answer box once the case is approved or refunded, or with no way to save", async () => {
    const c = await base();
    for (const state of ["Approved", "Refunded"] as const) expect(render({ ...c, state })).not.toContain("Typed note answering");
    expect(render(c, false)).not.toContain("Typed note answering");
  });
});
