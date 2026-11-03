/**
 * Muse Voice Transcribe 1.0: the returns lead says what they see while unpacking, and the transcript
 * joins the evidence. Contract from Meta's docs (dev.meta.ai/docs/speech-to-text and
 * /docs/api-reference/voice/transcribe):
 *   POST {base}/asr/transcribe, multipart/form-data with two parts:
 *     request (application/json) {model, audioEncoding:"WAV", mode?, languageBias?, keywords?}
 *     audio   a RIFF/WAVE file, mono 16-bit PCM at 16 or 24 kHz, ≤ 10 minutes, body ≤ 32 MB
 *   200 → {sessionId, transcript, audioDurationMs, turns[]}
 * It is NOT the OpenAI audio endpoint, so it goes through fetch, not the SDK. Billing: $0.18 per hour,
 * whole seconds rounded down; failed requests aren't billed. Every call is logged for `spend`.
 *
 * A transcript is evidence, not authority: readers and the draft may quote it, and a spoken claim can
 * raise a hold, but it never clears one (that rule lives in reconcile/crossCheck, unchanged).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { VoiceNote } from "@/lib/domain/case";
import { logLlmCall, PRICES, usdToMicroCents } from "@/lib/obs/llm-log";
import { assertNotContributor, metaConfig, type MetaConfig } from "./config";

export const MAX_AUDIO_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

export const TranscribeResponse = z.object({
  sessionId: z.string().optional(),
  transcript: z.string(),
  audioDurationMs: z.number().nonnegative().optional(),
  turns: z.array(z.object({ turnId: z.number().optional(), startMs: z.number().optional(), endMs: z.number().optional(), transcript: z.string(), speaker: z.string().optional() })).default([]),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

export class VoiceTranscribeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Words a returns lead says at the bench that a general model may mishear. */
export const BENCH_TERMS = ["lens cap", "battery door", "body cap", "charger", "serial", "scratched", "dented", "cracked", "missing", "look-alike"] as const;
export const MAX_KEYWORDS = 50;

/**
 * Vocabulary biasing for Muse Voice Transcribe, from the kit file (dev.meta.ai/docs/speech-to-text: `keywords`
 * "for product names, people, places, acronyms, and other terms the model might mishear"; they bias, they don't force).
 * Item names, SAM concepts, SKUs, the kit and merchant names, serial PREFIXES (e.g. "BW-CB") and bench terms.
 * Full serials are left out on purpose: biasing toward the slip's own serial could turn a misheard serial into a match.
 */
