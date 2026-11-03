/**
 * The bench speaks first (a demo beat, HOLD direction only): after an inspection lands in Held, a click reads out
 * what's short and asks "Hold the refund?" in the browser's own voice (speechSynthesis: an OS voice, not a Meta model).
 * The person answers into the microphone; Muse Voice Transcribe writes it down, and only a clear yes is recorded,
 * as a person's hold on a case that is already held. Nothing here can release, approve or refund: a "no", silence or
 * anything unclear changes nothing, and a refund still needs the typed-name, single-use signed approval.
 */
import type { ReconciliationLine } from "@/lib/domain/schemas";

export const BENCH_VOICE_LABEL = "browser voice · not a Meta model";

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const n = (k: number) => WORDS[k] ?? String(k);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * What the bench says, or null when it has nothing to ask (the case isn't held, or no line is short or unclear).
 * Always ends with the one question it may ask: "Hold the refund?"
 */
export function holdPromptText(state: string, lines: Pick<ReconciliationLine, "description" | "status" | "missingQty">[]): string | null {
  if (state !== "Held") return null;
  const missing = lines.filter((l) => l.status === "MISSING" && l.missingQty > 0);
  const unclear = lines.filter((l) => l.status === "HELD" || l.status === "EXTRA");
  if (!missing.length && !unclear.length) return null;
  const parts: string[] = [];
  if (missing.length === 1) {
    const l = missing[0];
    parts.push(`${l.missingQty === 1 ? "One" : n(l.missingQty).replace(/^./, (c) => c.toUpperCase())} ${lower(l.description)} ${l.missingQty === 1 ? "is" : "are"} missing.`);
  } else if (missing.length > 1) {
    parts.push(`${list(missing.map((l) => `${n(l.missingQty)} ${lower(l.description)}`)).replace(/^./, (c) => c.toUpperCase())} are missing.`);
  }
  if (unclear.length) parts.push(`I can't confirm the ${list(unclear.map((l) => lower(l.description)))}.`);
  parts.push("Hold the refund?");
  return parts.join(" ");
}

const NEGATIVE = /\b(no|nope|not|don'?t|do not|cancel|stop|wait|release|refund it|approve)\b/i;
const AFFIRMATIVE = /\b(yes|yeah|yep|yup|correct|confirm(ed)?|hold it|hold the refund|keep it held|please hold)\b/i;

/**
 * App code, deterministic: a clear yes and no hint of a no. "Yes, hold it" → true; "no", "yes but release it",
 * "hmm" → false. A false answer changes nothing (the case stays held).
 */
export function isClearYes(transcript: string): boolean {
  const t = transcript.trim();
  if (!t || t.length > 120) return false;
  return AFFIRMATIVE.test(t) && !NEGATIVE.test(t);
}

/** The audit line for a voice-confirmed hold: who, what they said, and which model wrote it down. */
export function voiceHoldReason(transcript: string, model: string): string {
  return `Said yes to the bench's hold question: "${transcript.trim().slice(0, 120)}" (transcribed by ${model}; the question was read by the browser's voice)`;
}
