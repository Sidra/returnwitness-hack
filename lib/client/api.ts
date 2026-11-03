"use client";

import type { EvidenceRequest, ReturnCase, ReviewerCorrection, VoiceNote } from "@/lib/domain/case";
import type { StageEvent } from "@/lib/engine/pipeline";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  } catch {
    throw new ApiError("network", "Can't reach the ReturnWitness server. Nothing was changed.", 0);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(body.error ?? "error", body.message ?? `request failed (${res.status})`, res.status);
  return body;
}

export const api = {
  cases: () => call<{ cases: ReturnCase[] }>("/api/cases").then((r) => r.cases),
  case: (id: string) => call<{ case: ReturnCase }>(`/api/cases/${id}`).then((r) => r.case),
  approve: (id: string, b: { approver: string; amountCents: number; note: string; overrideReason?: string }) =>
    call<{ case: ReturnCase; token: string; expiresAt: string }>(`/api/cases/${id}/approve`, { method: "POST", body: JSON.stringify(b) }),
  /** 200 = refunded; 202 = the intent is pending or its outcome unknown (the returned case says which). */
  refund: (id: string, token: string) => call<{ case: ReturnCase }>(`/api/cases/${id}/refund`, { method: "POST", body: JSON.stringify({ token }) }).then((r) => r.case),
  /** Server-side recovery of the case's in-flight refund intent (no token: same intent, same idempotency key). */
  recover: (id: string) => call<{ case: ReturnCase }>(`/api/cases/${id}/refund/recover`, { method: "POST", body: "{}" }).then((r) => r.case),
  hold: (id: string, person: string, reason: string) => call<{ case: ReturnCase }>(`/api/cases/${id}/hold`, { method: "POST", body: JSON.stringify({ person, reason }) }).then((r) => r.case),
  status: () => call<SystemStatus>("/api/status"),
  charges: () => call<{ ok: boolean; error?: string; charges: Array<{ orderId: string; paymentIntentId: string; chargeId: string; amountCents: number; receiptUrl: string | null }> }>("/api/charges"),
  reset: () => call<{ ok: boolean }>("/api/demo/reset", { method: "POST" }),
  correct: (id: string, b: Omit<ReviewerCorrection, "id" | "caseId" | "rmaId" | "at"> & { expectedVersion?: number }) =>
    call<{ case: ReturnCase; correction: ReviewerCorrection }>(`/api/cases/${id}/corrections`, { method: "POST", body: JSON.stringify(b) }),
  supplyEvidence: (id: string, b: { requestId: string; note: string; person: string; evidenceDigest: string }) =>
    call<{ case: ReturnCase; request: EvidenceRequest }>(`/api/cases/${id}/evidence`, { method: "POST", body: JSON.stringify(b) }),
};

export interface SystemStatus {
  meta: { keyPresent: boolean; live: boolean; baseURL: string; models: { sam: string; spark: string; wonder: string }; refusedModels: string[] };
  openWeight: { provider: string | null; model: string; ready: boolean; reason: string };
  samFailover: { enabled: boolean; model: string; reason: string };
  labelReader: { enabled: boolean; provider: "modal" | "fireworks" | null; model: string | null; adapter: string | null; reason: string; status: string };
  publicDemo: boolean;
  liveSeeded?: string[];
  judgeLive?: { enabled: boolean; perVisitorPerDay: number; dailyCap: number; reason: string };
  store: string;
  stripe: { ok: boolean; mode?: string; error?: string };
  secret: { ok: boolean; error?: string };
}

/** Start an inspection and stream its stage events. Resolves with the finished case. */
/** Upload a bench recording (local profile only). */
export async function uploadClip(rmaId: string, blob: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/clips", { method: "POST", headers: { "content-type": blob.type || "video/webm", "x-rma-id": rmaId }, body: blob });
  } catch {
    throw new ApiError("network", "Can't reach the ReturnWitness server.", 0);
  }
  const b = (await res.json().catch(() => ({}))) as { clipId?: string; error?: string; message?: string };
  if (!res.ok || !b.clipId) throw new ApiError(b.error ?? "error", b.message ?? `upload failed (${res.status})`, res.status);
  return b.clipId;
}

/** Uploads the returns lead's spoken note; the server transcribes it live (Muse Voice Transcribe). */
export async function uploadVoiceNote(blob: Blob, person?: string, synthetic = false): Promise<{ voiceNoteId: string; note: VoiceNote }> {
  let res: Response;
  try {
    res = await fetch("/api/voice-notes", { method: "POST", headers: { "content-type": blob.type || "audio/webm", ...(person ? { "x-person": person } : {}), ...(synthetic ? { "x-synthetic-voice": "1" } : {}) }, body: blob });
  } catch {
    throw new ApiError("network", "Can't reach the ReturnWitness server.", 0);
  }
  const b = (await res.json().catch(() => ({}))) as { voiceNoteId?: string; note?: VoiceNote; error?: string; message?: string };
  if (!res.ok || !b.voiceNoteId || !b.note) throw new ApiError(b.error ?? "error", b.message ?? `transcription failed (${res.status})`, res.status);
  return { voiceNoteId: b.voiceNoteId, note: b.note };
}

export async function runInspectionStream(rmaId: string, onStage: (e: StageEvent) => void, opts: { live?: boolean; clipId?: string; voiceNoteId?: string; liveSeeded?: boolean; signal?: AbortSignal } = {}): Promise<ReturnCase> {
  let res: Response;
  try {
    res = await fetch("/api/inspections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rmaId, live: Boolean(opts.live), ...(opts.clipId ? { clipId: opts.clipId } : {}), ...(opts.voiceNoteId ? { voiceNoteId: opts.voiceNoteId } : {}), ...(opts.liveSeeded ? { liveSeeded: true } : {}) }), signal: opts.signal });
  } catch {
    throw new ApiError("network", "Can't reach the ReturnWitness server.", 0);
  }
  if (!res.ok || !res.body) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(b.error ?? "error", b.message ?? `inspection failed (${res.status})`, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: ReturnCase | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!ev || data == null) continue;
      const parsed = JSON.parse(data);
      if (ev === "stage") onStage(parsed as StageEvent);
      else if (ev === "case") result = parsed as ReturnCase;
      else if (ev === "error") throw new ApiError("pipeline", (parsed as { message: string }).message, 500);
    }
  }
  if (!result) throw new ApiError("pipeline", "the inspection ended without a result", 500);
  return result;
}
