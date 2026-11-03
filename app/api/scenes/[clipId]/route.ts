import { connection } from "next/server";
import { FixtureSegmenter } from "@/lib/vision/fixture-segmenter";
import { COUNTER_CONFIG } from "@/lib/runtime";
import { json } from "@/lib/api";

/** Segmentation frames for the replay view (fixture clips only), plus the zones. */
export async function GET(_req: Request, { params }: { params: Promise<{ clipId: string }> }) {
  await connection();
  const { clipId } = await params;
  try {
    const raw = await new FixtureSegmenter().segment({ clipId, concepts: [], fps: 5 });
    // Served without the run's date (no run dates on public surfaces); the request ids still trace the call.
    const { recordedAt: _recordedAt, ...source } = raw.source as typeof raw.source & { recordedAt?: string };
    const seg = { ...raw, source };
    return json({ segmentation: seg, zones: { tray: COUNTER_CONFIG.trayZone, box: COUNTER_CONFIG.boxZone }, items: COUNTER_CONFIG.items, hand: COUNTER_CONFIG.handConcept, ignore: COUNTER_CONFIG.ignoreConcepts });
  } catch (e) {
    return json({ error: "not_found", message: e instanceof Error ? e.message : String(e) }, 404);
  }
}
