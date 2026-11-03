/** Transcode a clip to what the segmenter gets: 5 fps, 720p, H.264, no audio. Needs ffmpeg on PATH. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface PreparedClip {
  path: string;
  fps: number;
  width: number;
  height: number;
  durationS: number;
  frames: number;
}

const CLIP_EXTS = ["mov", "mp4", "MOV", "MP4", "m4v", "webm"];

/** A clip by its stem ("g1-clean" or "g1-clean.mov"), whatever container it was saved in; null if none exists. */
export function findClip(dir: string, name: string): string | null {
  const stem = name.replace(/\.(mov|mp4|m4v|webm)$/i, "");
  for (const e of CLIP_EXTS) {
    const f = path.join(dir, `${stem}.${e}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function probe(file: string): { width: number; height: number; durationS: number; fps: number } {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", file], { encoding: "utf8" });
  const j = JSON.parse(out);
  const s = j.streams?.[0] ?? {};
  const [n, d] = String(s.r_frame_rate ?? "0/1").split("/").map(Number);
  return { width: s.width, height: s.height, durationS: Number(j.format?.duration ?? 0), fps: d ? n / d : 0 };
}

export function prepareClip(src: string, outDir: string, fps = 5, height = 720): PreparedClip {
  if (!fs.existsSync(src)) throw new Error(`clip not found: ${src}`);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${path.basename(src, path.extname(src))}.${fps}fps.${height}p.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-an", "-vf", `fps=${fps},scale=-2:${height}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]); // faststart: Meta remuxes uploads without it (docs)
  const p = probe(out);
  return { path: out, fps, width: p.width, height: p.height, durationS: p.durationS, frames: Math.round(p.durationS * fps) };
}
