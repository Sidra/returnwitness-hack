/**
 * The settings /play (camera) and /play/walker can run, each a complete input to the SAME engine (reconcile, calculateSettlement):
 * a kit, a slip, a return, a policy, and the words the page uses for "money back".
 *
 *   camera  the product: an online store's camera-kit return (data/kit.config.ts, data/fixtures.ts)
 *   walker  ADR-009's higher-impact setting: a walker coming back to a mobility-equipment loan closet.
 *           An illustration of the same engine, not a second product: no pilot, partner or measured result
 *           exists, the deposit and part prices are illustrative, and it never judges whether equipment is
 *           safe or suitable for anyone. It only records which parts came back.
 */
import { KIT, type KitItemConfig } from "@/data/kit.config";
import { FIXTURE_LABEL, MERCHANT, ORDERS, POLICY, RMAS } from "@/data/fixtures";
import type { PackingSlip, Policy, PolicyClause, Rma } from "@/lib/domain/schemas";

export type ScenarioId = "camera" | "walker";

/** The trick a preset applies to one item (or the whole return). */
export interface PresetSpec {
  id: string;
  label: string;
  /** Items left in the box (everything else is in the tray). */
  leftOut?: string[];
  standIns?: string[];
  unreadable?: string[];
  late?: boolean;
}

export interface ScenarioCopy {
  /** Eyebrow over the bench: who runs it and what comes back. */
  operator: string;
  /** Header of the two refund cells and the approve button. */
  fullLabel: string;
  partialLabel: string;
  /** Why the partial amount is what it is, in this setting's words. */
  partialWhy: string;
  /** What the printed label is called here ("serial", "asset tag"), and the look-alike trick's wording. */
  labelNoun: string;
  lookAlike: string;
  approveVerb: string;
  /** What a complete box means here, in one sentence. */
  completeLine: string;
  /** Plain names for the engine's three settlement options. */
  options: { full_hold: string; partial: string; full_refund: string };
  /** What would happen after a person approves (no call is made from /play). */
  nextSteps: (amount: string) => string[];
  /** Label shown under the bench: fixture or illustration, never a claim of a real customer. */
  fixtureLabel: string;
  /** A hard limit shown on the page, or null. */
  hardLimit: string | null;
}

export interface PlayScenario {
  id: ScenarioId;
  /** Tab label. */
  name: string;
  kitName: string;
  items: KitItemConfig[];
  slip: PackingSlip;
  rma: Rma;
  policy: Policy;
  /** The return-window clause, when the setting has one ("returned late" is offered only then). */
  windowClause: PolicyClause | null;
  windowDays: number | null;
  presets: PresetSpec[];
  copy: ScenarioCopy;
}

/* ---------- camera: the product ---------- */

const CAMERA_ORDER = ORDERS[1];
const CAMERA_WINDOW = POLICY.clauses.find((c) => c.id === "1.1")!;

export const CAMERA: PlayScenario = {
  id: "camera",
  name: "Camera kit · online store",
  kitName: KIT.kitName,
  items: KIT.items,
  slip: CAMERA_ORDER.slip,
  rma: { ...RMAS[1], id: "RMA-PLAY", clipId: "play-visitor-bench", scenario: "a visitor at the bench" },
  policy: POLICY,
  windowClause: CAMERA_WINDOW,
  windowDays: 30,
  presets: [
    { id: "complete", label: "Complete box" },
    { id: "lens_left", label: "Lens left in the box", leftOut: ["lens"] },
    { id: "stand_in", label: "Look-alike lens", standIns: ["lens"] },
    { id: "unreadable", label: "Unreadable label", unreadable: ["lens"] },
    { id: "late", label: "Returned late", late: true },
  ],
  copy: {
    operator: `${MERCHANT.name} · ${KIT.kitName}`,
    fullLabel: "Full refund · clause 4.2",
    partialLabel: "Partial · clause 4.3",
    partialWhy: "Kit price less every line that is missing or unclear (clause 4.3).",
    labelNoun: "serial",
    lookAlike: "Swap in a look-alike",
    approveVerb: "Approve refund",
    completeLine: "Every line on the packing slip is in the tray and every serial label matches. It still waits for a person.",
    options: { full_hold: "Keep the full refund on hold", partial: "Refund what was seen, hold the rest", full_refund: "Refund in full" },
    nextSteps: (amount) => [
      `The person's approval issues a single-use token, signed and bound to this exact count, this return and ${amount}. It expires in 10 minutes.`,
      "The refund endpoint accepts that token and nothing else, and spends it once.",
      `A Stripe test-mode refund of ${amount} runs on the seeded charge. No real funds move.`,
    ],
    fixtureLabel: `${FIXTURE_LABEL} · order ${CAMERA_ORDER.slip.orderId}`,
    hardLimit: null,
  },
};

/* ---------- walker: ADR-009's loan closet ---------- */

