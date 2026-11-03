/**
 * Which Muse Glimmer label reader runs, from one env var (RETURNWITNESS_LABEL_READER):
 *   "modal"     → my own Modal GPU endpoint (glimmer-modal.ts). It takes precedence: with "modal"
 *                 set, Fireworks is never called even if every FIREWORKS_* variable is present, and a
 *                 Modal endpoint that isn't configured means "not run" (no silent switch to Fireworks).
 *   "fireworks" → Fireworks serverless (fireworks.ts), exactly as written.
 *   anything else → no label reader; the card says why.
 * Pure: runtime.ts wires the result into pipelineDeps and systemStatus.
 */
import type { ReaderEvidence, ReaderResult } from "@/lib/meta/readers";
import { fireworksConfig, glimmerLabelRead, GLIMMER_READER_NAME, LABEL_READER_NOT_RUN } from "./fireworks";
import { GLIMMER_MODAL_READER_NAME, labelReaderSelection, MODAL_GLIMMER_NOT_RUN, modalDisplayModel, modalGlimmerConfig, modalGlimmerLabelRead } from "./glimmer-modal";

export interface LabelReaderChoice {
  provider: "modal" | "fireworks" | null;
  enabled: boolean;
  /** Reader name on the case card (matches /glimmer/i so corrections feed the fine-tune dataset). */
  readerName: string;
  model: string | null;
  adapter: string | null;
  /** Why it is off, with the "not run" tag the card shows. Empty when on. */
  reason: string;
  /** Plain status for /settings. */
  status: string;
  read: ((e: ReaderEvidence) => Promise<ReaderResult>) | null;
}

export function selectLabelReader(env: NodeJS.ProcessEnv = process.env): LabelReaderChoice {
  const sel = labelReaderSelection(env);
  if (sel === "modal") {
    const m = modalGlimmerConfig(env);
    return {
      provider: "modal",
      enabled: m.enabled,
      readerName: GLIMMER_MODAL_READER_NAME,
      model: modalDisplayModel(m),
      adapter: m.adapter,
      reason: m.enabled ? "" : `${MODAL_GLIMMER_NOT_RUN}: ${m.reason}`,
      status: m.enabled
        ? `Modal endpoint configured (${modalDisplayModel(m)}); labelled LIVE · Meta open weights on a partner GPU only once a real call succeeds`
        : `Muse Glimmer on Modal: deployed (vLLM FP8 on an L40S) and evaluated; off on this server (${m.reason})`,
      read: m.enabled ? (e) => modalGlimmerLabelRead(e, m) : null,
    };
  }
  const f = fireworksConfig(env);
  if (sel === "fireworks") {
    return {
      provider: "fireworks",
      enabled: f.enabled,
      readerName: GLIMMER_READER_NAME,
      model: f.model,
      adapter: null,
      reason: f.enabled ? "" : `${LABEL_READER_NOT_RUN}: ${f.reason}`,
      status: f.enabled ? `Fireworks configured (${f.model})` : `Fireworks: not configured (no Fireworks credits): ${f.reason}`,
      read: f.enabled ? (e) => glimmerLabelRead(e, f) : null,
    };
  }
  return {
    provider: null,
    enabled: false,
    readerName: "muse-glimmer",
    model: null,
    adapter: null,
    reason: `${MODAL_GLIMMER_NOT_RUN}: no label reader selected on this server (RETURNWITNESS_LABEL_READER=modal turns it on)`,
    status: "Muse Glimmer on Modal: deployed (vLLM FP8 on an L40S) and evaluated; off on this server. Fireworks: not configured (no Fireworks credits)",
    read: null,
  };
}
