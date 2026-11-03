/**
 * Key-day check for the Fireworks label reader (Muse Glimmer). Prints no secrets.
 *   - not configured: prints why and exits 0
 *   - configured (FIREWORKS_API_KEY set): lists the models the key can call on the OpenAI-compatible
 *     endpoint, says whether FIREWORKS_GLIMMER_MODEL is among them, and prints every id containing
 *     "glimmer" or "muse" so the exact serverless id can be copied into FIREWORKS_GLIMMER_MODEL.
 * One read-only GET; no inference call, no spend.
 *   npx tsx --env-file=.env.local scripts/check-fireworks.ts
 */
import { fireworksConfig, listFireworksModels } from "../lib/openweights/fireworks";

async function main() {
  const cfg = fireworksConfig();
  if (!cfg.apiKey) {
    console.log(`Fireworks label reader not configured: ${cfg.reason}`);
    return;
  }
  console.log(`Fireworks base URL ${cfg.baseURL} · account ${cfg.accountId ?? "(FIREWORKS_ACCOUNT_ID not set; needed only for fine-tuning)"}`);
  const ids = await listFireworksModels(cfg);
  const muse = ids.filter((id) => /glimmer|muse/i.test(id));
  console.log(`${ids.length} models listed. Glimmer/Muse ids:${muse.length ? "" : " none"}`);
  for (const id of muse) console.log(`  ${id}`);
  if (!cfg.model) console.log("FIREWORKS_GLIMMER_MODEL not set: copy the exact Glimmer id from the list above.");
  else console.log(ids.includes(cfg.model) ? `FIREWORKS_GLIMMER_MODEL "${cfg.model}" is in the list: ready.` : `FIREWORKS_GLIMMER_MODEL "${cfg.model}" is NOT in the list: the reader would fail; fix the id.`);
  if (!cfg.enabled) console.log(`Reader still disabled: ${cfg.reason}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