const WALKER_ITEMS: KitItemConfig[] = [
  {
    key: "walker_frame",
    name: "Walker frame",
    sku: "LC-WALK-FR",
    unitPriceCents: 4500,
    samConcept: "folding walker frame", genericName: "folding walker frame",
    requiresSerial: true,
    serials: { complete: "LC-WF-0417", missingCase: "LC-WF-0388" },
    expectedAreaFrac: 0.08,
  },
  { key: "tip_rear_left", name: "Rubber tip, rear left", sku: "LC-TIP-25", unitPriceCents: 400, samConcept: "rubber walker tip", genericName: "rubber walker tip", requiresSerial: false, serials: { complete: "", missingCase: "" }, expectedAreaFrac: 0.002 },
  { key: "tip_rear_right", name: "Rubber tip, rear right", sku: "LC-TIP-25", unitPriceCents: 400, samConcept: "rubber walker tip", genericName: "rubber walker tip", requiresSerial: false, serials: { complete: "", missingCase: "" }, expectedAreaFrac: 0.002 },
  { key: "glide_front_left", name: "Glide, front left", sku: "LC-GLD-25", unitPriceCents: 600, samConcept: "walker glide cap", genericName: "walker glide cap", requiresSerial: false, serials: { complete: "", missingCase: "" }, expectedAreaFrac: 0.003 },
  { key: "glide_front_right", name: "Glide, front right", sku: "LC-GLD-25", unitPriceCents: 600, samConcept: "walker glide cap", genericName: "walker glide cap", requiresSerial: false, serials: { complete: "", missingCase: "" }, expectedAreaFrac: 0.003 },
];

const WALKER_DEPOSIT_CENTS = WALKER_ITEMS.reduce((s, i) => s + i.unitPriceCents, 0);

/** No return-window clause: a late loan is still wanted back, so lateness never holds the parts check. */
export const LOAN_POLICY: Policy = {
  id: "pol_loan_closet_illustration",
  merchant: "Neighbourhood equipment loan closet (illustration)",
  version: "illustration-1",
  effective: "2026-10-29",
  clauses: [
    { id: "2.1", title: "Parts check", text: "Every returned item is unpacked at the bench and each part on the loan record is checked back in." },
    { id: "4.1", title: "Loan record", text: "Each part lent with an item is listed as its own line on the loan record." },
    { id: "4.2", title: "Back on the shelf", text: "An item is marked ready to re-lend, and the deposit returned, only when every part on the loan record is back." },
    {
      id: "4.3",
      title: "Missing parts",
      text: "When a part is missing, the item stays off the shelf for review. A volunteer may return the deposit less the replacement cost of each missing part.",
    },
    { id: "4.4", title: "Asset tags", text: "A tagged item must carry the asset tag recorded on the loan record." },
    { id: "5.1", title: "Holds are not penalties", text: "A hold keeps the item off the shelf; it is not a charge. The borrower is told what was not seen and may bring the part back." },
    {
      id: "7.1",
      title: "Not a safety check",
      text: "This check records which parts came back. It does not judge whether equipment is safe or suitable for anyone; the closet's own safety check still applies before anything is re-lent.",
    },
  ],
};

const WALKER_SLIP: PackingSlip = {
  orderId: "LOAN-0417",
  shippedAt: "2026-09-14T16:00:00Z",
  lines: WALKER_ITEMS.map((i) => ({
    itemKey: i.key,
    sku: i.sku,
    description: i.name,
    qty: 1,
    unitPriceCents: i.unitPriceCents,
    requiresSerial: i.requiresSerial,
    ...(i.requiresSerial ? { serial: i.serials.complete } : {}),
  })),
};

export const WALKER: PlayScenario = {
  id: "walker",
  name: "Walker · loan closet",
  kitName: "Folding walker",
  items: WALKER_ITEMS,
  slip: WALKER_SLIP,
  rma: {
    id: "RET-PLAY",
    orderId: WALKER_SLIP.orderId,
    customer: { name: "A borrower", email: "borrower@example.com" },
    reason: "Finished with it, thanks.",
    requestedRefundCents: WALKER_DEPOSIT_CENTS,
    createdAt: "2026-10-28T11:00:00Z",
    clipId: "play-visitor-bench-walker",
    scenario: "a walker back at a loan closet",
  },
  policy: LOAN_POLICY,
  windowClause: null,
  windowDays: null,
  presets: [
    { id: "complete", label: "Every part back" },
    { id: "tip_left", label: "A rubber tip left in the box", leftOut: ["tip_rear_left"] },
    { id: "stand_in", label: "Another closet's walker", standIns: ["walker_frame"] },
    { id: "unreadable", label: "Asset tag unreadable", unreadable: ["walker_frame"] },
  ],
  copy: {
    operator: "A loan closet · folding walker · illustration",
    fullLabel: "Ready to re-lend · deposit back · clause 4.2",
    partialLabel: "Deposit less missing parts · clause 4.3",
    partialWhy: "Deposit less the replacement cost of every part that is missing or unclear (clause 4.3).",
    labelNoun: "asset tag",
    lookAlike: "Another closet's walker",
    approveVerb: "Mark ready to re-lend",
    completeLine: "Every part on the loan record is back and the asset tag matches. Parts present only: the closet's own safety check still comes next.",
    options: { full_hold: "Keep it off the shelf, deposit held", partial: "Return the deposit less the missing parts", full_refund: "Back on the shelf, deposit returned" },
    nextSteps: (amount) => [
      "A volunteer's sign-off is recorded against this exact parts count and this asset tag.",
      `The deposit of ${amount} goes back to the borrower. In the product this uses the same single-use token as a refund.`,
      "The closet's own safety check runs before the walker is lent again. This page never judges safety.",
    ],
    fixtureLabel: "[Illustration · same engine, made-up loan record and prices; no closet, pilot or partner]",
    hardLimit: LOAN_POLICY.clauses.find((c) => c.id === "7.1")!.text,
  },
};

export const SCENARIOS: Record<ScenarioId, PlayScenario> = { camera: CAMERA, walker: WALKER };
export const scenarioById = (id: string | undefined | null): PlayScenario => (id === "walker" ? WALKER : CAMERA);
