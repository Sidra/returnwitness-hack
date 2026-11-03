import type { KitConfig } from "@/data/kit.config";
import { DEFAULT_COUNTER_CONFIG, type TrayCounterConfig } from "./tray-counter";

/** Build the counter config from the kit file, with optional overrides (zones, thresholds). */
export function counterConfigForKit(kit: KitConfig, overrides: Partial<TrayCounterConfig> = {}): TrayCounterConfig {
  return {
    ...DEFAULT_COUNTER_CONFIG,
    items: kit.items.map((i) => ({
      key: i.key,
      concept: i.samConcept,
      expectedAreaFrac: i.expectedAreaFrac,
      requiresSerial: i.requiresSerial,
    })),
    handConcept: kit.handConcept,
    ignoreConcepts: kit.packingConcepts,
    ...overrides,
  };
}
