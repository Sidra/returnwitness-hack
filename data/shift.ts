/**
 * [Seeded shift fixture · synthetic]: one bench shift of 24 open returns of the Creator Kit, for the
 * agent fleet (lib/fleet). Deterministic: no clock, no randomness, no network.
 *
 * What is seeded and what is computed:
 *   - The first three boxes are the demo returns from data/fixtures.ts (RMA-20418 lens missing,
 *     RMA-20419 complete, RMA-20420 the re-boxed camera), with their own slips, serials and prices.
 *   - Seeded: the other orders and customers, addresses, delivery and receipt dates, carrier scans,
 *     what a damage model would see on each crop (crops, outerBox), and the returns lead's voice notes
 *     (VoiceNote shape, RECORDED_FIXTURE, "seeded note text, not a live transcription").
 *   - Computed: every count. The demo boxes use the demo scenes (data/scenes.ts); the others carry
 *     synthetic segmentation tracks built with the gate clips' own track builders (lib/evals/suite.ts).
 *     The inspector agent runs the REAL tray counter on them. No count below is written by hand.
 *
 * The mix is a believable day, not a showcase: 18 of 24 boxes are complete and go to a person for
 * approval; 6 are held, each for one distinct, explainable cause. Prices and serial formats come from
 * kit.config.ts.
 */
import { KIT, KIT_TOTAL_CENTS } from "./kit.config";
import { RMAS, orderFor } from "./fixtures";
import type { PackingSlip, Rma } from "@/lib/domain/schemas";
import type { VoiceNote } from "@/lib/domain/case";
import type { TrackSpec } from "@/lib/vision/synth";
import { GATE_DIMS, GATE_FRAMES, GATE_SPOT, gateHand, gatePut } from "@/lib/evals/suite";

export const SHIFT_LABEL = "[Seeded shift fixture · synthetic]";

export const SHIFT = {
  id: "shift-2026-10-29-bench2",
  date: "2026-10-29",
  bench: "Bench 2",
  lead: "Rita Calder",
  merchant: KIT.merchantName,
} as const;

export type ItemKey = "camera_body" | "lens" | "battery";
export const ITEM_KEYS: ItemKey[] = ["camera_body", "lens", "battery"];

/** What a crop of each settled item would show a damage model (seeded annotation; live: muse-spark-1.3 on the crop). */
export type SurfaceCondition = "sealed" | "opened" | "scuffed" | "dented";
export interface CropAnnotation {
  itemKey: ItemKey;
  surface: SurfaceCondition;
  /** What is visible, in the words a reader would use. */
  detail: string;
  /** Clip time of the crop (s), used as the photo reference in a carrier claim. */
  t: number;
}

export interface CarrierScan {
  at: string;
  event: string;
}

export interface ShiftOrder {
  id: string;
  customer: { name: string; email: string };
  /** Shipping address; returns come back from the same address. */
  address: string;
  deliveredAt: string;
  slip: PackingSlip;
  returnShipment: { carrier: "UPS" | "USPS" | "FedEx"; tracking: string; scans: CarrierScan[] };
}

export type ClipPattern = "clean" | "hand_rest" | "paper" | "lift" | "merge" | "fast";
export type LabelSpec = { text: string; confidence: number } | null;

export interface ShiftReturn {
  rma: Rma;
  order: ShiftOrder;
  /** When the return reached the dock. */
  receivedAt: string;
  /** Synthetic tracks from a motion pattern, or (sceneId) one of the demo scenes in data/scenes.ts. */
  clip: { pattern: ClipPattern; present: ItemKey[]; labels: Partial<Record<ItemKey, LabelSpec>>; note: string; sceneId?: string };
  /** Seeded crop annotations for the items that reach the tray. */
  crops: CropAnnotation[];
  /** The outer carton as the bench camera sees it; "not_in_frame" when the dock moved the items to a tote. */
  outerBox: "intact" | "crushed" | "not_in_frame";
  voiceNote?: VoiceNote;
  /** One-line description of what is in this box, for the screen. */
  scenario: string;
}

/* ---------- Synthetic segmentation tracks (the gate clips' motions) ---------- */

