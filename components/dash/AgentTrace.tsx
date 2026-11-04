"use client";

import { useState } from "react";
import type { DraftRecord, EvidenceKind, EvidenceRequest, ReturnCase } from "@/lib/domain/case";
import { ModeBadge } from "@/components/ModeBadge";
import { MERCHANT } from "@/data/fixtures";
import { api, ApiError } from "@/lib/client/api";
import { useStoredValue } from "@/lib/client/storage";
import { AGENT_LIMITS } from "@/lib/engine/agent-limits";
import { fromFilmedClip, isRealReplay } from "@/lib/domain/schemas";
import { misreadsIn } from "@/data/known-misreads";
import { LossNotes } from "./LossNotes";

const PROTOCOL: Record<string, string> = {
  tools: "tool calls",
  structured: "two structured-output calls (tool calling unavailable on this model)",
  recorded: "replay of a recorded live run; the guard re-ran in app code just now",
};

// Same wording as lib/engine/evidence-request.ts EVIDENCE_KIND_TEXT (that module is server-only).
const KIND_TEXT: Record<EvidenceKind, string> = {
  label_closeup: "a close-up of the label",
  underside: "a view of the underside",
  spoken_observation: "a spoken observation from the returns lead",
};

const short = (v: unknown, n = 140) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : (s ?? "");
};

const STATUS: Record<EvidenceRequest["status"], { cls: string; text: string }> = {
  open: { cls: "st st-held", text: "OPEN · EVIDENCE REQUESTED" },
  answered: { cls: "st st-ok", text: "ANSWERED · TYPED NOTE" },
  stale: { cls: "st st-extra", text: "STALE · EVIDENCE CHANGED" },
};

/** The Wonder agent's trace: what it read, what it proposed or requested, and what app code decided. */
export function AgentTrace({ draft, c, onCase }: { draft: DraftRecord; c?: ReturnCase; onCase?: (c: ReturnCase) => void }) {
  const a = draft.agent;
  // The case holds each request's current status (answered / stale); the trace holds what the run asked for.
  const requests = c?.evidenceRequests ?? a?.evidenceRequests ?? [];
  return (
    <section className="card-flat stack" style={{ gap: 10 }} aria-label="Decision agent trace">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 className="h3">Decision agent · Muse Wonder 1.0</h3>
        {a ? <ModeBadge mode={a.mode} realReplay={isRealReplay(c?.clip.provenance)} /> : <span className="mode mode-det">NOT RUN</span>}
      </div>
      <p style={{ margin: 0, fontSize: 15 }}>
        <strong>The agent can only move a case toward HELD.</strong> APPROVED needs a person&apos;s one-time token, and app code rejects any other proposal. It may ask a person for missing evidence (at most {AGENT_LIMITS.maxEvidenceRequests} requests, {AGENT_LIMITS.maxModelRounds} rounds, {AGENT_LIMITS.deadlineMs / 1000} s); it never waits for the answer.
      </p>
      {a && <LossNotes items={misreadsIn(fromFilmedClip(c?.clip) ? c?.clip.clipId : undefined, JSON.stringify(a.steps))} />}
      {!a && <p className="muted" style={{ margin: 0, fontSize: 14 }}>Agent trace · not run: {draft.agentNotRun}. The draft below is the app-code template.</p>}
      {a && (
        <>
          <span className="mono muted" style={{ fontSize: 13 }}>
            {a.model} · {PROTOCOL[a.protocol] ?? a.protocol}
            {a.latencyMs ? ` · ${(a.latencyMs / 1000).toFixed(1)} s` : ""}
            {a.error ? ` · error: ${a.error}` : ""}
          </span>
          {a.mode === "LIVE_META" && a.requestIds?.length ? (
            <span className="mono muted live-proof" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
              {a.requestIds.length === 1 ? "request" : `${a.requestIds.length} requests`} {a.requestIds.join(" · ")}
            </span>
          ) : null}
          <ol className="audit" style={{ counterReset: "s" }}>
            {a.steps
              // The guard step shows app code's verdict on every tool but read_reconciliation; its raw result would repeat it.
              .filter((s) => s.kind !== "tool_result" || s.name === "read_reconciliation")
              .map((s, i) => (
                <li key={i} style={{ display: "grid", gridTemplateColumns: "28px 1fr", gap: 8 }}>
                  <span className="mono muted" style={{ fontSize: 13 }}>{String(i + 1).padStart(2, "0")}</span>
                  <span style={{ minWidth: 0 }}>
                    {s.kind === "tool_call" && (
                      <>
                        <span className="mono">{s.name}(</span>
                        <span className="mono muted" style={{ fontSize: 13, wordBreak: "break-word" }}>{short(s.args)}</span>
                        <span className="mono">)</span>
                      </>
                    )}
                    {s.kind === "tool_result" && (
                      <span className="mono muted" style={{ fontSize: 13, wordBreak: "break-word" }}>→ {short(s.result, 180)}</span>
                    )}
                    {s.kind === "guard" && s.verdict && (
                      <span className="row" style={{ gap: 8 }}>
                        <span className={s.verdict.accepted ? "st st-ok" : "st st-held"}>
                          {s.verdict.accepted ? "APP CODE · ACCEPTED" : "APP CODE · REJECTED"}
                          {s.name && s.name !== "propose_transition" ? ` · ${s.name.slice(0, 40)}` : ""}
                        </span>
                        <span style={{ fontSize: 14 }}>{s.verdict.reason}</span>
                      </span>
                    )}
                    {s.kind === "final" && <span style={{ fontSize: 14 }}>wrote the decision draft (validated against the policy text below)</span>}
                    {s.kind === "note" && <span className="muted" style={{ fontSize: 14 }}>{s.text}</span>}
                  </span>
                </li>
              ))}
          </ol>
          {a.effect === "hold" && <p style={{ margin: 0, fontWeight: 600 }}>The agent&apos;s HOLD proposal was accepted: the case moved to HELD.</p>}
        </>
      )}
      {requests.length > 0 && <EvidenceRequests requests={requests} c={c} onCase={onCase} />}
    </section>
  );
}

