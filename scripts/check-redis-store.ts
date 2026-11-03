/** Smoke test of RedisCaseStore against the real Upstash store (uses a throwaway key prefix, cleans up). */
process.env.RETURNWITNESS_KV_PREFIX = `rwtest-${Date.now()}`;

async function main() {
  const { kv } = await import("../lib/store/kv");
  const { RedisCaseStore } = await import("../lib/store/redis-store");
  const r = kv();
  if (!r) throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN not set");
  const s = new RedisCaseStore(r);
  const now = new Date().toISOString();
  const c = { id: "case_smoke", runId: "run_smoke", rmaId: "RMA-X", orderId: "ORD-X", createdAt: now, updatedAt: now, version: 0, state: "Received", holdReasons: [], clip: { clipId: "x", source: "fixture", mode: "RECORDED_FIXTURE", provenance: "", durationS: 0, fps: 5 }, disagreements: [], timings: [], costs: [], audit: [] } as never;
  const a = await s.put(c, 0);
  console.log("insert ok, version", a.version);
  try {
    await s.put(c, 0);
    console.log("FAIL: stale write accepted");
  } catch {
    console.log("stale write refused (CAS works)");
  }
  const b = await s.put({ ...a, state: "Held" } as never, 1);
  console.log("update ok, version", b.version, "state", (await s.get("case_smoke"))?.state);
  console.log("list:", (await s.list()).length);
  console.log("nonce first:", await s.consumeNonce("n-smoke"), "second:", await s.consumeNonce("n-smoke"));
  await s.reset();
  await r.del(`${process.env.RETURNWITNESS_KV_PREFIX}:nonce:n-smoke`);
  console.log("after reset list:", (await s.list()).length);
}
main().catch((e) => {
  console.error("redis smoke failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