const PICK: Record<ItemKey, number> = { camera_body: 4, lens: 20, battery: 36 };
const kitItem = (k: ItemKey) => KIT.items.find((i) => i.key === k)!;
const labelOpt = (labels: ShiftReturn["clip"]["labels"], k: ItemKey) => (k in labels ? { label: labels[k] ?? undefined } : {});

/** Build the tracks for one return from its motion pattern. Patterns that move a specific item fall back to "clean" if that item isn't in the box. */
export function buildTracks(clip: ShiftReturn["clip"]): { frames: number; tracks: TrackSpec[] } {
  const F = GATE_FRAMES;
  const has = (k: ItemKey) => clip.present.includes(k);
  const L = (k: ItemKey) => labelOpt(clip.labels, k);
  const lensLabel = clip.labels.lens === undefined ? { text: kitItem("lens").serials.complete, confidence: 0.92 } : clip.labels.lens ?? undefined;
  const all = has("camera_body") && has("lens") && has("battery");
  const pattern: ClipPattern = all ? clip.pattern : clip.pattern === "fast" || clip.pattern === "paper" ? clip.pattern : "clean";

  if (pattern === "fast") {
    const picks: Record<ItemKey, number> = { camera_body: 2, lens: 10, battery: 18 };
    return { frames: 50, tracks: ITEM_KEYS.filter(has).flatMap((k, i) => gatePut(k, i + 1, picks[k], 49, { travel: 3, ...L(k) })) };
  }
  if (pattern === "hand_rest") {
    const lens = kitItem("lens");
    return {
      frames: F,
      tracks: [
        ...gatePut("camera_body", 1, 4, F - 1, L("camera_body")),
        ...gatePut("lens", 2, 18, 34, L("lens")),
        gateHand("rest", 35, 45, [{ f: 35, x: GATE_SPOT.lens.x, y: GATE_SPOT.lens.y }]),
        { concept: lens.samConcept, trackId: 9, from: 46, to: F - 1, keys: [{ f: 46, x: GATE_SPOT.lens.x + 0.004, y: GATE_SPOT.lens.y }], ...GATE_DIMS.lens, area: lens.expectedAreaFrac, label: lensLabel },
        ...gatePut("battery", 3, 38, F - 1, L("battery")),
      ],
    };
  }
  if (pattern === "lift") {
    const lens = kitItem("lens");
    return {
      frames: F,
      tracks: [
        ...gatePut("camera_body", 1, 4, F - 1, L("camera_body")),
        ...gatePut("lens", 2, 18, 33, L("lens")),
        gateHand("lift", 33, 46, [{ f: 33, x: GATE_SPOT.lens.x, y: GATE_SPOT.lens.y }, { f: 37, x: 0.5, y: 0.45 }, { f: 41, x: 0.5, y: 0.45 }, { f: 45, x: 0.88, y: 0.5 }, { f: 46, x: 0.95, y: 0.75 }]),
        { concept: lens.samConcept, trackId: 8, from: 34, to: F - 1, keys: [{ f: 34, x: GATE_SPOT.lens.x, y: GATE_SPOT.lens.y + 0.01 }, { f: 37, x: 0.5, y: 0.45 }, { f: 41, x: 0.5, y: 0.45 }, { f: 45, x: 0.88, y: 0.5 }], ...GATE_DIMS.lens, area: lens.expectedAreaFrac, label: lensLabel },
        ...gatePut("battery", 3, 50, F - 1, L("battery")),
      ],
    };
  }
  if (pattern === "merge") {
    const cam = kitItem("camera_body");
    const batt = kitItem("battery");
    return {
      frames: F,
      tracks: [
        ...gatePut("camera_body", 1, 4, 37, L("camera_body")),
        ...gatePut("lens", 2, 18, F - 1, L("lens")),
        gateHand("touch", 32, 39, [{ f: 32, x: 0.22, y: 0.5 }, { f: 37, x: 0.71, y: 0.33 }, { f: 39, x: 0.85, y: 0.6 }]),
        { concept: cam.samConcept, trackId: 1, from: 38, to: F - 1, keys: [{ f: 38, x: 0.7, y: 0.32 }], w: 0.12, h: 0.1, area: cam.expectedAreaFrac + batt.expectedAreaFrac },
      ],
    };
  }
  const paper: TrackSpec[] =
    pattern === "paper"
      ? [
          { concept: KIT.packingConcepts[0], trackId: "p1", from: 0, to: F - 1, keys: [{ f: 0, x: 0.22, y: 0.5 }, { f: 5, x: 0.6, y: 0.5 }, { f: 9, x: 0.15, y: 0.2 }], w: 0.16, h: 0.12 },
          { concept: KIT.packingConcepts[0], trackId: "p2", from: 30, to: F - 1, keys: [{ f: 30, x: 0.22, y: 0.5 }], w: 0.12, h: 0.1 },
        ]
      : [];
  const offset = pattern === "paper" ? 8 : 0;
  return { frames: F, tracks: [...paper, ...ITEM_KEYS.filter(has).flatMap((k, i) => gatePut(k, i + 1, PICK[k] + offset, F - 1, L(k)))] };
}