export function kitVocabulary(kit: { kitName: string; kitSku: string; merchantName: string; items: Array<{ name: string; sku: string; genericName: string; serials: { complete: string; missingCase: string } }> }): string[] {
  const prefixes = kit.items.flatMap((i) => [i.serials.complete, i.serials.missingCase]).map((s) => /^([A-Z]+-[A-Z]+)-/i.exec(s)?.[1]).filter((x): x is string => !!x);
  const words = [kit.kitName, kit.merchantName, kit.kitSku, ...kit.items.flatMap((i) => [i.name, i.genericName, i.sku]), ...prefixes, ...BENCH_TERMS];
  const seen = new Set<string>();
  return words.filter((w) => {
    const k = w.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_KEYWORDS);
}

/** The JSON `request` part, exactly as documented. Keywords bias recognition toward the kit's words. */
export function transcribeRequest(model: string, keywords: string[] = []) {
  return {
    model,
    audioEncoding: "WAV" as const,
    mode: "PUSH_TO_TALK" as const,
    languageBias: ["English"],
    ...(keywords.length ? { keywords: keywords.slice(0, MAX_KEYWORDS) } : {}),
  };
}

/** Any audio or video file → mono 16-bit PCM WAV at 16 kHz (what the endpoint accepts). Needs ffmpeg. */
export function toTranscribeWav(src: string, outDir = os.tmpdir()): { wavPath: string; durationMs: number } {
  const wavPath = path.join(outDir, `rw-voice-${process.pid}-${Date.now()}.wav`);
  try {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1", wavPath]);
  } catch (e) {
    throw new VoiceTranscribeError(`could not extract audio for transcription: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  const bytes = fs.statSync(wavPath).size;
  // 16 kHz × 16-bit × mono = 32,000 bytes per second after the 44-byte header.
  const durationMs = Math.max(0, Math.round(((bytes - 44) / 32000) * 1000));
  return { wavPath, durationMs };
}

/** True when the file has an audio stream worth transcribing (a camera clip often has one). */
export function hasAudioStream(src: string): boolean {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", src], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface TranscribeOpts {
  caseId?: string;
  keywords?: string[];
  person?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Transcribes one WAV file live. Throws VoiceTranscribeError on any failure (logged, never billed). */
export async function transcribeWav(wavPath: string, cfg: MetaConfig = metaConfig(), opts: TranscribeOpts = {}): Promise<VoiceNote> {
  const model = cfg.models.voice;
  const t0 = Date.now();
  const req = transcribeRequest(model, opts.keywords);
  const logBase = { provider: "meta" as const, model, purpose: "voice_note", mode: "live" as const, inputTokens: null, outputTokens: null, caseId: opts.caseId, input: { ...req, audio: path.basename(wavPath) } };
  try {
    assertNotContributor(model);
    if (!cfg.apiKey) throw new VoiceTranscribeError("META_HACK_API_KEY is not set");
    const audio = fs.readFileSync(wavPath);
    if (audio.byteLength + 1024 > MAX_BODY_BYTES) throw new VoiceTranscribeError(`audio is ${(audio.byteLength / 1048576).toFixed(1)} MB; the endpoint takes at most 32 MB`, 413);
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(req)], { type: "application/json" }));
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), path.basename(wavPath));
    const res = await (opts.fetch ?? fetch)(`${cfg.baseURL.replace(/\/$/, "")}/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new VoiceTranscribeError(`Muse Voice Transcribe returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`, res.status);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new VoiceTranscribeError("Muse Voice Transcribe returned a body that isn't JSON");
    }
    const parsed = TranscribeResponse.safeParse(json);
    if (!parsed.success) throw new VoiceTranscribeError(`unexpected transcription response: ${parsed.error.issues[0]?.message ?? "shape mismatch"}`);
    const d = parsed.data;
    const audioMs = d.audioDurationMs ?? 0;
    if (audioMs > MAX_AUDIO_MS) throw new VoiceTranscribeError("audio over 10 minutes", 400);
    const latencyMs = Date.now() - t0;
    const billedS = Math.floor(audioMs / 1000);
    const usd = billedS * PRICES.voicePerSecondUsd;
    logLlmCall({ ...logBase, ok: true, latencyMs, units: { kind: "audio_seconds", count: billedS }, costUsd: usd, costMicroCents: usdToMicroCents(usd), output: { sessionId: d.sessionId ?? null, transcript: d.transcript.slice(0, 2000), audioDurationMs: audioMs } });
    return {
      transcript: d.transcript.trim(),
      mode: "LIVE_META",
      model,
      latencyMs,
      audioDurationMs: audioMs,
      ...(d.sessionId ? { requestId: d.sessionId } : {}),
      provenance: `live Muse Voice Transcribe call, ${(audioMs / 1000).toFixed(1)} s of audio, ${latencyMs} ms`,
      ...(opts.person ? { person: opts.person } : {}),
      recordedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
  } catch (e) {
    logLlmCall({ ...logBase, ok: false, latencyMs: Date.now() - t0, costUsd: null, costMicroCents: null, output: "", error: e instanceof Error ? e.message : String(e) });
    throw e instanceof VoiceTranscribeError ? e : new VoiceTranscribeError(e instanceof Error ? e.message : String(e));
  }
}

/** Any audio/video file → live transcript (converts to WAV first, cleans up after). */
export async function transcribeFile(src: string, cfg: MetaConfig = metaConfig(), opts: TranscribeOpts = {}): Promise<VoiceNote> {
  const { wavPath, durationMs } = toTranscribeWav(src);
  try {
    if (durationMs > MAX_AUDIO_MS) throw new VoiceTranscribeError("audio over 10 minutes: record a shorter note", 400);
    if (durationMs < 300) throw new VoiceTranscribeError("no audible note (under 0.3 s of audio)", 400);
    return await transcribeWav(wavPath, cfg, opts);
  } finally {
    fs.rmSync(wavPath, { force: true });
  }
}
