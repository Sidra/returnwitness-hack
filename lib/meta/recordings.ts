/**
 * Recorded Meta runs. Every live call's answer is saved per clip, so the public site (which never
 * holds the Meta key) replays REAL Meta output, labelled "RECORDED LIVE RUN · <model> · <time> · req <id>" (ModeBadge `replay`).
 */
import fs from "node:fs";
import path from "node:path";

// "sam-modal": a failover run on Modal is kept apart, so it never overwrites a Meta SAM recording the public site replays.
export type RecordingKind = "sam" | "sam-modal" | "spark" | "wonder" | "audit" | "labels";

const dir = () => process.env.RETURNWITNESS_RECORDINGS_DIR || path.join(process.cwd(), "data", "recordings");
const file = (clipId: string, kind: RecordingKind) => path.join(dir(), `${clipId.replace(/[^a-z0-9-]/gi, "_")}.${kind}.json`);

/** What a replay needs to say which real call it is: shown as "RECORDED LIVE RUN · model · time · req id". */
export interface RecordingMeta {
  model?: string;
  requestId?: string;
}

export function saveRecording(clipId: string, kind: RecordingKind, data: unknown, meta: RecordingMeta = {}): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(clipId, kind), JSON.stringify({ recordedAt: new Date().toISOString(), kind, clipId, ...(Object.keys(meta).length ? { meta } : {}), data }));
  } catch {
    /* read-only filesystem: skip */
  }
}

export function loadRecording<T>(clipId: string, kind: RecordingKind): { recordedAt: string; data: T; meta?: RecordingMeta } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file(clipId, kind), "utf8"));
    // Older SAM recordings were saved bare (the SegmentationResult itself).
    return raw && raw.kind === kind ? { recordedAt: raw.recordedAt, data: raw.data as T, ...(raw.meta ? { meta: raw.meta as RecordingMeta } : {}) } : { recordedAt: raw?.source?.recordedAt ?? "", data: raw as T };
  } catch {
    return null;
  }
}
