/**
 * "Return a box yourself" (/play): the visitor's bench state, and the mapping from that state to
 * the same CountResult the tray counter produces, so the REAL engine (reconcile,
 * calculateSettlement, refundBounds from lib/engine/reconcile.ts) can run on it in the browser.
 *
 * Pure and client-safe: no node built-ins, no network, no model. Everything the counter would
 * flag is mirrored from lib/vision/tray-counter.ts, and nothing is invented here:
 *   item left in the box     → not counted → the engine says MISSING (not_observed)
 *   look-alike item          → counted, its label carries another serial → HELD (serial_mismatch)
 *   label unreadable         → counted, no label read + a label_unreadable flag → HELD
 *   return date out of window→ a case-level policy hold (clause 1.1, outside_return_window): lines stay as
 *                              counted, the case holds, and a person checks the delivery date.
 *
 * `benchFor(scenario)` binds all of it to one setting (lib/play/scenarios.ts). The named exports below are the
 * camera kit's, the product's own setting.
 */
import type { KitItemConfig } from "@/data/kit.config";
import type { Arrival, BBox, CounterFlag, CountResult, Reconciliation, Rma } from "@/lib/domain/schemas";
import { calculateSettlement, reconcile, refundBounds, type Settlement } from "@/lib/engine/reconcile";
import { CAMERA, type PlayScenario } from "@/lib/play/scenarios";

export type Place = "box" | "tray";

export interface BenchState {
  /** Item keys in the inspected tray, in the order they were placed (that order is the arrival order). */
  tray: string[];
  /** Serialised items swapped for a look-alike carrying another serial. */
  standIns: string[];
  /** Serialised items whose serial label can't be read. */
  unreadable: string[];
  /** Return started outside the policy's return window (only offered where the setting has one). */
  late: boolean;
}

export interface Piece {
  key: string;
  name: string;
  sku: string;
  unitPriceCents: number;
  requiresSerial: boolean;
  /** What the label sticker says ("" when the item has no serial label). */
  labelText: string;
  isStandIn: boolean;
  labelUnreadable: boolean;
}

export interface Preset {
  id: string;
  label: string;
  state: BenchState;
}

export interface ReturnWindow {
  clauseId: string;
  limitDays: number;
  daysAfterShip: number;
  returnDate: string;
  outside: boolean;
  /** reconcile() checks clause 1.1 when given the policy (a case-level hold for a person). */
  checkedByEngine: true;
}

export interface BenchOutcome {
  count: CountResult;
  rma: Rma;
  recon: Reconciliation;
  settlement: Settlement;
  bounds: { fullCents: number; partialCents: number };
  /** Null in a setting with no return window. */
  window: ReturnWindow | null;
  /** One line per packing-slip line that isn't OK: "<item>: <engine reason>". */
  holdReasons: string[];
  /** True only when every line is OK: the one case where "Approve refund" is enabled. */
  approvable: boolean;
}

export const initialBench = (): BenchState => ({ tray: [], standIns: [], unreadable: [], late: false });

const toggleIn = (list: string[], key: string, on?: boolean) => {
  const has = list.includes(key);
  const want = on ?? !has;
  if (want === has) return list;
  return want ? [...list, key] : list.filter((k) => k !== key);
};

/* ---------- Keyboard (setting-independent) ---------- */

export type KeyIntent = "toggle" | "to_tray" | "to_box";

/**
 * What a key does on a focused item. Enter/Space toggle (the native button click does this);
 * Arrow Right sends the item to the tray and Arrow Left back to the box (the tray is on the right).
 */
export function keyIntent(key: string): KeyIntent | null {
  if (key === "Enter" || key === " " || key === "Spacebar") return "toggle";
  if (key === "ArrowRight") return "to_tray";
  if (key === "ArrowLeft") return "to_box";
  return null;
}

// Tray-zone placements, in frame coordinates (0..1), one per arrival order.
const TRAY_SPOTS: BBox[] = [
  [0.58, 0.18, 0.12, 0.12],
  [0.74, 0.2, 0.11, 0.11],
  [0.62, 0.5, 0.1, 0.1],
  [0.78, 0.52, 0.1, 0.1],
  [0.66, 0.74, 0.09, 0.09],
  [0.82, 0.76, 0.09, 0.09],
];
const FRAMES_PER_MOVE = 5;
const DAY_MS = 86_400_000;
const ON_TIME_DAYS = 19;
const LATE_DAYS = 45;

