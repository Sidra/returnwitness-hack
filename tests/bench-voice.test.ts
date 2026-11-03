import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BENCH_VOICE_LABEL, holdPromptText, isClearYes, voiceHoldReason } from "@/lib/voice/bench-voice";

const line = (description: string, status: "OK" | "MISSING" | "HELD" | "EXTRA", missingQty = 0) => ({ description, status, missingQty });
const kit = [line("Camera body", "OK"), line("Zoom lens", "OK"), line("Battery + charger", "OK")];

describe("the bench's spoken question (HOLD direction only)", () => {
  it("one missing item: names it and asks to hold", () => {
    expect(holdPromptText("Held", [kit[0], line("Zoom lens", "MISSING", 1), kit[2]])).toBe("One zoom lens is missing. Hold the refund?");
  });

  it("several missing, and an unclear line", () => {
    expect(holdPromptText("Held", [line("Camera body", "MISSING", 1), line("Zoom lens", "MISSING", 2), line("Battery + charger", "HELD")])).toBe(
      "One camera body and two zoom lens are missing. I can't confirm the battery + charger. Hold the refund?",
    );
  });

  it("silent unless the case is held and something is short or unclear", () => {
    expect(holdPromptText("AwaitingApproval", [line("Zoom lens", "MISSING", 1)])).toBeNull();
    expect(holdPromptText("Approved", [line("Zoom lens", "MISSING", 1)])).toBeNull();
    expect(holdPromptText("Held", kit)).toBeNull();
  });

  it("only ever asks to hold: never mentions approving or releasing", () => {
    for (const t of [holdPromptText("Held", [line("Zoom lens", "MISSING", 1)])!, holdPromptText("Held", [line("Zoom lens", "HELD")])!]) {
      expect(t).toMatch(/Hold the refund\?$/);
      expect(t).not.toMatch(/approve|release|refund (it|now)|go ahead/i);
    }
  });
});

describe("the spoken answer (deterministic, app code)", () => {
  it("a clear yes", () => {
    for (const t of ["Yes", "yes, hold it", "Yeah, hold the refund.", "Yep", "confirmed"]) expect(isClearYes(t), t).toBe(true);
  });

  it("anything else changes nothing", () => {
    for (const t of ["no", "No, release it", "yes but approve it", "yes, don't hold", "wait", "hmm", "", "I'm not sure, yes", "yes ".repeat(40)]) expect(isClearYes(t), t).toBe(false);
  });

  it("the audit line names the transcriber and the browser voice", () => {
    expect(voiceHoldReason(" yes, hold it ", "muse-voice-transcribe-1.0")).toBe(
      `Said yes to the bench's hold question: "yes, hold it" (transcribed by muse-voice-transcribe-1.0; the question was read by the browser's voice)`,
    );
  });
});

describe("BenchVoicePrompt (server render)", () => {
  const held = { id: "c1", state: "Held", reconciliation: { lines: [{ itemKey: "lens", sku: "s", description: "Zoom lens", expectedQty: 1, observedQty: 0, missingQty: 1, status: "MISSING", reasons: [], unitPriceCents: 1 }] } };

  it("labels the voice, needs a click, offers mute; renders nothing when there's no hold to ask about", async () => {
    const { BenchVoicePrompt } = await import("@/components/dash/BenchVoicePrompt");
    const props = { voiceEnabled: false, voiceDisabledReason: "off here.", onCase: () => {} };
    const html = renderToStaticMarkup(createElement(BenchVoicePrompt, { ...props, c: held as never }));
    expect(html).toContain(BENCH_VOICE_LABEL);
    expect(html).toContain("One zoom lens is missing. Hold the refund?");
    expect(html).toContain("Ask out loud");
    expect(html).toContain("Mute bench voice");
    expect(html).toContain("Off here.");
    expect(html).not.toMatch(/autoplay/i);
    expect(renderToStaticMarkup(createElement(BenchVoicePrompt, { ...props, c: { ...held, state: "AwaitingApproval" } as never }))).toBe("");
  });
});
