/**
 * Live model roles, with mocked clients only: no network, no key read, nothing paid.
 * Happy path → recordings with proof that replay as "recorded live Meta output"; a schema failure or a
 * rejected answer → the deterministic result with the error shown; contributor models refused before any
 * call; and live answers, however permissive or adversarial, never make an outcome less restrictive or
 * move money.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY } from "@/data/fixtures";
import { SEEDED_SHIFT, type ShiftReturn } from "@/data/shift";
import type { MetaConfig } from "@/lib/meta/config";
import type { LineStatus } from "@/lib/domain/schemas";
import { runInspector } from "@/lib/fleet/agents/inspector";
import { checkCustomerNote } from "@/lib/fleet/agents/message-drafter";
import { voiceNoteReaderLive } from "@/lib/fleet/agents/voice-note-reader";
import { runShift, toReconciliation } from "@/lib/fleet/coordinator";
import { fleetLiveQuote, fleetMetaJson, loadFleetRecordings, runFleetLive, type BoxEvidence, type ChatClient } from "@/lib/fleet/live";
import { LIVE_ROLES } from "@/lib/fleet/live-merge";
import { buildRoster } from "@/lib/fleet/coordinator";
import type { FleetRecording, RecordedFleet, RoleId } from "@/lib/fleet/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-fleet-live-"));
const prevLog = process.env.RETURNWITNESS_LLM_LOG;
beforeAll(() => {
  process.env.RETURNWITNESS_LLM_LOG = path.join(tmp, "llm-calls.jsonl"); // the call log goes to a temp file
});
afterAll(() => {
  if (prevLog === undefined) delete process.env.RETURNWITNESS_LLM_LOG;
  else process.env.RETURNWITNESS_LLM_LOG = prevLog;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A config object built in the test: the key is a placeholder string, never read from the environment. */
const cfg = (over: Partial<MetaConfig["models"]> = {}, extra: Partial<MetaConfig> = {}): MetaConfig => ({
  apiKey: "test-placeholder",
  baseURL: "http://mock.invalid/v1",
  models: { sam: "sam-3.1", spark: "muse-spark-1.3", wonder: "muse-wonder-1.0", voice: "muse-voice-transcribe-1.0", image: "muse-image-1.0", ...over },
  publicDemo: false,
  refusedModels: [],
  ...extra,
});

