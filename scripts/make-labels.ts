/**
 * Printable label sheet for the physical kit, generated from data/kit.config.ts.
 * Avery 8163 / 5163 geometry: US Letter, 2" x 4" labels, 2 columns x 5 rows,
 * 0.5" top margin, 0.156" side margin, 0.1875" column gap. Print at 100% (no "fit to page").
 * Set A = complete order (gate clips + d2). Set B = the missing-lens order (d1).
 */
import fs from "node:fs";
import { KIT } from "../data/kit.config";

const cam = KIT.items.find((i) => i.key === "camera_body")!;
const lens = KIT.items.find((i) => i.key === "lens")!;
const batt = KIT.items.find((i) => i.key === "battery")!;
const store = KIT.merchantName.replace(/ Camera Co\.$/, "").toUpperCase();

// Sizing: from 60-80 cm on a 1080p frame, 1 px is roughly 0.8 mm, so the serial is set as large
// as the label allows (~12 mm caps, ~15 px tall). The lens label wraps the TOP of the mug's barrel
// (the round lid faces sideways when the mug lies on its side, so the camera can't see it).
type Cell = { set: string; title: string; sku: string; serial?: string; small?: boolean };
const cells: Cell[] = [
  { set: "SET A · complete", title: cam.name, sku: cam.sku, serial: cam.serials.complete },
  { set: "SET A · complete", title: lens.name, sku: lens.sku, serial: lens.serials.complete, small: true },
  { set: "SET A · complete", title: batt.name, sku: batt.sku },
  { set: "SET B · missing-lens order (d1)", title: cam.name, sku: cam.sku, serial: cam.serials.missingCase },
  { set: "SET B · spare, not filmed", title: lens.name, sku: lens.sku, serial: lens.serials.missingCase, small: true },
  { set: "SPARE · set A", title: cam.name, sku: cam.sku, serial: cam.serials.complete },
  { set: "SPARE · set A", title: lens.name, sku: lens.sku, serial: lens.serials.complete, small: true },
  { set: "SPARE", title: batt.name, sku: batt.sku },
  { set: "SPARE · set B", title: cam.name, sku: cam.sku, serial: cam.serials.missingCase },
  { set: "SPARE · set A", title: lens.name, sku: lens.sku, serial: lens.serials.complete, small: true },
];

const label = (c: Cell) => {
  const [pre, num] = c.serial ? [c.serial.split("-").slice(0, 2).join("-"), c.serial.split("-").slice(2).join("-")] : ["", ""];
  const serial = c.serial ? `<div class="sn"><span class="pre">${pre}-</span>${num}</div>` : `<div class="sn nos">no serial</div>`;
  const where = c.small ? `<div class="where">wrap across the TOP of the barrel, facing the camera</div>` : "";
  return `<div class="label"><div class="tag">${c.set} · ${c.title}</div><div class="meta"><span class="store">${store}</span> <span class="sku">${c.sku}</span></div>${serial}${where}</div>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><title>ReturnWitness kit labels</title>
<style>
@page { size: letter; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #000; background: #fff; }
.sheet { width: 8.5in; height: 11in; padding: 0.5in 0.156in 0 0.156in; display: grid; grid-template-columns: 4in 4in; column-gap: 0.1875in; grid-auto-rows: 2in; }
.label { position: relative; padding: 0.12in 0.16in; overflow: hidden; }
.tag { font-size: 7pt; color: #555; letter-spacing: .04em; text-transform: uppercase; }
.meta { margin-top: 0.04in; font-size: 10pt; }
.store { font-weight: 800; letter-spacing: .08em; }
.sku { font-family: Menlo, monospace; }
.sn { font-family: Menlo, monospace; font-weight: 800; font-size: 46pt; line-height: 1; margin-top: 0.08in; letter-spacing: -.01em; white-space: nowrap; }
.sn .pre { font-size: 24pt; letter-spacing: 0; }
.where { font-size: 7pt; color: #555; margin-top: 4pt; }
.nos { color: #555; font-weight: 400 !important; font-size: 14pt !important; }
@media screen { body { background: #ddd; } .sheet { background: #fff; margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.2); } .label { outline: 1px dotted #bbb; } }
</style></head><body><div class="sheet">${cells.map(label).join("")}</div></body></html>`;

fs.mkdirSync("labels", { recursive: true });
fs.writeFileSync("labels/label-sheet.html", html);
console.log("labels/label-sheet.html");
