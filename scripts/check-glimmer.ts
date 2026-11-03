/**
 * GET /healthz on the Muse Glimmer Modal endpoint: status, model, GPU, served adapters, latency.
 *   npx tsx --env-file=.env.local scripts/check-glimmer.ts [--timeout-s 900]
 * A cold app boots an L40S container to answer (billed per GPU-second; FP8 load + compile take minutes).
 * Use it to warm the reader before a bench session: the reader's own 15 s budget can't cover a cold start.
 */
import { modalGlimmerConfig, modalGlimmerHealth } from "../lib/openweights/glimmer-modal";

async function main() {
  const i = process.argv.indexOf("--timeout-s");
  const timeoutS = i > 0 ? Number(process.argv[i + 1]) : 900;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) throw new Error("--timeout-s must be a positive number");
  const cfg = modalGlimmerConfig({ ...process.env, RETURNWITNESS_LABEL_READER: "modal" });
  if (!cfg.url) throw new Error(`not configured: ${cfg.reason}`);
  const h = await modalGlimmerHealth(cfg, { timeoutMs: timeoutS * 1000 });
  console.log(`${h.ok ? "OK" : "FAIL"} HTTP ${h.status} in ${(h.latencyMs / 1000).toFixed(1)} s`);
  console.log(JSON.stringify(h.body, null, 2));
  if (!h.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