type Answers = Partial<Record<string, unknown>>;
/** A mock Meta chat client: answers by schema name, records every call. */
function mockClient(answers: Answers, calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = []): ChatClient {
  return {
    chat: {
      completions: {
        create: async (body) => {
          const schema = (body.response_format as { json_schema: { name: string } }).json_schema.name;
          calls.push({ model: String(body.model), schema, body });
          const a = answers[schema];
          return { id: `resp_${schema}_${calls.length}`, choices: [{ message: { content: typeof a === "string" ? a : JSON.stringify(a ?? {}) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
        },
      },
    },
  };
}

const ret = (id: string) => SEEDED_SHIFT.returns.find((r) => r.rma.id === id)!;
function boxFor(r: ShiftReturn, voiceTranscript?: string): BoxEvidence {
  const insp = runInspector({ ret: r, settings: SEEDED_SHIFT.settings, policy: POLICY, up: {} }).output;
  const crops = insp.count.arrivals.map((a) => ({ caption: `crop of the counted ${a.itemKey} as it settled in the tray at ${a.t.toFixed(1)} s (read any serial label exactly)`, dataUrl: "data:image/jpeg;base64,AA==" }));
  return { ret: r, count: insp.count, reconciliation: toReconciliation(insp.lines, r.rma), images: [{ caption: "key frame at 3.0 s (overhead, box left, inspected tray right)", dataUrl: "data:image/jpeg;base64,AA==" }, ...crops], voiceTranscript, caseId: "case_test", frames: insp.frames };
}

/** Answers a careful live model would give for RMA-20418 (lens missing). */
const GOOD: Answers = {
  label_reads: { reads: [{ itemKey: "camera_body", serialText: "BW-CB-55107", legible: true, why: "sharp print" }] },
  damage_read: { items: [{ itemKey: "camera_body", surface: "opened", detail: "no marks" }, { itemKey: "battery", surface: "opened", detail: "no marks" }], outerBox: "intact" },
  voice_claims: { claims: [{ kind: "accessory_missing", itemKey: "lens", quote: "lens cap is not in the box" }, { kind: "battery_hazard", itemKey: "battery", quote: "the battery is on fire" }] },
  policy_reading: { clauses: ["4.3", "5.1", "9.9"], outsideWindow: false, conditionHolds: [], rationale: "within 30 days; lens missing" },
  restock_grades: { items: [{ itemKey: "camera_body", grade: "B", why: "opened" }, { itemKey: "battery", grade: "A", why: "looks new" }] },
  customer_note: { text: "Hi Darius,\nYour return RMA-20418 was opened on camera. The zoom lens was not seen. A reviewer may approve a partial refund (clause 4.3). A hold is not a denial; reply within 14 days (clause 5.1).\nBrindlewood Camera Co. returns desk" },
  carrier_claim: { fileClaim: false, damagedItems: [], evidence: [], summary: "no damage" },
};

describe("fleetMetaJson", () => {
  it("sends the role's JSON schema, keeps the response id and logs tokens and cost", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    const r = await fleetMetaJson({ client: mockClient(GOOD, calls), cfg: cfg(), model: "muse-spark-1.3", purpose: "fleet:test", system: "s", userText: "u", images: [{ caption: "c", dataUrl: "data:," }], schemaName: voiceNoteReaderLive.schemaName, schema: voiceNoteReaderLive.schema });
    expect(r.value).toEqual(GOOD.voice_claims);
    expect(r.requestId).toBe("resp_voice_claims_1");
    expect(r.costUsd).toBeCloseTo((1000 * 1.25 + 100 * 4.25) / 1e6, 9);
    expect((calls[0].body.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(true);
    const log = fs.readFileSync(process.env.RETURNWITNESS_LLM_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log.at(-1)).toMatchObject({ provider: "meta", model: "muse-spark-1.3", purpose: "fleet:test", mode: "live", ok: true, inputTokens: 1000, outputTokens: 100 });
  });
  it("refuses a contributor model before any call", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    const r = await fleetMetaJson({ client: mockClient(GOOD, calls), cfg: cfg(), model: "muse-spark-1.3-contributor", purpose: "fleet:test", system: "s", userText: "u", images: [], schemaName: "voice_claims", schema: voiceNoteReaderLive.schema });
    expect(calls).toHaveLength(0);
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/refused model/);
  });
  it("makes no call without a key or in the public demo profile", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    for (const c of [cfg({}, { apiKey: null }), cfg({}, { publicDemo: true })]) {
      const r = await fleetMetaJson({ client: mockClient(GOOD, calls), cfg: c, model: "muse-spark-1.3", purpose: "fleet:test", system: "s", userText: "u", images: [], schemaName: "voice_claims", schema: voiceNoteReaderLive.schema });
      expect(r.error).toBe("no live Meta key in this profile");
    }
    expect(calls).toHaveLength(0);
  });
  it("an answer that doesn't match the schema (or isn't JSON) comes back as no answer, with the error", async () => {
    for (const bad of [{ claims: [{ kind: "teleported", itemKey: null, quote: "x" }] }, "not json {"]) {
      const r = await fleetMetaJson({ client: mockClient({ voice_claims: bad }), cfg: cfg(), model: "muse-spark-1.3", purpose: "fleet:test", system: "s", userText: "u", images: [], schemaName: "voice_claims", schema: voiceNoteReaderLive.schema });
      expect(r.value).toBeNull();
      expect(r.error).toBe("schema validation failed");
      expect(r.requestId).toBeDefined();
    }
  });
});

describe("runFleetLive on one box", () => {
  const dir = path.join(tmp, "fleet");
  it("always-run: calls each model role once with the roster's model, saves recordings with proof, and they replay as recorded live output", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    const box = boxFor(ret("RMA-20418"), "Lens cap is not in the box. Everything else looks fine.");
    const res = await runFleetLive(box, cfg(), { client: mockClient(GOOD, calls), dir, settings: SEEDED_SHIFT.settings, now: () => new Date("2026-10-29T12:00:00Z"), dispatch: "always" });
    // No damage and no transit evidence on this box: the claim agent has nothing to read and is never called, so six calls.
    expect(res.dispatch.find((d) => d.role === "carrier-claim-agent")).toMatchObject({ called: false, reason: expect.stringMatching(/no damaged item and no transit evidence/) });
    expect(calls.map((c) => c.schema).sort()).toEqual(["customer_note", "damage_read", "label_reads", "policy_reading", "restock_grades", "voice_claims"]);
    const modelFor: Record<string, string> = { label_reads: "muse-spark-1.3", damage_read: "muse-spark-1.3", voice_claims: "muse-spark-1.3", restock_grades: "muse-spark-1.3", policy_reading: "muse-wonder-1.0", customer_note: "muse-wonder-1.0" };
    for (const c of calls) expect(c.model).toBe(modelFor[c.schema]);
    expect(res.recordings.every((r) => r.mode === "LIVE_META" && r.ok && r.requestId?.startsWith("resp_"))).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual(res.recordings.map((r) => `RMA-20418.${r.role}.json`).sort());
    // The voice claim quoting words that were never said is dropped; the lens cap claim is kept.
    expect(res.recordings.find((r) => r.role === "voice-note-reader")).toMatchObject({ output: GOOD.voice_claims, input: { transcript: "Lens cap is not in the box. Everything else looks fine." } });

    const recorded = loadFleetRecordings(SEEDED_SHIFT.returns.map((r) => r.rma.id), dir);
    const o = runShift(SEEDED_SHIFT, { recorded, dispatch: "always" }).outcomes.find((x) => x.rmaId === "RMA-20418")!;
    const live = o.traces.filter((t) => t.source === "recorded_live");
    expect(live.map((t) => t.role).sort()).toEqual(["customer-message-drafter", "damage-reader", "label-reader", "policy-agent", "restock-grader", "voice-note-reader"]);
    // The recorded transcript replays with it: the lens cap claim (quoted from it) holds the lens line too.
    expect(o.lines.find((l) => l.itemKey === "lens")!.reasons.map((r) => r.code)).toContain("spoken_claim");
    expect(o.traces.find((t) => t.role === "voice-note-reader")!.line).toMatch(/dropped 1 claim\(s\) whose quote isn't in the transcript/);
    for (const t of live) expect(t.proof).toMatchObject({ model: expect.stringMatching(/^muse-/), requestId: expect.stringMatching(/^resp_/), recordedAt: "2026-10-29T12:00:00.000Z" });
    expect(o.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(o.message.text).toMatch(/clause 5\.1/);
    // An unknown clause id from the model is dropped.
    expect(o.traces.find((t) => t.role === "policy-agent")!.line).toMatch(/dropped unknown clause id\(s\) 9\.9/);
    // The live restock grade for the battery ("A") is less conservative than app code's "B": app code's stands.
    expect(o.restock!.find((r) => r.itemKey === "battery")!.grade).toBe("B");
  });

  it("a schema failure leaves the deterministic result in place and shows the error", async () => {
    const d2 = path.join(tmp, "fleet-bad");
    const res = await runFleetLive(boxFor(ret("RMA-30116")), cfg(), { client: mockClient({ ...GOOD, label_reads: { reads: "everything fine" } }), dir: d2, settings: SEEDED_SHIFT.settings });
    const rec = res.recordings.find((r) => r.role === "label-reader")!;
    expect(rec).toMatchObject({ ok: false, error: "schema validation failed", output: null });
    const o = runShift(SEEDED_SHIFT, { recorded: loadFleetRecordings(["RMA-30116"], d2) }).outcomes.find((x) => x.rmaId === "RMA-30116")!;
    const step = o.traces.find((t) => t.role === "label-reader")!;
    expect(step.source).toBe("live_rejected");
    expect(step.proof?.error).toBe("schema validation failed");
    expect(step.line).toMatch(/live answer not used \(schema validation failed\); app code: holding lens/);
    expect(o.lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");
  });

  it("a customer note that says money moved is rejected, recorded as failed, and the template stands", async () => {
    const d3 = path.join(tmp, "fleet-note");
    const res = await runFleetLive(boxFor(ret("RMA-30101")), cfg(), { client: mockClient({ ...GOOD, label_reads: { reads: [{ itemKey: "camera_body", serialText: "BW-CB-56101", legible: true, why: "ok" }, { itemKey: "lens", serialText: "BW-LN-81201", legible: true, why: "ok" }] }, customer_note: { text: "Good news: your refund has been issued." } }), dir: d3, settings: SEEDED_SHIFT.settings, dispatch: "always" });
    expect(res.recordings.find((r) => r.role === "customer-message-drafter")).toMatchObject({ ok: false, error: expect.stringMatching(/says money moved/) });
    const o = runShift(SEEDED_SHIFT, { recorded: loadFleetRecordings(["RMA-30101"], d3), dispatch: "always" }).outcomes.find((x) => x.rmaId === "RMA-30101")!;
    expect(o.message.text).not.toMatch(/has been issued/);
    expect(o.message.text).toMatch(/waiting for a reviewer's approval/);
    // The rejected note shows as unavailable (malformed), under an app-code label, never as recorded live output.
    const step = o.traces.find((t) => t.role === "customer-message-drafter")!;
    expect(step).toMatchObject({ source: "live_rejected", unavailable: { kind: "malformed", reason: expect.stringMatching(/says money moved/) } });
    // Selective dispatch on the same box never calls the drafter (complete box): the fixed app-code note goes out.
    const sel = runShift(SEEDED_SHIFT, { recorded: loadFleetRecordings(["RMA-30101"], d3) }).outcomes.find((x) => x.rmaId === "RMA-30101")!;
    expect(sel.dispatch.find((d) => d.role === "customer-message-drafter")).toMatchObject({ state: "skipped" });
    expect(sel.message.text).toBe(o.message.text);
  });

  it("a contributor model configured for Spark is refused for every Spark role; Wonder roles still run", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    const res = await runFleetLive(boxFor(ret("RMA-30101")), cfg({ spark: "muse-spark-1.3-contributor" }), { client: mockClient(GOOD, calls), dir: null, settings: SEEDED_SHIFT.settings });
    expect(calls.every((c) => c.model === "muse-wonder-1.0")).toBe(true);
    for (const r of res.recordings.filter((x) => x.model.includes("contributor"))) expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/refused model/) });
  });

  it("carrier claim: the model can decide, but app code prices it from the slip", async () => {
    const res = await runFleetLive(boxFor(ret("RMA-30107")), cfg(), {
      client: mockClient({ ...GOOD, damage_read: { items: [{ itemKey: "camera_body", surface: "dented", detail: "dent on top plate" }], outerBox: "crushed" }, carrier_claim: { fileClaim: true, damagedItems: ["camera_body", "tripod"], evidence: ["carrier exception scan"], summary: "transit damage" } }),
      dir: path.join(tmp, "fleet-claim"),
      settings: SEEDED_SHIFT.settings,
    });
    expect(res.recordings.map((r) => r.role)).toContain("carrier-claim-agent");
    const o = runShift(SEEDED_SHIFT, { recorded: loadFleetRecordings(["RMA-30107"], path.join(tmp, "fleet-claim")) }).outcomes.find((x) => x.rmaId === "RMA-30107")!;
    expect(o.claim).toMatchObject({ carrier: "UPS", claimCents: 19900, damagedItems: [{ itemKey: "camera_body", valueCents: 19900 }] });
  });
});

describe("live runs: selective dispatch and a stalling specialist", () => {
  it("selective (the default) calls only what the box's evidence calls for, and says why the rest were skipped", async () => {
    const calls: Array<{ model: string; schema: string; body: Record<string, unknown> }> = [];
    const res = await runFleetLive(boxFor(ret("RMA-30101")), cfg(), { client: mockClient(GOOD, calls), dir: null, settings: SEEDED_SHIFT.settings });
    // A complete box with confident serial reads: the damage read (core) and the restock grade (complete box) only.
    expect(calls.map((c) => c.schema).sort()).toEqual(["damage_read", "restock_grades"]);
    const skipped = Object.fromEntries(res.dispatch.filter((d) => !d.called).map((d) => [d.role, d.reason]));
    expect(Object.keys(skipped).sort()).toEqual(["carrier-claim-agent", "customer-message-drafter", "label-reader", "policy-agent", "voice-note-reader"]);
    expect(skipped["label-reader"]).toMatch(/0\.90 or above/);
    expect(skipped["voice-note-reader"]).toBe("no voice note on this box");
  });

  it("one optional specialist stalls: recorded as a timeout, the others answer, holds are kept, and the box still goes to a person", async () => {
    const dir = path.join(tmp, "fleet-stall");
    const base = mockClient({ ...GOOD, voice_claims: { claims: [] } });
    const stalling: ChatClient = {
      chat: {
        completions: {
          create: (body) => ((body.response_format as { json_schema: { name: string } }).json_schema.name === "voice_claims" ? new Promise(() => {}) : base.chat.completions.create(body)),
        },
      },
    };
    const box = boxFor(ret("RMA-30113"), ret("RMA-30113").voiceNote!.transcript);
    const res = await runFleetLive(box, cfg(), { client: stalling, dir, settings: SEEDED_SHIFT.settings, timeoutMs: 25 });
    const voice = res.recordings.find((r) => r.role === "voice-note-reader")!;
    expect(voice).toMatchObject({ ok: false, timedOut: true, error: "timeout after 25 ms", output: null, costUsd: null });
    expect(res.recordings.filter((r) => r.role !== "voice-note-reader").every((r) => r.ok)).toBe(true);
    // App code read the transcript instead: the lens-cap hold stands.
    expect(res.lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");

    const run = runShift(SEEDED_SHIFT, { recorded: loadFleetRecordings(["RMA-30113"], dir) });
    const o = run.outcomes.find((x) => x.rmaId === "RMA-30113")!;
    const step = o.traces.find((t) => t.role === "voice-note-reader")!;
    expect(step.source).toBe("live_rejected");
    expect(step.unavailable).toEqual({ kind: "timeout", reason: "timeout after 25 ms" });
    expect(o.dispatch.find((d) => d.role === "voice-note-reader")).toMatchObject({ state: "unavailable", modelCall: true });
    expect(o.lines.find((l) => l.itemKey === "lens")!.status).toBe("HELD");
    expect(o.route.queues[0]).toBe("hold_review");
    expect(o.requiresPerson).toBe(true);
  });
});

describe("no-money invariant on live outputs", () => {
  /** The most permissive answers a model could give, plus a note claiming money moved, on every box. */
  const permissive: Record<RoleId, unknown> = {
    // "legible", and the serial copied from the box's own order record, whatever the label shows.
    "label-reader": (r: ShiftReturn) => ({ reads: r.order.slip.lines.filter((l) => l.serial).map((l) => ({ itemKey: l.itemKey, serialText: l.serial, legible: true, why: "fine" })) }),
    "damage-reader": { items: [], outerBox: "intact" },
    "voice-note-reader": { claims: [] },
    "carrier-claim-agent": { fileClaim: false, damagedItems: [], evidence: [], summary: "none" },
    "policy-agent": { clauses: ["4.2"], outsideWindow: false, conditionHolds: [], rationale: "all fine" },
    "restock-grader": { items: [{ itemKey: "camera_body", grade: "A", why: "new" }, { itemKey: "lens", grade: "A", why: "new" }, { itemKey: "battery", grade: "A", why: "new" }] },
    "customer-message-drafter": { text: "Your refund has been approved and processed." },
  } as Record<RoleId, unknown>;
  const recordedAll = (answers: Record<string, unknown>): RecordedFleet =>
    Object.fromEntries(
      SEEDED_SHIFT.returns.map((r) => [
        r.rma.id,
        Object.fromEntries(LIVE_ROLES.map((d) => [d.role, { kind: "fleet", rmaId: r.rma.id, role: d.role, mode: "LIVE_META", model: d.modelKind === "spark" ? "muse-spark-1.3" : "muse-wonder-1.0", latencyMs: 900, requestId: `resp_${d.role}`, recordedAt: "2026-10-29T12:00:00Z", ok: true, output: typeof answers[d.role] === "function" ? (answers[d.role] as (x: ShiftReturn) => unknown)(r) : answers[d.role], usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 } satisfies FleetRecording])),
      ]),
    );
  const RANK: Record<LineStatus, number> = { OK: 0, EXTRA: 1, HELD: 2, MISSING: 3 };

  it("a permissive or adversarial live answer never lowers a line, raises the money proposed, adds an approval, or lets a note say money moved", () => {
    const det = runShift(SEEDED_SHIFT);
    const live = runShift(SEEDED_SHIFT, { recorded: recordedAll(permissive) });
    for (const [i, o] of live.outcomes.entries()) {
      const d = det.outcomes[i];
      expect(o.requiresPerson).toBe(true);
      expect(o).not.toHaveProperty("approval");
      expect(o).not.toHaveProperty("refund");
      for (const l of d.lines) expect(RANK[o.lines.find((x) => x.itemKey === l.itemKey)!.status]).toBeGreaterThanOrEqual(RANK[l.status]);
      expect(o.proposedRefundCents).toBeLessThanOrEqual(d.proposedRefundCents);
      expect(checkCustomerNote(o.message.text, false).filter((e) => e.includes("money"))).toEqual([]);
      expect((o.restock ?? []).reduce((s, r) => s + r.recoveryCents, 0)).toBeLessThanOrEqual((d.restock ?? []).reduce((s, r) => s + r.recoveryCents, 0));
    }
    // Every held box stays held (and with these answers nothing new is held either).
    const heldIds = (run: typeof det) => run.outcomes.filter((o) => o.lines.some((l) => l.status !== "OK")).map((o) => o.rmaId);
    expect(heldIds(live)).toEqual(heldIds(det));
  });

  it("a more restrictive live answer does add a hold (a dent app code didn't see)", () => {
    const strict = { ...permissive, "damage-reader": { items: [{ itemKey: "camera_body", surface: "dented", detail: "dent near the lens mount" }], outerBox: "intact" } };
    const o = runShift(SEEDED_SHIFT, { recorded: recordedAll(strict) }).outcomes.find((x) => x.rmaId === "RMA-30101")!;
    expect(o.lines.find((l) => l.itemKey === "camera_body")!.status).toBe("HELD");
    expect(o.proposedRefundCents).toBe(0);
  });

  it("the customer-note check itself", () => {
    expect(checkCustomerNote("Your refund has been issued.", false)).toHaveLength(1);
    expect(checkCustomerNote("We have refunded you.", false)).toHaveLength(1);
    expect(checkCustomerNote("This looks like fraud.", true).join()).toMatch(/accuses/);
    expect(checkCustomerNote("On hold; reply within 14 days.", true).join()).toMatch(/5\.1/);
    expect(checkCustomerNote("A refund is waiting for a reviewer's approval (clause 6.1).", false)).toEqual([]);
  });
});

describe("the live quote", () => {
  it("counts one call per model role per box, worst case, from the roster's token budgets", () => {
    const q = fleetLiveQuote(3, buildRoster(SEEDED_SHIFT));
    expect(q.spark.calls).toBe(3 * 4);
    expect(q.wonder.calls).toBe(3 * 3);
    expect(q.totalUsd).toBeCloseTo(3 * q.perBoxUsd, 9);
    expect(q.totalUsd).toBeLessThan(1);
  });
});
