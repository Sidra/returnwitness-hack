import fs from "node:fs";
import path from "node:path";
import { json } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";
import { liveMetaAvailable, metaConfig } from "@/lib/meta/config";
import { kitVocabulary, transcribeFile, VoiceTranscribeError } from "@/lib/meta/voice";
import { KIT } from "@/data/kit.config";

const MAX_BYTES = 20 * 1024 * 1024;
const DIR = path.join(process.cwd(), ".data", "voice");

/**
 * The returns lead's spoken note for a box, transcribed live by Muse Voice Transcribe 1.0.
 * LOCAL PROFILE ONLY (uploads are off on the public demo) and only with the Meta key configured.
 * Body: raw audio (audio/webm, audio/ogg, audio/mp4, audio/wav); header x-synthetic-voice: 1 when a synthetic voice
 * read the note (it is then labelled so on screen). Returns {voiceNoteId, note}; pass
 * `voiceNoteId` to POST /api/inspections so the note joins that box's evidence.
 */
export async function POST(req: Request) {
  if (process.env.RETURNWITNESS_PUBLIC_DEMO === "1" || process.env.VERCEL) return json({ error: "uploads_off", message: "Voice notes are off on the public demo." }, 403);
  const limited = await rateLimited(req, "inspect");
  if (limited) return limited;
  if (!liveMetaAvailable()) return json({ error: "no_live_key", message: "Transcribing a voice note needs the Meta Model API key, which isn't configured here." }, 409);
  const type = req.headers.get("content-type") ?? "";
  const ext = type.includes("webm") ? "webm" : type.includes("ogg") ? "ogg" : type.includes("mp4") || type.includes("m4a") ? "m4a" : type.includes("wav") ? "wav" : null;
  if (!ext) return json({ error: "bad_type", message: "send audio/webm, audio/ogg, audio/mp4 or audio/wav" }, 415);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return json({ error: "bad_size", message: "empty, or over 20 MB" }, 400);
  fs.mkdirSync(DIR, { recursive: true });
  const voiceNoteId = `vn-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const src = path.join(DIR, `${voiceNoteId}.${ext}`);
  fs.writeFileSync(src, buf);
  try {
    const person = (req.headers.get("x-person") ?? "").slice(0, 80) || undefined;
    const transcribed = await transcribeFile(src, metaConfig(), { keywords: kitVocabulary(KIT), person });
    // Said plainly on the card: a synthetic voice read this note; the Meta transcription of it is real.
    const note = req.headers.get("x-synthetic-voice") === "1" ? { ...transcribed, synthetic: true, provenance: `${transcribed.provenance} · synthetic voice` } : transcribed;
    fs.writeFileSync(path.join(DIR, `${voiceNoteId}.json`), JSON.stringify(note, null, 2));
    return json({ voiceNoteId, note });
  } catch (e) {
    const status = e instanceof VoiceTranscribeError && e.status && e.status < 500 ? 422 : 502;
    return json({ error: "transcription_failed", message: e instanceof Error ? e.message : String(e) }, status);
  }
}
