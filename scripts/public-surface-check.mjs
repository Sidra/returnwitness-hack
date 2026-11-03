// Public-surface check: every public page (its HTML and its RSC/flight payload) and every public GET API, scanned for
// run dates and private-repo traces: ISO dates, "commit <hex>", any of this repo's commit hashes, "<hex>-dirty", and
// clock times in Pacific time. The export scrub never sees these: Vercel builds the public site from the private repo,
// so the runtime itself must not ship them.
//
//   node scripts/public-surface-check.mjs [baseUrl]      (a production build in the public-demo profile)
// Exits 1 and lists every hit with its surroundings. ALLOW names the only date-like strings that may ship.
import { execFileSync } from "node:child_process";

const base = process.argv[2] ?? "http://localhost:3711";
const PAGES = ["/", "/how-it-works", "/pricing", "/play", "/play/walker", "/demo", "/onboarding", "/dashboard", "/dashboard/bench", "/dashboard/held", "/dashboard/refunds", "/dashboard/evals", "/dashboard/agents", "/dashboard/settings"];
const APIS = ["/api/status", "/api/cases", "/api/charges", "/api/evals", "/api/llm-calls", "/api/packet-key"];
const CLIPS = ["d1-rma-20418-lens-missing", "d2-rma-20419-complete", "gate-g0", "gate-g1"];
/** Explicitly allowed strings that look like dates (fictional, and said so on the page). Keep it short. */
const ALLOW = [
  // Stripe's API version id on the test-mode refund event (a vendor identifier, not a date of mine)
  '"api_version":"2026-02-25.clover"', '\\"api_version\\":\\"2026-02-25.clover\\"',
];

let hashes = [];
try {
  hashes = execFileSync("git", ["rev-list", "--all", "--abbrev-commit", "--abbrev=7"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  /* not a git checkout: the hash rule still catches "commit <hex>" and "-dirty" */
}
const hashSet = new Set(hashes);
const RULES = [
  // no \b after the day: an ISO timestamp has no word boundary before its T
  ["ISO date", /(?<![0-9])20\d\d-[01]\d-[0-3]\d(?![0-9])/g],
  ['"commit <hex>"', /\bcommit [0-9a-f]{7,40}\b/gi],
  ['"<hex>-dirty"', /\b[0-9a-f]{7,40}-dirty\b/g],
  ["clock time in Pacific time", /\b\d{1,2}:\d\d(?::\d\d)?\s?(?:PT|PST|PDT)\b/g],
];

function scan(where, text) {
  const hits = [];
  for (const [name, rx] of RULES)
    for (const m of text.matchAll(rx)) {
      const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 40).replace(/\s+/g, " ");
      if (ALLOW.some((a) => around.includes(a))) continue;
      hits.push(`${where}: ${name} "${m[0]}" … ${around}`);
    }
  for (const m of text.matchAll(/\b[0-9a-f]{7}\b/g))
    if (hashSet.has(m[0])) hits.push(`${where}: a private commit hash "${m[0]}" … ${text.slice(Math.max(0, m.index - 60), m.index + 47).replace(/\s+/g, " ")}`);
  return hits;
}

async function get(path, headers = {}) {
  const r = await fetch(base + path, { headers, redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

const hits = [];
let checked = 0;
for (const p of PAGES) {
  for (const [kind, headers] of [["HTML", {}], ["RSC", { RSC: "1" }]]) {
    const r = await get(p, headers);
    checked++;
    if (r.status >= 400) hits.push(`${p} ${kind}: HTTP ${r.status}`);
    hits.push(...scan(`${p} ${kind}`, r.text));
  }
}
const apis = [...APIS, ...CLIPS.map((c) => `/api/scenes/${c}`)];
try {
  const cases = JSON.parse((await get("/api/cases")).text);
  for (const c of (cases.cases ?? cases).slice?.(0, 40) ?? []) if (c?.id) apis.push(`/api/cases/${c.id}`, `/api/cases/${c.id}/packet`, `/dashboard/cases/${c.id}`);
} catch {
  /* no case list: pages above still checked */
}
for (const p of apis) {
  const r = await get(p);
  checked++;
  hits.push(...scan(p, r.text));
  if (p.startsWith("/dashboard/cases/")) {
    const rsc = await get(p, { RSC: "1" });
    checked++;
    hits.push(...scan(`${p} RSC`, rsc.text));
  }
}
const unique = [...new Set(hits)];
for (const h of unique.slice(0, 200)) console.log("surface:", h);
console.log(`public-surface-check: ${checked} responses from ${base}, ${unique.length} hits${unique.length > 200 ? " (first 200 shown)" : ""}`);
process.exit(unique.length ? 1 : 0);
