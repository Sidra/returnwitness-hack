// The on-camera run (ONE live take, no retakes): drives the bench (/dashboard/bench) LIVE in the LIGHT theme with
// Rita Calder as the approver and records every beat at NATIVE 3840×2160 (1920×1080 CSS at deviceScaleFactor 2,
// Chrome's device-pixel screencast, the same encoder as video/capture.mjs). One mp4 per shot plus a PNG per beat.
// Every beat's start is logged in video/out/shots/SHOTS.json (seconds into its own mp4) so the edit can cut to the voice.
//
// Usage: node video/capture-shots.mjs [baseUrl] [--voice <wav>] [--allow-recorded]
//   Refuses to start unless /api/status lists RMA-20418 and RMA-20419 under liveSeeded (a live take), unless
//   --allow-recorded (a dry rehearsal against a replay-only server; its files go to video/out/shots-rehearsal/).
//
// Shots: a d1 result + zoom on $340 HELD · b readers (packing-slip reasons + the independent readers) · c Wonder's
// trace (evidence requests, cited clauses) · d voice-note card (--voice) · e d2 result · f the person's path on d2
// (override if held) → token → refund receipt, then the SAME token sent again (the server's real answer is saved:
// after the refund it is 409 bad_state, "a case in state Refunded can't be refunded", and the refusal is on the audit) · g /dashboard/cases/<d1> diagnostics ·
// j /play (lens left in the box) then /play/walker · k 03-held.png (the d1 HELD frame).
// No panel renders a real-clip frame or crop; the camera tab (live webcam) is never opened.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const base = args[0]?.startsWith("http") ? args[0] : "http://localhost:3700";
const voiceIdx = args.indexOf("--voice");
const voiceWav = voiceIdx >= 0 ? args[voiceIdx + 1] : null;
const allowRecorded = args.includes("--allow-recorded");
const VIEWPORT = { width: 1920, height: 1080 };
const DSF = 2;
const HOLD = 6000; // each beat holds ~4 s longer than it needs, for the voice

const status = await fetch(`${base}/api/status`).then((r) => r.json());
const live = ["RMA-20418", "RMA-20419"].every((id) => status.liveSeeded?.includes(id));
if (!live && !allowRecorded) throw new Error("server is not live for RMA-20418/RMA-20419 (liveSeeded); refusing. --allow-recorded for a rehearsal");
const out = live ? "video/out/shots" : "video/out/shots-replay-run2";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const log = { base, live, startedAt: new Date().toISOString(), shots: {}, cases: {}, requests: [], reuse: null, errors: [] };
const save = () => fs.writeFileSync(path.join(out, "SHOTS.json"), JSON.stringify(log, null, 1));
console.log(`base ${base} · ${live ? "LIVE take" : "REPLAY of the recorded run (no model call)"} → ${out}`);

async function startScreencast(page, name) {
  const dir = path.join(out, `${name}-frames`);
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let dropped = 0;
  cdp.on("Page.screencastFrame", async (f) => {
    const buf = Buffer.from(f.data, "base64");
    if (buf.readUInt32BE(16) !== VIEWPORT.width * DSF || buf.readUInt32BE(20) !== VIEWPORT.height * DSF) dropped++;
    else {
      const file = path.join(dir, `${String(frames.length).padStart(6, "0")}.png`);
      fs.writeFileSync(file, buf);
      frames.push({ file, t: f.metadata.timestamp });
    }
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width * DSF, maxHeight: VIEWPORT.height * DSF, everyNthFrame: 1 });
  const t0 = Date.now();
  const beats = [];
  return {
    mark: (beat) => beats.push({ beat, t: Number(((Date.now() - t0) / 1000).toFixed(2)) }),
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => {});
      const mp4 = path.join(out, `${name}-3840x2160.mp4`);
      log.shots[name] = { mp4, beats, frames: frames.length, dropped };
      if (frames.length < 2) return console.log(`${name}: too few frames captured`);
      const list = frames.map((fr, i) => `file '${path.resolve(fr.file)}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? fr.t + 1 / 30) - fr.t).toFixed(4)}`).join("\n");
      const listFile = path.join(dir, "frames.txt");
      fs.writeFileSync(listFile, `${list}\nfile '${path.resolve(frames.at(-1).file)}'\n`);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", mp4]);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`${name}: ${frames.length} frames (${dropped} off-size dropped) → ${mp4}`);
      save();
    },
  };
}

