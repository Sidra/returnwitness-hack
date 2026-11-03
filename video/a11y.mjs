// axe-core audit of every route in both themes (WCAG 2.1 AA rules). Usage: node video/a11y.mjs [baseUrl]
import { chromium } from "playwright";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = process.argv[2] ?? "http://localhost:3700";
const allRoutes = ["/", "/how-it-works", "/demo", "/play", "/pricing", "/onboarding", "/dashboard", "/dashboard/bench", "/dashboard/held", "/dashboard/refunds", "/dashboard/evals", "/dashboard/settings"];
// ROUTES=/play,/demo limits the run to those routes.
const routes = process.env.ROUTES ? process.env.ROUTES.split(",").map((r) => r.trim()).filter(Boolean) : allRoutes;
const browser = await chromium.launch({ channel: "chrome" });
const out = [];
for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("rw-theme", t); } catch {} }, theme);
  const page = await ctx.newPage();
  for (const r of routes) {
    await page.goto(base + r, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
    for (const v of res.violations) out.push({ theme, route: r, id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(" "), why: v.nodes[0]?.failureSummary?.split("\n")[1]?.trim() });
  }
  await ctx.close();
}
await browser.close();
const byRule = {};
for (const v of out) (byRule[v.id] ??= []).push(v);
for (const [id, vs] of Object.entries(byRule)) console.log(`${id} (${vs[0].impact}) ×${vs.length}: e.g. ${vs[0].theme} ${vs[0].route} ${vs[0].sample} — ${vs[0].why}`);
console.log(out.length ? `${out.length} violations` : "0 axe violations");
