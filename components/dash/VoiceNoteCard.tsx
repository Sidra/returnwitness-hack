import type { VoiceNote } from "@/lib/domain/case";
import { LiveProof, ModeBadge } from "@/components/ModeBadge";

/** What the returns lead said at the bench. Evidence the draft may quote; a spoken claim never clears a hold. */
export function VoiceNoteCard({ note, cited }: { note: VoiceNote; cited?: string }) {
  const at = cited ? note.transcript.toLowerCase().indexOf(cited.toLowerCase()) : -1;
  return (
    <div className="card-flat stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>Returns lead&apos;s voice note · Muse Voice Transcribe</strong>
        <ModeBadge mode={note.mode} title={note.provenance} fixture="seeded note" />
      </div>
      {note.synthetic && <span className="fixture-label">[Synthetic voice reading a scripted note · the Muse Voice Transcribe call on it is real]</span>}
      <LiveProof mode={note.mode} model={note.model} ms={note.latencyMs} requestId={note.requestId} />
      <blockquote style={{ margin: 0, fontSize: 15 }}>
        {at >= 0 && cited ? (
          <>
            &ldquo;{note.transcript.slice(0, at)}
            <mark>{note.transcript.slice(at, at + cited.length)}</mark>
            {note.transcript.slice(at + cited.length)}&rdquo;
          </>
        ) : (
          <>&ldquo;{note.transcript}&rdquo;</>
        )}
      </blockquote>
      <span className="muted" style={{ fontSize: 13 }}>
        {(note.audioDurationMs / 1000).toFixed(1)} s of audio{note.person ? ` · ${note.person}` : ""}
        {note.synthetic ? <strong> · synthetic voice</strong> : null}
        {cited ? " · the highlighted words are quoted in the decision draft" : ""}. A spoken claim can raise a hold; it never clears one.
      </span>
      {note.mode !== "LIVE_META" && <span className="fixture-label">{note.provenance}</span>}
    </div>
  );
}
