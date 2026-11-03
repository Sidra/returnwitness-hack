// UI pass, step 1 ($0, read-only): screenshots of the main pages in light AND dark, and a responsive audit at
// 375/768/1280 (horizontal scroll, elements past the viewport edge, small tap targets). Page loads only: no clicks,
// nothing written to the case store, no model call (run it against a replay-only server).
//
//   node scripts/ui-audit.mjs [baseUrl] [--out docs/ui-pass-<date>] [--case /dashboard/cases/<id>]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const base = args[0]?.startsWith("http") ? args[0] : "http://localhost:3700";
const out = opt("out", "docs/ui-pass");
const casePath = opt("case", null);
fs.mkdirSync(path.join(out, "shots"), { recursive: true });

const status = await fetch(`${base}/api/status`).then((r) => r.json());
if (status.meta?.live || status.liveSeeded?.length) throw new Error("server has live models: run this against a replay-only server");

const PAGES = [
  ["home", "/"],
  ["how-it-works", "/how-it-works"],
  ["play", "/play"],
  ["play-walker", "/play/walker"],
  ["pricing", "/pricing"],
  ["demo", "/demo"],
  ["dashboard", "/dashboard"],
  ["evals", "/dashboard/evals"],
  ["agents", "/dashboard/agents"],
  ...(casePath ? [["case-d1-held", casePath]] : []),
];
const NARROW = new Set(["home", "play", "dashboard"]);

const browser = await chromium.launch({ channel: "chrome", headless: true });
async function open(theme, width, url) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("rw-theme", t);
      localStorage.setItem("rw-film", "1");
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  await page.goto(base + url, { waitUntil: "load" });
  await page.waitForTimeout(3500); // client fetches settle (evals, scenes)
  return { ctx, page, errors };
}

// 1. Screenshots: every page at 1280 in both themes; home, play and dashboard also at 390.
const shots = [];
for (const [name, url] of PAGES)
  for (const theme of ["light", "dark"])
    for (const width of [1280, ...(NARROW.has(name) ? [390] : [])]) {
      const { ctx, page } = await open(theme, width, url);
      const file = path.join(out, "shots", `${name}-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
      await ctx.close();
    }

// 2. Responsive audit (light theme; layout doesn't change with the theme).
const audit = [];
for (const [name, url] of PAGES)
  for (const width of [375, 768, 1280]) {
    const { ctx, page, errors } = await open("light", width, url);
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const sel = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${[...el.classList].slice(0, 2).join(".")}` : ""}`;
      // Elements whose box runs past the right edge, skipping descendants of an element that already does,
      // and anything inside a horizontally scrolling container (tables in .table-wrap scroll on purpose).
      const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if ((s.overflowX === "auto" || s.overflowX === "scroll") && p.scrollWidth > p.clientWidth) return true; } return false; };
      const over = [];
      for (const el of document.body.querySelectorAll("*")) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.right <= vw + 1 || scrolls(el)) continue;
        if (over.some((o) => o.el.contains(el))) continue;
        over.push({ el, right: Math.round(b.right) });
      }
      // Tap targets: links, buttons, inputs; WCAG 2.2 AA minimum 24×24 CSS px, the 44×44 comfort size noted too.
      const taps = [...document.querySelectorAll("a[href], button, input, select, textarea, [role=button], [role=tab]")].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== "hidden"; });
      const small24 = taps.filter((el) => { const b = el.getBoundingClientRect(); return b.width < 24 || b.height < 24; });
      const small44 = taps.filter((el) => { const b = el.getBoundingClientRect(); return b.width < 44 || b.height < 44; });
      // Body text smaller than 13 px (the review flags dense small text).
      const tiny = [...document.querySelectorAll("p, li, td, span, div")].filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 20) && parseFloat(getComputedStyle(el).fontSize) < 13);
      return {
        horizontalScroll: document.documentElement.scrollWidth > vw + 1,
        scrollWidth: document.documentElement.scrollWidth,
        viewport: vw,
        overflowing: over.slice(0, 8).map((o) => `${sel(o.el)} → ${o.right}px`),
        overflowCount: over.length,
        tapTargets: taps.length,
        under24: small24.length,
        under24Examples: small24.slice(0, 5).map((el) => `${sel(el)} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`),
        under44: small44.length,
        tinyTextBlocks: tiny.length,
      };
    });
    audit.push({ page: name, url, width, ...r, pageErrors: errors });
    await ctx.close();
  }
await browser.close();

fs.writeFileSync(path.join(out, "responsive-audit.json"), JSON.stringify({ base, at: new Date().toISOString(), audit }, null, 1));
const rows = audit.map((a) => `| ${a.page} | ${a.width} | ${a.horizontalScroll ? `**YES** (${a.scrollWidth}px)` : "no"} | ${a.overflowCount}${a.overflowing.length ? `: ${a.overflowing.slice(0, 3).join("; ")}` : ""} | ${a.under24}/${a.tapTargets}${a.under24Examples.length ? `: ${a.under24Examples.slice(0, 2).join("; ")}` : ""} | ${a.under44} | ${a.tinyTextBlocks} | ${a.pageErrors.length} |`);
const md = `# Responsive audit\n\nPage loads only (no clicks), light theme, film mode. Against ${base} (replay-only).\n\n| Page | Width | Horizontal scroll | Past the right edge | Tap targets < 24 px | < 44 px | Text blocks < 13 px | Page errors |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
fs.writeFileSync(path.join(out, "RESPONSIVE-AUDIT.md"), md);
console.log(`${shots.length} screenshots → ${path.join(out, "shots")}`);
console.log(md);
