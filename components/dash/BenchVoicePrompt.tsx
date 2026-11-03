"use client";

import { useEffect, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import { MERCHANT } from "@/data/fixtures";
import { api, ApiError } from "@/lib/client/api";
import { useStoredValue } from "@/lib/client/storage";
import { BENCH_VOICE_LABEL, holdPromptText, isClearYes, voiceHoldReason } from "@/lib/voice/bench-voice";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";

/**
 * "The bench speaks first": on a held box, a click reads out what's short and asks "Hold the refund?" in the
 * browser's own voice (never on its own: no autoplay). A spoken "yes", written down by Muse Voice Transcribe, is
 * recorded as this person's hold on the already-held case. Voice can't release money: a "no" or anything unclear
 * changes nothing. Remount per case (key).
 */
export function BenchVoicePrompt({ c, voiceEnabled, voiceDisabledReason, onCase }: { c: ReturnCase; voiceEnabled: boolean; voiceDisabledReason: string; onCase: (c: ReturnCase) => void }) {
  const text = holdPromptText(c.state, c.reconciliation?.lines ?? []);
  const [muted, setMuted] = useStoredValue("rw-bench-voice-muted", "0");
  const [person] = useStoredValue("rw-approver", MERCHANT.returnsLead);
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const isMuted = muted === "1";

  useEffect(() => {
    // Checked after mount: the server render can't know, and a mismatch would flash.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined");
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  if (!text) return null;

  const speak = () => {
    if (isMuted || !supported) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  };

  const toggleMute = () => {
    if (!isMuted && supported) window.speechSynthesis.cancel();
    setSpeaking(false);
    setMuted(isMuted ? "0" : "1");
  };

  const onAnswer = async (_id: string | null, note: { transcript: string; model: string; person?: string } | null) => {
    if (!note) return;
    if (!isClearYes(note.transcript)) {
      setOutcome({ ok: false, text: `Heard “${note.transcript.trim() || "(nothing)"}”: not a clear yes, so nothing changed. The box stays held.` });
      return;
    }
    const who = (note.person ?? person).trim();
    try {
      const updated = await api.hold(c.id, who, voiceHoldReason(note.transcript, note.model));
      onCase(updated);
      setOutcome({ ok: true, text: `Recorded: ${who} said yes to the hold. The box stays held for review.` });
    } catch (e) {
      setOutcome({ ok: false, text: `The hold wasn't recorded (${e instanceof ApiError ? e.message : String(e)}). The box stays held.` });
    }
  };

  return (
    <div className="card-flat stack" style={{ gap: 10 }} aria-labelledby={`bench-voice-${c.id}`}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <span className="eyebrow" id={`bench-voice-${c.id}`}>
          The bench asks
        </span>
        <span className="fixture-label">{BENCH_VOICE_LABEL}</span>
      </div>
      <p style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>&ldquo;{text}&rdquo;</p>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={speak} disabled={isMuted || !supported || speaking}>
          {speaking ? "Speaking…" : "Ask out loud"}
        </button>
        <button type="button" className="btn btn-sm" onClick={toggleMute} aria-pressed={isMuted}>
          {isMuted ? "Unmute bench voice" : "Mute bench voice"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          {!supported ? "This browser has no speech voice; the question is shown above." : isMuted ? "Muted: the question is shown, not spoken." : "Plays only when you click."}
        </span>
      </div>
      <VoiceNoteRecorder
        enabled={voiceEnabled}
        disabledReason={voiceDisabledReason.charAt(0).toUpperCase() + voiceDisabledReason.slice(1)}
        onNote={(id, n) => void onAnswer(id, n)}
        eyebrow="Answer out loud"
        recordLabel="Answer"
        recordingHint="Recording… say “yes, hold it” to keep the refund on hold."
        idleHint="Muse Voice Transcribe 1.0 writes your answer down. Only a clear yes is recorded, as your hold. Voice can't release a refund: that needs your typed name on a signed approval."
      />
      {outcome && (
        <span role="status" className={outcome.ok ? "st st-ok" : "muted"} style={{ fontSize: 14 }}>
          {outcome.text}
        </span>
      )}
    </div>
  );
}
