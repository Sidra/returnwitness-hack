// Seed the test-mode charges for the fixture orders when the server starts ([Seeded test-mode charge]).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.RETURNWITNESS_SKIP_SEED === "1") return;
  const { seedCharges } = await import("./lib/runtime");
  seedCharges()
    .then((r) => console.info(r.ok ? `[returnwitness] seeded ${r.charges.length} test-mode charges` : `[returnwitness] payment rail off: ${r.error}`))
    .catch((e) => console.warn(`[returnwitness] seeding test charges failed: ${e instanceof Error ? e.message : e}`));
}
