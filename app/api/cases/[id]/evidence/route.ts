import { connection } from "next/server";
import { getStore } from "@/lib/store/case-store";
import { getEvidenceRequests, supplyEvidence } from "@/lib/engine/evidence-request";
import { apiError, json, readJson } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

/**
 * A person answers an open evidence request (one the decision agent left on a held case) with a typed
 * note, bound to the case's current evidence digest. Evidence on the record, never a decision: it can't
 * approve, clear the hold or reach the refund.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "inspect");
  if (limited) return limited;
  const { id } = await params;
  const body = await readJson<Record<string, unknown>>(req);
  try {
    const r = await supplyEvidence({ store: getStore() }, id, body);
    return json({ request: r.request, case: r.case }, 201);
  } catch (e) {
    return apiError(e);
  }
}

/** The case's evidence requests and the digest a person must answer against. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  try {
    return json(await getEvidenceRequests({ store: getStore() }, id));
  } catch (e) {
    return apiError(e);
  }
}
