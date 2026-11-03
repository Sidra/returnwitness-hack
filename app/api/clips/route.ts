import fs from "node:fs";
import path from "node:path";
import { json } from "@/lib/api";
import { rmaById } from "@/lib/runtime";

const MAX_BYTES = 300 * 1024 * 1024;

/**
 * Save a bench recording for a live inspection. LOCAL PROFILE ONLY: the public demo has uploads off.
 * Body: the raw video (video/webm or video/mp4). Header x-rma-id names the return.
 */
export async function POST(req: Request) {
  if (process.env.RETURNWITNESS_PUBLIC_DEMO === "1" || process.env.VERCEL) return json({ error: "uploads_off", message: "Uploads are off on the public demo." }, 403);
  const rmaId = req.headers.get("x-rma-id") ?? "";
  if (!rmaById(rmaId)) return json({ error: "unknown_rma", message: `unknown RMA ${rmaId}` }, 404);
  const type = req.headers.get("content-type") ?? "";
  const ext = type.includes("mp4") ? "mp4" : type.includes("webm") ? "webm" : type.includes("quicktime") ? "mov" : null;
  if (!ext) return json({ error: "bad_type", message: "send video/webm, video/mp4 or video/quicktime" }, 415);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return json({ error: "too_large", message: "clip is over 300 MB" }, 413);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length || buf.length > MAX_BYTES) return json({ error: "bad_size", message: "empty or too large" }, 400);
  const clipId = `live-${rmaId}-${new Date().toISOString().replace(/[:.]/g, "-")}`.toLowerCase();
  const dir = path.join(process.cwd(), ".data", "clips");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${clipId}.${ext}`);
  fs.writeFileSync(file, buf);
  return json({ clipId, bytes: buf.length });
}