async function zoomTo(page, locator, scale = 1.6) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(
    ({ box, scale }) => {
      const root = document.documentElement;
      root.style.transition = "transform 900ms cubic-bezier(.2,.7,.2,1)";
      root.style.transformOrigin = `${box.x + box.width / 2 + window.scrollX}px ${box.y + box.height / 2 + window.scrollY}px`;
      root.style.transform = `scale(${scale})`;
    },
    { box, scale },
  );
  await page.waitForTimeout(1200);
}
const zoomOut = (page) => page.evaluate(() => (document.documentElement.style.transform = "none")).then(() => page.waitForTimeout(1000));
const center = (loc) => loc.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
const top = (loc) => loc.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "smooth" }));

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DSF });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("rw-theme", "light");
      localStorage.setItem("rw-approver", "Rita Calder");
      localStorage.setItem("rw-film", "1"); // film mode: no wall-clock time on screen (durations and request ids stay)
    } catch {}
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log.errors.push(String(e)));
  // Every model call's request id is on the case; keep the API answers that carry cases and tokens.
  page.on("response", async (r) => {
    const u = r.url();
    if (!/\/api\/(inspections|cases\/[^/]+\/(approve|refund))/.test(u)) return;
    log.requests.push({ url: u.replace(base, ""), status: r.status(), at: new Date().toISOString() });
    if (/\/approve$/.test(u) && r.ok()) {
      const j = await r.json().catch(() => null);
      if (j?.token) log.cases.d2Token = { caseId: j.case?.id, token: j.token };
    }
  });
  return { ctx, page };
}

const DSF_FLAG = `--force-device-scale-factor=${DSF}`;
const browser = await chromium.launch({ channel: "chrome", headless: true, args: [DSF_FLAG] });
const { ctx, page } = await newPage(browser);
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const inspectWait = live ? 240_000 : 60_000;

await fetch(`${base}/api/demo/reset`, { method: "POST" });

