/**
 * The agent fleet: the seeded shift's counts come from the real counter, the shift is a believable
 * mix, each agent does its job on the edge cases, the merge can only make lines more restrictive, and
 * nothing in the fleet can approve or refund.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { KIT, KIT_TOTAL_CENTS } from "@/data/kit.config";
import { POLICY, RMAS, orderFor } from "@/data/fixtures";
import { SCENES } from "@/data/scenes";
import { SEEDED_SHIFT, SHIFT_LABEL, buildTracks, type SeededShift, type ShiftReturn } from "@/data/shift";
import { counterConfigForKit } from "@/lib/vision/counter-config";
import { synthFrames } from "@/lib/vision/synth";
import { countClip } from "@/lib/vision/tray-counter";
import { CUT_ROLES, applyHolds, buildRoster, runShift } from "@/lib/fleet/coordinator";
import { countReturn, runInspector } from "@/lib/fleet/agents/inspector";
import { runLabelReader } from "@/lib/fleet/agents/label-reader";
import { runDamageReader } from "@/lib/fleet/agents/damage-reader";
import { extractClaims, runVoiceNoteReader } from "@/lib/fleet/agents/voice-note-reader";
import { runSerialMatcher } from "@/lib/fleet/agents/serial-matcher";
import { normAddress, runFraudPattern } from "@/lib/fleet/agents/fraud-pattern";
import { carrierClaimTriggered, runCarrierClaim } from "@/lib/fleet/agents/carrier-claim";
import { runPolicy } from "@/lib/fleet/agents/policy";
import { LIVE_ROLES } from "@/lib/fleet/live-merge";
import { projectDaily } from "@/lib/fleet/projection";
import type { ReturnCtx } from "@/lib/fleet/context";
import type { AgentResult, FleetLine, HoldEffect, ReturnOutcome } from "@/lib/fleet/types";
import type { LineStatus } from "@/lib/domain/schemas";

const root = path.resolve(__dirname, "..");
const ret = (id: string) => SEEDED_SHIFT.returns.find((r) => r.rma.id === id)!;
const ctx = (r: ShiftReturn, extra: Partial<ReturnCtx> = {}): ReturnCtx => ({ ret: r, settings: SEEDED_SHIFT.settings, policy: POLICY, up: {}, ...extra });
const withInspector = (r: ShiftReturn): ReturnCtx => {
  const c = ctx(r);
  c.up.inspector = runInspector(c).output;
  return c;
};
/** A copy of a seeded box under a new RMA id (so the counter memo doesn't reuse the original's count). */
const variant = (id: string, newId: string, edit: (r: ShiftReturn) => void): ShiftReturn => {
  const r = structuredClone(ret(id));
  r.rma.id = newId;
  edit(r);
  return r;
};
const shiftOf = (returns: ShiftReturn[]): SeededShift => ({ ...SEEDED_SHIFT, returns });
const full = runShift(SEEDED_SHIFT);
const out = (id: string) => full.outcomes.find((o) => o.rmaId === id)!;
const RANK: Record<LineStatus, number> = { OK: 0, EXTRA: 1, HELD: 2, MISSING: 3 };
const held = (o: ReturnOutcome) => o.lines.some((l) => l.status !== "OK");

