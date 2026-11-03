/**
 * Contract test of the LIVE wiring against the local mock (scripts/mock-meta/server.mjs):
 * clip → 5 fps/720p → SAM adapter (files + responses, per concept, parallel) → parser → counter →
 * Spark reader (key frames + crops from the full-res clip) → Wonder drafter → validation.
 *   node scripts/mock-meta/server.mjs &   npx tsx scripts/check-live-path.ts <clip.mp4>
 * Uses a throwaway clip id and never touches the real Meta API.
 */
process.env.META_HACK_API_KEY = "mock-key";
process.env.META_BASE_URL = `http://localhost:${process.env.MOCK_META_PORT ?? 3799}/v1`;
process.env.RETURNWITNESS_STORE = "memory";
process.env.RETURNWITNESS_OPENWEIGHT_PROVIDER = "baseten";
process.env.BASETEN_API_KEY = "mock-key";
process.env.BASETEN_BASE_URL = process.env.META_BASE_URL;
// Mock calls must never reach the spend log or the committed recordings.
process.env.RETURNWITNESS_LLM_LOG = "/tmp/rw-live-check/llm-calls.jsonl";
process.env.RETURNWITNESS_RECORDINGS_DIR = "/tmp/rw-live-check/recordings";

async function main() {
  const clip = process.argv[2];
  if (!clip) throw new Error("usage: check-live-path.ts <clip>");
  const { pipelineDeps, liveEvidenceImages, POLICY, rmaById, orderFor } = await import("../lib/runtime");
  const { runInspection } = await import("../lib/engine/pipeline");
  const { prepareClip } = await import("../lib/vision/prepare-clip");
  const rma = rmaById("RMA-20419")!;
  const order = orderFor(rma.orderId)!;
  const prepared = prepareClip(clip, "/tmp/rw-live-check");
  const deps = pipelineDeps({ liveModels: true, liveSegmentation: true }, (e) => {
    if (e.status === "end") console.log(`  ${e.stage} ${e.ms ?? ""} ${e.mode ?? ""}`);
  });
  deps.evidenceImages = liveEvidenceImages(clip);
  const c = await runInspection({ rma, slip: order.slip, policy: POLICY, clip: { clipId: "live-contract-check", source: "camera", videoPath: prepared.path } }, deps);
  console.log(
    JSON.stringify(
      {
        state: c.state,
        segMode: c.clip.mode,
        counts: c.count?.counts,
        flags: c.count?.flags.map((f) => f.code),
        recon: c.reconciliation?.lines.map((l) => `${l.itemKey}:${l.status}`),
        reconMode: c.reconciliation?.mode,
        draft: c.draft && { source: c.draft.source, mode: c.draft.mode, rec: c.draft.draft.recommendation, rejected: c.draft.rejected },
        agent: c.draft?.agent && { protocol: c.draft.agent.protocol, effect: c.draft.agent.effect, steps: c.draft.agent.steps.map((x) => `${x.kind}:${x.name ?? ""}${x.verdict ? `=${x.verdict.accepted ? "accepted" : "rejected"}` : ""}`) },
        holdReasons: c.holdReasons,
        errors: c.audit.filter((a) => a.event === "ERROR").map((a) => a.detail),
        readers: c.readerRuns?.map((r) => `${r.reader}:${r.ok ? "ok" : r.error}`),
        battery: c.reconciliation?.lines.find((l) => l.itemKey === "battery")?.reasons.map((r) => `${r.code}: ${r.detail}`),
      },
      null,
      1,
    ),
  );
  const calls = await (await fetch(`http://localhost:${process.env.MOCK_META_PORT ?? 3799}/__calls`, { headers: { authorization: "Bearer mock-key" } })).json();
  console.log("calls:", (calls as string[]).join(" | "));
}

main().catch((e) => {
  console.error("live path check failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});

export {};
