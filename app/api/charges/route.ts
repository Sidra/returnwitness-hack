import { connection } from "next/server";
import { seedCharges } from "@/lib/runtime";
import { json, publicJson } from "@/lib/api";

/** The seeded test-mode charges the refunds run against ([Seeded test-mode charge]). */
export async function GET() {
  await connection();
  try {
    return publicJson(await seedCharges());
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e), charges: [] }, 502);
  }
}