describe("the seeded shift", () => {
  it("is 24 open returns, labelled as a synthetic seeded fixture, with unique RMAs and orders", () => {
    expect(SHIFT_LABEL).toBe("[Seeded shift fixture · synthetic]");
    expect(SEEDED_SHIFT.returns).toHaveLength(24);
    expect(new Set(SEEDED_SHIFT.returns.map((r) => r.rma.id)).size).toBe(24);
    expect(new Set(SEEDED_SHIFT.returns.map((r) => r.order.id)).size).toBe(24);
    for (const r of SEEDED_SHIFT.returns) {
      expect(r.rma.requestedRefundCents).toBe(KIT_TOTAL_CENTS);
      expect(r.order.slip.lines.map((l) => [l.itemKey, l.unitPriceCents])).toEqual(KIT.items.map((i) => [i.key, i.unitPriceCents]));
    }
  });

  it("opens with the three demo returns, using their own fixture slips, serials and prices", () => {
    expect(SEEDED_SHIFT.returns.slice(0, 3).map((r) => r.rma.id)).toEqual(RMAS.map((r) => r.id));
    for (const [i, r] of SEEDED_SHIFT.returns.slice(0, 3).entries()) {
      expect(r.rma).toEqual(RMAS[i]);
      expect(r.order.slip).toEqual(orderFor(RMAS[i].orderId)!.slip);
      expect(r.clip.sceneId).toBe(RMAS[i].clipId);
    }
    expect(out("RMA-20418").lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(held(out("RMA-20419"))).toBe(false);
    expect(held(out("RMA-20420"))).toBe(false);
  });

  it("is a believable mix: most boxes clean, 4–6 held, each held box for one distinct cause", () => {
    const heldOutcomes = full.outcomes.filter(held);
    expect(heldOutcomes.length).toBeGreaterThanOrEqual(4);
    expect(heldOutcomes.length).toBeLessThanOrEqual(6);
    const primary = heldOutcomes.map((o) => o.holdReasons.map((h) => h.split(":")[1]).sort().join("+"));
    expect(new Set(primary).size).toBe(heldOutcomes.length);
    expect(full.outcomes.filter((o) => o.route.queues.includes("approve_refund")).length).toBe(24 - heldOutcomes.length);
  });

  it("voice notes are seeded fixtures in the VoiceNote shape, never shown as live", () => {
    const notes = SEEDED_SHIFT.returns.flatMap((r) => (r.voiceNote ? [r.voiceNote] : []));
    expect(notes.length).toBeGreaterThanOrEqual(3);
    for (const n of notes) {
      expect(n.mode).toBe("RECORDED_FIXTURE");
      expect(n.provenance).toBe("seeded note text, not a live transcription");
      expect(n.model).toBe("muse-voice-transcribe-1.0");
    }
  });

  it("carries no hand-written counts: every count is the real tray counter on the box's frames", () => {
    const cfg = counterConfigForKit(KIT);
    for (const r of SEEDED_SHIFT.returns) {
      expect(Object.keys(r)).not.toContain("count");
      const frames = r.clip.sceneId ? SCENES[r.clip.sceneId]().frames : (() => {
        const { frames: n, tracks } = buildTracks(r.clip);
        return synthFrames({ frames: n, fps: 5, tracks });
      })();
      expect(countReturn(r).count).toEqual(countClip(r.rma.clipId, frames, cfg));
    }
  });

  it("the counter absorbs the messy unpacks: re-issued IDs, a re-boxed camera, kraft paper", () => {
    expect(countReturn(ret("RMA-20418")).count.counts).toEqual({ camera_body: 1, lens: 0, battery: 1 });
    const reboxed = countReturn(ret("RMA-20420")).count;
    expect(reboxed.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 });
    expect(reboxed.diagnostics.rawTrackIdsPerItem.camera_body).toBe(3);
    const handRest = countReturn(ret("RMA-30102")).count;
    expect(handRest.counts.lens).toBe(1);
    expect(handRest.diagnostics.rawTrackIdsPerItem.lens).toBe(2);
    expect(countReturn(ret("RMA-30108")).count.counts).toEqual({ camera_body: 1, lens: 1, battery: 1 }); // under kraft paper
  });
});

