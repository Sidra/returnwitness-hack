/**
 * The ONE place the demo kit is defined. The packing slip, RMA fixtures, SAM concept
 * prompts, printed labels and the gate manifest's item keys all derive from this file.
 *
 * Physical kit: Kodak EC35 film camera (powder blue),
 * a black zoom-lens replica mug lying on its side, an NP-FW50 dual charger with both batteries
 * clicked in. Areas are estimates until calibrated from clip g1.
 *
 * To film a different kit, change names, SKUs, prices,
 * prompts and serials here only. Keep the three `key`s stable (camera_body, lens, battery)
 * unless gate/manifest.json is regenerated too.
 */

export interface KitItemConfig {
  /** Stable machine key, used by the counter, manifest and tests. */
  key: string;
  /** What the returns worker and the judge read. */
  name: string;
  sku: string;
  unitPriceCents: number;
  /**
   * Text concept sent to SAM 3.1: the words SAM finds this SKU by on this bench. Per-SKU store config, like the price;
   * it describes what the camera sees, which for a stand-in prop may not be the product's own name (see camera_body).
   */
  samConcept: string;
  /** Generic product noun for people and the illustration ("film camera"); never sent to SAM. */
  genericName: string;
  /** Serial printed on the label sticker; the line needs a readable label when true. */
  requiresSerial: boolean;
  serials: { complete: string; missingCase: string };
  /**
   * Expected mask area as a fraction of the 720p frame when the item lies in the tray.
   * Used only to flag merged masks. Estimates until calibrated from g1 (see gate/CLIP-SPEC.md).
   */
  expectedAreaFrac: number;
}

export interface KitConfig {
  kitName: string;
  kitSku: string;
  merchantName: string;
  items: KitItemConfig[];
  /** Concepts the counter must ignore (never counted, but used for occlusion). */
  handConcept: string;
  packingConcepts: string[];
}

export const KIT: KitConfig = {
  kitName: "Creator Kit",
  kitSku: "CK-16-STARTER",
  merchantName: "Brindlewood Camera Co.",
  items: [
    {
      key: "camera_body",
      name: "Camera body",
      sku: "CK-BODY-01",
      unitPriceCents: 19900,
      // "film camera" and "camera" found nothing on the stand-in prop (its label sticker covers the top) on the first
      // g1 take; "mint green object" tracked it. Chosen on g1, the calibration clip (RULE.md, addendum 2).
      samConcept: "mint green object",
      genericName: "film camera",
      requiresSerial: true,
      serials: { complete: "BW-CB-55120", missingCase: "BW-CB-55107" },
      // Kodak EC35 (powder blue) lying on its back, ~12 x 7 cm, in a ~150 x 84 cm frame.
      expectedAreaFrac: 0.0067,
    },
    {
      key: "lens",
      name: "Zoom lens",
      sku: "CK-LENS-24105",
      unitPriceCents: 10900,
      samConcept: "camera lens",
      genericName: "camera lens",
      requiresSerial: true,
      serials: { complete: "BW-LN-80311", missingCase: "BW-LN-80298" },
      // Lens-replica mug on its side, ~11 x 9 cm.
      expectedAreaFrac: 0.0079,
    },
    {
      key: "battery",
      name: "Battery + charger",
      sku: "CK-BATT-CHG",
      unitPriceCents: 3200,
      // "battery charger" and "charger" found nothing on the first g1 take; "battery" tracked it (same addendum).
      samConcept: "battery",
      genericName: "battery charger",
      requiresSerial: false,
      serials: { complete: "", missingCase: "" },
      // NP-FW50 dual charger with both batteries in, one object, ~9 x 6 cm.
      expectedAreaFrac: 0.0043,
    },
  ],
  handConcept: "hand",
  packingConcepts: ["kraft paper", "cardboard box"],
};

/** Stable id for files derived from this kit (e.g. the generated illustration). */
export const KIT_ID = KIT.kitSku.toLowerCase();

export const KIT_TOTAL_CENTS = KIT.items.reduce((s, i) => s + i.unitPriceCents, 0);
export const kitItem = (key: string): KitItemConfig | undefined => KIT.items.find((i) => i.key === key);
