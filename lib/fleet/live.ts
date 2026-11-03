/**
 * Live model roles for one box, on the Meta Model API (OpenAI-SDK compatible, the same pattern as
 * lib/meta/readers.ts): one chat completion per role, a zod JSON schema per role, the contributor
 * guard before every call, every call logged with tokens and cost (lib/obs/llm-log.ts), and the
 * response id kept as the request id. Each answer is saved to data/recordings/fleet/<rmaId>.<role>.json
 * (mode LIVE_META at run time) so the public site replays it, labelled "recorded live Meta output".
 *
 * The merge rules don't change for live answers: holds and work items only, combined with the
 * deterministic result so nothing gets less restrictive, and nothing here can approve money.
 * The caller passes the MetaConfig (this module reads no environment and no key on its own) and,
 * in tests, a mocked client.
 */
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { metaResponseFormat, parseMetaReply } from "@/lib/meta/json-schema";
import { POLICY } from "@/data/fixtures";
import type { ShiftReturn, SeededShift } from "@/data/shift";
import type { CountResult, Reconciliation } from "@/lib/domain/schemas";
import { calculateSettlement } from "@/lib/engine/reconcile";
import { assertNotContributor, type MetaConfig } from "@/lib/meta/config";
import { cachedTokensOf, logLlmCall, promptCacheKey, tokenCostUsd, usdToMicroCents } from "@/lib/obs/llm-log";
import { applyHolds, toReconciliation } from "./coordinator";
import type { EvidenceImage, InspectorOutput, ReturnCtx } from "./context";
import { runCarrierClaim } from "./agents/carrier-claim";
import { decide } from "./dispatch";
import { runDamageReader } from "./agents/damage-reader";
import { runLabelReader } from "./agents/label-reader";
import { runMessageDrafter } from "./agents/message-drafter";
import { runPolicy } from "./agents/policy";
import { runRestockGrader } from "./agents/restock-grader";
import { runVoiceNoteReader } from "./agents/voice-note-reader";
import { applyRecorded, liveRoleFor, type AnyLiveRole } from "./live-merge";
import type { AgentResult, DispatchMode, FleetLine, FleetRecording, RecordedFleet, RoleId } from "./types";
import { WITHHELD_FLEET_ANSWERS } from "@/data/known-misreads";

/** The slice of the OpenAI client this module uses, so tests can pass a mock. */
export interface ChatClient {
  chat: {
    completions: {
      create(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<{ id?: string; choices: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } | null }>;
    };
  };
}

export const openAIClient = (cfg: MetaConfig): ChatClient => new OpenAI({ apiKey: cfg.apiKey ?? "", baseURL: cfg.baseURL, timeout: 60_000, maxRetries: 1 }) as unknown as ChatClient;


export interface LiveCall<T> {
  value: T | null;
  model: string;
  latencyMs: number;
  requestId?: string;
  error?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Of inputTokens, served from Meta's prompt cache. */
  cachedTokens?: number;
  costUsd: number | null;
}

