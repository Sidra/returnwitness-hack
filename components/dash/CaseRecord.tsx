"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReturnCase } from "@/lib/domain/case";
import { api, ApiError } from "@/lib/client/api";
import { rmaById } from "@/data/fixtures";
import { SceneReplay } from "./SceneReplay";
import { InspectionResult } from "./InspectionResult";
import { CaseSummary } from "./CaseSummary";
import { StageRail, stagesFromTimings } from "./StageRail";
import { isRealReplay } from "@/lib/domain/schemas";
import { LocalTime } from "@/components/LocalTime";

/** The full inspection record: the evidence, the reasoning, the decision trail, the money. */
export function CaseRecord() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<ReturnCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .case(id)
      .then(setC)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? "This inspection isn't on this server (records live in this server's store)." : String(e)));
  }, [id]);

  if (error)
    return (
      <div className="card">
        <p style={{ margin: 0 }}>{error}</p>
      </div>
    );
  if (!c) return <p className="muted">Loading the record…</p>;
  const rma = rmaById(c.rmaId);
  return (
    <>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">
            Inspection record · {c.id} · run {c.runId}
          </span>
          <h1 className="h1">
            {c.rmaId} · {rma?.scenario}
          </h1>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
          <a className="btn btn-sm" href={`/api/cases/${encodeURIComponent(c.id)}/packet`} download>
            Download evidence packet
          </a>
          <span className="muted" style={{ fontSize: 13, maxWidth: "34ch", textAlign: "right" }}>
            Signed JSON for a dispute or carrier claim: the slip, what the bench recorded, the clauses, the trail. Check it at /api/packet/verify.
          </span>
        </div>
      </div>
      <div className="stack" style={{ gap: 32 }}>
        <CaseSummary c={c} requestedCents={rma?.requestedRefundCents} />
        <div className="bench-grid">
          <SceneReplay key={c.clip.clipId} clipId={c.clip.clipId} arrivals={c.count?.arrivals} />
          <div className="stack" style={{ gap: 16 }}>
            <StageRail stages={stagesFromTimings(c.timings)} realReplay={isRealReplay(c.clip.provenance)} />
            {c.count && (
              <div className="card-flat stack" style={{ gap: 6 }}>
                <span className="eyebrow">Counter diagnostics</span>
                <span style={{ fontSize: 14 }}>
                  Raw segmenter track IDs per item:{" "}
                  <span className="mono">
                    {Object.entries(c.count.diagnostics.rawTrackIdsPerItem)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(" · ")}
                  </span>
                </span>
                <span style={{ fontSize: 14 }}>
                  Counted arrivals:{" "}
                  <span className="mono">
                    {Object.entries(c.count.counts)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(" · ")}
                  </span>
                </span>
                <span className="muted" style={{ fontSize: 13 }}>
                  The count comes from where items settled in the tray, never from the number of track IDs.
                </span>
                {c.count.flags.length > 0 && (
                  <ul className="audit">
                    {c.count.flags.map((f, i) => (
                      <li key={i}>
                        <span className="mono">{f.code}</span> · {f.detail} <span className="muted mono">at {f.t.toFixed(1)} s</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
        <InspectionResult c={c} onCase={setC} compact />
        <div className="stack" style={{ gap: 8 }}>
          <h2 className="h3">Decision trail</h2>
          <ul className="audit">
            {c.audit.map((a, i) => (
              <li key={i}>
                <span className="mono muted" style={{ fontSize: 13 }}>
                  <LocalTime iso={a.at} />
                </span>{" "}
                <strong>{a.from ?? "·"} → {a.to}</strong> <span className="mono" style={{ fontSize: 13 }}>{a.actor}</span> · {a.detail}
              </li>
            ))}
          </ul>
          {c.approval && (
            <p className="mono muted" style={{ fontSize: 13, margin: 0, wordBreak: "break-all" }}>
              Approval bound to digest {c.approval.digest} · token expires <LocalTime iso={c.approval.expiresAt} />
            </p>
          )}
        </div>
      </div>
    </>
  );
}
