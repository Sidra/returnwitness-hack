"use client";

/**
 * Replays a clip's segmentation over a bench diagram: the BOX and TRAY zones, every item mask
 * with its raw track ID, hands and packing paper, and a numbered marker the moment the counter
 * counts an item. For the seeded clips this is the fixture segmentation (labelled); once real
 * clips exist the same overlay draws on top of the video.
 * Parents render it with key={clipId}, so a new clip starts from a clean state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Arrival, Frame, SegmentationResult } from "@/lib/domain/schemas";
import type { Zone } from "@/lib/vision/geometry";
import { LiveProof, ModeBadge } from "@/components/ModeBadge";
import { isRealReplay } from "@/lib/domain/schemas";

interface SceneData {
  segmentation: SegmentationResult;
  zones: { tray: Zone; box: Zone };
  items: Array<{ key: string; concept: string }>;
  hand: string;
  ignore: string[];
}

const tok = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim() || "#888";

/** `synthetic`: the case was decided on the synthetic scene, so replay that scene even if a recording of the real run exists. */
export function SceneReplay({ clipId, arrivals, autoPlayKey, onTime, showTracks = true, synthetic = false }: { clipId: string; arrivals?: Arrival[]; autoPlayKey?: number; onTime?: (t: number) => void; showTracks?: boolean; synthetic?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<SceneData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/scenes/${encodeURIComponent(clipId)}${synthetic ? "?scene=synthetic" : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const b = await r.json();
        if (!r.ok) throw new Error(b.message ?? "scene unavailable");
        return b as SceneData;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setFrame(d.segmentation.frames.length - 1);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [clipId, synthetic]);

  const total = data?.segmentation.frames.length ?? 0;
  const fps = data?.segmentation.fps ?? 5;

  // Auto-play when the parent starts an inspection.
  useEffect(() => {
    if (!data || autoPlayKey === undefined || autoPlayKey === 0) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = setTimeout(() => {
      if (reduce) {
        setFrame(total - 1);
        return;
      }
      setFrame(0);
      setPlaying(true);
    }, 0);
    return () => clearTimeout(id);
  }, [autoPlayKey, data, total]);

  useEffect(() => {
    if (!playing || !data) return;
    let last = performance.now();
    const step = (now: number) => {
      if (now - last >= 1000 / fps / 1.6) {
        last = now;
        setFrame((f) => {
          if (f >= total - 1) {
            setPlaying(false);
            return f;
          }
          return f + 1;
        });
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, data, fps, total]);

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const ink = tok(cv, "--ink");
    const muted = tok(cv, "--muted");
    const card = tok(cv, "--card");
    const card2 = tok(cv, "--card-2");
    const accent = tok(cv, "--accent");
    const success = tok(cv, "--success");
    const mono = tok(cv, "--font-mono");

    ctx.fillStyle = card2;
    ctx.fillRect(0, 0, W, H);
    const zone = (z: Zone, label: string) => {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(z.x0 * W + 4, z.y0 * H + 4, (z.x1 - z.x0) * W - 8, (z.y1 - z.y0) * H - 8);
      ctx.restore();
      ctx.fillStyle = muted;
      ctx.font = `600 11px ${mono}`;
      ctx.fillText(label, z.x0 * W + 12, z.y1 * H - 12);
    };
    zone(data.zones.box, "BOX");
    zone(data.zones.tray, "INSPECTED TRAY");

    const f: Frame | undefined = data.segmentation.frames[frame];
    const t = f?.t ?? 0;
    const itemConcepts = new Map(data.items.map((i) => [i.concept.toLowerCase(), i.key]));
    const masks = f?.masks ?? [];
    // Packing first, then items, hands on top.
    const order = (c: string) => (data.ignore.map((x) => x.toLowerCase()).includes(c) ? 0 : c === data.hand.toLowerCase() ? 2 : 1);
    for (const m of [...masks].sort((a, b) => order(a.concept.toLowerCase()) - order(b.concept.toLowerCase()))) {
      const [x, y, w, h] = m.bbox;
      const px = x * W;
      const py = y * H;
      const pw = w * W;
      const ph = h * H;
      const c = m.concept.toLowerCase();
      if (c === data.hand.toLowerCase()) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = muted;
        ctx.fillRect(px, py, pw, ph);
        ctx.restore();
        ctx.fillStyle = muted;
        ctx.font = `600 10px ${mono}`;
        ctx.fillText("hand", px + 4, py + 12);
        continue;
      }
      if (!itemConcepts.has(c)) {
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = muted;
        ctx.strokeRect(px, py, pw, ph);
        ctx.restore();
        ctx.fillStyle = muted;
        ctx.font = `10px ${mono}`;
        ctx.fillText(m.concept, px + 3, py + 11);
        continue;
      }
      ctx.fillStyle = card;
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = ink;
      ctx.font = `600 10px ${mono}`;
      ctx.fillText(`${m.concept} · id ${m.trackId}`, px, py - 4 < 10 ? py + ph + 12 : py - 4);
    }

    // Counted arrivals so far.
    (arrivals ?? [])
      .filter((a) => a.t <= t + 1e-6)
      .forEach((a, i) => {
        const cx = (a.bbox[0] + a.bbox[2]) * W;
        const cy = a.bbox[1] * H;
        ctx.fillStyle = success;
        ctx.fillRect(cx - 10, cy - 10, 20, 20);
        ctx.fillStyle = card;
        ctx.font = `700 12px ${mono}`;
        ctx.textAlign = "center";
        ctx.fillText(String(i + 1), cx, cy + 4);
        ctx.textAlign = "left";
      });

    ctx.fillStyle = ink;
    ctx.font = `600 12px ${mono}`;
    ctx.fillText(`t=${t.toFixed(1)}s  frame ${frame + 1}/${total}`, W - 168, 20);
    ctx.fillStyle = accent;
    ctx.fillRect(0, H - 4, (W * (frame + 1)) / Math.max(1, total), 4);
    onTime?.(t);
  }, [data, frame, arrivals, total, onTime]);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(() => draw());
    if (canvasRef.current) ro.observe(canvasRef.current);
    const mo = new MutationObserver(() => draw());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [draw]);

  const tracks = useMemo(() => (data ? summarizeTracks(data) : []), [data]);
  const nowT = data?.segmentation.frames[frame]?.t ?? 0;
  const liveIds = new Set((data?.segmentation.frames[frame]?.masks ?? []).map((m) => `${m.concept}#${m.trackId}`));

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="viewport">
        {data && (
          <div className="viewport-label">
            <ModeBadge mode={data.segmentation.source.mode} realReplay={isRealReplay(data.segmentation.source.provenance)} title={data.segmentation.source.provenance} />
            <LiveProof mode={data.segmentation.source.mode} model={data.segmentation.source.model} requestId={data.segmentation.source.requestIds[0] ? `${data.segmentation.source.requestIds[0]}${data.segmentation.source.requestIds.length > 1 ? ` +${data.segmentation.source.requestIds.length - 1}` : ""}` : undefined} />
          </div>
        )}
        <canvas ref={canvasRef} role="img" aria-label={`Overhead bench replay for ${clipId}: zones, item masks, hands and counted items`} />
        {error && (
          <p style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", margin: 0, padding: 16 }} className="muted">
            Replay unavailable: {error}
          </p>
        )}
      </div>
      {data && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => (frame >= total - 1 ? (setFrame(0), setPlaying(true)) : setPlaying((p) => !p))}>
              {playing ? "Pause" : frame >= total - 1 ? "Replay clip" : "Play"}
            </button>
            <label className="scrub-control">
            <span className="sr-only">Scrub through the clip</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, total - 1)}
              value={frame}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
              aria-label="Scrub through the clip"
              style={{ width: 180, accentColor: "var(--accent)" }}
            />
            </label>
          </div>
          <span className="fixture-label" title={data.segmentation.source.provenance}>
            {data.segmentation.source.model === "synthetic" ? "Synthetic scene, not a filmed clip" : data.segmentation.source.provenance}
          </span>
        </div>
      )}
      {data && showTracks && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4 className="h3" style={{ fontSize: 16 }}>What SAM returned vs what was counted</h4>
            <span className="mono muted" style={{ fontSize: 13 }}>raw track IDs never feed the count</span>
          </div>
          <div className="table-wrap">
            <table className="table table-dense" aria-label="Raw segmenter tracks per item and the tray counter's count">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Raw SAM track IDs (seen from–to, zone)</th>
                  <th className="num">IDs</th>
                  <th className="num">Counted</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((row) => {
                  const counted = (arrivals ?? []).filter((a) => a.itemKey === row.key && a.t <= nowT + 1e-6).length;
                  return (
                    <tr key={row.key}>
                      <td>{row.concept}</td>
                      <td>
                        {row.ids.map((t) => (
                          <span key={t.id} className="kbd" style={{ marginRight: 6, marginBottom: 4, display: "inline-block", ...(liveIds.has(`${row.concept}#${t.id}`) ? { background: "var(--ink)", color: "var(--bg)" } : {}) }} title={`${t.from.toFixed(1)}–${t.to.toFixed(1)} s`}>
                            id {t.id} · {t.from.toFixed(1)}–{t.to.toFixed(1)} s · {t.zones}
                          </span>
                        ))}
                        {row.ids.length === 0 && <span className="muted">never seen</span>}
                      </td>
                      <td className="num">{row.ids.length}</td>
                      <td className="num">
                        <strong>{arrivals ? counted : "—"}</strong>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Per kit item: every raw track ID the segmenter issued, when it was seen, and where. */
function summarizeTracks(d: SceneData) {
  const inZ = (x: number, y: number, z: Zone) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  return d.items.map((it) => {
    const byId = new Map<string, { id: string; from: number; to: number; zones: Set<string> }>();
    for (const f of d.segmentation.frames) {
      for (const m of f.masks) {
        if (m.concept.toLowerCase() !== it.concept.toLowerCase()) continue;
        const id = String(m.trackId).replace(/^.*#/, "");
        const cx = m.bbox[0] + m.bbox[2] / 2;
        const cy = m.bbox[1] + m.bbox[3] / 2;
        const zone = inZ(cx, cy, d.zones.tray) ? "tray" : inZ(cx, cy, d.zones.box) ? "box" : "gap";
        const cur = byId.get(id) ?? { id, from: f.t, to: f.t, zones: new Set<string>() };
        cur.to = f.t;
        cur.zones.add(zone);
        byId.set(id, cur);
      }
    }
    return { key: it.key, concept: it.concept, ids: [...byId.values()].map((v) => ({ ...v, zones: [...v.zones].join("→") })) };
  });
}
