/**
 * One inspection, end to end: segment → count → reconcile (+ readers) → draft.
 * Every stage is timed and labelled with its mode; the case is saved after every stage; any
 * error anywhere leaves the case HELD with the reason (fail-closed). Nothing here can refund.
 */
import { randomUUID } from "node:crypto";
import type { ReturnCase, StageTiming, VoiceNote } from "@/lib/domain/case";
import type { ModeLabel, PackingSlip, Policy, Rma } from "@/lib/domain/schemas";
import type { CaseStore } from "@/lib/store/case-store";
import type { Segmenter } from "@/lib/vision/segmenter";
import { countClip, type TrayCounterConfig } from "@/lib/vision/tray-counter";
import { crossCheckReaders, reconcile, type ReaderAnswer } from "./reconcile";
import { templateDraft, validateDraft } from "./decision";
import { failClosed, transition } from "./case-machine";
import { logDecision } from "@/lib/obs/decision-log";
import { PRICES } from "@/lib/obs/llm-log";
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import type { AgentContext, AgentRun } from "@/lib/meta/wonder-agent";
import { AGENT_LIMITS, evidenceDigest } from "./agent-guard";
import { EVIDENCE_KIND_TEXT } from "./evidence-request";

/** The agent enforces its own deadline (AbortSignal); this backstop catches an agent that ignores it. */
const AGENT_DEADLINE_GRACE_MS = 2_000;

function withAgentDeadline(p: Promise<AgentRun | null>, ms: number): Promise<AgentRun | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`agent-work deadline (${Math.round(ms / 1000)} s) passed; the draft is the deterministic template`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export interface StageEvent {
  caseId: string;
  stage: StageTiming["stage"] | "done";
  status: "start" | "end";
  ms?: number;
  mode?: ModeLabel;
  state?: ReturnCase["state"];
  note?: string;
}

export interface PipelineDeps {
  store: CaseStore;
  segmenter: Segmenter;
  counterConfig: TrayCounterConfig;
  /** Independent readers; each can only raise holds. Empty in fixture mode. */
  readers: Array<{ name: string; required: boolean; readsSerials?: boolean; read: (e: ReaderEvidence) => Promise<ReaderResult> }>;
  /** Readers that were deliberately not run, with the reason (shown as labelled cards). */
  skippedReaders?: Array<{ name: string; model: string; reason: string }>;
  /** The Wonder decision agent (live, or a recorded live run replayed); null → template draft, labelled. */
  agent: ((ctx: AgentContext) => Promise<AgentRun | null>) | null;
  /** Why the agent isn't running, shown on the trace card. */
  agentNotRun?: string;
  /** Backstop on the agent's wall-clock time (default: AGENT_LIMITS.deadlineMs plus a short grace). */
  agentDeadlineMs?: number;
  /** Builds reader images (key frames + crops). Live mode only. */
  evidenceImages?: (c: ReturnCase) => Promise<ReaderEvidence["images"]>;
  onStage?: (e: StageEvent) => void;
  now?: () => Date;
}

export interface InspectionInput {
  rma: Rma;
  slip: PackingSlip;
  policy: Policy;
  clip: { clipId: string; source: ReturnCase["clip"]["source"]; videoPath?: string; videoUrl?: string };
  /** What the returns lead said at the bench (transcribed before the run, or a labelled seeded note). */
  voiceNote?: VoiceNote;
}

export function newCase(input: InspectionInput, segmenter: Segmenter, now: Date): ReturnCase {
  const at = now.toISOString();
  const id = `case_${randomUUID().slice(0, 8)}`;
  return {
    id,
    runId: `run_${now.getTime().toString(36)}_${id.slice(5)}`,
    rmaId: input.rma.id,
    orderId: input.rma.orderId,
    createdAt: at,
    updatedAt: at,
    version: 0,
    state: "Received",
    holdReasons: [],
    clip: { clipId: input.clip.clipId, source: input.clip.source, mode: segmenter.mode, provenance: "", durationS: 0, fps: 0, ...(input.clip.videoUrl ? { videoUrl: input.clip.videoUrl } : {}) },
    disagreements: [],
    timings: [],
    costs: [],
    audit: [
      { at, actor: "system", event: "RECEIVED", from: null, to: "Received", detail: `bench inspection started for ${input.rma.id}` },
      ...(input.voiceNote ? [{ at, actor: (input.voiceNote.mode === "LIVE_META" ? `model:${input.voiceNote.model}` : "system") as ReturnCase["audit"][number]["actor"], event: "VOICE_NOTE", from: null, to: "Received" as const, detail: `voice note attached (${input.voiceNote.provenance})` }] : []),
    ],
    ...(input.voiceNote ? { voiceNote: input.voiceNote } : {}),
  };
}