export function benchFor(sc: PlayScenario) {
  const ITEMS = sc.items;
  const SLIP = sc.slip;
  const serialised: KitItemConfig[] = ITEMS.filter((i) => i.requiresSerial);
  const isKitKey = (key: string) => ITEMS.some((i) => i.key === key);
  const isSerialised = (key: string) => serialised.some((i) => i.key === key);
  const slipSerial = (key: string) => SLIP.lines.find((l) => l.itemKey === key)?.serial ?? "";

  /** A look-alike wears a real serial from another order, never this slip's. */
  function standInSerial(item: KitItemConfig): string {
    const own = slipSerial(item.key);
    const other = [item.serials.missingCase, item.serials.complete].find((s) => s && s !== own);
    return other ?? `${own}-X`;
  }

  function pieceFor(item: KitItemConfig, s: BenchState): Piece {
    const isStandIn = item.requiresSerial && s.standIns.includes(item.key);
    return {
      key: item.key,
      name: isStandIn ? `Look-alike ${item.name.toLowerCase()}` : item.name,
      sku: item.sku,
      unitPriceCents: item.unitPriceCents,
      requiresSerial: item.requiresSerial,
      labelText: item.requiresSerial ? (isStandIn ? standInSerial(item) : slipSerial(item.key)) : "",
      isStandIn,
      labelUnreadable: item.requiresSerial && s.unreadable.includes(item.key),
    };
  }

  const pieces = (s: BenchState): Piece[] => ITEMS.map((i) => pieceFor(i, s));
  const placeOf = (s: BenchState, key: string): Place => (s.tray.includes(key) ? "tray" : "box");

  /** Move an item to a place (or to the other place when `to` is omitted). Unknown keys are ignored. */
  function moveItem(s: BenchState, key: string, to?: Place): BenchState {
    if (!isKitKey(key)) return s;
    const target = to ?? (placeOf(s, key) === "box" ? "tray" : "box");
    if (placeOf(s, key) === target) return s;
    return { ...s, tray: target === "tray" ? [...s.tray, key] : s.tray.filter((k) => k !== key) };
  }

  function setStandIn(s: BenchState, key: string, on?: boolean): BenchState {
    if (!isSerialised(key)) return s;
    return { ...s, standIns: toggleIn(s.standIns, key, on) };
  }

  function setUnreadable(s: BenchState, key: string, on?: boolean): BenchState {
    if (!isSerialised(key)) return s;
    return { ...s, unreadable: toggleIn(s.unreadable, key, on) };
  }

  /** Lateness exists only where the setting has a return window; elsewhere the state never turns late. */
  const setLate = (s: BenchState, late: boolean): BenchState => {
    const want = late && sc.windowClause != null;
    return s.late === want ? s : { ...s, late: want };
  };

  function applyKey(s: BenchState, itemKey: string, key: string): BenchState {
    const intent = keyIntent(key);
    if (!intent) return s;
    return moveItem(s, itemKey, intent === "toggle" ? undefined : intent === "to_tray" ? "tray" : "box");
  }

  const ALL = ITEMS.map((i) => i.key);
  const presets: Preset[] = sc.presets.map((p) => ({
    id: p.id,
    label: p.label,
    state: {
      ...initialBench(),
      tray: ALL.filter((k) => !(p.leftOut ?? []).includes(k)),
      standIns: [...(p.standIns ?? [])],
      unreadable: [...(p.unreadable ?? [])],
      late: !!p.late && sc.windowClause != null,
    },
  }));

  function benchToCount(s: BenchState): CountResult {
    const counts: Record<string, number> = {};
    for (const i of ITEMS) counts[i.key] = s.tray.includes(i.key) ? 1 : 0;

    const arrivals: Arrival[] = [];
    const flags: CounterFlag[] = [];
    const trackIdsPerSlot: Record<string, string[]> = {};
    const inTray = s.tray.filter(isKitKey);
    inTray.forEach((key, idx) => {
      const item = ITEMS.find((i) => i.key === key)!;
      const p = pieceFor(item, s);
      const t = idx + 1;
      const frameIndex = t * FRAMES_PER_MOVE;
      const bbox = TRAY_SPOTS[idx % TRAY_SPOTS.length];
      const slotId = `${key}-0`;
      trackIdsPerSlot[slotId] = [`play-${key}`];
      const readable = p.requiresSerial && !p.labelUnreadable;
      arrivals.push({
        slotId,
        itemKey: key,
        t,
        frameIndex,
        bbox,
        area: item.expectedAreaFrac,
        ...(readable ? { label: { text: p.labelText, confidence: 0.94 } } : {}),
      });
      // Mirrors the counter: a serialised item that settled without a readable label is flagged.
      if (p.requiresSerial && p.labelUnreadable) {
        flags.push({ code: "label_unreadable", itemKeys: [key], t, frameIndex, detail: "no label read for this item", bbox });
      }
    });

    const rawTrackIdsPerItem: Record<string, number> = {};
    for (const i of ITEMS) rawTrackIdsPerItem[i.key] = s.tray.includes(i.key) ? 1 : 0;

    return {
      clipId: sc.rma.clipId,
      counts,
      arrivals,
      flags,
      diagnostics: {
        framesProcessed: Math.max(1, inTray.length) * FRAMES_PER_MOVE,
        rawTrackIdsPerItem,
        trackIdsPerSlot,
        ignoredMasks: 0,
      },
    };
  }

  function returnWindow(late: boolean): ReturnWindow | null {
    if (!sc.windowClause || sc.windowDays == null) return null;
    const days = late ? LATE_DAYS : ON_TIME_DAYS;
    const returnDate = new Date(Date.parse(SLIP.shippedAt) + days * DAY_MS).toISOString();
    return { clauseId: sc.windowClause.id, limitDays: sc.windowDays, daysAfterShip: days, returnDate, outside: days > sc.windowDays, checkedByEngine: true };
  }

  function runBench(s: BenchState): BenchOutcome {
    const window = returnWindow(s.late);
    const rma: Rma = window ? { ...sc.rma, createdAt: window.returnDate } : sc.rma;
    const count = benchToCount(s);
    const recon = reconcile(rma, SLIP, count, sc.policy);
    const settlement = calculateSettlement(recon, rma);
    const bounds = refundBounds(recon, rma);
    const holdReasons = recon.lines
      .filter((l) => l.status !== "OK")
      .map((l) => {
        const r = l.reasons.find((x) => x.code !== "count_match") ?? l.reasons[0];
        return `${l.description}: ${r?.detail ?? l.status}`;
      })
      .concat((recon.policyHolds ?? []).map((h) => `Return window (clause ${h.clauseId}): ${h.detail}`));
    return { count, rma, recon, settlement, bounds, window, holdReasons, approvable: recon.summary.allClear };
  }

  return {
    scenario: sc,
    slip: SLIP,
    rma: sc.rma,
    serialised,
    presets,
    standInSerial,
    pieceFor,
    pieces,
    placeOf,
    moveItem,
    setStandIn,
    setUnreadable,
    setLate,
    applyKey,
    benchToCount,
    returnWindow,
    runBench,
  };
}

