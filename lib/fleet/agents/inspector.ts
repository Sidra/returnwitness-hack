/**
 * Inspector: one named agent per return (`inspector-rma-30101`, …). Runs the REAL tray counter on
 * the return's segmentation and reconciles the count against the packing slip. App code.
 *
 * It reconciles counts only: the slip's serials are withheld here because serial matching is the
 * serial matcher's job, so each agent's contribution can be measured on its own (the production
 * pipeline in lib/engine/pipeline.ts still checks serials inside `reconcile`).
 */
import { KIT } from "@/data/kit.config";
import { buildTracks, type ShiftReturn } from "@/data/shift";
import { reconcile } from "@/lib/engine/reconcile";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { synthFrames } from "@/lib/vision/synth";
import { countClip } from "@/lib/vision/tray-counter";
import type { CountResult, Frame } from "@/lib/domain/schemas";
import { SCENES } from "@/data/scenes";
import type { InspectorOutput, ReturnCtx } from "../context";
import type { AgentResult, AgentSpec, FleetLine } from "../types";

const COUNTER = counterConfigForKit(KIT);

/** The segmentation frames for one return: a demo scene (data/scenes.ts) or synthetic tracks from its motion pattern. */
export function framesFor(ret: ShiftReturn): Frame[] {
  if (ret.clip.sceneId) {
    const scene = SCENES[ret.clip.sceneId];
    if (!scene) throw new Error(`no demo scene ${ret.clip.sceneId}`);
    return scene().frames;
  }
  const { frames, tracks } = buildTracks(ret.clip);
  return synthFrames({ frames, fps: 5, tracks });
}
const memo = new Map<string, { count: CountResult; frames: number }>();

/** The counter run for one return (memoised: the counter is deterministic, and ablation re-runs the shift many times). */
export function countReturn(ret: ShiftReturn): { count: CountResult; frames: number } {
  const hit = memo.get(ret.rma.id);
  if (hit) return hit;
  const frames = framesFor(ret);
  const r = { count: countClip(ret.rma.clipId, frames, COUNTER), frames: frames.length };
  memo.set(ret.rma.id, r);
  return r;
}

export const inspectorName = (rmaId: string) => `inspector-${rmaId.toLowerCase()}`;

export function inspectorSpec(rmaId: string): AgentSpec {
  return {
    name: inspectorName(rmaId),
    role: "inspector",
    kind: "code",
    costPerRunUsd: 0,
    costBasis: "app code (tray counter); its segmentation input is costed by the cost agent",
    scope: "return",
    does: `counts what settles in the tray for ${rmaId} and reconciles it with the packing slip`,
  };
}

export function runInspector(ctx: ReturnCtx): AgentResult<InspectorOutput> {
  const { ret } = ctx;
  const { count, frames } = countReturn(ret);
  const slipNoSerials = { ...ret.order.slip, lines: ret.order.slip.lines.map((l) => ({ ...l, serial: undefined })) };
  const recon = reconcile(ret.rma, slipNoSerials, count);
  const lines: FleetLine[] = recon.lines.map((l) => ({
    itemKey: l.itemKey,
    description: l.description,
    expectedQty: l.expectedQty,
    observedQty: l.observedQty,
    missingQty: l.missingQty,
    unitPriceCents: l.unitPriceCents,
    status: l.status,
    reasons: l.reasons.map((r) => ({ code: r.code as FleetLine["reasons"][number]["code"], detail: r.detail, by: inspectorName(ret.rma.id) })),
  }));
  const seen = Object.values(count.counts).reduce((s, n) => s + n, 0);
  const notOk = lines.filter((l) => l.status !== "OK").map((l) => `${l.itemKey} ${l.status}`);
  return {
    output: { count, lines, frames },
    trace: `counted ${seen} of ${lines.reduce((s, l) => s + l.expectedQty, 0)} items over ${frames} frames${notOk.length ? `; ${notOk.join(", ")}` : "; every line matches the slip"}`,
    holds: [],
    workItems: [],
  };
}

