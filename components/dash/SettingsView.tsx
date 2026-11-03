"use client";

import { useEffect, useState } from "react";
import { api, type SystemStatus } from "@/lib/client/api";
import { MERCHANT } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { formatCentsExact } from "@/lib/format";
import { useStoredValue } from "@/lib/client/storage";

const STORE_NOTE: Record<string, string> = {
  "upstash-redis": "Upstash Redis, shared by every server instance; records expire after 14 days",
  "memory+file": "in memory, mirrored to .data/store.json (local)",
  memory: "in memory: records reset when the server restarts",
};

export function SettingsView({ counter, initialStatus }: { initialStatus?: SystemStatus; counter: { tray: { x0: number; x1: number }; box: { x0: number; x1: number }; settleFrames: number; settleMotion: number; mergeAreaRatio: number; slotIoU: number } }) {
  const [s, setS] = useState<SystemStatus | null>(initialStatus ?? null);
  const [stored, save] = useStoredValue("rw-approver", MERCHANT.returnsLead);
  const [edit, setApprover] = useState<string | null>(null);
  const approver = edit ?? stored;
  const [saved, setSaved] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  useEffect(() => {
    api.status().then(setS).catch(() => setS(null));
  }, []);
  const ok = (b: boolean) => <span className={b ? "st st-ok" : "st st-held"}>{b ? "ON" : "OFF"}</span>;
  return (
    <div className="stack" style={{ gap: 32 }}>
      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">What is live on this server</h2>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr>
                <td>Meta Model API key</td>
                <td>{s ? ok(s.meta.keyPresent) : "…"}</td>
                <td className="muted">{s?.meta.keyPresent ? (s.publicDemo ? "present, but the public demo profile uses fixtures only" : "SAM 3.1, Muse Spark 1.3 and Muse Wonder 1.0 can run live") : "not configured: segmentation replays recorded fixtures, labelled on every result"}</td>
              </tr>
              <tr>
                <td>Models</td>
                <td colSpan={2} className="mono" style={{ fontSize: 13 }}>
                  {s ? `${s.meta.models.sam} · ${s.meta.models.spark} · ${s.meta.models.wonder} @ ${s.meta.baseURL}` : "…"}
                  {s && s.meta.refusedModels.length > 0 && (
                    <div style={{ color: "var(--danger)", fontFamily: "var(--font-body)", marginTop: 4 }}>
                      Refused (contributor mode, Meta may train on it): {s.meta.refusedModels.join(", ")}. Calls to it hold the case instead.
                    </div>
                  )}
                </td>
              </tr>
              <tr>
                <td>Open-weight audit (Muse Spark Open)</td>
                <td>{s ? ok(s.openWeight.ready) : "…"}</td>
                <td className="muted">{s?.openWeight.ready ? `${s.openWeight.provider} · ${s.openWeight.model}` : `[Open-weight audit · off on this server — runs on Baseten in local runs]${s?.openWeight.reason ? `: ${s.openWeight.reason}` : ""}`}</td>
              </tr>
              <tr>
                <td>SAM 3.1 failover (open weights on Modal)</td>
                <td>{s ? ok(s.samFailover.enabled) : "…"}</td>
                <td className="muted">{s?.samFailover.enabled ? `configured (${s.samFailover.model}): runs only when Meta's hosted SAM 3.1 errors or times out` : `built and mock-tested, not configured: if Meta's SAM fails, the case is held${s?.samFailover.reason ? ` (${s.samFailover.reason})` : ""}`}</td>
              </tr>
              <tr>
                <td>Label reader (Muse Glimmer open weights{s?.labelReader.provider === "fireworks" ? " on Fireworks" : " on Modal"})</td>
                <td>{s ? ok(s.labelReader.enabled) : "…"}</td>
                <td className="muted">
                  {s ? (s.labelReader.enabled ? `${s.labelReader.status}: reads serial and SKU labels on the settled crops; can only raise holds` : s.labelReader.status) : "…"}
                  {s && s.labelReader.provider !== "fireworks" &&<div style={{ marginTop: 4 }}>A fine-tuned adapter is used only after it beats the base model on held-out reviewer corrections with no extra false clears.</div>}
                </td>
              </tr>
              <tr>
                <td>Judge live mode (public site)</td>
                <td>{s ? ok(Boolean(s.judgeLive?.enabled)) : "…"}</td>
                <td className="muted">{s?.judgeLive ? s.judgeLive.reason : "…"}. Capped per visitor and per day in shared Redis; a kill switch turns it off without a redeploy.</td>
              </tr>
              <tr>
                <td>Stripe refund rail</td>
                <td>{s ? ok(s.stripe.ok) : "…"}</td>
                <td className="muted">{s?.stripe.ok ? "test mode only (the server refuses any key that isn't sk_test_)" : s?.stripe.error}</td>
              </tr>
              <tr>
                <td>Approval token secret</td>
                <td>{s ? ok(s.secret.ok) : "…"}</td>
                <td className="muted">{s?.secret.ok ? "HMAC-SHA256, single-use, 10-minute tokens" : s?.secret.error}</td>
              </tr>
              <tr>
                <td>Case store</td>
                <td>{s ? <span className="st">{s.store}</span> : "…"}</td>
                <td className="muted">{s ? STORE_NOTE[s.store] ?? s.store : ""}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">Bench and counter</h2>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              <tr><td>Box zone</td><td className="mono">x {counter.box.x0}–{counter.box.x1} of the frame</td></tr>
              <tr><td>Inspected tray zone</td><td className="mono">x {counter.tray.x0}–{counter.tray.x1} of the frame</td></tr>
              <tr><td>Settle time</td><td className="mono">{counter.settleFrames} frames at 5 fps ({(counter.settleFrames / 5).toFixed(1)} s), moving less than {counter.settleMotion} of the frame</td></tr>
              <tr><td>Same-spot match</td><td className="mono">IoU ≥ {counter.slotIoU}</td></tr>
              <tr><td>Merge check</td><td className="mono">mask ≥ {counter.mergeAreaRatio}× the item&apos;s expected size → HOLD</td></tr>
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Zones and thresholds are calibrated from the empty-mat and clean clips; changes are committed with the gate results.</p>
      </section>

      <section className="stack" style={{ gap: 8 }}>
        <h2 className="h3">Kit on the packing slip</h2>
        <div className="table-wrap">
          <table className="table table-dense">
            <thead><tr><th>Item</th><th>SKU</th><th>What the camera is asked to find</th><th className="num">Price</th><th>Serial label</th></tr></thead>
            <tbody>
              {KIT.items.map((i) => (
                <tr key={i.key}><td>{i.name}</td><td>{i.sku}</td><td>&ldquo;{i.samConcept}&rdquo;</td><td className="num">{formatCentsExact(i.unitPriceCents)}</td><td>{i.requiresSerial ? "required" : "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <span className="fixture-label">[Seeded merchant order &amp; RMA fixture]</span>
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <h2 className="h3">Approver on this device</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field" style={{ flex: "1 1 260px" }}>
            Name recorded on approvals
            <input className="input" value={approver} onChange={(e) => { setApprover(e.target.value); setSaved(false); }} />
          </label>
          <button type="button" className="btn btn-sm" onClick={() => setSaved(save(approver))}>
            Save
          </button>
          {saved && <span className="muted" style={{ fontSize: 14 }}>Saved in this browser.</span>}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>No sign-in in this version: the name is recorded on the approval and in the decision trail.</p>
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <h2 className="h3">Demo data</h2>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => api.reset().then(() => setResetMsg("Inspection records cleared. The seeded RMAs are ready to inspect again.")).catch((e) => setResetMsg(String(e)))}>
            Clear inspection records
          </button>
          {resetMsg && <span className="muted" style={{ fontSize: 14 }}>{resetMsg}</span>}
        </div>
      </section>
    </div>
  );
}
