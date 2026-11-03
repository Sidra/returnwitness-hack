"use client";

import { useEffect, useRef, useState } from "react";
import type { VoiceNote } from "@/lib/domain/case";
import { ApiError, uploadVoiceNote } from "@/lib/client/api";
import { VoiceNoteCard } from "./VoiceNoteCard";

const MAX_S = 60;

/**
 * "Say what you see": the returns lead records a short note at the bench; the server transcribes it with
 * Muse Voice Transcribe 1.0 and the transcript joins this box's evidence. Live only (local profile + Meta key).
 */
/** Remount it (key) per return: a note belongs to one box. */
export function VoiceNoteRecorder({
  enabled,
  disabledReason,
  onNote,
  eyebrow = "Say what you see · optional voice note",
  recordLabel = "Record a note",
  recordingHint = "Recording… say what's in the box and anything the camera can't see.",
  idleHint = "Transcribed by Muse Voice Transcribe 1.0 ($0.18 per hour of audio). It joins this box's evidence; it can raise a hold, never clear one.",
}: {
  enabled: boolean;
  disabledReason: string;
  onNote: (id: string | null, note: VoiceNote | null) => void;
  eyebrow?: string;
  recordLabel?: string;
  recordingHint?: string;
  idleHint?: string;
}) {
  const [state, setState] = useState<"idle" | "recording" | "sending" | "done">("idle");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        setState("sending");
        try {
          // ?voice=synthetic on the page marks a scripted synthetic-voice take (the demo film); the card says so.
          const synthetic = new URLSearchParams(window.location.search).get("voice") === "synthetic";
          let person: string | undefined;
          try {
            person = localStorage.getItem("rw-approver") ?? undefined;
          } catch {
            person = undefined;
          }
          const { voiceNoteId, note: n } = await uploadVoiceNote(new Blob(chunks, { type: mr.mimeType || "audio/webm" }), person, synthetic);
          setNote(n);
          setState("done");
          onNote(voiceNoteId, n);
        } catch (e) {
          setError(e instanceof ApiError ? e.message : String(e));
          setState("idle");
        }
      };
      rec.current = mr;
      mr.start();
      setSecs(0);
      setState("recording");
      timer.current = setInterval(() => setSecs((s) => (s + 1 >= MAX_S ? (mr.state === "recording" && mr.stop(), MAX_S) : s + 1)), 1000);
    } catch (e) {
      setError(e instanceof Error && e.name === "NotAllowedError" ? "Microphone permission was denied." : `Couldn't start the microphone: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="card-flat stack" style={{ gap: 8 }}>
      <span className="eyebrow">{eyebrow}</span>
      {!enabled ? (
        <span className="muted" style={{ fontSize: 14 }}>{disabledReason}</span>
      ) : (
        <div className="row" style={{ alignItems: "center" }}>
          {state === "recording" ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => rec.current?.stop()}>
              Stop ({MAX_S - secs} s left)
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={start} disabled={state === "sending"}>
              {state === "sending" ? "Transcribing…" : note ? "Record again" : recordLabel}
            </button>
          )}
          <span className="muted" style={{ fontSize: 13 }} aria-live="polite">
            {state === "recording" ? recordingHint : idleHint}
          </span>
        </div>
      )}
      {error && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: 14 }}>
          {error}
        </span>
      )}
      {note && <VoiceNoteCard note={note} />}
    </div>
  );
}