/* ---------- The shift ---------- */

const SLIP_SHIPPED = "2026-09-30T17:20:00Z";
const bodySerial = (n: number) => `BW-CB-${56100 + n}`;
const lensSerial = (n: number) => `BW-LN-${81200 + n}`;

function slip(orderId: string, n: number): PackingSlip {
  return {
    orderId,
    shippedAt: SLIP_SHIPPED,
    lines: KIT.items.map((i) => ({
      itemKey: i.key,
      sku: i.sku,
      description: i.name,
      qty: 1,
      unitPriceCents: i.unitPriceCents,
      requiresSerial: i.requiresSerial,
      ...(i.requiresSerial ? { serial: i.key === "camera_body" ? bodySerial(n) : lensSerial(n) } : {}),
    })),
  };
}

const note = (transcript: string, audioDurationMs: number, recordedAt: string): VoiceNote => ({
  transcript,
  mode: "RECORDED_FIXTURE",
  model: "muse-voice-transcribe-1.0",
  latencyMs: 0,
  audioDurationMs,
  provenance: "seeded note text, not a live transcription",
  person: SHIFT.lead,
  recordedAt,
});

interface Seed {
  n: number;
  customer: [string, string];
  address: string;
  delivered: string;
  received: string;
  reason: string;
  scenario: string;
  pattern: ClipPattern;
  present?: ItemKey[];
  labels?: Partial<Record<ItemKey, LabelSpec>>;
  surfaces?: Partial<Record<ItemKey, [SurfaceCondition, string]>>;
  outerBox?: ShiftReturn["outerBox"];
  carrier?: ShiftOrder["returnShipment"]["carrier"];
  exception?: string;
  voice?: [string, number];
}

const OPENED = (k: ItemKey): [SurfaceCondition, string] => ["opened", `${kitItem(k).name.toLowerCase()} out of its sleeve, no marks`];
const SEALED: Seed["surfaces"] = { camera_body: ["sealed", "factory sleeve intact"], lens: ["sealed", "factory sleeve intact"], battery: ["sealed", "blister pack intact"] };

/**
 * The rest of the shift after the three demo returns. A realistic day: most boxes are complete and go
 * straight to a person for approval (some with a messy unpack the counter absorbs: a hand resting on an
 * item, kraft paper, an item lifted and set down again, a fast unpack). Five are held, each for one
 * distinct reason: a swapped body serial, transit damage, a late return, a missing lens cap the lead
 * mentions, a smudged serial label. With RMA-20418 (lens missing) that is 6 of 24 held.
 */
