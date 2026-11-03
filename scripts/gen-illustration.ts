/**
 * ONE paid Muse Image call ($0.01): draws a generic, unbranded "complete return" layout of the kit from
 * each item's generic concept, and saves it to public/illustrations/ so every deploy shows it, labelled
 * "generated illustration" (RECORDED once replayed). Refuses to run without --confirm-spend.
 *
 *   npx tsx --env-file=.env.local scripts/gen-illustration.ts --confirm-spend
 */
import { KIT, KIT_ID } from "../data/kit.config";
import { generateIllustration, illustrationPrompt } from "../lib/meta/image";

const items = KIT.items.map((i) => ({ concept: i.genericName, qty: 1 }));
console.log(`prompt: ${illustrationPrompt(items)}`);
if (!process.argv.includes("--confirm-spend")) {
  console.log("dry run: this would make one Muse Image call ($0.01). Re-run with --confirm-spend once Sidra has OK'd the spend.");
  process.exit(0);
}
generateIllustration(KIT_ID, items)
  .then((r) => console.log(`saved ${r.imagePath} · ${r.latencyMs} ms · ${r.model}`))
  .catch((e) => {
    console.error(`illustration failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
