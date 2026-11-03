"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import { RMAS, MERCHANT, orderFor } from "@/data/fixtures";
import { formatCents } from "@/lib/format";
import { runInspectionStream, uploadClip, api, ApiError, type SystemStatus } from "@/lib/client/api";
import { SceneReplay } from "./SceneReplay";
import { CameraPicker } from "./CameraPicker";
import { StageRail, EMPTY_STAGES, type StageMap } from "./StageRail";
import { isRealReplay } from "@/lib/domain/schemas";
import { InspectionResult } from "./InspectionResult";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";
import { BenchVoicePrompt } from "./BenchVoicePrompt";
import { CompleteKitCard } from "./CompleteKitCard";

/**
 * The screen at the returns bench: pick the RMA, watch the clip, run the inspection with live
 * stage timers, and act on the result. Seeded RMAs replay their recorded segmentation; the live
 * camera tab records real clips (live inspection of them runs once the Meta key is configured).
 */
export function BenchStation({ initialRma, guided = false, onCase, autoRunKey = 0 }: { initialRma?: string; guided?: boolean; onCase?: (c: ReturnCase) => void; autoRunKey?: number }) {
  const [rmaId, setRmaId] = useState(initialRma ?? RMAS[0].id);
  const [tab, setTab] = useState<"replay" | "camera">("replay");
  const [stages, setStages] = useState<StageMap>(EMPTY_STAGES);
  const [result, setResult] = useState<ReturnCase | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playKey, setPlayKey] = useState(0);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [live, setLive] = useState(false);
  const [voiceNoteId, setVoiceNoteId] = useState<string | null>(null);
  // This return's filmed clip is on the server and the key is configured: run it live end to end.
  const liveSeeded = Boolean(status?.liveSeeded?.includes(rmaId));

  const rma = RMAS.find((r) => r.id === rmaId)!;
  const order = orderFor(rma.orderId);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
  }, []);
  const pickRma = (id: string) => {
    setRmaId(id);
    setVoiceNoteId(null);
    setResult(null);
    setStages(EMPTY_STAGES);
    setError(null);
  };

  const setCase = useCallback(
    (c: ReturnCase) => {
      setResult(c);
      onCase?.(c);
    },
    [onCase],
  );

  const [clip, setClip] = useState<Blob | null>(null);

  const inspect = async (liveClip?: Blob) => {
    setRunning(true);
    setError(null);
    setResult(null);
    setStages(EMPTY_STAGES);
    setPlayKey((k) => k + 1);
    try {
      const clipId = liveClip ? await uploadClip(rmaId, liveClip) : undefined;
      const c = await runInspectionStream(
        rmaId,
        (e) => {
          if (e.stage === "done") return;
          setStages((s) => ({ ...s, [e.stage]: e.status === "start" ? { state: "running", mode: e.mode } : { state: "done", ms: e.ms, mode: e.mode } }));
        },
        { live, clipId, ...(voiceNoteId ? { voiceNoteId } : {}), ...(!liveClip && liveSeeded ? { liveSeeded: true } : {}) },
      );
      setCase(c);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  // The Instant Demo starts the inspection without a second click.
  useEffect(() => {
    if (autoRunKey === 0) return;
    const id = setTimeout(() => void inspect(), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRunKey]);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <label className="field" style={{ minWidth: 280, flex: "1 1 320px" }}>
          Return authorization at {MERCHANT.bench}
          <select className="select" value={rmaId} onChange={(e) => pickRma(e.target.value)} disabled={running}>
            {RMAS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.customer.name} · {formatCents(r.requestedRefundCents)} requested
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          {(status?.meta.live || status?.judgeLive?.enabled) && (
            <label className="row" style={{ gap: 6, fontSize: 14 }}>
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Send counts to Muse Spark + Wonder (live)
              {status?.publicDemo && status.judgeLive?.enabled ? <span className="muted"> · {status.judgeLive.perVisitorPerDay} live runs per visitor per day</span> : null}
            </label>
          )}
          <button type="button" className="btn btn-primary" onClick={() => inspect()} disabled={running}>
            {running ? "Inspecting…" : liveSeeded ? "Inspect live (SAM 3.1 + Spark + Wonder + Voice)" : guided ? "Run this inspection" : "Inspect this return"}
          </button>
        </div>
      </div>

      <div className="bench-grid">
        <div className="stack" style={{ gap: 12 }}>
          {!guided && (
            <div className="row" role="tablist" aria-label="Clip source">
              <button type="button" role="tab" aria-selected={tab === "replay"} className={`btn btn-sm ${tab === "replay" ? "btn-primary" : ""}`} onClick={() => setTab("replay")}>
                Clip replay
              </button>
              <button type="button" role="tab" aria-selected={tab === "camera"} className={`btn btn-sm ${tab === "camera" ? "btn-primary" : ""}`} onClick={() => setTab("camera")}>
                Live camera
              </button>
            </div>
          )}
          {tab === "replay" || guided ? (
            <SceneReplay key={rma.clipId} clipId={rma.clipId} arrivals={result?.count?.arrivals} autoPlayKey={playKey} />
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <CameraPicker clipName={`${rma.id.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`} onRecorded={setClip} />
              {status?.meta.live && !status.publicDemo ? (
                <div className="row">
                  <button type="button" className="btn btn-primary" disabled={!clip || running} onClick={() => clip && inspect(clip)}>
                    {running ? "Inspecting live…" : "Inspect this clip live (SAM 3.1 + Muse Spark + Muse Wonder)"}
                  </button>
                  <span className="muted" style={{ fontSize: 14 }}>{clip ? "Uses Meta Model API credits." : "Record a clip first."}</span>
                </div>
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                  {status?.publicDemo
                    ? "Uploads are off on the public demo: the clip stays in this browser. The seeded RMAs replay their recorded clips."
                    : "Recording works now. Inspecting a recorded clip needs the Meta Model API key, which isn't configured on this server yet; the seeded RMAs use their recorded clips meanwhile."}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <div className="card-flat stack" style={{ gap: 6 }}>
            <span className="eyebrow">Packing slip · order {order?.id}</span>
            {order?.slip.lines.map((l) => (
              <div className="row" key={l.itemKey} style={{ justifyContent: "space-between" }}>
                <span>
                  {l.qty} × {l.description}
                </span>
                <span className="mono muted" style={{ fontSize: 13 }}>
                  {l.sku}
                  {l.serial ? ` · SN ${l.serial}` : ""}
                </span>
              </div>
            ))}
            <span className="muted" style={{ fontSize: 14 }}>Customer says: &ldquo;{rma.reason}&rdquo;</span>
            <span className="fixture-label">[Seeded merchant order &amp; RMA fixture]</span>
          </div>
          {!guided && <CompleteKitCard />}
          {!guided && (
            <VoiceNoteRecorder
              key={rmaId}
              enabled={Boolean(status?.meta.live && !status.publicDemo)}
              disabledReason={status?.publicDemo ? "Voice notes are off on the public demo: the microphone isn't used here." : "Recording a voice note needs the Meta Model API key on this server (Muse Voice Transcribe)."}
              onNote={(id) => setVoiceNoteId(id)}
            />
          )}
          <StageRail stages={stages} realReplay={isRealReplay(result?.clip.provenance)} />
        </div>
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger)", fontWeight: 600 }}>
          {error}
        </p>
      )}
      {result && (
        <div className="rule-top stack" style={{ paddingTop: 16, gap: 16 }}>
          <BenchVoicePrompt
            key={result.id}
            c={result}
            onCase={setCase}
            voiceEnabled={Boolean(status?.meta.live && !status.publicDemo)}
            voiceDisabledReason={status?.publicDemo ? "off on the public demo (the microphone isn't used here)." : "needs the Meta Model API key on this server (Muse Voice Transcribe)."}
          />
          <InspectionResult c={result} onCase={setCase} compact={guided} />
        </div>
      )}
    </div>
  );
}