/** One role, one call. Never throws: errors come back on the result (and are logged). */
export async function fleetMetaJson<T>(args: { client: ChatClient; cfg: MetaConfig; model: string; purpose: string; system: string; userText: string; images: EvidenceImage[]; schemaName: string; schema: z.ZodType<T>; caseId?: string; signal?: AbortSignal }): Promise<LiveCall<T>> {
  const t0 = Date.now();
  const base = { model: args.model, inputTokens: null, outputTokens: null, costUsd: null };
  if (!args.cfg.apiKey || args.cfg.publicDemo) return { ...base, value: null, latencyMs: 0, error: "no live Meta key in this profile" };
  const content: Array<Record<string, unknown>> = [{ type: "text", text: args.userText }];
  for (const im of args.images) {
    content.push({ type: "text", text: im.caption });
    content.push({ type: "image_url", image_url: { url: im.dataUrl } });
  }
  try {
    assertNotContributor(args.model);
    const res = await args.client.chat.completions.create({
      model: args.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content },
      ],
      response_format: metaResponseFormat(args.schemaName, args.schema),
      // Each role's system prompt is fixed: one key per role, so its prefix stays on one backend.
      prompt_cache_key: promptCacheKey(`fleet-${args.purpose}`),
    }, args.signal ? { signal: args.signal } : undefined);
    const text = res.choices[0]?.message?.content ?? "";
    const inTok = res.usage?.prompt_tokens ?? null;
    const outTok = res.usage?.completion_tokens ?? null;
    const cachedTok = cachedTokensOf(res.usage);
    const usd = tokenCostUsd(args.model, inTok, outTok, cachedTok);
    let parsed: ReturnType<z.ZodType<T>["safeParse"]>;
    try {
      parsed = parseMetaReply(args.schema, JSON.parse(text));
    } catch {
      parsed = { success: false, error: new z.ZodError([]) } as ReturnType<z.ZodType<T>["safeParse"]>;
    }
    const requestId = typeof res.id === "string" ? res.id : undefined;
    const latencyMs = Date.now() - t0;
    logLlmCall({ provider: "meta", model: args.model, purpose: args.purpose, mode: "live", ok: parsed.success, latencyMs, inputTokens: inTok, outputTokens: outTok, cachedTokens: cachedTok, costUsd: usd, costMicroCents: usdToMicroCents(usd), caseId: args.caseId, input: { system: args.system, user: args.userText, images: args.images.map((i) => i.caption) }, output: { requestId: requestId ?? null, text }, ...(parsed.success ? {} : { error: "schema validation failed" }) });
    return { model: args.model, inputTokens: inTok, outputTokens: outTok, cachedTokens: cachedTok, costUsd: usd, latencyMs, ...(requestId ? { requestId } : {}), ...(parsed.success ? { value: parsed.data } : { value: null, error: "schema validation failed" }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLlmCall({ provider: "meta", model: args.model, purpose: args.purpose, mode: "live", ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, caseId: args.caseId, input: args.userText, output: "", error: msg });
    return { ...base, value: null, latencyMs: Date.now() - t0, error: msg };
  }
}

/* ---------- Recordings ---------- */

export const fleetRecordingsDir = (root = process.cwd()) => path.join(root, "data", "recordings", "fleet");
const fileFor = (dir: string, rmaId: string, role: RoleId) => path.join(dir, `${rmaId.replace(/[^a-z0-9-]/gi, "_")}.${role}.json`);

export function saveFleetRecording(rec: FleetRecording, dir = fleetRecordingsDir()): string | null {
  try {
    fs.mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    const f = fileFor(dir, rec.rmaId, rec.role);
    fs.writeFileSync(/*turbopackIgnore: true*/ f, `${JSON.stringify(rec, null, 2)}\n`);
    return f;
  } catch {
    return null; // read-only filesystem
  }
}

/** Every saved fleet recording for these boxes. Files that don't parse are ignored (the box stays deterministic). */
export function loadFleetRecordings(rmaIds: string[], dir = fleetRecordingsDir()): RecordedFleet {
  const out: RecordedFleet = {};
  let files: string[] = [];
  try {
    // The pages read recordings at build time (they are prerendered), so nothing needs tracing into the server bundle.
    files = fs.readdirSync(/*turbopackIgnore: true*/ dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ path.join(dir, f), "utf8")) as FleetRecording;
      if (rec?.kind !== "fleet" || !rmaIds.includes(rec.rmaId) || !liveRoleFor(rec.role)) continue;
      // A known-false answer is never replayed (data/known-misreads.ts): the box stays on app code for that role.
      if (WITHHELD_FLEET_ANSWERS.some((w) => w.rmaId === rec.rmaId && w.role === rec.role && w.requestId === rec.requestId)) continue;
      (out[rec.rmaId] ??= {})[rec.role] = rec;
    } catch {
      /* skip */
    }
  }
  return out;
}

/* ---------- One box, every model role, live ---------- */

/** What the live inspection hands the fleet: its count and reconciliation, the clip's crops and key frames, the transcript. */
export interface BoxEvidence {
  /** The box in the seeded shift (slip, dates, carrier scans come from here). */
  ret: ShiftReturn;
  count: CountResult;
  reconciliation: Reconciliation;
  images: EvidenceImage[];
  /** Muse Voice Transcribe's transcript of the lead's note, when one was recorded. */
  voiceTranscript?: string;
  caseId?: string;
  frames?: number;
}

export interface RunFleetLiveOptions {
  client?: ChatClient;
  /** Where recordings go; null = don't save. */
  dir?: string | null;
  settings: SeededShift["settings"];
  now?: () => Date;
  /**
   * "selective" (default): an optional specialist is called only when the box's evidence calls for it (lib/fleet/dispatch.ts).
   * "always": every model role with something to read is called (a role with nothing to read, e.g. the voice-note reader
   * without a transcript, is never called: its answer would be rejected as missing evidence).
   */
  dispatch?: DispatchMode;
  /** Per-call time limit (ms, default 90 s). A call that stalls past it is abandoned and recorded as a timeout; app code stands in. */
  timeoutMs?: number;
}

