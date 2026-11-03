import { approveCase } from "@/lib/engine/service";
import { getStore } from "@/lib/store/case-store";
import { approvalSecret, rmaById } from "@/lib/runtime";
import { apiError, json, readJson } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

/** A person approves an amount. Returns a single-use, expiring token bound to this exact case. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "money");
  if (limited) return limited;
  const { id } = await params;
  const b = await readJson<{ approver: string; amountCents: number; note: string; overrideReason: string }>(req);
  try {
    const store = getStore();
    const c = await store.get(id);
    const rma = c ? rmaById(c.rmaId) : undefined;
    if (!c || !rma) return json({ error: "not_found", message: `case ${id} not found` }, 404);
    const r = await approveCase({ store, secret: approvalSecret() }, id, rma, {
      approver: String(b.approver ?? ""),
      amountCents: Number(b.amountCents),
      note: String(b.note ?? ""),
      overrideReason: b.overrideReason ? String(b.overrideReason) : undefined,
    });
    return json(r);
  } catch (e) {
    return apiError(e);
  }
}
