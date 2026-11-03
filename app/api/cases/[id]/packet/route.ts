import { connection } from "next/server";
import { getStore } from "@/lib/store/case-store";
import { json } from "@/lib/api";
import { buildPacket, packetKeys } from "@/lib/engine/evidence-packet";
import { approvalSecret, orderFor, POLICY, rmaById } from "@/lib/runtime";
import { publicProfile } from "@/lib/public/neutral-times";

/** Signs with the deployment's key when it has one; otherwise the packet says it is unsigned. */
function keys() {
  try {
    return packetKeys(approvalSecret());
  } catch {
    return null;
  }
}

/** GET /api/cases/:id/packet → the case's dispute & carrier-claim evidence packet, as a JSON download. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const c = await getStore().get(id);
  if (!c) return json({ error: "not_found", message: `case ${id} not found` }, 404);
  const rma = rmaById(c.rmaId);
  const order = rma ? orderFor(rma.orderId) : undefined;
  if (!rma || !order) return json({ error: "not_found", message: `no order record for ${c.rmaId}` }, 404);
  const packet = buildPacket(c, { rma, slip: order.slip, policy: POLICY }, { keys: keys(), neutralTimes: publicProfile() });
  return new Response(JSON.stringify(packet, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="evidence-packet-${c.rmaId}-${c.id}.json"`,
      "cache-control": "no-store",
    },
  });
}
