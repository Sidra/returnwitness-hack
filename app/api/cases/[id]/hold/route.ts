import { holdCase } from "@/lib/engine/service";
import { getStore } from "@/lib/store/case-store";
import { apiError, json, readJson } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "money");
  if (limited) return limited;
  const { id } = await params;
  const b = await readJson<{ person: string; reason: string }>(req);
  try {
    return json({ case: await holdCase({ store: getStore() }, id, String(b.person ?? ""), String(b.reason ?? "")) });
  } catch (e) {
    return apiError(e);
  }
}
