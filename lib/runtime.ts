/**
 * Picks the implementation for each stage from the environment, so every result can say what
 * produced it. Fixture segmentation for the seeded clips; live SAM 3.1 only for a real clip with
 * a key. Spark/Wonder only with a key (and not in the public demo profile). No non-Meta fallback exists.
 */
import { KIT } from "@/data/kit.config";
import fs from "node:fs";
import path from "node:path";
import { ORDERS, POLICY, RMAS, rmaById, orderFor } from "@/data/fixtures";
import type { PipelineDeps } from "@/lib/engine/pipeline";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { MetaSamSegmenter } from "@/lib/meta/sam";
import { judgeLiveConfig } from "@/lib/judge-live";
import { withModalFailover } from "@/lib/openweights/modal-sam";
import { recordedSparkReconcile, sparkReconcile } from "@/lib/meta/readers";
import { replayWonderAgent, runWonderAgent } from "@/lib/meta/wonder-agent";
import { loadRecording } from "@/lib/meta/recordings";
import { OPEN_WEIGHT_NOT_RUN, openWeightAudit, openWeightConfig, recordedOpenWeightAudit } from "@/lib/openweights/auditor";
import { recordedGlimmerLabelRead } from "@/lib/openweights/fireworks";
import { selectLabelReader } from "@/lib/openweights/label-reader";
import { modalSamConfig } from "@/lib/openweights/modal-sam";
import { liveMetaAvailable, metaConfig } from "@/lib/meta/config";
import { getStore } from "@/lib/store/case-store";
import { getRail } from "@/lib/payments/stripe-rail";
import { requireSecret } from "@/lib/engine/approval";
import type { ReturnCase } from "@/lib/domain/case";
import type { ReaderEvidence } from "@/lib/meta/readers";
import { frameJpeg } from "@/lib/vision/frames";
import { KitCalibration, withCalibration } from "@/lib/vision/calibration";
import kitCalibrationJson from "@/data/kit-calibration.json";
import { probe } from "@/lib/vision/prepare-clip";

/** RETURNWITNESS_HAND_BLOCKS_TRAY=1 turns on the hand-overlap fallback rule (decided by the gate). */
export const COUNTER_CONFIG = counterConfigForKit(KIT, { handBlocksTray: process.env.RETURNWITNESS_HAND_BLOCKS_TRAY === "1" });

/** Item sizes measured from clean clip g1 (data/kit-calibration.json); null until calibrated or if the file is malformed. */
const parsedCalibration = KitCalibration.safeParse(kitCalibrationJson);
export const KIT_CALIBRATION: KitCalibration | null = parsedCalibration.success ? parsedCalibration.data : null;

/** Real footage (live or a recorded real run) counts with the calibrated sizes; synthetic scenes keep the estimates they were built at. */
export const REAL_FOOTAGE_COUNTER_CONFIG = withCalibration(COUNTER_CONFIG, KIT_CALIBRATION);

