/**
 * Health check of the SAM 3.1 open-weights endpoint on Modal (modal/sam31_app.py). Prints no secrets.
 *   configured     → GET <MODAL_SAM_URL>/healthz, prints HTTP status, latency and the app's answer
 *   not configured → prints why and exits 0 (nothing to check yet)
 *
 *   --healthz-timeout-s N (default 180; a first boot also downloads the checkpoint)
 *   --clip <mp4> --concepts "a,b" [--fps 5]
 *                  → also sends that ONE clip through ModalSamSegmenter and prints, per concept, the
 *                    frame each track first appears on and the objects per frame (so an item that only
 *                    enters late in the clip shows as a track starting late). Saved as a sam-modal recording.
 *
 * A cold endpoint boots a GPU container and loads the weights to answer, so the first check can take a
 * minute or two and is billed GPU time. Calls are logged to .data/llm-calls.jsonl (unpriced).
 *
 *   npx tsx --env-file=.env.local scripts/check-modal.ts
 *   npx tsx --env-file=.env.local scripts/check-modal.ts --clip <mp4> --concepts "paper bag"
 */
import fs from "node:fs";
import path from "node:path";
import { logLlmCall } from "../lib/obs/llm-log";
import { ModalSamSegmenter, modalSamConfig } from "../lib/openweights/modal-sam";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function segmentOne(clip: string, concepts: string[], fps: number) {
  if (!fs.existsSync(clip)) throw new Error(`no such clip: ${clip}`);
  const clipId = `modal-smoke-${path.basename(clip, path.extname(clip))}`;
  const t0 = Date.now();
  const r = await new ModalSamSegmenter().segment({ clipId, videoPath: clip, concepts, fps });
  console.log(`segment: ${Date.now() - t0} ms round trip · ${r.frames.length} frames · ${r.width}×${r.height} · ${r.source.provenance}`);
  const last = JSON.parse(fs.readFileSync(".data/llm-calls.jsonl", "utf8").trim().split("\n").at(-1) ?? "{}");
  // logLlmCall stores output as a JSON string
  const out = typeof last.output === "string" ? JSON.parse(last.output || "{}") : (last.output ?? {});
  console.log(`server: gpu_seconds ${out.gpu_seconds ?? "?"} · peak_gpu_mb ${out.peak_gpu_mb ?? "?"}`);
  for (const c of concepts) {
    const first = new Map<string | number, number>();
    const perFrame = r.frames.map((f) => {
      const objs = f.masks.filter((m) => m.concept === c);
      for (const m of objs) if (!first.has(m.trackId)) first.set(m.trackId, f.index);
      return objs.length;
    });
    console.log(`  "${c}": ${first.size} tracks · first seen on frames ${[...first.entries()].map(([id, fi]) => `#${id}@${fi}`).join(", ") || "none"}`);
    console.log(`    objects per frame: ${perFrame.join(" ")}`);
  }
}

async function main() {
  const cfg = modalSamConfig();
  if (!cfg.url || !cfg.token) {
    console.log(`Modal SAM endpoint not configured: ${cfg.reason}`);
    return;
  }
  if (!cfg.enabled) console.log(`note: ${cfg.reason}; checking the endpoint anyway`);
  const url = `${cfg.url}/healthz`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(Number(arg("healthz-timeout-s") ?? 180) * 1000) });
    const latencyMs = Date.now() - t0;
    const body = (await res.text()).slice(0, 400);
    logLlmCall({ provider: "modal", model: cfg.model, purpose: "healthz", mode: "live", ok: res.ok, latencyMs, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, input: `GET ${new URL(url).host}/healthz`, output: body });
    console.log(`healthz: HTTP ${res.status} · ${latencyMs} ms · ${body}`);
    console.log(`failover: ${cfg.enabled ? `ON (primary budget ${cfg.timeoutMs} ms, model ${cfg.model})` : "OFF"}`);
    if (!res.ok) process.exitCode = 2;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLlmCall({ provider: "modal", model: cfg.model, purpose: "healthz", mode: "live", ok: false, latencyMs: Date.now() - t0, inputTokens: null, outputTokens: null, costUsd: null, costMicroCents: null, input: `GET ${new URL(url).host}/healthz`, output: "", error: msg });
    console.error(`healthz failed after ${Date.now() - t0} ms: ${msg}`);
    process.exitCode = 2;
  }
  const clip = arg("clip");
  if (clip && !process.exitCode) {
    try {
      await segmentOne(clip, (arg("concepts") ?? "").split(",").map((c) => c.trim()).filter(Boolean), Number(arg("fps") ?? 5));
    } catch (e) {
      console.error(`segment failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 3;
    }
  }
}

main();