const SEEDS: Seed[] = [
  { n: 1, customer: ["Imogen Hale", "imogen.hale@example.com"], address: "77 Alder Way, Portland OR", delivered: "2026-10-06", received: "2026-10-27", reason: "Too heavy for travel.", scenario: "complete kit, opened, no marks", pattern: "clean" },
  { n: 2, customer: ["Theo Marchetti", "theo.marchetti@example.com"], address: "1402 Pine St, Seattle WA", delivered: "2026-10-08", received: "2026-10-27", reason: "Changed my mind.", scenario: "complete kit; a hand rests on the lens and the segmenter re-issues its ID", pattern: "hand_rest" },
  { n: 3, customer: ["Gus Whitlow", "gus.whitlow@example.com"], address: "330 Elm Ave, Denver CO", delivered: "2026-10-05", received: "2026-10-27", reason: "Camera stopped working.", scenario: "camera body serial does not match the order (swapped body)", pattern: "paper", labels: { camera_body: { text: "BW-CB-49870", confidence: 0.93 } } },
  { n: 4, customer: ["Omar Haddad", "omar.haddad@example.com"], address: "14 Spruce St, Phoenix AZ", delivered: "2026-10-15", received: "2026-10-28", reason: "Duplicate order.", scenario: "complete kit, never opened", pattern: "clean", surfaces: SEALED },
  { n: 5, customer: ["Hana Mori", "hana.mori@example.com"], address: "600 Maple Dr, San Jose CA", delivered: "2026-10-14", received: "2026-10-28", reason: "Bought the bundle elsewhere.", scenario: "complete kit; lens picked up to show its label", pattern: "lift" },
  { n: 6, customer: ["Priya Raman", "priya.raman@example.com"], address: "9 Cedar Ct, Austin TX", delivered: "2026-10-09", received: "2026-10-28", reason: "Found a better price.", scenario: "complete kit; the lead notes a crushed outer box, contents fine", pattern: "fast", outerBox: "not_in_frame", voice: ["Outer box was crushed at the dock, contents look fine.", 3400] },
  { n: 7, customer: ["Ana Sousa", "ana.sousa@example.com"], address: "52 Harbor Rd, Boston MA", delivered: "2026-10-12", received: "2026-10-28", reason: "Arrived damaged.", scenario: "transit damage: dented camera body, crushed carton, carrier exception scan", pattern: "clean", surfaces: { camera_body: ["dented", "dent on the top plate beside the shutter dial"] }, outerBox: "crushed", carrier: "UPS", exception: "Exception: package damaged in transit, repackaged by carrier" },
  { n: 8, customer: ["Elif Aydin", "elif.aydin@example.com"], address: "205 Cypress St, Raleigh NC", delivered: "2026-10-13", received: "2026-10-27", reason: "Changed my mind.", scenario: "complete kit under kraft paper", pattern: "paper" },
  { n: 9, customer: ["Jonah Reyes", "jonah.reyes@example.com"], address: "17 Hemlock Rd, Salt Lake City UT", delivered: "2026-10-16", received: "2026-10-28", reason: "Gift duplicate.", scenario: "complete kit, opened, no marks", pattern: "clean" },
  { n: 10, customer: ["Felix Brandt", "felix.brandt@example.com"], address: "21 Birch Ln, Chicago IL", delivered: "2026-09-14", received: "2026-10-28", reason: "Didn't get around to using it.", scenario: "complete kit, returned 43 days after delivery", pattern: "clean" },
  { n: 11, customer: ["Lucia Ferreira", "lucia.ferreira@example.com"], address: "88 Willow Rd, Miami FL", delivered: "2026-10-07", received: "2026-10-27", reason: "Not for me.", scenario: "complete kit; a hand rests on the lens", pattern: "hand_rest" },
  { n: 12, customer: ["Diego Lima", "diego.lima@example.com"], address: "71 Oak Hollow, San Diego CA", delivered: "2026-10-12", received: "2026-10-27", reason: "Too complicated.", scenario: "complete kit, opened, no marks", pattern: "clean" },
  { n: 13, customer: ["Ben Adeyemi", "ben.adeyemi@example.com"], address: "5 Poplar Pl, Atlanta GA", delivered: "2026-10-13", received: "2026-10-28", reason: "Changed my mind.", scenario: "complete kit; the lead notes the lens cap is missing", pattern: "clean", voice: ["Lens cap missing on this one. The front cap isn't in the box.", 3800] },
  { n: 14, customer: ["Clara Novak", "clara.novak@example.com"], address: "230 Ash Blvd, Minneapolis MN", delivered: "2026-10-16", received: "2026-10-28", reason: "Upgrading.", scenario: "complete kit, all three out within 8 s", pattern: "fast" },
  { n: 15, customer: ["Rosa Kim", "rosa.kim@example.com"], address: "19 Linden St, Brooklyn NY", delivered: "2026-10-09", received: "2026-10-28", reason: "Wrong model.", scenario: "complete kit, never opened", pattern: "clean", surfaces: SEALED },
  { n: 16, customer: ["Ines Duarte", "ines.duarte@example.com"], address: "940 Juniper Way, Sacramento CA", delivered: "2026-10-15", received: "2026-10-28", reason: "Not needed.", scenario: "lens label smudged; read at low confidence", pattern: "clean", labels: { lens: { text: lensSerial(16), confidence: 0.64 } } },
  { n: 17, customer: ["Victor Hale", "victor.hale@example.com"], address: "402 Sycamore Ave, Newark NJ", delivered: "2026-10-10", received: "2026-10-28", reason: "Ordered the wrong kit.", scenario: "complete kit; lens picked up to show its label", pattern: "lift" },
  { n: 18, customer: ["Nadia Petrov", "nadia.petrov@example.com"], address: "66 Chestnut St, Philadelphia PA", delivered: "2026-10-11", received: "2026-10-28", reason: "Changed my mind.", scenario: "complete kit; the lead confirms the charger is still in its blister", pattern: "clean", surfaces: { battery: ["sealed", "blister pack intact"] }, voice: ["All three here. Charger is still in its blister.", 2900] },
  { n: 19, customer: ["Sam Okafor", "sam.okafor@example.com"], address: "3 Magnolia Ct, Nashville TN", delivered: "2026-10-14", received: "2026-10-28", reason: "Not what I expected.", scenario: "complete kit under kraft paper", pattern: "paper" },
  { n: 20, customer: ["Paolo Conti", "paolo.conti@example.com"], address: "48 Redwood Dr, Las Vegas NV", delivered: "2026-10-10", received: "2026-10-28", reason: "Gift, not needed.", scenario: "complete kit, never opened", pattern: "clean", surfaces: SEALED },
  { n: 21, customer: ["Grace Lindqvist", "grace.lindqvist@example.com"], address: "12 Aspen Ct, Boulder CO", delivered: "2026-10-12", received: "2026-10-28", reason: "Lens not for me.", scenario: "complete kit, all three out within 8 s", pattern: "fast" },
];

