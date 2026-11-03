import { connection } from "next/server";
import { json } from "@/lib/api";
import { packetKeys } from "@/lib/engine/evidence-packet";
import { approvalSecret } from "@/lib/runtime";

/** GET /api/packet-key → the public key evidence packets from this deployment are signed with. */
export async function GET() {
  await connection();
  let k: ReturnType<typeof packetKeys> = null;
  try {
    k = packetKeys(approvalSecret());
  } catch {
    k = null;
  }
  return k ? json({ alg: "Ed25519", keyId: k.keyId, publicKeyPem: k.publicKeyPem }) : json({ error: "no_key", message: "this server has no signing key; its packets are unsigned" }, 404);
}
