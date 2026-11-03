// Route screenshots at 375/768/1280 in dark and light, with a horizontal-overflow check.
// Usage: [ROUTES=/play] node video/screens.mjs [baseUrl]  → docs/screens/<route>-<width>-<theme>.png + report.json
import { chromium } from "playwright";
import fs from "node:fs";

const base = process.argv[2] ?? "http://localhost:3700";
const allRoutes = ["/", "/how-it-works", "/demo", "/play", "/pricing", "/onboarding", "/dashboard", "/dashboard/bench", "/dashboard/held", "/dashboard/refunds", "/dashboard/evals", "/dashboard/settings"];
// ROUTES=/play,/demo limits the run to those routes.
const routes = process.env.ROUTES ? process.env.ROUTES.split(",").map((r) => r.trim()).filter(Boolean) : allRoutes;
const widths = [375, 768, 1280];
const themes = ["dark", "light"];
const out = "docs/screens";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = [];
for (const theme of themes) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { localStorage.setItem("rw-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const r of routes) {
      errors.length = 0;
      await page.goto(base + r, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const small = await page.evaluate(() => [...document.querySelectorAll("p, li, td, a, span, label")].filter((el) => el.offsetParent && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).length);
      const name = `${r === "/" ? "home" : r.slice(1).replace(/\//g, "_")}-${w}-${theme}.png`;
      await page.screenshot({ path: `${out}/${name}`, fullPage: true });
      report.push({ route: r, width: w, theme, overflowPx: overflow, textUnder12px: small, errors: [...errors] });
    }
  }
  await ctx.close();
}
await browser.close();
// A filtered run writes its own report so the full-run report.json is never overwritten by a partial one.
const reportName = process.env.ROUTES ? `report-${routes.map((r) => (r === "/" ? "home" : r.slice(1).replace(/\//g, "_"))).join("+")}.json` : "report.json";
fs.writeFileSync(`${out}/${reportName}`, JSON.stringify(report, null, 2));
const bad = report.filter((x) => x.overflowPx > 0 || x.errors.length);
console.log(`${report.length} shots; ${bad.length} with overflow or console errors`);
for (const b of bad) console.log(JSON.stringify(b));