/** The open work items the agent left: what to supply, and a typed-note answer bound to the evidence digest. */
function EvidenceRequests({ requests, c, onCase }: { requests: EvidenceRequest[]; c?: ReturnCase; onCase?: (c: ReturnCase) => void }) {
  const [storedPerson, savePerson] = useStoredValue("rw-approver", MERCHANT.returnsLead);
  const [personEdit, setPerson] = useState<string | null>(null);
  const person = personEdit ?? storedPerson;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = requests.filter((r) => r.status === "open");
  const canAnswer = Boolean(c && onCase) && c?.state !== "Approved" && c?.state !== "Refunded";

  const submit = async (r: EvidenceRequest) => {
    const note = (notes[r.id] ?? "").trim();
    if (!c || !onCase || !note || !person.trim()) return;
    setBusy(r.id);
    setError(null);
    try {
      savePerson(person);
      // The note binds to the digest the request was asked about; the server checks it is still the case's.
      const res = await api.supplyEvidence(c.id, { requestId: r.id, note, person: person.trim(), evidenceDigest: r.digest });
      setNotes((x) => ({ ...x, [r.id]: "" }));
      onCase(res.case);
    } catch (e) {
      setError(e instanceof ApiError ? (e.status === 409 ? `${e.message}. Reload the case.` : e.message) : e instanceof Error ? e.message : String(e));
      if (e instanceof ApiError && e.code === "stale_request") api.case(c.id).then(onCase, () => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" style={{ gap: 10 }} aria-label="Evidence requests">
      <div className="stack" style={{ gap: 4 }}>
        <span className="eyebrow">Evidence requested · {open.length} open</span>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          A person supplies these later. An answer is a typed note on the record: it can&apos;t approve, clear the hold or reach the refund, and it is refused if the case evidence has changed since the request.
        </p>
      </div>
      {canAnswer && open.length > 0 && (
        <label className="field" style={{ maxWidth: 320 }}>
          Your name
          <input className="input" value={person} onChange={(e) => setPerson(e.target.value)} autoComplete="name" />
        </label>
      )}
      <ul className="audit" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {requests.map((r) => (
          <li key={r.id} className="stack" style={{ gap: 6 }}>
            <span className="row" style={{ gap: 8 }}>
              <span className={STATUS[r.status].cls}>{STATUS[r.status].text}</span>
              <span style={{ fontSize: 14 }}>
                {KIND_TEXT[r.kind]} for <span className="mono">{r.itemKey}</span>
              </span>
            </span>
            <span style={{ fontSize: 14 }}>{r.reason}</span>
            <span className="mono muted" style={{ fontSize: 13, overflowWrap: "anywhere" }}>
              {r.id} · digest {r.digest} · {r.mode === "LIVE_META" ? `asked by ${r.requestedBy} (live)` : `from a replayed recorded run of ${r.requestedBy}, not a live model decision`}
            </span>
            {r.status === "answered" && r.answer && (
              <span style={{ fontSize: 14 }}>
                Typed note by {r.answer.person}: &ldquo;{r.answer.note}&rdquo;
              </span>
            )}
            {r.status === "stale" && r.staleDetail && <span className="muted" style={{ fontSize: 14 }}>{r.staleDetail}</span>}
            {r.status === "open" && canAnswer && (
              <span className="row" style={{ gap: 8, alignItems: "flex-end" }}>
                <label className="field" style={{ flex: "1 1 260px", minWidth: 0 }}>
                  Typed note (no upload yet)
                  <textarea className="textarea" aria-label={`Typed note answering ${r.id}`} value={notes[r.id] ?? ""} maxLength={1000} onChange={(e) => setNotes((x) => ({ ...x, [r.id]: e.target.value }))} placeholder={r.kind === "spoken_observation" ? "what you saw at the bench" : "what the label / underside shows"} />
                </label>
                <button type="button" className="btn btn-sm" onClick={() => submit(r)} disabled={busy !== null || !(notes[r.id] ?? "").trim() || !person.trim()}>
                  {busy === r.id ? "Saving…" : "Save typed note"}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 14 }}>
          {error}
        </p>
      )}
    </div>
  );
}
