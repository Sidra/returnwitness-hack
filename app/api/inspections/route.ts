import fs from "node:fs";
import path from "node:path";
import { runInspection, type StageEvent } from "@/lib/engine/pipeline";
import { pipelineDeps, liveEvidenceImages, POLICY, rmaById, orderFor, seededClipFile } from "@/lib/runtime";
import { liveMetaAvailable, metaConfig } from "@/lib/meta/config";
import { hasAudioStream, kitVocabulary, transcribeFile } from "@/lib/meta/voice";
import type { VoiceNote } from "@/lib/domain/case";
import { KIT } from "@/data/kit.config";
import { prepareClip } from "@/lib/vision/prepare-clip";
import { json, readJson } from "@/lib/api";
import { clientIp, rateLimited } from "@/lib/ratelimit";
import { reserveJudgeRun } from "@/lib/judge-live";

/**
 * Start a bench inspection. Streams stage events (text/event-stream) and ends with the case.
 * Body: {rmaId, live?: boolean, clipId?, voiceNoteId?}. Seeded clips replay their fixture segmentation; `live`
 * lets a local run with a Meta key send the counts to Spark and Wonder (labelled per stage). A recorded clip
 * with an audio track is transcribed first (Muse Voice Transcribe), or a separate voice note joins by id.
 */
export async function POST(req: Request) {
  const limited = await rateLimited(req, "inspect");
  if (limited) return limited;
  const body = await readJson<{ rmaId: string; live: boolean; clipId: string; voiceNoteId: string; liveSeeded: boolean }>(req);
  const rma = body.rmaId ? rmaById(body.rmaId) : undefined;
  const order = rma ? orderFor(rma.orderId) : undefined;
  if (!rma || !order) return json({ error: "unknown_rma", message: `unknown RMA ${body.rmaId ?? ""}` }, 404);

  // A recorded bench clip: live SAM 3.1 + Spark + Wonder, local profile only.
  let liveClip: { clipId: string; videoPath: string; srcPath: string } | null = null;
  if (body.clipId) {
    if (!/^live-[a-z0-9-]+$/.test(body.clipId)) return json({ error: "bad_clip", message: "unknown clip" }, 400);
    if (!liveMetaAvailable()) return json({ error: "no_live_key", message: "Live inspection of a recorded clip needs the Meta Model API key, which isn't configured here." }, 409);
    const dir = path.join(process.cwd(), ".data", "clips");
    const src = fs.readdirSync(dir).find((f) => f.startsWith(`${body.clipId}.`));
    if (!src) return json({ error: "bad_clip", message: "clip not found" }, 404);
    const prepared = prepareClip(path.join(dir, src), path.join(dir, "prepared"));
    liveClip = { clipId: body.clipId, videoPath: prepared.path, srcPath: path.join(dir, src) };
  }

  // Public profile: live models only through a reserved, capped judge run (off unless switched on).
  let judgeLive = false;
  if (body.live && !body.clipId && metaConfig().publicDemo) {
    const r = await reserveJudgeRun(clientIp(req));
    if (!r.ok) return json({ error: `judge_live_${r.reason}`, message: r.message }, r.reason === "visitor_cap" || r.reason === "daily_cap" ? 429 : 403);
    judgeLive = true;
  }
  // A seeded RMA's own filmed clip, run live end to end (local profile with the key; the public site never has it).
  if (body.liveSeeded && !liveClip) {
    if (!liveMetaAvailable() || metaConfig().publicDemo) return json({ error: "no_live_key", message: "Live runs of the filmed demo clips need the Meta Model API key on this server." }, 409);
    const src = seededClipFile(rma.clipId);
    if (!src) return json({ error: "no_clip", message: `no filmed clip for ${rma.clipId} on this server` }, 404);
    const prepared = prepareClip(src, path.join(process.cwd(), ".data", "clips", "prepared"));
    liveClip = { clipId: rma.clipId, videoPath: prepared.path, srcPath: src };
  }
  let storedNote: VoiceNote | undefined;
  if (body.voiceNoteId) {
    if (!/^vn-[a-z0-9]+$/.test(body.voiceNoteId)) return json({ error: "bad_voice_note", message: "unknown voice note" }, 400);
    const f = path.join(process.cwd(), ".data", "voice", `${body.voiceNoteId}.json`);
    if (!fs.existsSync(f)) return json({ error: "bad_voice_note", message: "voice note not found" }, 404);
    storedNote = JSON.parse(fs.readFileSync(f, "utf8")) as VoiceNote;
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        // The clip's own audio track: the returns lead says what they see while unpacking. Optional evidence:
        // a failed transcription is reported and the inspection goes on without it.
        let voiceNote = storedNote;
        if (!voiceNote && liveClip && hasAudioStream(liveClip.srcPath)) {
          send("stage", { caseId: "", stage: "listen", status: "start", mode: "LIVE_META" });
          const t0 = performance.now();
          try {
            voiceNote = await transcribeFile(liveClip.srcPath, metaConfig(), { keywords: kitVocabulary(KIT) });
            send("voice", voiceNote);
          } catch (e) {
            send("voice_error", { message: e instanceof Error ? e.message : String(e) });
          }
          send("stage", { caseId: "", stage: "listen", status: "end", ms: Math.round(performance.now() - t0), mode: "LIVE_META" });
        }
        const deps = pipelineDeps({ liveModels: Boolean(body.live) || Boolean(liveClip), liveSegmentation: Boolean(liveClip), clipId: liveClip?.clipId ?? rma.clipId, judgeLive }, (e: StageEvent) => send("stage", e));
        if (liveClip) deps.evidenceImages = liveEvidenceImages(liveClip.srcPath);
        const c = await runInspection(
          { rma, slip: order.slip, policy: POLICY, clip: liveClip ? { clipId: liveClip.clipId, source: "camera", videoPath: liveClip.videoPath } : { clipId: rma.clipId, source: "fixture" }, ...(voiceNote ? { voiceNote } : {}) },
          deps,
        );
        send("case", c);
      } catch (e) {
        send("error", { message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}