const at = (d: string, hh: string) => `${d}T${hh}:00Z`;

function scansFor(received: string, exception?: string): CarrierScan[] {
  return [
    { at: at(addDays(received, -3), "14:10"), event: "Picked up" },
    ...(exception ? [{ at: at(addDays(received, -2), "06:40"), event: exception }] : []),
    { at: at(received, "09:05"), event: "Delivered to merchant dock" },
  ];
}

function build(s: Seed): ShiftReturn {
  const rmaId = `RMA-${30100 + s.n}`;
  const orderId = `ORD-${61400 + s.n}`;
  const present = s.present ?? [...ITEM_KEYS];
  const labels: Partial<Record<ItemKey, LabelSpec>> = {
    camera_body: { text: bodySerial(s.n), confidence: 0.92 },
    lens: { text: lensSerial(s.n), confidence: 0.92 },
    ...(s.labels ?? {}),
  };
  const carrier = s.carrier ?? (["UPS", "USPS", "FedEx"] as const)[s.n % 3];
  const crops: CropAnnotation[] = present.map((k) => {
    const [surface, detail] = s.surfaces?.[k] ?? OPENED(k);
    return { itemKey: k, surface, detail, t: Number(((PICK[k] + 8) / 5).toFixed(1)) };
  });
  return {
    rma: {
      id: rmaId,
      orderId,
      customer: { name: s.customer[0], email: s.customer[1] },
      reason: s.reason,
      requestedRefundCents: KIT_TOTAL_CENTS,
      createdAt: at(addDays(s.received, -4), "16:00"),
      clipId: `shift-${rmaId.toLowerCase()}`,
      scenario: s.scenario,
    },
    order: {
      id: orderId,
      customer: { name: s.customer[0], email: s.customer[1] },
      address: s.address,
      deliveredAt: at(s.delivered, "18:00"),
      slip: slip(orderId, s.n),
      returnShipment: { carrier, tracking: `${carrier.toUpperCase()}-RW-${30100 + s.n}`, scans: scansFor(s.received, s.exception) },
    },
    receivedAt: at(s.received, "09:05"),
    clip: { pattern: s.pattern, present, labels, note: s.scenario },
    crops,
    outerBox: s.outerBox ?? "intact",
    ...(s.voice ? { voiceNote: note(s.voice[0], s.voice[1], at(SHIFT.date, "10:15")) } : {}),
    scenario: s.scenario,
  };
}

