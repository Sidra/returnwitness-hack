// Drives the /demo click path in the LIGHT theme (house rule for demo videos) and saves a screenshot per beat,
// plus, with --video, a NATIVE 3840×2160 recording: a 1920×1080 CSS viewport at deviceScaleFactor 2, captured
// through Chrome's screencast (device-pixel frames), then encoded by ffmpeg at the frames' own timing.
// Playwright's built-in recordVideo is CSS-pixel sized (1080p), so it isn't used. Headless Chrome's screencast only
// sends device pixels when the scale factor is forced at launch too (context DSF alone → 1920×1080).
//
// Usage: node video/capture.mjs [baseUrl] [--video] [--voice <wav>]
//   baseUrl  http://localhost:3700 for the live beats (the Meta key never goes on the public deploy)
//   --voice  a scripted synthetic-voice WAV fed to the bench's voice-note recorder through Chrome's fake mic,
//            in its OWN browser (the fake media flags also replace the camera); the card says "synthetic voice"
//
// Beats: 01 landing · 02 demo start · 03 held result · 04 complete kit ready · 05 approved · 06 refunded ·
//        07 the human gate (step 3) · [08 voice note transcribed, with --voice]
// Live vs recorded: when /api/status lists the seeded RMA under liveSeeded (key + filmed clip on this server),
// the demo buttons run SAM 3.1 + Spark + Wonder + Voice live and every result shows LIVE · Meta + LiveProof;
// otherwise they replay the recording, labelled RECORDED FIXTURE.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = args[0]?.startsWith("http") ? args[0] : "http://localhost:3700";
const recordVideo = args.includes("--video");
const voiceIdx = args.indexOf("--voice");
const voiceWav = voiceIdx >= 0 ? args[voiceIdx + 1] : null;
const out = "video/out";
const VIEWPORT = { width: 1920, height: 1080 };
const DSF = 2; // → 3840×2160 device pixels
fs.mkdirSync(out, { recursive: true });

/** Device-pixel screencast → PNG frames with timestamps → ffmpeg concat at the real frame durations. */
async function startScreencast(page, name) {
  const dir = path.join(out, `${name}-frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let dropped = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const buf = Buffer.from(f.data, "base64");
    // Keep only native 3840×2160 frames; never scale a stray one up.
    if (buf.readUInt32BE(16) !== VIEWPORT.width * DSF || buf.readUInt32BE(20) !== VIEWPORT.height * DSF) {
      dropped++;
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      return;
    }
    const file = path.join(dir, `${String(frames.length).padStart(6, "0")}.png`);
    fs.writeFileSync(file, buf);
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width * DSF, maxHeight: VIEWPORT.height * DSF, everyNthFrame: 1 });
  return async function stop() {
    await cdp.send("Page.stopScreencast").catch(() => {});
    if (frames.length < 2) return console.log(`${name}: too few frames captured`);
    const list = frames.map((fr, i) => `file '${path.resolve(fr.file)}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? fr.t + 1 / 30) - fr.t).toFixed(4)}`).join("\n");
    const listFile = path.join(dir, "frames.txt");
    fs.writeFileSync(listFile, `${list}\nfile '${path.resolve(frames.at(-1).file)}'\n`);
    const mp4 = path.join(out, `${name}-3840x2160.mp4`);
    // Constant 30 fps output, no scaling: the frames are already 3840×2160.
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", mp4]);
    const size = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4], { encoding: "utf8" }).trim();
    console.log(`${name}: ${frames.length} frames (${dropped} off-size dropped) → ${mp4} (${size})`);
  };
}

/** In-page zoom: the browser re-renders text at the new scale (never an ffmpeg crop of a smaller frame). */
async function zoomTo(page, selector, scale = 1.6) {
  await page.evaluate(
    ({ selector, scale }) => {
      const el = document.querySelector(selector);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ox = r.left + r.width / 2 + window.scrollX;
      const oy = r.top + r.height / 2 + window.scrollY;
      const root = document.documentElement;
      root.style.transition = "transform 900ms cubic-bezier(.2,.7,.2,1)";
      root.style.transformOrigin = `${ox}px ${oy}px`;
      root.style.transform = `scale(${scale})`;
    },
    { selector, scale },
  );
  await page.waitForTimeout(1200);
}
async function zoomOut(page) {
  await page.evaluate(() => {
    document.documentElement.style.transform = "none";
  });
  await page.waitForTimeout(1000);
}

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("rw-theme", "light");
      localStorage.setItem("rw-approver", "Rita Calder");
    } catch {}
  });
  return { ctx, page: await ctx.newPage() };
}

