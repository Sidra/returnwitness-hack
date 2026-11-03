import { getStore } from "@/lib/store/case-store";
import { json } from "@/lib/api";

/** Clears inspection records. Off on the public demo profile, where records are shared by every visitor. */
export async function POST() {
  if (process.env.RETURNWITNESS_PUBLIC_DEMO === "1") return json({ error: "disabled", message: "Clearing records is off on the public demo." }, 403);
  await getStore().reset();
  return json({ ok: true });
}
