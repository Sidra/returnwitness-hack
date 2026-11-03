"use client";

import { useState } from "react";
import type { ReaderRun, ReturnCase, ReviewerCorrection } from "@/lib/domain/case";
import { MERCHANT } from "@/data/fixtures";
import { api, ApiError } from "@/lib/client/api";
import { useStoredValue } from "@/lib/client/storage";
import { LocalTime } from "@/components/LocalTime";

type LabelRead = { itemKey: string; serialRead: string | null; skuRead: string | null; legible: boolean; confidence: number; cropCaption: string | null };
type Field = "serial" | "sku";

// Same sentinel as lib/learning/corrections.ts UNREADABLE (that module is server-only).
const UNREADABLE = "unreadable";

export const isLabelReaderRun = (r: ReaderRun) => /glimmer/i.test(r.reader) && Array.isArray((r.extras as { items?: unknown } | undefined)?.items);

/**
 * "Correct this read": a person fixes the label reader's serial or SKU for one item. The correction
 * is saved on the case as training data and an audit entry; it never changes the hold or the refund.
 */
export function CorrectionForm({ c, onCase }: { c: ReturnCase; onCase: (c: ReturnCase) => void }) {
  const run = c.readerRuns?.find(isLabelReaderRun);
  const reads = ((run?.extras as { items?: LabelRead[] } | undefined)?.items ?? []).filter((r) => typeof r.itemKey === "string");
  const [storedPerson, savePerson] = useStoredValue("rw-approver", MERCHANT.returnsLead);
  const [personEdit, setPerson] = useState<string | null>(null);
  const person = personEdit ?? storedPerson;
  const [field, setField] = useState<Record<string, Field>>({});
  const [value, setValue] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (!run || !reads.length) return null;
  const mine = (c.corrections ?? []).filter((x: ReviewerCorrection) => x.reader === run.reader);

  const submit = async (r: LabelRead) => {
    const f = field[r.itemKey] ?? "serial";
    const humanValue = (value[r.itemKey] ?? "").trim();
    if (!humanValue || !person.trim()) return;
    setBusy(r.itemKey);
    setError(null);
    setSaved(null);
    try {
      savePerson(person);
      const res = await api.correct(c.id, { itemKey: r.itemKey, field: f, modelValue: f === "serial" ? r.serialRead : r.skuRead, humanValue, reader: run.reader, cropCaption: r.cropCaption, person: person.trim(), expectedVersion: c.version });
      setValue((v) => ({ ...v, [r.itemKey]: "" }));
      setSaved(`Saved: ${r.itemKey} ${f} → "${res.correction.humanValue}"`);
      onCase(res.case);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 409 ? `${e.message}. Reload the case and try again.` : e.message) : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card-flat stack" style={{ gap: 12 }} aria-label="Correct the label reader">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Correct this read · label reader</span>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Each correction becomes a training example for the label reader. It never changes the hold or the refund.
        </p>
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        Your name
        <input className="input" value={person} onChange={(e) => setPerson(e.target.value)} autoComplete="name" />
      </label>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Model read</th>
              <th>Field</th>
              <th>Right value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {reads.map((r) => {
              const f = field[r.itemKey] ?? "serial";
              const v = value[r.itemKey] ?? "";
              return (
                <tr key={r.itemKey}>
                  <td className="mono">{r.itemKey}</td>
                  <td style={{ fontSize: 14 }}>
                    <div>
                      serial <span className="mono">{r.serialRead ?? "none"}</span> · SKU <span className="mono">{r.skuRead ?? "none"}</span>
                    </div>
                    <div className="muted mono" style={{ fontSize: 12 }}>
                      {r.legible ? "legible" : "not legible"} · confidence {Number.isFinite(r.confidence) ? r.confidence.toFixed(2) : "?"}
                    </div>
                  </td>
                  <td>
                    <select className="select" aria-label={`Field to correct for ${r.itemKey}`} value={f} onChange={(e) => setField((x) => ({ ...x, [r.itemKey]: e.target.value as Field }))}>
                      <option value="serial">Serial</option>
                      <option value="sku">SKU</option>
                    </select>
                  </td>
                  <td>
                    <input className="input mono" aria-label={`Right ${f} for ${r.itemKey}`} value={v} placeholder={`as printed, or "${UNREADABLE}"`} onChange={(e) => setValue((x) => ({ ...x, [r.itemKey]: e.target.value }))} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => submit(r)} disabled={busy !== null || !v.trim() || !person.trim()}>
                      {busy === r.itemKey ? "Saving…" : "Save correction"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}
      {saved && (
        <p aria-live="polite" className="muted" style={{ margin: 0, fontSize: 14 }}>
          {saved}
        </p>
      )}
      {mine.length > 0 && (
        <ul className="audit">
          {mine.map((x) => (
            <li key={x.id}>
              <span className="mono">{x.itemKey}</span> · {x.field}: <span className="mono">{x.modelValue ?? "no read"}</span> → <strong className="mono">{x.humanValue}</strong>
              <span className="muted">
                {" "}
                · {x.person} · <LocalTime iso={x.at} mode="datetime" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
