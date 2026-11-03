import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import type { VoiceNote } from "@/lib/domain/case";
import { noteQuote, templateDraft, validateDraft } from "@/lib/engine/decision";
import { runInspection, type PipelineDeps } from "@/lib/engine/pipeline";
import { reconcile } from "@/lib/engine/reconcile";
import type { ReaderEvidence } from "@/lib/meta/readers";
import type { AgentContext } from "@/lib/meta/wonder-agent";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";

const NOTE: VoiceNote = {
  transcript: "Lens cap is missing and the box corner is crushed. Everything else looks fine.",
  mode: "LIVE_META",
  model: "muse-voice-transcribe-1.0",
  latencyMs: 812,
  audioDurationMs: 6100,
  requestId: "sess-1",
  provenance: "live Muse Voice Transcribe call (test double)",
  recordedAt: new Date(0).toISOString(),
};

const run = async (i: 0 | 1, extra: Partial<PipelineDeps> = {}, voiceNote?: VoiceNote) =>
  runInspection(
    { rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" }, ...(voiceNote ? { voiceNote } : {}) },
    { store: new MemoryCaseStore(null), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null, ...extra },
  );

describe("voice note in the decision draft", () => {
  it("quotes the first sentence verbatim, at most 200 characters", () => {
    expect(noteQuote(NOTE.transcript)).toBe("Lens cap is missing and the box corner is crushed.");
    expect(noteQuote("no full stop here " + "x".repeat(300))).toHaveLength(200);
  });

  it("the template draft cites the note when there is one, and only then", async () => {
    const c = await run(1);
    const recon = c.reconciliation!;
    const withNote = templateDraft({ policy: POLICY, recon, rma: RMAS[1], voiceNote: NOTE.transcript });
    expect(withNote.citedVoiceNote).toBe("Lens cap is missing and the box corner is crushed.");
    expect(withNote.rationale).toContain('(transcribed): "Lens cap is missing');
    expect(validateDraft(withNote, { policy: POLICY, recon, rma: RMAS[1], voiceNote: NOTE.transcript }).ok).toBe(true);
    const without = templateDraft({ policy: POLICY, recon, rma: RMAS[1] });
    expect(without).not.toHaveProperty("citedVoiceNote");
  });

  it("a model draft that invents or misquotes a voice note is rejected", async () => {
    const c = await run(1);
    const recon = c.reconciliation!;
    const good = templateDraft({ policy: POLICY, recon, rma: RMAS[1] });
    const invented = { ...good, citedVoiceNote: "The customer said keep the lens." };
    expect(validateDraft(invented, { policy: POLICY, recon, rma: RMAS[1], voiceNote: NOTE.transcript }).errors).toContain("voice-note quote is not verbatim transcript text");
    expect(validateDraft({ ...good, citedVoiceNote: "Lens cap is missing" }, { policy: POLICY, recon, rma: RMAS[1] }).errors[0]).toMatch(/no voice note was recorded/);
  });

  it("a spoken claim never turns a held box into an approval", () => {
    const recon = reconcile(RMAS[0], ORDERS[0].slip, { clipId: "x", counts: { camera_body: 1, lens: 0, battery: 1 }, arrivals: [], flags: [], diagnostics: { framesProcessed: 1, rawTrackIdsPerItem: {}, trackIdsPerSlot: {}, ignoredMasks: 0 } });
    expect(recon.summary.allClear).toBe(false);
    const draft = { ...templateDraft({ policy: POLICY, recon, rma: RMAS[0] }), recommendation: "APPROVE_FULL" as const, citedVoiceNote: "Everything is here." };
    const v = validateDraft(draft, { policy: POLICY, recon, rma: RMAS[0], voiceNote: "Everything is here." });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/only HOLD is allowed/);
  });
});

describe("voice note through the pipeline", () => {
  it("is stored on the case with an audit entry naming the model, and reaches every reader and the agent", async () => {
    let seenEvidence: ReaderEvidence | null = null;
    let seenCtx: AgentContext | null = null;
    const c = await run(
      1,
      {
        readers: [{ name: "probe-reader", required: false, read: async (e) => ((seenEvidence = e), { output: null, mode: "DETERMINISTIC", model: "probe", latencyMs: 0 }) }],
        agent: async (ctx) => ((seenCtx = ctx), null),
      },
      NOTE,
    );
    expect(c.voiceNote).toEqual(NOTE);
    expect(c.audit.find((a) => a.event === "VOICE_NOTE")).toMatchObject({ actor: "model:muse-voice-transcribe-1.0" });
    expect(seenEvidence!.voiceNote).toBe(NOTE.transcript);
    expect(seenCtx!.voiceNote).toBe(NOTE.transcript);
    expect(c.draft?.draft.citedVoiceNote).toBe("Lens cap is missing and the box corner is crushed.");
  });

  it("a seeded note is attributed to the system, not to a model", async () => {
    const seeded: VoiceNote = { ...NOTE, mode: "RECORDED_FIXTURE", provenance: "seeded note text, not a live transcription" };
    const c = await run(1, {}, seeded);
    expect(c.audit.find((a) => a.event === "VOICE_NOTE")).toMatchObject({ actor: "system" });
  });

  it("no note, no citation, no audit entry", async () => {
    const c = await run(1);
    expect(c.voiceNote).toBeUndefined();
    expect(c.audit.some((a) => a.event === "VOICE_NOTE")).toBe(false);
    expect(c.draft?.draft.citedVoiceNote).toBeUndefined();
  });
});
