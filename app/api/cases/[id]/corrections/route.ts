import { connection } from "next/server";
import { getStore } from "@/lib/store/case-store";
import { getCorrections, recordCorrection } from "@/lib/learning/corrections";
import { apiError, json, readJson } from "@/lib/api";
import { rateLimited } from "@/lib/ratelimit";

/** A reviewer's correction of one model read: training data for the label reader, never a refund decision. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = await rateLimited(req, "inspect");
  if (limited) return limited;
  const { id } = await params;
  const body = await readJson<Record<string, unknown>>(req);
  try {
    const r = await recordCorrection({ store: getStore() }, id, body);
    return json({ correction: r.correction, case: r.case }, 201);
  } catch (e) {
    return apiError(e);
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  try {
    return json({ corrections: await getCorrections({ store: getStore() }, id) });
  } catch (e) {
    return apiError(e);
  }
}
