import { json } from "@/lib/api";
import { packetKeys, verifyPacket } from "@/lib/engine/evidence-packet";
import { approvalSecret } from "@/lib/runtime";
import { rateLimited } from "@/lib/ratelimit";

const MAX_BYTES = 1_000_000;

/** POST /api/packet/verify with a packet as the body → whether it is unchanged and signed by this deployment. */
export async function POST(req: Request) {
  const limited = await rateLimited(req, "inspect");
  if (limited) return limited;
  const text = await req.text();
  if (text.length > MAX_BYTES) return json({ ok: false, reason: "packet larger than 1 MB" }, 413);
  let packet: unknown;
  try {
    packet = JSON.parse(text);
  } catch {
    return json({ ok: false, reason: "not JSON" }, 400);
  }
  let pem: string | undefined;
  try {
    pem = packetKeys(approvalSecret())?.publicKeyPem;
  } catch {
    pem = undefined;
  }
  const verdict = verifyPacket(packet, pem);
  return json({ ...verdict, checkedAgainst: pem ? "this deployment's public key" : "the key embedded in the packet (this server has none)" });
}