export type Bench = ReturnType<typeof benchFor>;

/** A short sentence for the live region after each change. */
export function announce(o: BenchOutcome, formatMoney: (c: number) => string, noun = "refund"): string {
  if (o.approvable) return `Every line is OK. A person can approve the full ${formatMoney(o.bounds.fullCents)} ${noun}.`;
  const lines = o.recon.lines.filter((l) => l.status !== "OK").map((l) => `${l.description} ${l.status.toLowerCase()}`).concat((o.recon.policyHolds ?? []).map(() => "the return window needs a person's check"));
  const partial = o.settlement.options.find((x) => x.key === "partial");
  const partialText = partial?.available ? ` A partial ${noun} of ${formatMoney(partial.refundCents)} is the most a person could approve without an override.` : "";
  return `Held: ${lines.join(", ")}.${partialText}`;
}

/* ---------- The camera kit (the product's own setting) ---------- */

const camera = benchFor(CAMERA);

export const PLAY_SLIP = camera.slip;
export const PLAY_RMA: Rma = camera.rma;
/** Clause 1.1: "Items may be returned within 30 days of delivery." */
export const RETURN_WINDOW_DAYS = CAMERA.windowDays!;
export const WINDOW_CLAUSE = CAMERA.windowClause!;
export const SERIALISED_ITEMS = camera.serialised;
export const PRESETS = camera.presets;
export const { standInSerial, pieceFor, pieces, placeOf, moveItem, setStandIn, setUnreadable, setLate, applyKey, benchToCount, runBench } = camera;
export const returnWindow = (late: boolean): ReturnWindow => camera.returnWindow(late)!;
