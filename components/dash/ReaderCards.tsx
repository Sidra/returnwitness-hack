"use client";

import type { ReaderRun } from "@/lib/domain/case";
import { LiveProof, ModeBadge } from "@/components/ModeBadge";
import { misreadsIn } from "@/data/known-misreads";
import { LossNotes } from "./LossNotes";

type AuditItem = { itemKey: string; labelLegible: boolean; visibleDamage: boolean; standInSuspected: boolean; note: string };
type LabelItem = { itemKey: string; serialRead: string | null; skuRead?: string | null; legible: boolean; confidence?: number };

/** Independent readers: each can only raise a hold. Skipped readers say why, in plain words. */
export function ReaderCards({ runs, clipId }: { runs: ReaderRun[]; clipId?: string }) {
  if (!runs.length) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="eyebrow">Independent readers · each can raise a hold, none can clear one</span>
      <div className="settle-grid">
        {runs.map((r) => {
          // Each reader's extras have their own shape: the auditor's items carry standInSuspected, the label reader's serialRead.
          const items = (r.extras as { items?: Array<Record<string, unknown>> } | undefined)?.items;
          const audit = items?.every((x) => "standInSuspected" in x) ? (items as unknown as AuditItem[]) : undefined;
          const labels = !audit && items?.every((x) => "serialRead" in x) ? (items as unknown as LabelItem[]) : undefined;
          const notRun = !r.ok && r.mode === "DETERMINISTIC";
          return (
            <div key={r.reader} className="card-flat stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{r.reader.startsWith("muse-spark-open") ? "Open-weight audit · Muse Spark Open" : r.reader.startsWith("muse-spark-1.3") ? "Muse Spark 1.3 reader" : r.reader}</strong>
                {notRun ? <span className="mode mode-det">NOT RUN</span> : <ModeBadge mode={r.mode} replay={r.recordedAt ? { model: r.model, at: r.recordedAt, requestId: r.requestId } : undefined} />}
              </div>
              <span className="mono muted" style={{ fontSize: 13 }}>
                {r.model}
                {r.provider && r.provider !== "none" ? ` · ${r.provider}` : ""}
                {r.latencyMs ? ` · ${(r.latencyMs / 1000).toFixed(1)} s` : ""} · {r.required ? "required" : "optional"}
              </span>
              {r.ok && r.requestId && <LiveProof mode={r.mode} requestId={r.requestId} />}
              {r.error && <span style={{ fontSize: 14 }} className={notRun ? "muted" : undefined}>{r.error}</span>}
              {audit && (
                <ul className="audit">
                  {audit.map((a) => (
                    <li key={a.itemKey} style={{ fontSize: 14 }}>
                      <span className="mono">{a.itemKey}</span> · label {a.labelLegible ? "legible" : <strong>not legible</strong>} · {a.visibleDamage ? <strong>damage seen</strong> : "no damage seen"} · {a.standInSuspected ? <strong>stand-in suspected</strong> : "matches the slip"}
                      {a.note ? <span className="muted"> · {a.note}</span> : null}
                      <LossNotes items={misreadsIn(clipId, `${a.note} ${a.standInSuspected ? "stand-in" : ""}`, a.itemKey)} compact />
                    </li>
                  ))}
                </ul>
              )}
              {labels && (
                <ul className="audit">
                  {labels.map((l, i) => (
                    <li key={`${l.itemKey}-${i}`} style={{ fontSize: 14 }}>
                      <span className="mono">{l.itemKey}</span> · {l.serialRead ? <>serial <span className="mono">{l.serialRead}</span></> : "no serial read"} · label {l.legible ? "legible" : <strong>not legible</strong>}
                      {l.confidence != null ? <span className="muted"> · confidence {l.confidence.toFixed(2)}</span> : null}
                      {l.skuRead ? <span className="muted"> · SKU read &ldquo;{l.skuRead}&rdquo;</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {!audit && !labels && r.lines && r.lines.length > 0 && (
                <ul className="audit">
                  {r.lines.map((l) => (
                    <li key={l.itemKey} style={{ fontSize: 14 }}>
                      <span className="mono">{l.itemKey}</span> · {l.status} ({l.observedQty}){l.serialRead ? <> · serial <span className="mono">{l.serialRead}</span></> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