describe("the roster", () => {
  const roster = buildRoster(SEEDED_SHIFT);
  it("has at least 30 named agents with unique names: one inspector per return plus the specialists", () => {
    expect(roster.length).toBeGreaterThanOrEqual(30);
    expect(new Set(roster.map((a) => a.name)).size).toBe(roster.length);
    expect(roster.filter((a) => a.role === "inspector").map((a) => a.name)).toEqual(SEEDED_SHIFT.returns.map((r) => `inspector-${r.rma.id.toLowerCase()}`));
  });
  it("doesn't ship a cut role", () => {
    for (const c of CUT_ROLES) expect(roster.map((a) => a.name)).not.toContain(c.spec.name);
  });
  it("model roles name the Meta model they call live, have a token budget and a live definition; code roles cost nothing", () => {
    for (const a of roster) {
      if (a.kind === "model") {
        expect(a.model).toMatch(/^muse-(spark-1\.3|wonder-1\.0)$/);
        expect(a.budget!.inTok).toBeGreaterThan(0);
        expect(a.costPerRunUsd).toBeGreaterThan(0);
        expect(a.costBasis).toMatch(/estimate/);
        expect(LIVE_ROLES.map((d) => d.role)).toContain(a.role);
        expect(LIVE_ROLES.find((d) => d.role === a.role)!.modelKind).toBe(a.model === "muse-spark-1.3" ? "spark" : "wonder");
      } else {
        expect(a.model).toBeUndefined();
        expect(a.costPerRunUsd).toBe(0);
      }
    }
  });
});

