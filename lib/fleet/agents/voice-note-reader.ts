/**
 * Voice-note reader: turns what the returns lead said at the bench into claims and work items.
 * A spoken claim may RAISE a hold (a missing lens cap, a swollen battery: things the counter can't
 * see) and never clears one: "the customer says the lens is in there" becomes a work item, not a
 * count. It reads the TRANSCRIPT (Muse Voice Transcribe made it earlier in the run).
 * Deterministic: rules over the transcript. Live (`voiceNoteReaderLive`): muse-spark-1.3 on the
 * transcript text; a claim whose quote isn't in the transcript is dropped.
 */
import { z } from "zod";
import type { VoiceNote } from "@/lib/domain/case";
import { budgetBasis, slipAndCount, tokenBudgetUsd, type LiveRoleDef, type ReturnCtx, type VoiceClaim, type VoiceReaderOutput } from "../context";
import type { AgentResult, AgentSpec, HoldEffect, WorkItem } from "../types";

const BUDGET = { inTok: 1200, outTok: 300 };

export const voiceNoteReaderSpec: AgentSpec = {
  name: "voice-note-reader",
  role: "voice-note-reader",
  kind: "model",
  model: "muse-spark-1.3",
  budget: BUDGET,
  costPerRunUsd: tokenBudgetUsd("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok),
  costBasis: budgetBasis("muse-spark-1.3", BUDGET.inTok, BUDGET.outTok, "the transcript text; the transcription itself (Muse Voice Transcribe) is billed in the inspection"),
  scope: "return",
  does: "turns the lead's transcribed note into claims: a claim can raise a hold, never clear one",
};

/** Ordered rules: each finds one kind of claim in the transcript. */
const RULES: Array<{ kind: VoiceClaim["kind"]; itemKey: VoiceClaim["itemKey"]; re: RegExp }> = [
  { kind: "accessory_missing", itemKey: "lens", re: /\b(lens|front|rear)\s+cap\b[^.]*\b(missing|isn't|is not|not in|gone)\b|\b(missing|no)\b[^.]*\b(lens|front|rear)\s+cap\b/i },
  { kind: "battery_hazard", itemKey: "battery", re: /\b(swollen|swelling|bulging|smells? burnt|burning smell|leaking|scorch)/i },
  { kind: "carton_crushed", itemKey: null, re: /\b(box|carton|package)\b[^.]*\b(crushed|caved|torn open|soaked|damaged)\b/i },
  { kind: "customer_assertion", itemKey: null, re: /\b(customer|they|buyer)\b[^.]*\b(says?|said|emailed|claims?)\b/i },
];

export function extractClaims(transcript: string): VoiceClaim[] {
  const sentences = transcript.split(/(?<=[.!?])\s+/).filter(Boolean);
  const claims: VoiceClaim[] = [];
  for (const s of sentences) {
    for (const r of RULES) {
      if (r.re.test(s) && !claims.some((c) => c.kind === r.kind)) claims.push({ kind: r.kind, itemKey: r.itemKey, quote: s.trim() });
    }
  }
  return claims;
}

/** Claims → holds and work items. A claim without an item it can attach to holds every line (fail closed). */
export function claimsToResult(claims: VoiceClaim[], vn: VoiceNote, note = ""): AgentResult<VoiceReaderOutput> {
  const holds: HoldEffect[] = [];
  const workItems: WorkItem[] = [];
  const by = voiceNoteReaderSpec.name;
  const who = vn.person ?? "returns lead";
  for (const c of claims) {
    if (c.kind === "accessory_missing") {
      holds.push({ itemKey: c.itemKey ?? "*", code: "spoken_claim", detail: `${who} said: "${c.quote}" (clause 2.1: all accessories)` });
      workItems.push({ by, text: "Confirm the missing accessory and photograph it on the bench" });
    } else if (c.kind === "battery_hazard") {
      holds.push({ itemKey: c.itemKey ?? "*", code: "battery_hazard", detail: `${who} said: "${c.quote}"` });
      workItems.push({ by, text: "Move the battery to the lithium safety bin; do not test-charge it" });
    } else if (c.kind === "carton_crushed") {
      workItems.push({ by, text: "Note the crushed carton on the carrier record (the camera didn't see it)" });
    } else if (c.kind === "customer_assertion") {
      workItems.push({ by, text: "Customer disputes the count: reply with the timestamped inspection record (a spoken claim doesn't change the count)" });
    }
  }
  return {
    output: { claims },
    trace: `${claims.length ? `heard: ${claims.map((c) => c.kind.replace("_", " ")).join(", ")}${holds.length ? ` → hold on ${holds.map((h) => h.itemKey).join(", ")}` : " → work item only"}` : "note heard; no claim the fleet can act on"}${note}`,
    holds,
    workItems,
  };
}

export function runVoiceNoteReader(ctx: ReturnCtx): AgentResult<VoiceReaderOutput> {
  const vn = ctx.ret.voiceNote;
  if (!vn) return { output: { claims: [] }, trace: "no voice note on this return", holds: [], workItems: [] };
  return claimsToResult(extractClaims(vn.transcript), vn);
}

/* ---------- Live: muse-spark-1.3 on the transcript ---------- */

const KINDS = ["accessory_missing", "carton_crushed", "battery_hazard", "customer_assertion"] as const;
export const VoiceReaderLiveAnswer = z.object({
  claims: z.array(z.object({ kind: z.enum(KINDS), itemKey: z.string().nullable(), quote: z.string() })),
});
export type VoiceReaderLiveAnswer = z.infer<typeof VoiceReaderLiveAnswer>;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const voiceNoteReaderLive: LiveRoleDef<VoiceReaderOutput, VoiceReaderLiveAnswer> = {
  role: "voice-note-reader",
  modelKind: "spark",
  schemaName: "voice_claims",
  schema: VoiceReaderLiveAnswer,
  system: `You read the transcript of what a returns lead said while unpacking a returned kit. List each claim:
"accessory_missing" (a small part not on the packing slip is absent, e.g. a lens cap), "battery_hazard" (swollen,
leaking or burnt battery), "carton_crushed" (the shipping box arrived damaged), "customer_assertion" (the lead relays what
the customer says). itemKey is the packing-slip item it concerns, or null. quote must be copied word for word from the
transcript. Do not infer claims that weren't said. A spoken claim never proves an item is present.`,
  prompt: (ctx) => ({ text: JSON.stringify({ transcript: ctx.ret.voiceNote?.transcript ?? "", packingSlip: slipAndCount(ctx).packingSlip }, null, 1), images: [] }),
  toResult: (live, ctx) => {
    const vn = ctx.ret.voiceNote;
    if (!vn) throw new Error("no transcript on this box");
    const said = squash(vn.transcript);
    const keys = new Set(ctx.ret.order.slip.lines.map((l) => l.itemKey));
    const kept = live.claims.filter((c) => squash(c.quote).length > 0 && said.includes(squash(c.quote)));
    const dropped = live.claims.length - kept.length;
    const claims: VoiceClaim[] = kept.map((c) => ({ kind: c.kind, itemKey: c.itemKey && keys.has(c.itemKey) ? (c.itemKey as VoiceClaim["itemKey"]) : null, quote: c.quote }));
    return claimsToResult(claims, vn, dropped ? `; dropped ${dropped} claim(s) whose quote isn't in the transcript` : "");
  },
  combine: (det, live) => ({
    output: { claims: [...live.output.claims, ...det.output.claims.filter((c) => !live.output.claims.some((l) => l.kind === c.kind))] },
    trace: live.trace,
    holds: [...det.holds, ...live.holds.filter((h) => !det.holds.some((x) => x.itemKey === h.itemKey && x.code === h.code))],
    workItems: [...det.workItems, ...live.workItems.filter((w) => !det.workItems.some((x) => x.text === w.text))],
  }),
};