/**
 * The three demo returns (data/fixtures.ts), first in the shift, with their own slips, serials and prices.
 * Their counts come from the real counter on the demo scenes (data/scenes.ts), the same frames the bench
 * replays. Addresses, delivery dates and carrier scans are seeded here (the fixtures don't carry them).
 */
const DEMO_SEEDS: Array<{ index: 0 | 1 | 2; address: string; delivered: string; received: string; present: ItemKey[]; carrier: ShiftOrder["returnShipment"]["carrier"] }> = [
  { index: 0, address: "2210 Mission St, San Francisco CA", delivered: "2026-10-06", received: "2026-10-27", present: ["camera_body", "battery"], carrier: "UPS" },
  { index: 1, address: "915 Grove St, Oakland CA", delivered: "2026-10-06", received: "2026-10-27", present: [...ITEM_KEYS], carrier: "USPS" },
  { index: 2, address: "48 Shoreline Dr, Alameda CA", delivered: "2026-10-07", received: "2026-10-27", present: [...ITEM_KEYS], carrier: "FedEx" },
];

function buildDemo(d: (typeof DEMO_SEEDS)[number]): ShiftReturn {
  const rma = RMAS[d.index];
  const order = orderFor(rma.orderId)!;
  return {
    rma,
    order: {
      id: order.id,
      customer: order.customer,
      address: d.address,
      deliveredAt: at(d.delivered, "18:00"),
      slip: order.slip,
      returnShipment: { carrier: d.carrier, tracking: `${d.carrier.toUpperCase()}-RW-${rma.id.slice(4)}`, scans: scansFor(d.received) },
    },
    receivedAt: at(d.received, "09:05"),
    clip: { pattern: "clean", present: d.present, labels: {}, note: rma.scenario, sceneId: rma.clipId },
    crops: d.present.map((k) => ({ itemKey: k, surface: "opened" as const, detail: OPENED(k)[1], t: Number(((PICK[k] + 8) / 5).toFixed(1)) })),
    outerBox: "intact",
    scenario: `${rma.scenario} (demo return)`,
  };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface SeededShift {
  shift: typeof SHIFT;
  label: typeof SHIFT_LABEL;
  returns: ShiftReturn[];
  /** Merchant settings used by the restock and cost agents (seeded, shown as such). */
  settings: {
    returnWindowDays: number;
    /** Share of list price recovered on resale, by restock grade. */
    recovery: { A: number; B: number; C: number; recycle: number };
    /** Payment processing fee on the original charge, which a refund does not give back. */
    processingFee: { pct: number; fixedCents: number };
    returnLabelCents: number;
    /** Concepts the inspector's segmentation would bill per frame when live (3 items + hand + 2 packing). */
    segmentationConcepts: number;
  };
}

export const SEEDED_SHIFT: SeededShift = {
  shift: SHIFT,
  label: SHIFT_LABEL,
  returns: [...DEMO_SEEDS.map(buildDemo), ...SEEDS.map(build)],
  settings: {
    returnWindowDays: 30,
    recovery: { A: 1, B: 0.8, C: 0.35, recycle: 0 },
    processingFee: { pct: 0.029, fixedCents: 30 },
    returnLabelCents: 1140,
    segmentationConcepts: 6,
  },
};
