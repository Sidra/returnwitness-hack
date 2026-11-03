/** Key frames and item crops from a clip, as JPEG data URLs for the reader model. Needs ffmpeg. */
import { execFileSync } from "node:child_process";
import type { BBox } from "@/lib/domain/schemas";

export function frameJpeg(videoPath: string, t: number, opts: { bbox?: BBox; width?: number; height?: number; pad?: number; maxW?: number } = {}): string {
  const filters: string[] = [];
  if (opts.bbox && opts.width && opts.height) {
    const pad = opts.pad ?? 0.25;
    const [x, y, w, h] = opts.bbox;
    const px = Math.max(0, x - w * pad);
    const py = Math.max(0, y - h * pad);
    const pw = Math.min(1 - px, w * (1 + 2 * pad));
    const ph = Math.min(1 - py, h * (1 + 2 * pad));
    filters.push(`crop=${Math.round(pw * opts.width)}:${Math.round(ph * opts.height)}:${Math.round(px * opts.width)}:${Math.round(py * opts.height)}`);
  }
  filters.push(`scale='min(${opts.maxW ?? 1280},iw)':-2`);
  const buf = execFileSync("ffmpeg", ["-v", "error", "-ss", t.toFixed(2), "-i", videoPath, "-frames:v", "1", "-vf", filters.join(","), "-f", "image2", "-vcodec", "mjpeg", "-q:v", "3", "pipe:1"], { maxBuffer: 20 * 1024 * 1024 });
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