export async function runInspection(input: InspectionInput, deps: PipelineDeps): Promise<ReturnCase> {
  const now = deps.now ?? (() => new Date());
  const emit = (e: Omit<StageEvent, "caseId">, c: ReturnCase) => deps.onStage?.({ caseId: c.id, ...e });
  let c = await deps.store.put(newCase(input, deps.segmenter, now()), 0);
  const save = async (next: ReturnCase) => (c = await deps.store.put(next, c.version));

  // `startedAt`: a stage whose work began earlier (the draft stage includes the decision agent's run, so the rail never
  // shows "draft 0.18 ms" for a 19 s agent).
  const timed = async <T,>(stage: StageTiming["stage"], mode: ModeLabel, fn: () => Promise<T>, model?: string, startedAt?: number): Promise<[T, StageTiming]> => {
    emit({ stage, status: "start", mode }, c);
    const t0 = startedAt ?? performance.now();
    const v = await fn();
    // Measured, never rounded to a fake 0: app-code steps take fractions of a millisecond.
    const t: StageTiming = { stage, ms: Math.round((performance.now() - t0) * 1000) / 1000, mode, ...(model ? { model } : {}) };
    emit({ stage, status: "end", ms: t.ms, mode }, c);
    return [v, t];
  };

  const result = await failClosed(c, "pipeline", async (start) => {
    let cur = start;

    // 1. Segment.
    const [seg, tSeg] = await timed("segment", deps.segmenter.mode, () =>
      deps.segmenter.segment({
        clipId: input.clip.clipId,
        videoPath: input.clip.videoPath,
        concepts: [...deps.counterConfig.items.map((i) => i.concept), deps.counterConfig.handConcept, ...deps.counterConfig.ignoreConcepts],
        fps: 5,
        caseId: cur.id,
      }),
    );
    cur = {
      ...cur,
      clip: { ...cur.clip, mode: seg.source.mode, provenance: seg.source.provenance, durationS: seg.durationS, fps: seg.fps, ...(seg.source.requestIds.length ? { requestIds: seg.source.requestIds } : {}) },
      // The result names the engine that answered (Modal after a failover), not the configured primary.
      timings: [...cur.timings, { ...tSeg, mode: seg.source.mode, model: seg.source.model }],
      costs:
        seg.source.mode === "LIVE_META"
          ? [...cur.costs, { stage: "segment", model: seg.source.model, usd: seg.frames.length * deps.counterConfig.items.length * PRICES.samPerFrameUsd, basis: `${seg.frames.length} frames × ${deps.counterConfig.items.length + 1 + deps.counterConfig.ignoreConcepts.length} concepts @ $0.20/1k` }]
          : cur.costs,
    };

    // 2. Count (deterministic).
    const [count, tCount] = await timed("count", "DETERMINISTIC", async () => countClip(input.clip.clipId, seg.frames, deps.counterConfig));
    cur = transition({ ...cur, count, timings: [...cur.timings, tCount] }, { type: "COUNTED", detail: summarizeCounts(count.counts) }, "system", now());
    cur = await save(cur);

    // 3. Reconcile: deterministic, then each independent reader can only raise holds.
    const [recon, tRec] = await timed("reconcile", deps.readers.some((r) => r.required) ? "LIVE_META" : deps.readers.length ? "RECORDED_FIXTURE" : "DETERMINISTIC", async () => {
      const det = reconcile(input.rma, input.slip, count, input.policy);
      if (!deps.readers.length) return { det, final: det, disagreements: [] as ReturnCase["disagreements"], answers: [] as ReaderAnswer[], runs: [] as NonNullable<ReturnCase["readerRuns"]> };
      const images = deps.evidenceImages ? await deps.evidenceImages(cur) : [];
      const evidence: ReaderEvidence = { rma: input.rma, slip: input.slip, policy: input.policy, count, images, caseId: cur.id, clipId: input.clip.clipId, ...(input.voiceNote ? { voiceNote: input.voiceNote.transcript } : {}) };
      const results = await Promise.all(deps.readers.map(async (r) => ({ r, res: await r.read(evidence) })));
      const answers: ReaderAnswer[] = results.map(({ r, res }) => ({ reader: r.name, mode: res.mode, output: res.output, required: r.required, readsSerials: r.readsSerials }));
      const x = crossCheckReaders(det, answers, { rma: input.rma, slip: input.slip });
      const runs = results.map(({ r, res }) => ({ reader: r.name, model: res.model, provider: res.provider, mode: res.mode, required: r.required, ok: Boolean(res.output), latencyMs: res.latencyMs, ...(res.requestId ? { requestId: res.requestId } : {}), ...(res.recordedAt ? { recordedAt: res.recordedAt } : {}), ...(res.error ? { error: res.error } : {}), ...(res.extras ? { extras: res.extras } : {}), ...(res.output ? { lines: res.output.lines.map((l) => ({ itemKey: l.itemKey, status: l.status, observedQty: l.observedQty, ...(l.serialRead !== undefined ? { serialRead: l.serialRead } : {}) })) } : {}) }));
      return { det, final: x.reconciliation, disagreements: x.disagreements, answers, runs };
    });
    cur = {
      ...cur,
      deterministic: recon.det,
      reconciliation: recon.final,
      disagreements: recon.disagreements,
      readerRuns: [...recon.runs, ...(deps.skippedReaders ?? []).map((sk) => ({ reader: sk.name, model: sk.model, mode: "DETERMINISTIC" as ModeLabel, required: false, ok: false, latencyMs: 0, error: sk.reason }))],
      timings: [...cur.timings, { ...tRec, mode: recon.final.mode }],
    };
    cur = transition(cur, { type: "RECONCILED", detail: `${recon.final.lines.filter((l) => l.status === "OK").length} of ${recon.final.lines.length} lines OK` }, "system", now());
    if (recon.final.summary.allClear) {
      cur = transition(cur, { type: "CLEAR", detail: "every line OK; waiting for a person to approve" }, "system", now());
    } else {
      const reasons = recon.final.lines.filter((l) => l.status !== "OK").map((l) => `${l.itemKey}:${l.status}`);
      cur = transition(cur, { type: "HOLD", reasons, detail: `held: ${reasons.join(", ")}` }, "system", now());
    }
    cur = await save(cur);

    // 4. Decision agent: reads the reconciliation, may propose a move toward HELD (judged by app
    //    code), then drafts. It never authorises; APPROVED always needs a person's token.
    const agentCtx: AgentContext = { clipId: input.clip.clipId, caseId: cur.id, state: cur.state, digest: evidenceDigest(input.rma.id, recon.final), rma: input.rma, policy: input.policy, recon: recon.final, ...(input.voiceNote ? { voiceNote: input.voiceNote.transcript } : {}) };
    const agentT0 = performance.now();
    const agentRun: AgentRun | null = deps.agent ? await withAgentDeadline(deps.agent(agentCtx), deps.agentDeadlineMs ?? AGENT_LIMITS.deadlineMs + AGENT_DEADLINE_GRACE_MS).catch((e: unknown): AgentRun => ({ model: "muse-wonder-1.0", mode: "LIVE_META", protocol: "tools", steps: [], effect: "none", draft: null, latencyMs: 0, error: e instanceof Error ? e.message : String(e) })) : null;
    if (agentRun?.effect === "hold" && cur.state === "AwaitingApproval") {
      const why = [...agentRun.steps].reverse().find((x) => x.kind === "guard" && x.name === "propose_transition" && x.verdict?.accepted)?.args as { reason?: string } | undefined;
      cur = transition(cur, { type: "HOLD", reasons: ["agent_hold"], detail: `decision agent proposed HOLD (accepted by app code): ${why?.reason ?? ""}`.trim() }, `model:${agentRun.model}`, now());
    }
    // Evidence requests app code accepted become open work items on the case. The agent doesn't wait:
    // the case ends HELD (it already is, since a request needs a line that is not OK) for a person to supply them.
    const requests = agentRun?.evidenceRequests ?? [];
    if (agentRun && requests.length) {
      if (cur.state === "AwaitingApproval") cur = transition(cur, { type: "HOLD", reasons: ["evidence_requested"], detail: "decision agent requested more evidence (accepted by app code)" }, `model:${agentRun.model}`, now());
      const at = now().toISOString();
      const actor = (agentRun.mode === "LIVE_META" ? `model:${agentRun.model}` : "system") as ReturnCase["audit"][number]["actor"];
      cur = {
        ...cur,
        evidenceRequests: [...(cur.evidenceRequests ?? []), ...requests],
        audit: [
          ...cur.audit,
          ...requests.map((r) => ({ at, actor, event: "EVIDENCE_REQUESTED", from: cur.state, to: cur.state, detail: `${agentRun.mode === "LIVE_META" ? "decision agent" : "replayed recorded agent run"} requested ${EVIDENCE_KIND_TEXT[r.kind]} for ${r.itemKey} (${r.id}, digest ${r.digest}): ${r.reason}. Open for a person; the hold stays.` })),
        ],
      };
      for (const r of requests) logDecision({ caseId: cur.id, rmaId: cur.rmaId, runId: cur.runId, kind: "evidence_requested", state: cur.state, detail: `${r.id} ${r.itemKey} ${r.kind} (${agentRun.mode})` });
    }
    const [draft, tDraft] = await timed("draft", agentRun ? agentRun.mode : "DETERMINISTIC", async () => {
      const ctx = { policy: input.policy, recon: recon.final, rma: input.rma, ...(input.voiceNote ? { voiceNote: input.voiceNote.transcript } : {}) };
      const trace = agentRun ? { model: agentRun.model, mode: agentRun.mode, protocol: agentRun.protocol, steps: agentRun.steps, effect: agentRun.effect, latencyMs: agentRun.latencyMs, ...(agentRun.requestIds?.length ? { requestIds: agentRun.requestIds } : {}), ...(requests.length ? { evidenceRequests: requests } : {}), ...(agentRun.error ? { error: agentRun.error } : {}) } : undefined;
      const base = trace ? { agent: trace } : { agentNotRun: deps.agentNotRun ?? "no live Meta key on this server and no recorded agent run for this clip" };
      if (agentRun?.draft) {
        const v = validateDraft(agentRun.draft, ctx);
        if (v.ok && v.draft) return { draft: v.draft, source: "model" as const, mode: agentRun.mode, model: agentRun.model, ...base };
        return { draft: templateDraft(ctx), source: "template" as const, mode: "DETERMINISTIC" as const, model: agentRun.model, rejected: { errors: v.errors }, ...base };
      }
      if (agentRun) return { draft: templateDraft(ctx), source: "template" as const, mode: "DETERMINISTIC" as const, model: agentRun.model, rejected: { errors: [agentRun.error ?? "no draft returned"] }, ...base };
      return { draft: templateDraft(ctx), source: "template" as const, mode: "DETERMINISTIC" as const, ...base };
    }, undefined, agentRun ? agentT0 : undefined);
    cur = { ...cur, draft, timings: [...cur.timings, { ...tDraft, mode: draft.mode }] };
    cur = await save(cur);
    return cur;
  });

  // failClosed may hand back an unsaved HELD case built from the last saved version: persist it.
  const stored = await deps.store.get(result.id);
  if (!stored || stored.state !== result.state || stored.audit.length !== result.audit.length) {
    c = await deps.store.put(result, stored?.version ?? 0);
  } else {
    c = stored;
  }
  logDecision({
    caseId: c.id,
    rmaId: c.rmaId,
    runId: c.runId,
    kind: "pipeline_result",
    state: c.state,
    recommendation: c.draft?.draft.recommendation,
    draftSource: c.draft?.source,
    heldCents: c.reconciliation?.summary.heldCents,
    flags: c.count?.flags.map((f) => f.code),
    disagreements: c.disagreements.length,
  });
  emit({ stage: "done", status: "end", state: c.state }, c);
  return c;
}

const summarizeCounts = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
