import { describe, expect, it } from "vitest";
import { ORDERS, POLICY, RMAS } from "@/data/fixtures";
import { KIT } from "@/data/kit.config";
import { runInspection } from "@/lib/engine/pipeline";
import { buildPacket, packetKeys, PACKET_SCHEMA, verifyPacket } from "@/lib/engine/evidence-packet";
import { MemoryCaseStore } from "@/lib/store/case-store";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { counterConfigForKit } from "@/lib/vision/counter-config";

const SECRET = "s".repeat(48);
const inspect = (i: 0 | 1) =>
  runInspection({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY, clip: { clipId: RMAS[i].clipId, source: "fixture" } }, { store: new MemoryCaseStore(), segmenter: new FixtureSegmenter(), counterConfig: counterConfigForKit(KIT), readers: [], agent: null });
const ctx = (i: 0 | 1) => ({ rma: RMAS[i], slip: ORDERS[i].slip, policy: POLICY });
const now = new Date("2026-10-29T23:00:00Z");

describe("dispute & carrier-claim evidence packet", () => {
  it("a held case: the missing line with its reason, the verbatim kit clauses, the slip, provenance kept as recorded", async () => {
    const c = await inspect(0);
    expect(c.state).toBe("Held");
    const p = buildPacket(c, ctx(0), { now, keys: packetKeys(SECRET) });
    expect(p.schema).toBe(PACKET_SCHEMA);
    const lens = p.reconciliation!.lines.find((l) => l.itemKey === "lens")!;
    expect(lens.status).toBe("MISSING");
    expect(lens.reasons[0]).toMatch(/^not_observed:/);
    expect(p.policy.clauses.map((x) => x.id)).toEqual(expect.arrayContaining(["4.2", "4.3", "5.1"]));
    expect(p.policy.clauses.find((x) => x.id === "4.3")!.text).toBe(POLICY.clauses.find((x) => x.id === "4.3")!.text);
    expect(p.order.lines).toEqual(ORDERS[0].slip.lines);
    expect(p.observation.clip.label).toBe("RECORDED FIXTURE · synthetic scene, not a live Meta call");
    expect(p.limitations.join(" ")).toMatch(/replayed synthetic scene/);
    expect(p.limitations.join(" ")).toMatch(/not proof the customer kept anything/);
    expect(p.limitations.join(" ")).toMatch(/not certified for any card-network/);
    expect(p.timeline.length).toBe(c.audit.length);
  });

  it("signed: verifies under the deployment key; any changed field, or another key, is caught", async () => {
    const keys = packetKeys(SECRET)!;
    const p = buildPacket(await inspect(0), ctx(0), { now, keys });
    expect(verifyPacket(p, keys.publicKeyPem)).toEqual({ ok: true, keyId: keys.keyId });
    const json = JSON.parse(JSON.stringify(p));
    expect(verifyPacket(json, keys.publicKeyPem).ok).toBe(true); // survives a JSON round trip
    const tampered = { ...json, reconciliation: { ...json.reconciliation, lines: json.reconciliation.lines.map((l: { status: string }) => ({ ...l, status: "OK" })) } };
    expect(verifyPacket(tampered, keys.publicKeyPem)).toMatchObject({ ok: false, reason: expect.stringMatching(/content hash/) });
    const rehashed = { ...tampered, contentSha256: (await import("@/lib/engine/digest")).digestOf((({ contentSha256: _c, signature: _s, ...b }) => b)(tampered)) };
    expect(verifyPacket(rehashed, keys.publicKeyPem)).toMatchObject({ ok: false, reason: "signature does not verify" });
    const other = packetKeys("o".repeat(48))!;
    expect(verifyPacket(p, other.publicKeyPem)).toMatchObject({ ok: false, reason: expect.stringMatching(/different key/) });
  });

  it("the key is stable per secret and differs across secrets; no secret → unsigned, said plainly", async () => {
    expect(packetKeys(SECRET)!.publicKeyPem).toBe(packetKeys(SECRET)!.publicKeyPem);
    expect(packetKeys(SECRET)!.keyId).not.toBe(packetKeys("o".repeat(48))!.keyId);
    expect(packetKeys(undefined)).toBeNull();
    expect(packetKeys("short")).toBeNull();
    const p = buildPacket(await inspect(1), ctx(1), { now, keys: null });
    expect(p.signature).toBeNull();
    expect(p.limitations.join(" ")).toMatch(/Unsigned/);
    expect(verifyPacket(p)).toMatchObject({ ok: false, reason: expect.stringMatching(/unsigned/) });
  });

  it("refuses junk and unknown schemas", () => {
    expect(verifyPacket(null).ok).toBe(false);
    expect(verifyPacket({ schema: "something-else" })).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown schema/) });
  });

  it("no approval token or secret material ever lands in the packet", async () => {
    const c = await inspect(1);
    const withApproval = { ...c, approval: { approver: "Rita Calder", amountCents: 34000, note: "", override: false, digest: "d".repeat(64), nonce: "NONCE-SECRET", issuedAt: now.toISOString(), expiresAt: now.toISOString() } };
    const text = JSON.stringify(buildPacket(withApproval, ctx(1), { now, keys: packetKeys(SECRET) }));
    expect(text).not.toContain("NONCE-SECRET");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("typed name (unverified in this prototype)");
  });
});