/** The bench at /dashboard/bench (never the camera tab, never /demo's guided text): pick the RMA, inspect, wait. */
async function inspectOnBench(rmaId, rec) {
  await page.goto(base + "/dashboard/bench", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.locator("select.select").first().selectOption(rmaId);
  await page.waitForTimeout(1500);
  rec.mark(`bench: ${rmaId} picked`);
  await page.getByRole("button", { name: /^Inspect (live|this return)/ }).click();
  rec.mark(`Inspect ${rmaId} clicked`);
  await page.locator(".sticker-held, .sticker-ok").first().waitFor({ timeout: inspectWait });
  rec.mark(`${rmaId} result in`);
  await page.waitForTimeout(9000); // the stage replay finishes
  const badge = page.locator(".sticker-held, .sticker-ok").first();
  const state = (await badge.innerText()).trim();
  await center(badge);
  await page.waitForTimeout(1500);
  rec.mark(`${rmaId} badge: ${state}`);
  return { badge, state };
}
const caseHref = async () => page.locator('a[href*="/cases/"]').first().getAttribute("href").catch(() => null);

// ---- a + k: d1 result, zoom on $340 HELD
let rec = await startScreencast(page, "a-d1-result");
const d1 = await inspectOnBench("RMA-20418", rec);
log.cases.d1State = d1.state;
await zoomTo(page, d1.badge, 1.6);
rec.mark("zoom on HELD");
await shot("k-03-held");
await page.waitForTimeout(HOLD);
await zoomOut(page);
await rec.stop();
log.cases.d1 = await caseHref();
save();

// ---- b: the readers (packing-slip reasons, then the independent readers)
rec = await startScreencast(page, "b-readers");
await top(page.getByRole("heading", { name: "Packing slip vs what the camera saw" }).first());
await page.waitForTimeout(1200);
rec.mark("packing slip vs camera: reasons (the counter's HELD stands)");
await shot("b1-reasons");
await page.waitForTimeout(HOLD + 2000);
await center(page.getByText("Independent readers", { exact: false }).first());
await page.waitForTimeout(1200);
rec.mark("independent readers: Spark serial, Muse Spark Open note");
await shot("b2-readers");
await page.waitForTimeout(HOLD + 2000);
await rec.stop();

// ---- c: Wonder's trace, evidence requests, cited clauses
rec = await startScreencast(page, "c-wonder-trace");
await top(page.getByRole("heading", { name: /Decision draft/ }).first());
await page.waitForTimeout(1200);
rec.mark("decision draft: cited clauses");
await shot("c1-clauses");
await page.waitForTimeout(HOLD);
await top(page.getByRole("heading", { name: /Decision agent · Muse Wonder/ }).first());
await page.waitForTimeout(1200);
rec.mark("Wonder trace");
await shot("c2-trace");
await page.waitForTimeout(HOLD);
const evr = page.getByText("Evidence requested", { exact: false }).first();
if (await evr.count()) {
  await center(evr);
  await page.waitForTimeout(1200);
  rec.mark("evidence requests");
  await shot("c3-evidence");
  await page.waitForTimeout(HOLD);
}
await rec.stop();

// ---- e: d2 result
rec = await startScreencast(page, "e-d2-result");
const d2 = await inspectOnBench("RMA-20419", rec);
const d2State = d2.state;
log.cases.d2State = d2State;
await zoomTo(page, d2.badge, 1.4);
await shot("e-d2-result");
await page.waitForTimeout(HOLD);
await zoomOut(page);
await top(page.getByRole("heading", { name: "Packing slip vs what the camera saw" }).first());
await page.waitForTimeout(1200);
rec.mark("d2 lines");
await shot("e2-d2-lines");
await page.waitForTimeout(HOLD);
await rec.stop();
log.cases.d2 = await caseHref();
save();
const d2Section = page.locator("body");

// ---- f: the person's path on d2 → token → refund receipt → the same token again
rec = await startScreencast(page, "f-person-refund");
const panel = d2Section.locator('section[aria-label="Approval and refund"]');
await top(panel);
await page.waitForTimeout(1500);
rec.mark("a person decides");
const held = d2State.includes("HELD");
if (held) {
  await panel.getByText("Refund in full anyway (override)").click();
  await page.waitForTimeout(1200);
  rec.mark("override picked");
  await panel.locator("textarea").first().pressSequentially("Checked the camera at the bench: label BW-CB-55120 matches the slip; lens and charger are in the tray.", { delay: 18 });
  await panel.getByLabel(/Override reason/).pressSequentially("Look-alike flag checked by hand; serial matches the slip.", { delay: 18 });
  await page.waitForTimeout(1500);
  rec.mark("note + override reason typed");
}
const approveBtn = panel.getByRole("button", { name: /^Approve \$340/ });
await approveBtn.click();
rec.mark("approve clicked");
const runRefund = panel.getByRole("button", { name: /Run refund/ });
await runRefund.waitFor({ timeout: 20000 });
await center(runRefund);
await page.waitForTimeout(1500);
rec.mark("single-use token issued");
await shot("f1-token");
await page.waitForTimeout(HOLD);
await runRefund.click();
rec.mark("run refund clicked");
await page.getByText("Refund receipt").first().waitFor({ timeout: 60000 });
await center(page.getByText("Refund receipt").first());
await page.waitForTimeout(1500);
rec.mark("refund receipt");
await shot("f2-receipt");
await page.waitForTimeout(HOLD + 2000);
await rec.stop();

// The SAME token, sent again: the server refuses it and writes the refusal on the case (after a refund the state check
// answers first: 409 bad_state; 403 token_used is the answer to two requests racing on an Approved case).
const t = log.cases.d2Token;
if (t?.token) {
  const r = await fetch(`${base}/api/cases/${t.caseId}/refund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: t.token }) });
  log.reuse = { status: r.status, body: await r.json().catch(() => null), at: new Date().toISOString() };
  fs.writeFileSync(path.join(out, "f-reuse-response.json"), JSON.stringify(log.reuse, null, 1));
  console.log(`token reuse → HTTP ${r.status} ${log.reuse.body?.error ?? ""}`);
}
log.cases.d2Token = t ? { caseId: t.caseId, token: "(redacted: spent)" } : null;
log.cases.d2 ??= t ? `/dashboard/cases/${t.caseId}` : null;
save();

// ---- f3 + g: case records (d2's audit shows the refused reuse; d1's diagnostics)
rec = await startScreencast(page, "g-case-records");
for (const [label, href] of [["d2 case record (the refused second use in the audit)", log.cases.d2], ["d1 case record diagnostics", log.cases.d1]]) {
  if (!href) continue;
  await page.goto(base + href, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  rec.mark(label);
  await shot(label.startsWith("d2") ? "f3-d2-case" : "g1-d1-case");
  await page.waitForTimeout(HOLD);
  const used = page.getByText(/can.t be refunded|token already used/).first();
  if (label.startsWith("d2") && (await used.count())) {
    await center(used);
    await page.waitForTimeout(1500);
    rec.mark("audit: the second use of the token refused");
    await shot("f4-reuse-refused");
    await page.waitForTimeout(HOLD);
  }
  for (let y = 0; y < 3; y++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(2500);
  }
}
await rec.stop();

// ---- j: play (evals and agents are not filmed)
for (const [name, url, beatsFn] of [
  ["j-play", "/play", async (r) => {
    r.mark("play");
    await page.getByRole("button", { name: /Lens left in the box/ }).click();
    await page.waitForTimeout(2500);
    r.mark("lens left in the box");
    await shot("j1-play-lens-left");
    await page.waitForTimeout(HOLD);
    await page.goto(base + "/play/walker", { waitUntil: "load" });
    await page.waitForTimeout(2500);
    r.mark("walker");
    await page.getByRole("button", { name: /A rubber tip left in the box/ }).click();
    await page.waitForTimeout(2500);
    await shot("j2-walker");
    await page.waitForTimeout(HOLD);
  }],
]) {
  await page.goto(base + url, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const r = await startScreencast(page, name);
  await beatsFn(r);
  await r.stop();
}
await ctx.close();
await browser.close();

// ---- d: voice-note card (its own browser: the fake mic flags replace the camera too)
if (voiceWav) {
  if (!fs.existsSync(voiceWav)) throw new Error(`voice WAV not found: ${voiceWav}`);
  const vb = await chromium.launch({ channel: "chrome", headless: true, args: [DSF_FLAG, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.resolve(voiceWav)}%noloop`] });
  const v = await newPage(vb);
  await v.ctx.grantPermissions(["microphone"], { origin: base });
  await v.page.goto(`${base}/dashboard/bench?voice=synthetic`, { waitUntil: "load" });
  await v.page.waitForTimeout(2500);
  const vr = await startScreencast(v.page, "d-voice-note");
  const recBtn = v.page.getByRole("button", { name: /Record a note/ });
  if (await recBtn.isVisible().catch(() => false)) {
    await center(recBtn);
    await v.page.waitForTimeout(1200);
    vr.mark("record a note");
    await recBtn.click();
    const secs = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", voiceWav], { encoding: "utf8" }));
    await v.page.waitForTimeout(Math.ceil(secs * 1000) + 1200);
    await v.page.getByRole("button", { name: /^Stop/ }).click();
    vr.mark("stop");
    await v.page.getByText("synthetic voice", { exact: false }).first().waitFor({ timeout: 90_000 });
    await center(v.page.getByText("synthetic voice", { exact: false }).first());
    await v.page.waitForTimeout(1500);
    vr.mark("transcribed card");
    await v.page.screenshot({ path: `${out}/d-voice-note.png` });
    await v.page.waitForTimeout(HOLD);
  } else {
    vr.mark("recorder off on this server");
    console.log("voice beat skipped: the recorder is off on this server");
  }
  await vr.stop();
  await v.ctx.close();
  await vb.close();
}

log.finishedAt = new Date().toISOString();
save();
console.log(log.errors.length ? `page errors:\n${log.errors.join("\n")}` : "capture complete, no page errors");
console.log(`cases: d1 ${log.cases.d1} · d2 ${log.cases.d2} (${log.cases.d2State}) · reuse ${log.reuse?.status ?? "not tried"}`);
