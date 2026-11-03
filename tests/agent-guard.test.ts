import { describe, expect, it } from "vitest";
import { judgeProposal } from "@/lib/engine/agent-guard";

const D = "abc123";
describe("agent guard: only toward HELD, never APPROVED", () => {
  it("APPROVED is always rejected, from any state", () => {
    for (const state of ["Held", "AwaitingApproval", "Reconciled"] as const) {
      const v = judgeProposal({ state, digest: D }, { to_state: "APPROVED", evidence_digest: D, reason: "x" });
      expect(v).toMatchObject({ accepted: false, effect: "none" });
      expect(v.reason).toMatch(/approval token/);
    }
  });
  it("HELD from AwaitingApproval is accepted and holds", () => {
    expect(judgeProposal({ state: "AwaitingApproval", digest: D }, { to_state: "HELD", evidence_digest: D, reason: "x" })).toMatchObject({ accepted: true, effect: "hold" });
  });
  it("HELD on a held case is accepted with no effect", () => {
    expect(judgeProposal({ state: "Held", digest: D }, { to_state: "HELD", evidence_digest: D, reason: "x" })).toMatchObject({ accepted: true, effect: "none" });
  });
  it("Held → AWAITING_APPROVAL is rejected (the agent can't release a hold)", () => {
    expect(judgeProposal({ state: "Held", digest: D }, { to_state: "AWAITING_APPROVAL", evidence_digest: D, reason: "x" })).toMatchObject({ accepted: false, effect: "none" });
  });
  it("a stale evidence digest is rejected", () => {
    expect(judgeProposal({ state: "AwaitingApproval", digest: D }, { to_state: "HELD", evidence_digest: "other", reason: "x" }).accepted).toBe(false);
  });
  it("malformed proposals are rejected", () => {
    expect(judgeProposal({ state: "AwaitingApproval", digest: D }, null).accepted).toBe(false);
    expect(judgeProposal({ state: "AwaitingApproval", digest: D }, { to_state: "REFUNDED" as never, evidence_digest: D, reason: "" }).accepted).toBe(false);
  });
  it("Approved / Refunded cases can't be touched by the agent", () => {
    expect(judgeProposal({ state: "Refunded", digest: D }, { to_state: "HELD", evidence_digest: D, reason: "x" }).accepted).toBe(false);
  });
});