export interface FleetLiveResult {
  rmaId: string;
  recordings: FleetRecording[];
  /** Every model role on this box: called or skipped, and why. */
  dispatch: Array<{ role: RoleId; called: boolean; reason: string }>;
  /** The box's lines after merging every role's (deterministic + live) holds. */
  lines: FleetLine[];
  costUsd: number;
}

export const FLEET_CALL_TIMEOUT_MS = 90_000;

/**
 * Race a call against a time limit. At the limit the request itself is aborted, so it can't keep running (and keep
 * billing) after the fleet has moved on: in run 2 an abandoned call finished at 109 s and was billed while the fleet
 * reported it as a $0 timeout. A timed-out call's cost is unknown (null = unpriced, never $0): the provider may bill
 * the tokens it generated before the abort.
 */
async function withTimeout<T>(call: (signal: AbortSignal) => Promise<LiveCall<T>>, ms: number, model: string): Promise<LiveCall<T> & { timedOut?: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctl = new AbortController();
  const p = call(ctl.signal);
  const stall = new Promise<LiveCall<T> & { timedOut: boolean }>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve({ value: null, model, latencyMs: ms, error: `timeout after ${ms} ms`, inputTokens: null, outputTokens: null, costUsd: null, timedOut: true });
    }, ms);
  });
  try {
    return await Promise.race([p, stall]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const linesFrom = (recon: Reconciliation, by: string): FleetLine[] =>
  recon.lines.map((l) => ({ itemKey: l.itemKey, description: l.description, expectedQty: l.expectedQty, observedQty: l.observedQty, missingQty: l.missingQty, unitPriceCents: l.unitPriceCents, status: l.status, reasons: l.reasons.map((r) => ({ code: r.code as FleetLine["reasons"][number]["code"], detail: r.detail, by })) }));

/**
 * Fire the model roles for one box (one call per role), merge each live answer with the deterministic
 * result the same way the coordinator replays it, and save every answer. Stages follow the coordinator:
 * label / damage / voice → carrier claim → policy → restock + customer note.
 */
export async function runFleetLive(box: BoxEvidence, cfg: MetaConfig, opts: RunFleetLiveOptions): Promise<FleetLiveResult> {
  const client = opts.client ?? openAIClient(cfg);
  const now = opts.now ?? (() => new Date());
  const dir = opts.dir === undefined ? fleetRecordingsDir() : opts.dir;
  const rmaId = box.ret.rma.id;
  const ret: ShiftReturn = box.voiceTranscript
    ? { ...box.ret, voiceNote: { transcript: box.voiceTranscript, mode: "LIVE_META", model: cfg.models.voice, latencyMs: 0, audioDurationMs: 0, provenance: "Muse Voice Transcribe, live", recordedAt: now().toISOString() } }
    : { ...box.ret, voiceNote: undefined };
  const inspector: InspectorOutput = { count: box.count, lines: linesFrom(box.reconciliation, `inspector-${rmaId.toLowerCase()}`), frames: box.frames ?? 0 };
  const ctx: ReturnCtx = { ret, settings: opts.settings, policy: POLICY, up: { inspector }, images: box.images };
  const recordings: FleetRecording[] = [];
  const mode: DispatchMode = opts.dispatch ?? "selective";
  const timeoutMs = opts.timeoutMs ?? FLEET_CALL_TIMEOUT_MS;
  const dispatch: FleetLiveResult["dispatch"] = [];
  /** Whether to call this role now; records the decision either way. */
  const wants = (role: RoleId): boolean => {
    const d = decide(role, ctx, mode);
    const called = d.run && !d.missingEvidence;
    dispatch.push({ role, called, reason: d.missingEvidence ?? d.reason });
    return called;
  };

  const call = async <O,>(def: AnyLiveRole, det: AgentResult<O>): Promise<AgentResult<O>> => {
    const model = def.modelKind === "spark" ? cfg.models.spark : cfg.models.wonder;
    const p = def.prompt(ctx);
    const r = await withTimeout((signal) => fleetMetaJson({ client, cfg, model, purpose: `fleet:${def.role}`, system: def.system, userText: p.text, images: p.images, schemaName: def.schemaName, schema: def.schema, caseId: box.caseId, signal }), timeoutMs, model);
    const rec: FleetRecording = {
      kind: "fleet",
      rmaId,
      role: def.role,
      mode: "LIVE_META",
      model,
      latencyMs: r.latencyMs,
      ...(r.requestId ? { requestId: r.requestId } : {}),
      recordedAt: now().toISOString(),
      ok: r.value !== null,
      ...(r.error ? { error: r.error } : {}),
      output: r.value,
      usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, cachedTokens: r.cachedTokens ?? 0 },
      costUsd: r.costUsd,
      ...(def.role === "voice-note-reader" && ctx.ret.voiceNote ? { input: { transcript: ctx.ret.voiceNote.transcript } } : {}),
      ...(r.timedOut ? { timedOut: true } : {}),
    };
    const merged = applyRecorded(def, det, rec, ctx);
    if (merged.source === "live_rejected" && rec.ok) {
      rec.ok = false;
      rec.error = merged.proof?.error;
    }
    recordings.push(rec);
    if (dir) saveFleetRecording(rec, dir);
    return merged.result;
  };

  // Stage 1 (the damage reader is a core role: always called).
  const [label, damage, voice] = await Promise.all([
    wants("label-reader") ? call(liveRoleFor("label-reader")!, runLabelReader(ctx)) : Promise.resolve(null),
    wants("damage-reader") ? call(liveRoleFor("damage-reader")!, runDamageReader(ctx)) : Promise.resolve(null),
    wants("voice-note-reader") ? call(liveRoleFor("voice-note-reader")!, runVoiceNoteReader(ctx)) : Promise.resolve(null),
  ]);
  if (label) ctx.up.labelReader = label.output;
  if (damage) ctx.up.damageReader = damage.output;
  if (voice) ctx.up.voiceReader = voice.output;
  let lines = inspector.lines;
  for (const [by, r] of [["label-reader", label], ["damage-reader", damage], ["voice-note-reader", voice]] as const) if (r) lines = applyHolds(lines, r.holds, by);

  // Stage 2: the claim, only when something points at damage or transit (as in the coordinator).
  if (wants("carrier-claim-agent")) ctx.up.carrierClaim = (await call(liveRoleFor("carrier-claim-agent")!, runCarrierClaim(ctx))).output;

  // Stage 3.
  ctx.lines = lines;
  if (wants("policy-agent")) {
    const policy = await call(liveRoleFor("policy-agent")!, runPolicy(ctx));
    ctx.up.policy = policy.output;
    lines = applyHolds(lines, policy.holds, "policy-agent");
  }
  ctx.lines = lines;
  ctx.settlement = calculateSettlement(toReconciliation(lines, ret.rma), ret.rma);

  // Stage 4: decide both before either call (the drafter's trigger doesn't depend on the grades).
  const stage4 = [wants("restock-grader") ? call(liveRoleFor("restock-grader")!, runRestockGrader(ctx)) : null, wants("customer-message-drafter") ? call(liveRoleFor("customer-message-drafter")!, runMessageDrafter(ctx)) : null];
  await Promise.all(stage4);

  return { rmaId, recordings, dispatch, lines, costUsd: recordings.reduce((s, r) => s + (r.costUsd ?? 0), 0) };
}

/* ---------- The quote ---------- */

/** Worst case for one box: every model role fires once (the claim agent included). Token budgets are estimates. */
export function fleetLiveQuote(boxes: number, roster: Array<{ kind: string; model?: string; budget?: { inTok: number; outTok: number }; costPerRunUsd: number }>) {
  const model = roster.filter((a) => a.kind === "model" && a.budget);
  const kind = (m: string) => model.filter((a) => a.model === m);
  const line = (m: "muse-spark-1.3" | "muse-wonder-1.0") => {
    const roles = kind(m);
    const inTok = roles.reduce((s, a) => s + a.budget!.inTok, 0);
    const outTok = roles.reduce((s, a) => s + a.budget!.outTok, 0);
    return { model: m, calls: boxes * roles.length, inTok, outTok, usd: boxes * roles.reduce((s, a) => s + a.costPerRunUsd, 0) };
  };
  const spark = line("muse-spark-1.3");
  const wonder = line("muse-wonder-1.0");
  return { spark, wonder, perBoxUsd: (spark.usd + wonder.usd) / Math.max(1, boxes), totalUsd: spark.usd + wonder.usd };
}