describe("no network, no keys, no money", () => {
  const fleetDir = path.join(root, "lib", "fleet");
  const files = [path.join(root, "data", "shift.ts"), ...fs.readdirSync(fleetDir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => path.join(fleetDir, f))];
  it.each(files.map((f) => [path.relative(root, f), f]))("%s reads no key and can't reach the refund path", (rel, f) => {
    const src = fs.readFileSync(f, "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/from\s+"(stripe|node:https?|node:net)"/);
    // Only the live module talks to Meta, through the OpenAI SDK, with a config the caller passes in.
    if (rel !== path.join("lib", "fleet", "live.ts")) expect(src).not.toMatch(/from\s+"openai"/);
    expect(src).not.toMatch(/from\s+"[^"]*(engine\/(approval|service)|payments\/stripe-rail)"/);
    expect(src).not.toMatch(/\b(issueToken|verifyToken|createRefund|approveCase|refundCase)\s*\(/);
  });
  it("the outcome and agent result types have no way to approve or refund", () => {
    type Forbidden = "approval" | "approve" | "approved" | "refund" | "refundId" | "token" | "approvalToken" | "nonce";
    expectTypeOf<Extract<keyof ReturnOutcome, Forbidden>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof AgentResult<unknown>, Forbidden>>().toEqualTypeOf<never>();
    // A hold effect carries no status at all: an agent cannot write OK onto a line.
    expectTypeOf<keyof HoldEffect>().toEqualTypeOf<"itemKey" | "code" | "detail">();
    expectTypeOf<ReturnOutcome["requiresPerson"]>().toEqualTypeOf<true>();
  });
  it("every outcome goes to a person; only a clean return reaches the approval queue, and even that is a proposal", () => {
    for (const o of full.outcomes) {
      expect(o.requiresPerson).toBe(true);
      expect(o).not.toHaveProperty("approval");
      expect(o).not.toHaveProperty("refund");
      expect(o.route.queues.includes("approve_refund")).toBe(!held(o));
      if (held(o)) expect(o.route.queues).toContain("hold_review");
    }
    expect(out("RMA-30101").proposedRefundCents).toBe(KIT_TOTAL_CENTS);
    expect(out("RMA-30101").route.why).toMatch(/a person approves/);
  });
  it("without recordings every model step says it ran as app code", () => {
    for (const o of full.outcomes) for (const t of o.traces.filter((x) => buildRoster(SEEDED_SHIFT).find((a) => a.name === x.agent)?.kind === "model")) expect(t.source).toBe("deterministic");
  });
});

describe("the merge only ever adds restriction", () => {
  const line = (status: LineStatus, itemKey = "lens"): FleetLine => ({ itemKey, description: itemKey, expectedQty: 1, observedQty: status === "MISSING" ? 0 : 1, missingQty: status === "MISSING" ? 1 : 0, unitPriceCents: 100, status, reasons: [] });
  it("a hold raises OK to HELD, leaves MISSING as MISSING and HELD as HELD", () => {
    const h: HoldEffect = { itemKey: "lens", code: "spoken_claim", detail: "x" };
    expect(applyHolds([line("OK")], [h], "a")[0].status).toBe("HELD");
    expect(applyHolds([line("MISSING")], [h], "a")[0].status).toBe("MISSING");
    expect(applyHolds([line("HELD")], [h], "a")[0].status).toBe("HELD");
  });
  it("an adversarial effect that smuggles status OK is still a hold", () => {
    const evil = { itemKey: "lens", code: "count_match", detail: "all fine", status: "OK" } as unknown as HoldEffect;
    const merged = applyHolds([line("MISSING"), line("HELD", "camera_body")], [evil, { ...evil, itemKey: "camera_body" }], "evil");
    expect(merged.map((l) => l.status)).toEqual(["MISSING", "HELD"]);
  });
  it("a hold aimed at a line that doesn't exist holds every line (fail closed)", () => {
    const merged = applyHolds([line("OK", "camera_body"), line("OK", "lens")], [{ itemKey: "tripod", code: "spoken_claim", detail: "x" }], "a");
    expect(merged.every((l) => l.status === "HELD")).toBe(true);
  });
  it("nothing in the fleet clears a hold the tray counter raised, on any return", () => {
    for (const r of SEEDED_SHIFT.returns) {
      const counterOnly = runInspector(ctx(r)).output.lines;
      const merged = out(r.rma.id).lines;
      for (const l of counterOnly) expect(RANK[merged.find((m) => m.itemKey === l.itemKey)!.status]).toBeGreaterThanOrEqual(RANK[l.status]);
    }
  });
  it("a spoken claim that the lens is in the box doesn't change the count", () => {
    const claim = variant("RMA-20418", "RMA-T-CLAIM", (r) => {
      r.voiceNote = { ...ret("RMA-30113").voiceNote!, transcript: "Customer emailed that the lens is in there and everything is included." };
    });
    const o = runShift(shiftOf([claim])).outcomes[0];
    expect(o.lines.find((l) => l.itemKey === "lens")!.status).toBe("MISSING");
    expect(o.workItems.map((w) => w.text).join()).toMatch(/spoken claim doesn't change the count/);
  });
  it("the shift runs the same way twice (deterministic)", () => {
    expect(runShift(SEEDED_SHIFT)).toEqual(full);
  });
  it("without the inspector every line is held and nothing is proposed", () => {
    for (const o of runShift(SEEDED_SHIFT, { remove: ["inspector"] }).outcomes) {
      expect(o.lines.every((l) => l.status === "HELD" && l.reasons.some((x) => x.code === "no_count"))).toBe(true);
      expect(o.proposedRefundCents).toBe(0);
    }
  });
});

describe("each agent on its edge cases", () => {
  it("label reader: holds a 0.64 read that happens to match, passes 0.92, holds a read outside the serial format", () => {
    expect(runLabelReader(withInspector(ret("RMA-30116"))).holds).toEqual([expect.objectContaining({ itemKey: "lens", code: "label_unreadable" })]);
    expect(runLabelReader(withInspector(ret("RMA-30101"))).holds).toEqual([]);
    const ocr = variant("RMA-30101", "RMA-T-OCR", (r) => {
      r.clip.labels.lens = { text: "BW-LN-8121O", confidence: 0.95 };
    });
    expect(runLabelReader(withInspector(ocr)).holds[0].detail).toMatch(/serial format/);
  });
  it("label reader: no count → nothing to judge, no hold", () => {
    const r = runLabelReader(ctx(ret("RMA-30116")));
    expect(r.holds).toEqual([]);
    expect(r.trace).toMatch(/no count/);
  });

  it("serial matcher: names the order a stray serial was sold on, and leaves illegible reads to the label reader", () => {
    const stray = variant("RMA-30101", "RMA-T-STRAY", (r) => {
      r.clip.labels.camera_body = { text: ret("RMA-30102").order.slip.lines[0].serial!, confidence: 0.91 };
    });
    const c = withInspector(stray);
    c.up.labelReader = runLabelReader(c).output;
    expect(runSerialMatcher({ ...c, shiftReturns: SEEDED_SHIFT.returns }).holds[0].detail).toMatch(/sold on ORD-61402 \(RMA-30102\)/);
    const smudged = withInspector(ret("RMA-30116"));
    smudged.up.labelReader = runLabelReader(smudged).output;
    expect(runSerialMatcher({ ...smudged, shiftReturns: SEEDED_SHIFT.returns }).holds).toEqual([]);
  });
  it("serial matcher: without a label reader it matches the counter's raw reads", () => {
    expect(runSerialMatcher({ ...withInspector(ret("RMA-30103")), shiftReturns: SEEDED_SHIFT.returns }).holds).toEqual([expect.objectContaining({ itemKey: "camera_body", code: "serial_mismatch" })]);
  });

  it("voice-note reader: finds each claim kind in different wordings, ignores small talk", () => {
    expect(extractClaims("No lens cap with this one.").map((c) => c.kind)).toEqual(["accessory_missing"]);
    expect(extractClaims("The rear cap is gone.").map((c) => c.kind)).toEqual(["accessory_missing"]);
    expect(extractClaims("Battery is bulging a bit.").map((c) => c.kind)).toEqual(["battery_hazard"]);
    expect(extractClaims("Package came in soaked and torn open.").map((c) => c.kind)).toEqual(["carton_crushed"]);
    expect(extractClaims("Buyer says the lens shipped separately.").map((c) => c.kind)).toEqual(["customer_assertion"]);
    expect(extractClaims("All three here. Charger is still in its blister.")).toEqual([]);
    expect(extractClaims("")).toEqual([]);
  });
  it("voice-note reader: a spoken claim raises a hold the counter can't see; a carton note is a work item only", () => {
    expect(runVoiceNoteReader(ctx(ret("RMA-30113"))).holds).toEqual([expect.objectContaining({ itemKey: "lens", code: "spoken_claim" })]);
    const swollen = variant("RMA-30101", "RMA-T-SWOLLEN", (r) => {
      r.voiceNote = { ...ret("RMA-30113").voiceNote!, transcript: "Charger smells burnt and one battery looks swollen." };
    });
    expect(runVoiceNoteReader(ctx(swollen)).holds).toEqual([expect.objectContaining({ itemKey: "battery", code: "battery_hazard" })]);
    const carton = runVoiceNoteReader(ctx(ret("RMA-30106")));
    expect(carton.holds).toEqual([]);
    expect(carton.workItems).toHaveLength(1);
    expect(runVoiceNoteReader(ctx(ret("RMA-30101"))).trace).toBe("no voice note on this return");
  });

  it("fraud-pattern agent (cut from the roster, still tested): one address in three spellings is one address; two returns from it are not a pattern", () => {
    expect(new Set(["418 Larch St, Oakland CA", "418 Larch St., Oakland, CA", "418 LARCH STREET, OAKLAND CA"].map(normAddress)).size).toBe(1);
    const at = (id: string, n: string, address: string) => ({ ret: variant(id, n, (r) => (r.order.address = address)) });
    const venn = [at("RMA-30101", "RMA-T-V1", "418 Larch St, Oakland CA"), at("RMA-30102", "RMA-T-V2", "418 Larch St., Oakland, CA"), at("RMA-30105", "RMA-T-V3", "418 LARCH STREET, OAKLAND CA")];
    expect([...runFraudPattern(venn).values()].every((r) => r.holds.some((h) => h.code === "repeat_address" && h.itemKey === "*"))).toBe(true);
    expect([...runFraudPattern(venn.slice(0, 2)).values()].every((r) => r.holds.length === 0)).toBe(true);
  });
  it("fraud-pattern agent: a copied serial holds both boxes; two order records listing one serial is an inventory work item, not a hold", () => {
    const ins = (r: ShiftReturn) => ({ ret: r, inspector: runInspector(ctx(r)).output });
    const copy = variant("RMA-30102", "RMA-T-COPY", (r) => {
      r.clip.labels.camera_body = { text: ret("RMA-30101").order.slip.lines[0].serial!, confidence: 0.91 };
    });
    const res = runFraudPattern([ins(ret("RMA-30101")), ins(copy), ins(ret("RMA-30105"))]);
    expect(res.get("RMA-30101")!.holds).toEqual([expect.objectContaining({ itemKey: "camera_body", code: "duplicate_serial" })]);
    expect(res.get("RMA-T-COPY")!.holds).toEqual([expect.objectContaining({ itemKey: "camera_body", code: "duplicate_serial" })]);
    expect(res.get("RMA-30105")!.holds).toEqual([]);
    // The demo fixtures: ORD-58227 and ORD-58241 both list the same serials (one labelled unit is filmed for both).
    const demo = runFraudPattern([ins(ret("RMA-20419")), ins(ret("RMA-20420"))]);
    for (const r of demo.values()) {
      expect(r.holds).toEqual([]);
      expect(r.workItems.map((w) => w.text).join()).toMatch(/order records of RMA-20419 and RMA-20420/);
    }
  });

  it("carrier-claim agent: needs damage AND transit evidence; app code prices the claim", () => {
    const damagedOnly = ctx(ret("RMA-30101"), { up: { damageReader: { items: [{ itemKey: "lens", surface: "dented", detail: "dent", t: 5.6, holds: true }], outerBox: "intact" } } });
    expect(carrierClaimTriggered(damagedOnly)).toBe(true);
    expect(runCarrierClaim(damagedOnly).output).toBeNull();
    const transitOnly = ctx(ret("RMA-30107"), { up: { damageReader: { items: [], outerBox: "crushed" } } });
    expect(runCarrierClaim(transitOnly).output).toBeNull();
    expect(runCarrierClaim(transitOnly).workItems[0].text).toMatch(/no claim/);
    expect(carrierClaimTriggered(ctx(ret("RMA-30101"), { up: { damageReader: { items: [], outerBox: "intact" } } }))).toBe(false);
    const claim = out("RMA-30107").claim!;
    expect(claim).toMatchObject({ carrier: "UPS", claimCents: KIT.items[0].unitPriceCents, status: "draft · a person files it" });
    expect(claim.photoRefs[0]).toMatch(/shift-rma-30107 @ \d+\.\d s/);
    expect(claim.exceptionScan).toMatch(/damaged in transit/);
  });

  it("policy agent: the window boundary is inclusive (30 days is in, 31 is out)", () => {
    const at = (days: number) => {
      const r = structuredClone(ret("RMA-30101"));
      r.order.deliveredAt = "2026-09-01T09:00:00Z";
      r.receivedAt = new Date(Date.parse("2026-09-01T09:00:00Z") + days * 86400000).toISOString();
      return runPolicy(ctx(r, { lines: [] }));
    };
    expect(at(30).output.late).toBe(false);
    expect(at(30).holds).toEqual([]);
    expect(at(31).output.late).toBe(true);
    expect(at(31).holds).toEqual([expect.objectContaining({ itemKey: "*", code: "outside_window" })]);
    expect(out("RMA-30110").holdReasons).toContain("camera_body:outside_window");
  });
  it("policy agent: scuffs hold for a condition review; an opened sleeve does not", () => {
    const scuffed = variant("RMA-30101", "RMA-T-SCUFF", (r) => {
      r.crops[0] = { ...r.crops[0], surface: "scuffed", detail: "scuff marks across the top plate" };
    });
    const c = ctx(scuffed);
    c.up.damageReader = runDamageReader(c).output;
    expect(runPolicy({ ...c, lines: [] }).holds).toEqual([expect.objectContaining({ itemKey: "camera_body", code: "condition_review" })]);
    expect(held(out("RMA-30105"))).toBe(false);
  });

  it("restock grader: sealed A, opened B, dented C, a stray serial quarantined, a hazard battery recycled", () => {
    const grade = (o: ReturnOutcome, key: string) => o.restock!.find((r) => r.itemKey === key)!;
    // Always-run grades every box, so the grading rules are visible on the held ones too.
    const always = runShift(SEEDED_SHIFT, { dispatch: "always" });
    const all = (id: string) => always.outcomes.find((o) => o.rmaId === id)!;
    expect(grade(out("RMA-30104"), "lens").grade).toBe("A");
    expect(grade(out("RMA-30101"), "lens").grade).toBe("B");
    expect(grade(all("RMA-30107"), "camera_body").grade).toBe("C");
    // Selective: the dented box is held, so grading waits for the person (and says so).
    expect(out("RMA-30107").restock).toBeNull();
    expect(out("RMA-30107").dispatch.find((d) => d.role === "restock-grader")).toMatchObject({ state: "skipped", reason: expect.stringMatching(/waits for the decision/) });
    // A stray serial is diverted now, held or not: the grader runs on that box.
    expect(grade(out("RMA-30103"), "camera_body")).toMatchObject({ recoveryCents: 0, channel: expect.stringMatching(/Quarantine/) });
    const swollen = variant("RMA-30101", "RMA-T-SWOLLEN2", (r) => {
      r.voiceNote = { ...ret("RMA-30113").voiceNote!, transcript: "One battery looks swollen." };
    });
    expect(grade(runShift(shiftOf([swollen])).outcomes[0], "battery")).toMatchObject({ grade: "recycle", recoveryCents: 0 });
    expect(all("RMA-20418").restock!.map((r) => r.itemKey)).not.toContain("lens"); // nothing to grade
  });

  it("message drafter: explains the hold in plain words, cites 5.1, offers the 4.3 partial only on a missing-only return, never accuses", () => {
    for (const o of full.outcomes) {
      expect(o.message.text).not.toMatch(/fraud|stolen|scam/i);
      if (held(o)) expect(o.message.text).toMatch(/clause 5\.1/);
    }
    expect(out("RMA-20418").message.text).toMatch(/zoom lens was not seen in the box[\s\S]*partial refund of \$231[\s\S]*clause 4\.3/);
    expect(out("RMA-30103").message.text).not.toMatch(/partial refund/);
  });

  it("cost agent: the processing fee is counted only when a refund is proposed", () => {
    expect(out("RMA-30101").cost!.processingFeeLostCents).toBeGreaterThan(0);
    expect(out("RMA-30103").cost!.processingFeeLostCents).toBe(0);
    for (const o of full.outcomes) expect(o.cost!.totalCents).toBeGreaterThanOrEqual(o.cost!.returnLabelCents);
  });
});

describe("the 500-a-day projection", () => {
  it("scales the seeded shift's per-return agents and cost, and labels nothing as measured", () => {
    const p = projectDaily(full, buildRoster(SEEDED_SHIFT), 500);
    expect(p.namedInspectorsPerDay).toBe(500);
    // Selective dispatch: inspector, damage reader, serial matcher, cost agent and coordinator on every box, specialists on some.
    expect(p.agentsPerReturn).toBeGreaterThan(5);
    expect(p.agentRunsPerDay).toBeGreaterThan(500 * 5);
    const always = projectDaily(runShift(SEEDED_SHIFT, { dispatch: "always" }), buildRoster(SEEDED_SHIFT), 500);
    expect(always.agentsPerReturn).toBeGreaterThan(p.agentsPerReturn);
    expect(always.modelUsdPerDay).toBeGreaterThan(p.modelUsdPerDay);
    expect(p.usdPer30Days).toBeCloseTo(p.modelUsdPerDay * 30, 0);
    expect(p.codeShare).toBeGreaterThan(0);
    expect(p.codeShare).toBeLessThan(1);
    expect(projectDaily({ ...full, outcomes: [] }, [], 500).agentRunsPerDay).toBe(0);
  });
});