/** Scripts that calibrate mid-run read the file again (the import above is fixed at process start). */
export function readKitCalibration(file = path.join(process.cwd(), "data", "kit-calibration.json")): KitCalibration | null {
  try {
    const r = KitCalibration.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function pipelineDeps(opts: { liveModels: boolean; liveSegmentation: boolean; clipId?: string; judgeLive?: boolean }, onStage?: PipelineDeps["onStage"]): PipelineDeps {
  // A reserved judge live run (lib/judge-live.ts) lifts the public profile's fixtures-only rule for this one run.
  const base = metaConfig();
  const cfg = opts.judgeLive ? { ...base, publicDemo: false } : base;
  const live = liveMetaAvailable(cfg);
  const liveModels = live && opts.liveModels;
  const readers: PipelineDeps["readers"] = [];
  if (liveModels) readers.push({ name: "muse-spark-1.3", required: true, readsSerials: true, read: (e) => sparkReconcile(e, cfg) });
  // Public / no key: replay a recorded LIVE Spark answer for this clip when one exists.
  else if (opts.clipId && loadRecording(opts.clipId, "spark")) readers.push({ name: "muse-spark-1.3 (recorded)", required: false, readsSerials: true, read: (e) => recordedSparkReconcile(e, cfg) });

  // Open-weight auditor (Muse Spark Open): never required, can only raise holds.
  const ow = openWeightConfig();
  const skippedReaders: PipelineDeps["skippedReaders"] = [];
  if (opts.liveSegmentation && ow.provider) readers.push({ name: `muse-spark-open (${ow.provider})`, required: false, readsSerials: false, read: (e) => openWeightAudit(e, ow) });
  else if (opts.clipId && loadRecording(opts.clipId, "audit")) readers.push({ name: "muse-spark-open (recorded)", required: false, readsSerials: false, read: (e) => recordedOpenWeightAudit(e) });
  else skippedReaders.push({ name: "muse-spark-open", model: ow.model, reason: ow.provider ? "runs on live clips only (it audits the settled-item crops)" : `${OPEN_WEIGHT_NOT_RUN}: ${ow.reason}` });

  // Label reader (Muse Glimmer): my Modal GPU when RETURNWITNESS_LABEL_READER=modal (takes precedence),
  // Fireworks when =fireworks. Never required; readsSerials so an unread or wrong serial holds.
  const lr = selectLabelReader();
  if (opts.liveSegmentation && lr.read) readers.push({ name: lr.readerName, required: false, readsSerials: true, read: lr.read });
  else if (opts.clipId && loadRecording(opts.clipId, "labels")) readers.push({ name: "muse-glimmer (recorded)", required: false, readsSerials: true, read: (e) => recordedGlimmerLabelRead(e) });
  // A replay of a recorded real run with no Glimmer answer: the live run got none (it didn't answer in time or wasn't on);
  // say that, not that the reader is off on this server.
  else if (opts.clipId && loadRecording(opts.clipId, "sam") && !liveModels) skippedReaders.push({ name: "muse-glimmer", model: lr.model ?? "meta-models/Muse-Glimmer-30B", reason: "no recorded answer for this clip: the replayed live run got none from the label reader" });
  else skippedReaders.push({ name: "muse-glimmer", model: lr.model ?? "not configured", reason: lr.enabled ? "runs on live clips only (it reads the settled-item crops)" : lr.reason });
  return {
    store: getStore(),
    // Live clips: Meta SAM 3.1, with SAM 3.1 open weights on Modal as the failover when RETURNWITNESS_SAM_FAILOVER=modal.
    segmenter: live && opts.liveSegmentation ? withModalFailover(new MetaSamSegmenter(cfg)) : new FixtureSegmenter(),
    // A replay of a recorded real run counts exactly as the live run did: SAM masks carry no text, so the counter's
    // label check is off and the readers (recorded) answer for labels.
    counterConfig: (live && opts.liveSegmentation) || (opts.clipId && loadRecording(opts.clipId, "sam")) ? { ...REAL_FOOTAGE_COUNTER_CONFIG, checkLabels: false } : COUNTER_CONFIG,
    readers,
    skippedReaders,
    agent: liveModels ? (ctx) => runWonderAgent(ctx, cfg) : async (ctx) => replayWonderAgent(ctx),
    agentNotRun: live ? "live models not requested for this run and no recorded agent run for this clip" : "no live Meta key on this server and no recorded agent run for this clip yet",
    onStage,
  };
}

export function approvalSecret(): string {
  return requireSecret(process.env.RETURNWITNESS_APPROVAL_SECRET ?? (process.env.RETURNWITNESS_PUBLIC_DEMO === "1" ? undefined : devSecret()));
}

// Local dev without a configured secret: a per-process random secret (tokens die on restart, which is safe).
let _dev: string | null = null;
function devSecret() {
  if (process.env.NODE_ENV === "production") return undefined;
  _dev ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  return _dev;
}

/** Filmed bench clips for the seeded RMAs (d1–d3), named by clip id. Local only; never on the public deploy. */
export const DEMO_CLIPS_DIR = () => process.env.RETURNWITNESS_DEMO_CLIPS_DIR || path.join(process.cwd(), "gate", "clips");

export function seededClipFile(clipId: string): string | null {
  const dir = DEMO_CLIPS_DIR();
  if (!/^[a-z0-9-]+$/.test(clipId) || !fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.replace(/\.[a-z0-9]+$/i, "") === clipId);
  return f ? path.join(dir, f) : null;
}

export function systemStatus() {
  const cfg = metaConfig();
  const rail = getRail();
  return {
    meta: { keyPresent: Boolean(cfg.apiKey), live: liveMetaAvailable(cfg), baseURL: cfg.baseURL, models: cfg.models, refusedModels: cfg.refusedModels },
    openWeight: (() => {
      const ow = openWeightConfig();
      return { provider: ow.provider, model: ow.model, ready: Boolean(ow.provider), reason: ow.reason };
    })(),
    samFailover: (() => {
      const m = modalSamConfig();
      return { enabled: m.enabled, model: m.model, reason: m.reason };
    })(),
    labelReader: (() => {
      const l = selectLabelReader();
      return { enabled: l.enabled, provider: l.provider, model: l.model, adapter: l.adapter, reason: l.reason, status: l.status };
    })(),
    publicDemo: cfg.publicDemo,
    /** Seeded RMAs whose filmed clip is on this server, so they can run live end to end. */
    liveSeeded: liveMetaAvailable(cfg) ? RMAS.filter((r) => seededClipFile(r.clipId)).map((r) => r.id) : [],
    judgeLive: (() => {
      const j = judgeLiveConfig();
      return { enabled: j.enabled, perVisitorPerDay: j.perVisitorPerDay, dailyCap: j.dailyCap, reason: j.reason };
    })(),
    store: getStore().kind,
    stripe: rail instanceof Error ? { ok: false, error: rail.message } : { ok: true, mode: rail.mode },
    secret: (() => {
      try {
        approvalSecret();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })(),
  };
}

export async function seedCharges() {
  const rail = getRail();
  if (rail instanceof Error) return { ok: false as const, error: rail.message, charges: [] };
  const charges = [];
  for (const o of ORDERS) charges.push(await rail.ensureCharge({ id: o.id, totalCents: o.totalCents, customerEmail: o.customer.email }));
  return { ok: true as const, charges };
}

export { POLICY, rmaById, orderFor };

/**
 * Reader evidence for a live clip: four evenly spaced key frames plus a padded crop of each
 * counted item at the moment it settled, cut from the ORIGINAL full-resolution clip so the
 * serial labels stay legible.
 */
/** The four key frames of a clip, exactly as the Spark reader sees them (the same-input A/B gives Spark alone these). */
export function keyFrameImages(srcPath: string, fallbackDurationS?: number): ReaderEvidence["images"] {
  const dur = probe(srcPath).durationS || fallbackDurationS || 1;
  return [0.2, 0.45, 0.7, 0.95].map((f) => {
    const t = Math.max(0, Math.min(dur - 0.05, dur * f));
    return { caption: `key frame at ${t.toFixed(1)} s (overhead, box left, inspected tray right)`, dataUrl: frameJpeg(srcPath, t, { maxW: 1280 }) };
  });
}

export function liveEvidenceImages(srcPath: string) {
  return async (c: ReturnCase): Promise<ReaderEvidence["images"]> => {
    const meta = probe(srcPath);
    const images: ReaderEvidence["images"] = keyFrameImages(srcPath, c.clip.durationS);
    for (const a of c.count?.arrivals ?? []) {
      images.push({
        caption: `crop of the counted ${a.itemKey} as it settled in the tray at ${a.t.toFixed(1)} s (read any serial label exactly)`,
        dataUrl: frameJpeg(srcPath, a.t + 0.2, { bbox: a.bbox, width: meta.width, height: meta.height, pad: 0.35, maxW: 1024 }),
      });
    }
    return images;
  };
}