const status = await fetch(`${base}/api/status`).then((r) => r.json()).catch(() => ({}));
const live = (id) => Array.isArray(status.liveSeeded) && status.liveSeeded.includes(id);
console.log(`base ${base} · RMA-20418 ${live("RMA-20418") ? "LIVE" : "recorded"} · RMA-20419 ${live("RMA-20419") ? "LIVE" : "recorded"}`);

const DSF_FLAG = `--force-device-scale-factor=${DSF}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [DSF_FLAG] });
const { ctx, page } = await newPage(browser);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${out}/${n}.png`, fullPage: false });
const waitInspect = live("RMA-20418") ? 120_000 : 30_000;

await fetch(`${base}/api/demo/reset`, { method: "POST" });
const stop = recordVideo ? await startScreencast(page, "demo") : null;

await page.goto(base + "/", { waitUntil: "networkidle" });
await shot("01-landing");

await page.goto(base + "/demo", { waitUntil: "networkidle" });
await shot("02-demo-start");
await page.getByRole("button", { name: /Instant Demo|Inspect RMA-20418 live/ }).click();
await page.locator(".sticker-held").first().waitFor({ timeout: waitInspect });
await page.waitForTimeout(9000); // let the replay finish
await page.locator(".sticker-held").first().scrollIntoViewIfNeeded();
await zoomTo(page, ".sticker-held");
await shot("03-held");
await zoomOut(page);

await page.getByRole("button", { name: /Inspect RMA-20419|Inspect live/ }).first().click();
await page.getByText("READY FOR A PERSON").waitFor({ timeout: waitInspect });
await page.waitForTimeout(9000);
await page.getByText("READY FOR A PERSON").scrollIntoViewIfNeeded();
await shot("04-ready");

await page.getByRole("button", { name: /^Approve \$340/ }).click();
await page.getByRole("button", { name: /Run refund/ }).waitFor({ timeout: 15000 });
await page.getByRole("button", { name: /Run refund/ }).scrollIntoViewIfNeeded();
await shot("05-approved");

await page.getByRole("button", { name: /Run refund/ }).click();
await page.getByText("Refund receipt").waitFor({ timeout: 45000 });
await page.getByText("Refund receipt").scrollIntoViewIfNeeded();
await shot("06-refunded");

// The demo ends on the human gate.
await page.locator('section[aria-labelledby="s3"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
await page.waitForTimeout(800);
await zoomTo(page, 'section[aria-labelledby="s3"]', 1.15);
await shot("07-human-gate");
await page.waitForTimeout(2500);
await zoomOut(page);

if (stop) await stop();
await ctx.close();
await browser.close();

// Voice-note beat: its own browser, because the fake media flags replace the camera too.
if (voiceWav) {
  if (!fs.existsSync(voiceWav)) throw new Error(`voice WAV not found: ${voiceWav}`);
  const vb = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [DSF_FLAG, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(voiceWav)}%noloop`],
  });
  const v = await newPage(vb);
  await v.ctx.grantPermissions(["microphone"], { origin: base });
  v.page.on("pageerror", (e) => errors.push(String(e)));
  const vstop = recordVideo ? await startScreencast(v.page, "voice") : null;
  await v.page.goto(`${base}/dashboard/bench?voice=synthetic`, { waitUntil: "networkidle" });
  const rec = v.page.getByRole("button", { name: /Record a note/ });
  if (await rec.isVisible().catch(() => false)) {
    await rec.click();
    await v.page.waitForTimeout(8800); // the WAV is 7.7 s plus a beat
    await v.page.getByRole("button", { name: /^Stop/ }).click();
    await v.page.getByText("synthetic voice", { exact: false }).first().waitFor({ timeout: 60_000 });
    await v.page.getByText("synthetic voice", { exact: false }).first().scrollIntoViewIfNeeded();
    await v.page.screenshot({ path: `${out}/08-voice-note.png` });
  } else {
    console.log("voice beat skipped: the recorder is off on this server (it needs the Meta key, local profile)");
  }
  if (vstop) await vstop();
  await v.ctx.close();
  await vb.close();
}

console.log(errors.length ? `page errors:\n${errors.join("\n")}` : "capture complete, no page errors");
