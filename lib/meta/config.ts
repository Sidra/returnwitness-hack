/**
 * Meta Model API configuration. Base URL and model IDs come from env; the key is never logged.
 * Mode on every result: LIVE · Meta when META_HACK_API_KEY is set (and the call succeeds),
 * otherwise RECORDED FIXTURE · synthetic scene, not a live Meta call. ADR-002. There is no non-Meta fallback:
 * when Meta isn't available the demo replays labelled fixtures (a recorded Meta run once one exists).
 * Contributor-mode model variants (cheaper, but Meta may train on the content) are refused at every
 * call site, always. There is no opt-in: Sidra's rule is never to use Meta contributor mode. ADR-002.
 */
import type { ModeLabel } from "@/lib/domain/schemas";

export interface MetaConfig {
  apiKey: string | null;
  baseURL: string;
  models: { sam: string; spark: string; wonder: string; voice: string; image: string };
  /** Public demo profile: uploads off, fixtures only, no live calls even with a key. */
  publicDemo: boolean;
  /** Configured model ids the contributor guard will refuse (shown on /settings). */
  refusedModels: string[];
}

/** The opt-in flag this guard once had. It is ignored now; kept only so tests can prove that. */
export const RETIRED_CONTRIBUTOR_FLAG = "RETURNWITNESS_ALLOW_CONTRIBUTOR_MODELS";
export const isContributorModel = (id: string) => /contributor/i.test(id);

/** Throws before any call to a contributor-mode model. No flag or env var turns this off. */
export function assertNotContributor(model: string): void {
  if (isContributorModel(model)) throw new Error(`refused model "${model}": contributor-mode variants may be used by Meta for training, and ReturnWitness never uses them`);
}

export function metaConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  const publicDemo = env.RETURNWITNESS_PUBLIC_DEMO === "1";
  const models = {
    sam: env.META_MODEL_SAM?.trim() || "sam-3.1",
    spark: env.META_MODEL_SPARK?.trim() || "muse-spark-1.3",
    wonder: env.META_MODEL_WONDER?.trim() || "muse-wonder-1.0",
    voice: env.META_MODEL_VOICE?.trim() || "muse-voice-transcribe-1.0",
    image: env.META_MODEL_IMAGE?.trim() || "muse-image-1.0",
  };
  return {
    apiKey: env.META_HACK_API_KEY?.trim() || null,
    baseURL: env.META_BASE_URL?.trim() || "https://api.meta.ai/v1",
    models,
    publicDemo,
    refusedModels: Object.values(models).filter(isContributorModel),
  };
}

export const liveMetaAvailable = (c: MetaConfig = metaConfig()) => Boolean(c.apiKey) && !c.publicDemo;
export const metaMode = (c: MetaConfig = metaConfig()): ModeLabel => (liveMetaAvailable(c) ? "LIVE_META" : "RECORDED_FIXTURE");
