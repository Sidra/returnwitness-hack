/**
 * ONE Muse Voice Transcribe 1.0 call on a synthetic voice note (a scripted WAV read by a TTS voice, none of the
 * builder's footage or voice), saved as its own record, apart from every bench run:
 *   npx tsx --env-file=.env.local scripts/voice-note-synthetic.ts <note.wav> --confirm-spend
 * Writes data/recordings/voice-synthetic/<wav stem>.voice.json (the transcript verbatim, latency, request id, cost
 * from the call log) and refuses to run again if that record exists: no retake, a wrong word stays as it came.
 */
import fs from "node:fs";
import path from "node:path";
import { KIT } from "../data/kit.config";
import { metaConfig, liveMetaAvailable } from "../lib/meta/config";
import { kitVocabulary, transcribeFile } from "../lib/meta/voice";

async function main() {
  const wav = process.argv[2];
  if (!wav || !fs.existsSync(wav)) throw new Error("usage: voice-note-synthetic.ts <note.wav> --confirm-spend");
  const dir = path.join("data", "recordings", "voice-synthetic");
  const out = path.join(dir, `${path.basename(wav, path.extname(wav))}.voice.json`);
  if (fs.existsSync(out)) throw new Error(`${out} exists: one call only, no retake`);
  if (!process.argv.includes("--confirm-spend")) return console.log(`would send ${wav} to Muse Voice Transcribe 1.0 once (≈ $0.18/h of audio). Add --confirm-spend.`);
  const cfg = metaConfig();
  if (!liveMetaAvailable(cfg)) throw new Error("no live Meta key in this profile");
  const t0 = new Date().toISOString();
  const note = await transcribeFile(wav, cfg, { keywords: kitVocabulary(KIT) });
  const logFile = process.env.RETURNWITNESS_LLM_LOG || path.join(".data", "llm-calls.jsonl");
  const logged = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; purpose?: string; costUsd?: number | null; ok?: boolean }).filter((r) => r.at >= t0 && r.purpose === "voice_note");
  const record = {
    label: "a separate call on a synthetic voice note",
    note: "Scripted note read by a TTS voice (ElevenLabs Alice). Not part of any bench run; none of the builder's footage or voice.",
    audio: path.basename(wav),
    ...note,
    synthetic: true,
    costUsd: logged.at(-1)?.costUsd ?? null,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(record, null, 1));
  console.log(JSON.stringify(record, null, 1));
  console.log(`saved ${out}`);
}

main().catch((e) => {
  console.error(`voice-note-synthetic: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
