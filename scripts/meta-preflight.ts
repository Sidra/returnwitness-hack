/**
 * Meta preflight: one cheap live call per Meta model on a clip with a KNOWN answer, before the filmed clips
 * arrive, so a wire-format bug costs cents instead of a gate run. (The Modal SAM tries each found one.)
 *   1. SAM 3.1 alone on the synthetic late-item clip (sam3's groceries photo, a grey card hides the 4th bag
 *      until frame 8): expect 4 "paper bag" tracks, one first seen at frame ≥ 7. Compared with the Modal
 *      open-weights run of the same clip when data/recordings/modal-smoke-late-bag.sam-modal.json exists.
 *   2. Muse Voice Transcribe on a scripted macOS `say` WAV: expect the key words back.
 *   3. The real pipeline LIVE on RMA-20419 with that clip and the voice note: SAM 3.1 (kit concepts; no camera
 *      kit is in frame, so the expected outcome is a HOLD) → Muse Spark 1.3 → Muse Wonder 1.0 → validation.
 *      Proves the reader and agent request/response shapes end to end, not accuracy.
 * Nothing is saved for the public site: recordings go to a scratch folder. Spend is logged as usual.
 * The Modal failover is turned off inside this process so a Meta failure shows as a failure.
 *
 *   npx tsx --env-file=.env.local scripts/meta-preflight.ts --clip <late-bag.mp4>                  # quote only
 *   npx tsx --env-file=.env.local scripts/meta-preflight.ts --clip <late-bag.mp4> --confirm-spend [--cap 1]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n: string, d = "") => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const CLIP = opt("clip");
const CAP = Number(opt("cap", "1.00"));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "rw-preflight-"));
process.env.RETURNWITNESS_RECORDINGS_DIR = path.join(SCRATCH, "recordings");
process.env.RETURNWITNESS_SAM_FAILOVER = "";
process.env.RETURNWITNESS_STORE = "memory";
const VOICE_TEXT = "The lens cap is missing and the battery door sticks.";

function spentSince(t0: number): number {
  const f = process.env.RETURNWITNESS_LLM_LOG || path.join(process.cwd(), ".data", "llm-calls.jsonl");
  if (!fs.existsSync(f)) return 0;
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at?: string; provider?: string; costUsd?: number | null })
    .filter((r) => r.provider === "meta" && Date.parse(r.at ?? "") >= t0)
    .reduce((s, r) => s + (r.costUsd ?? 0), 0);
}

async function main() {
  if (!CLIP || !fs.existsSync(CLIP)) throw new Error("usage: meta-preflight.ts --clip <mp4> [--confirm-spend] [--cap 1]");
  const { metaConfig, liveMetaAvailable } = await import("../lib/meta/config");
  const { PRICES } = await import("../lib/obs/llm-log");
  const { KIT } = await import("../data/kit.config");
  const cfg = metaConfig();
  if (!liveMetaAvailable(cfg)) throw new Error("no Meta key on this machine (or public demo mode)");

  const { counterConfigForKit } = await import("../lib/vision/counter-config");
  const cc = counterConfigForKit(KIT);
  const pipelineConcepts = cc.items.length + 1 + cc.ignoreConcepts.length; // items + hand + packing, as the pipeline sends them
  const billedFrames = (1 + pipelineConcepts) * 50; // 25-frame clip: every request bills the 50-frame minimum
  const quote = {
    sam: billedFrames * PRICES.samPerFrameUsd,
    voice: 5 * PRICES.voicePerSecondUsd,
    spark: (14_000 * PRICES["muse-spark-1.3"].in + 2_000 * PRICES["muse-spark-1.3"].out) / 1e6,
    wonder: (15_000 * PRICES["muse-wonder-1.0"].in + 2_000 * PRICES["muse-wonder-1.0"].out) / 1e6,
  };
  const total = Object.values(quote).reduce((a, b) => a + b, 0);
  console.log(`Meta preflight quote (estimates): SAM $${quote.sam.toFixed(3)} (${billedFrames} billed frames) · Voice $${quote.voice.toFixed(4)} · Spark $${quote.spark.toFixed(3)} · Wonder $${quote.wonder.toFixed(3)} · TOTAL $${total.toFixed(3)} · cap $${CAP.toFixed(2)}`);
  if (!args.includes("--confirm-spend")) return console.log("Quote only. Re-run with --confirm-spend.");
  if (total > CAP) throw new Error(`quote $${total.toFixed(3)} is over the cap $${CAP.toFixed(2)}`);
  const t0 = Date.now();
  const guard = (next: number, label: string) => {
    const s = spentSince(t0);
    if (s + next > CAP) throw new Error(`stopping before ${label}: spent $${s.toFixed(3)} + next ~$${next.toFixed(3)} would pass the cap $${CAP.toFixed(2)}`);
  };
  const verdicts: string[] = [];

  // 1. SAM 3.1 alone, known answer.
  const { MetaSamSegmenter } = await import("../lib/meta/sam");
  const t1 = Date.now();
  const seg = await new MetaSamSegmenter(cfg).segment({ clipId: "meta-preflight-late-bag", videoPath: CLIP, concepts: ["paper bag"], fps: 5 });
  const first = new Map<string | number, number>();
  const perFrame = seg.frames.map((f) => {
    for (const m of f.masks) if (!first.has(m.trackId)) first.set(m.trackId, f.index);
    return f.masks.length;
  });
  const late = [...first.values()].filter((i) => i >= 7);
  const samOk = first.size === 4 && late.length === 1;
  console.log(`\n1. SAM 3.1 (Meta): ${Date.now() - t1} ms · ${seg.frames.length} frames · ${first.size} tracks, first seen ${[...first.entries()].map(([id, i]) => `${id}@${i}`).join(", ")}`);
  console.log(`   objects per frame: ${perFrame.join(" ")} · request ids: ${(seg.source as { requestIds?: string[] }).requestIds?.join(", ") ?? "-"}`);
  const modalRec = path.join("data", "recordings", "modal-smoke-late-bag.sam-modal.json");
  if (fs.existsSync(modalRec)) {
    const m = JSON.parse(fs.readFileSync(modalRec, "utf8")) as { data?: { frames?: Array<{ masks: unknown[] }> } };
    const mf = m.data?.frames ?? [];
    console.log(`   Modal open weights, same clip: ${mf.map((f) => f.masks.length).join(" ")}`);
  }
  verdicts.push(`SAM 3.1 ${samOk ? "PASS" : "CHECK"} (4 tracks with one late expected; got ${first.size}, ${late.length} late)`);

  // 2. Voice.
  guard(quote.voice, "voice");
  const { transcribeFile } = await import("../lib/meta/voice");
  const aiff = path.join(SCRATCH, "note.aiff");
  execFileSync("say", ["-o", aiff, VOICE_TEXT]);
  const note = { ...(await transcribeFile(aiff, cfg, { caseId: "meta-preflight", keywords: ["lens cap", "battery door"] })), synthetic: true }; // a macOS voice reading a scripted note
  const want = ["lens", "cap", "missing", "battery", "door"];
  const got = want.filter((w) => note.transcript.toLowerCase().includes(w));
  console.log(`\n2. Voice Transcribe: "${note.transcript}" · ${note.audioDurationMs} ms audio · ${note.latencyMs} ms · ${note.requestId ?? "-"} · ${got.length}/${want.length} key words`);
  verdicts.push(`Voice ${got.length === want.length ? "PASS" : "CHECK"} (${got.length}/${want.length} key words)`);

  // 3. The real pipeline, live.
  guard(quote.sam - 50 * PRICES.samPerFrameUsd + quote.spark + quote.wonder, "the live pipeline");
  const { pipelineDeps, liveEvidenceImages, POLICY, rmaById, orderFor } = await import("../lib/runtime");
  const { runInspection } = await import("../lib/engine/pipeline");
  const { prepareClip } = await import("../lib/vision/prepare-clip");
  const rma = rmaById("RMA-20419")!;
  const order = orderFor(rma.orderId)!;
  const prepared = prepareClip(CLIP, SCRATCH);
  const deps = pipelineDeps({ liveModels: true, liveSegmentation: true }, (e) => {
    if (e.status === "end") console.log(`   ${e.stage.padEnd(10)} ${String(e.ms ?? "").padStart(6)} ms  ${e.mode ?? ""}`);
  });
  deps.evidenceImages = liveEvidenceImages(CLIP);
  console.log(`\n3. Pipeline LIVE on ${rma.id} (no camera kit in frame → expect a HOLD):`);
  const c = await runInspection({ rma, slip: order.slip, policy: POLICY, voiceNote: note, clip: { clipId: "meta-preflight-pipeline", source: "camera", videoPath: prepared.path } }, deps);
  const readers = c.readerRuns?.map((r) => `${r.reader}:${r.ok ? "ok" : `ERR ${r.error}`}${r.requestId ? ` (${r.requestId})` : ""}`) ?? [];
  console.log(`   state ${c.state} · seg ${c.clip.mode} · recon ${c.reconciliation?.mode} · draft ${c.draft?.source}/${c.draft?.mode}${c.draft?.rejected ? " (rejected)" : ""}`);
  console.log(`   agent ${c.draft?.agent ? `${c.draft.agent.protocol} · ${c.draft.agent.steps.map((x) => `${x.kind}:${x.name ?? ""}${x.verdict ? `=${x.verdict.accepted ? "accepted" : "rejected"}` : ""}`).join(" → ")}` : "not run"}`);
  console.log(`   readers ${readers.join(" · ") || "none"}`);
  console.log(`   hold reasons: ${(c.holdReasons ?? []).slice(0, 4).join(" | ")}`);
  const sparkOk = readers.some((r) => r.startsWith("spark") && r.includes(":ok")) || c.reconciliation?.mode === "LIVE_META";
  const wonderOk = c.draft?.mode === "LIVE_META" && !c.draft?.rejected;
  const held = c.state === "Held";
  verdicts.push(`Spark ${sparkOk ? "PASS" : "CHECK"} · Wonder ${wonderOk ? "PASS" : "CHECK"} · outcome ${held ? "HELD as expected" : `CHECK (${c.state})`}`);

  console.log(`\nVerdicts:\n  ${verdicts.join("\n  ")}\nLogged Meta spend this run: $${spentSince(t0).toFixed(4)} (quote $${total.toFixed(3)}). Scratch: ${SCRATCH}`);
}

main().catch((e) => {
  console.error("preflight failed:", e instanceof Error ? e.stack : e);
  process.exit(1);
});

export {};
