/**
 * Tray-zone counter (spec §3 hole 1).
 *
 * An item counts when its mask first SETTLES inside the "inspected tray" region. Identity
 * comes from where an item settled (a slot), never from the segmenter's track IDs, so a
 * hand covering an item, SAM re-issuing a new ID, or an item lifted and put back cannot add
 * a second count. Raw track IDs are only recorded in diagnostics (the gate's fragmentation
 * metric). Anything the counter can't resolve becomes a HOLD flag, never a guess.
 *
 * Merges keep identity: while one mask swallows two counted items, their slots are held as
 * occluded (not lifted), so the merged mask can't settle as a new item and the split can't add
 * a second count. A merge that splits back into every item seen on its own, at its own spot, at
 * its own size, for a settle window is downgraded to `merge_resolved`; one that never splits
 * stays a `merged_mask` HOLD.
 */
import {
  HOLDING_FLAGS,
  type Arrival,
  type BBox,
  type CountResult,
  type CounterFlag,
  type FlagCode,
  type Frame,
  type LabelRead,
  type Mask,
} from "@/lib/domain/schemas";
import { boxArea, centroid, coverage, dist, inZone, iou, type Zone } from "./geometry";

export interface CounterItem {
  key: string;
  concept: string;
  expectedAreaFrac: number;
  requiresSerial: boolean;
}

export interface TrayCounterConfig {
  trayZone: Zone;
  boxZone: Zone;
  items: CounterItem[];
  handConcept: string;
  ignoreConcepts: string[];
  /** Consecutive frames in the tray, nearly still, before a mask counts as settled (5 fps → 3 = 0.6 s). */
  settleFrames: number;
  /** Max centroid movement between frames (normalised) while settling. */
  settleMotion: number;
  /** IoU at which a settled mask is the same slot. */
  slotIoU: number;
  /** Frames a slot may be empty with no hand over it before it counts as lifted. */
  liftGraceFrames: number;
  /** Frames a slot may stay covered by a hand before an informational flag. */
  longOcclusionFrames: number;
  /** A settled mask at least this many times its expected area is a merge. */
  mergeAreaRatio: number;
  /** A re-placed item matches a lifted slot when its area is within this relative tolerance. */
  liftAreaTolerance: number;
  /** Fraction of a slot a hand must cover to count as occluding it. */
  handCoverage: number;
  /** Fraction of a mask a hand must cover to count as still gripping it (no settle while gripped). */
  gripCoverage: number;
  /** Minimum label confidence for a readable serial. */
  labelMinConfidence: number;
  /**
   * Check serial labels here only when the segmenter supplies label reads (fixtures do; SAM 3.1
   * doesn't read text). With live SAM the reader model reads the labels and the cross-check holds
   * any serial line it can't read.
   */
  checkLabels: boolean;
  /** Frames an item must be seen outside the tray to flag it as seen but never placed. */
  seenNotPlacedFrames: number;
  /**
   * Fallback rule (after-kickoff decision): while ANY hand mask overlaps the tray zone, nothing can
   * settle. Off by default; turned on if the gate shows hands near the tray still split counts.
   */
  handBlocksTray: boolean;
}

export const DEFAULT_COUNTER_CONFIG: Omit<TrayCounterConfig, "items" | "handConcept" | "ignoreConcepts"> = {
  boxZone: { x0: 0.0, y0: 0.0, x1: 0.45, y1: 1.0 },
  trayZone: { x0: 0.55, y0: 0.0, x1: 1.0, y1: 1.0 },
  settleFrames: 3,
  settleMotion: 0.02,
  slotIoU: 0.3,
  liftGraceFrames: 3,
  longOcclusionFrames: 25,
  // Charger + camera merged is ~1.64x the camera alone, so the ratio has to sit below that.
  mergeAreaRatio: 1.4,
  liftAreaTolerance: 0.4,
  handCoverage: 0.2,
  gripCoverage: 0.6,
  labelMinConfidence: 0.6,
  checkLabels: true,
  seenNotPlacedFrames: 3,
  handBlocksTray: false,
};

type SlotState = "present" | "occluded" | "lifted";

interface Slot {
  id: string;
  itemKey: string;
  bbox: BBox;
  area: number;
  state: SlotState;
  emptyFrames: number;
  occludedFrames: number;
  longOcclusionFlagged: boolean;
  liftedAtFrame: number | null;
  trackIds: Set<string>;
  bestLabel: LabelRead | undefined;
  /** The oversized mask this item sits inside (or is), and the HOLD raised for it, until it splits. */
  mergeBox: BBox | null;
  mergeFlag: number | null;
}

/** One merge of counted items: which slots, and whether every one was later seen on its own again. */
interface MergeEvent {
  id: number;
  slotIds: Set<string>;
  cleanStreak: number;
  resolvedFrame: number | null;
  /** Split of an oversized mask: items that settle back inside this box join the event. */
  box: BBox | null;
}

interface Pending {
  itemKey: string;
  bbox: BBox;
  area: number;
  streak: number;
  trackIds: Set<string>;
  label: LabelRead | undefined;
  matched: boolean;
}

const betterLabel = (a: LabelRead | undefined, b: LabelRead | undefined): LabelRead | undefined => {
  if (!a) return b;
  if (!b) return a;
  return b.confidence > a.confidence ? b : a;
};

export class TrayCounter {
  private readonly cfg: TrayCounterConfig;
  private readonly conceptToKey = new Map<string, string>();
  private readonly itemByKey = new Map<string, CounterItem>();
  private readonly ignore: Set<string>;
  private slots: Slot[] = [];
  private pending: Pending[] = [];
  private flags: CounterFlag[] = [];
  private arrivals: Arrival[] = [];
  private flagKeys = new Set<string>();
  private rawIds = new Map<string, Set<string>>();
  private outsideStreak = new Map<string, number>();
  private seenOutside = new Set<string>();
  /** Frames each item's mask was seen at all, and inside the tray (not necessarily consecutive). */
  private seenFrames = new Map<string, number>();
  private trayFrames = new Map<string, number>();
  private ignoredMasks = 0;
  private frames = 0;
  private lastFrame: Frame | null = null;
  private slotSeq = 0;
  private merges: MergeEvent[] = [];
  /** Flag index → the merge events it was raised for. A flag raised outside a merge event never resolves. */
  private flagMerges = new Map<number, Set<number>>();
  private unresolvableFlags = new Set<number>();
  private matchedThisFrame = new Set<string>();

  constructor(cfg: TrayCounterConfig) {
    if (cfg.settleFrames < 1) throw new Error("settleFrames must be >= 1");
    this.cfg = cfg;
    for (const it of cfg.items) {
      this.conceptToKey.set(norm(it.concept), it.key);
      this.conceptToKey.set(norm(it.key), it.key);
      this.itemByKey.set(it.key, it);
    }
    this.ignore = new Set(cfg.ignoreConcepts.map(norm));
  }

  /** Process one frame. Frames must arrive in order. */
  push(frame: Frame): void {
    if (this.lastFrame && frame.index <= this.lastFrame.index) {
      throw new Error(`frames out of order: ${frame.index} after ${this.lastFrame.index}`);
    }
    this.frames++;
    const hands: BBox[] = [];
    const items: Array<{ key: string; m: Mask }> = [];
    for (const m of frame.masks) {
      const c = norm(m.concept);
      if (c === norm(this.cfg.handConcept)) {
        hands.push(m.bbox);
        continue;
      }
      const key = this.conceptToKey.get(c);
      if (!key || this.ignore.has(c)) {
        this.ignoredMasks++;
        continue;
      }
      const ids = this.rawIds.get(key) ?? new Set<string>();
      ids.add(String(m.trackId));
      this.rawIds.set(key, ids);
      items.push({ key, m });
    }

    for (const k of new Set(items.map((x) => x.key))) this.seenFrames.set(k, (this.seenFrames.get(k) ?? 0) + 1);
    const trayItems = items.filter(({ m }) => inZone(centroid(m.bbox), this.cfg.trayZone));
    for (const k of new Set(trayItems.map((x) => x.key))) this.trayFrames.set(k, (this.trayFrames.get(k) ?? 0) + 1);
    const outsideItems = items.filter(({ m }) => !inZone(centroid(m.bbox), this.cfg.trayZone));
    this.trackOutside(outsideItems.map((x) => x.key));

    this.updateSlots(frame, trayItems, hands);
    this.updatePending(frame, trayItems, hands);
    this.lastFrame = frame;
  }

  /** Finish the clip and return the count. */
  finish(clipId: string): CountResult {
    const last = this.lastFrame;
    const t = last?.t ?? 0;
    const fi = last?.index ?? 0;
    for (const s of this.slots) {
      if (s.state === "lifted") {
        this.flag("left_tray", [s.itemKey], t, fi, `${s.itemKey} settled in the tray, then left it and did not come back`, s.bbox);
      }
    }
    for (const s of this.slots) {
      const item = this.itemByKey.get(s.itemKey);
      if (this.cfg.checkLabels && item?.requiresSerial) {
        const l = s.bestLabel;
        if (!l || !l.text.trim() || l.confidence < this.cfg.labelMinConfidence) {
          this.flag(
            "label_unreadable",
            [s.itemKey],
            t,
            fi,
            l ? `best label read "${l.text}" at confidence ${l.confidence.toFixed(2)}` : "no label read for this item",
            s.bbox,
          );
        }
      }
    }
    // Seen but never counted is never a silent "missing": an item whose mask showed up on enough
    // frames (anywhere, not only in a run outside the tray) and never settled holds its line.
    for (const it of this.cfg.items) {
      if (this.slots.some((s) => s.itemKey === it.key)) continue;
      const seen = this.seenFrames.get(it.key) ?? 0;
      const inTray = this.trayFrames.get(it.key) ?? 0;
      if (this.seenOutside.has(it.key)) this.flag("seen_not_placed", [it.key], t, fi, `${it.key} was seen outside the tray but never settled in it`);
      else if (seen >= this.cfg.seenNotPlacedFrames)
        this.flag("seen_not_placed", [it.key], t, fi, inTray ? `${it.key} was seen in the tray on ${inTray} frames but never held still long enough to count` : `${it.key} was seen on ${seen} frames but never settled in the tray`);
    }

    this.resolveMergeFlags();

    const counts: Record<string, number> = {};
    for (const it of this.cfg.items) counts[it.key] = this.slots.filter((s) => s.itemKey === it.key).length;
    const rawTrackIdsPerItem: Record<string, number> = {};
    for (const it of this.cfg.items) rawTrackIdsPerItem[it.key] = this.rawIds.get(it.key)?.size ?? 0;
    const trackIdsPerSlot: Record<string, string[]> = {};
    for (const s of this.slots) trackIdsPerSlot[s.id] = [...s.trackIds].sort();
    const arrivals = this.arrivals.map((a) => {
      const s = this.slots.find((x) => x.id === a.slotId);
      return s?.bestLabel ? { ...a, label: s.bestLabel } : a;
    });
    return {
      clipId,
      counts,
      arrivals,
      flags: this.flags,
      diagnostics: {
        framesProcessed: this.frames,
        rawTrackIdsPerItem,
        trackIdsPerSlot,
        ignoredMasks: this.ignoredMasks,
      },
    };
  }

  /* ---------------- internals ---------------- */

  private trackOutside(keys: string[]): void {
    const present = new Set(keys);
    for (const it of this.cfg.items) {
      const n = present.has(it.key) ? (this.outsideStreak.get(it.key) ?? 0) + 1 : 0;
      this.outsideStreak.set(it.key, n);
      if (n >= this.cfg.seenNotPlacedFrames) this.seenOutside.add(it.key);
    }
  }

  private updateSlots(frame: Frame, trayItems: Array<{ key: string; m: Mask }>, hands: BBox[]): void {
    this.matchedThisFrame.clear();
    const mergerSeen = new Set<number>();
    for (const s of this.slots) {
      if (s.state === "lifted") continue;
      const match = trayItems.find(({ key, m }) => key === s.itemKey && iou(m.bbox, s.bbox) >= this.cfg.slotIoU);
      if (match) {
        const swallowed = this.slots.filter((o) => o !== s && o.state !== "lifted" && coverage(o.bbox, match.m.bbox) >= 0.5);
        if (swallowed.length > 0) {
          // The swallowed items are still physically there; don't let them drift to "lifted".
          mergerSeen.add(this.noteMerge(frame, [s, ...swallowed], match.m.bbox, `the ${s.itemKey} mask now also covers ${swallowed.map((o) => o.itemKey).join(", ")}`, match.m.area).ev);
          for (const o of swallowed) {
            o.emptyFrames = 0;
            o.state = "occluded";
          }
        } else {
          const over = this.checkOversize(frame, s.itemKey, match.m.area, match.m.bbox);
          // Its own mask grew over something not yet counted: remember the latest box so the split can resolve it.
          if (over !== null && (this.unresolvableFlags.has(over) || s.mergeFlag === over)) {
            s.mergeBox = match.m.bbox;
            s.mergeFlag = over;
          }
          // Back at its own spot at normal size after sitting inside an oversized mask: the merge split.
          if (over === null && s.mergeBox) this.startSplit(s);
          // Seen on its own, at its spot, at its size: evidence a merge has split back.
          if (Math.abs(match.m.area - s.area) <= this.cfg.liftAreaTolerance * Math.max(s.area, 1e-9)) this.matchedThisFrame.add(s.id);
        }
        s.state = "present";
        s.emptyFrames = 0;
        s.occludedFrames = 0;
        s.trackIds.add(String(match.m.trackId));
        s.bestLabel = betterLabel(s.bestLabel, match.m.label);
        continue;
      }
      // No mask at this spot, but a merged mask swallows it (and another counted item): the item
      // is still there, inside the merge. Without this the slot lifts and the merge settles as new.
      const merger = trayItems.find(
        ({ key, m }) => coverage(s.bbox, m.bbox) >= 0.5 && (this.coveredSlots(m.bbox).length >= 2 || (key === s.itemKey && s.mergeBox != null && iou(m.bbox, s.mergeBox) >= this.cfg.slotIoU)),
      );
      if (merger) {
        const covered = this.coveredSlots(merger.m.bbox);
        if (covered.length >= 2) mergerSeen.add(this.noteMerge(frame, covered, merger.m.bbox, `one ${merger.key} mask covers ${covered.map((o) => o.itemKey).join(", ")}`, merger.m.area).ev);
        s.state = "occluded";
        s.emptyFrames = 0;
        continue;
      }
      const handOver = hands.some((h) => coverage(s.bbox, h) >= this.cfg.handCoverage);
      if (handOver) {
        s.state = "occluded";
        s.occludedFrames++;
        if (s.occludedFrames >= this.cfg.longOcclusionFrames && !s.longOcclusionFlagged) {
          s.longOcclusionFlagged = true;
          this.flag("occlusion_long", [s.itemKey], frame.t, frame.index, `${s.itemKey} covered by a hand for ${s.occludedFrames} frames`, s.bbox);
        }
        continue;
      }
      s.emptyFrames++;
      if (s.emptyFrames >= this.cfg.liftGraceFrames) {
        s.state = "lifted";
        s.liftedAtFrame = frame.index;
      }
    }
    this.advanceMerges(frame, mergerSeen);
  }

  /** Non-lifted slots a mask covers by at least half. */
  private coveredSlots(bbox: BBox): Slot[] {
    return this.slots.filter((o) => o.state !== "lifted" && coverage(o.bbox, bbox) >= 0.5);
  }

  /**
   * Record (or extend) a merge of these slots and raise its HOLD; returns the event id and the flag index.
   * If the mask is bigger than the counted items under it explain, anything not yet counted that fits in
   * the rest may be inside too: that gets its own HOLD, which never resolves.
   */
  private noteMerge(frame: Frame, slots: Slot[], bbox: BBox, detail: string, area?: number): { ev: number; flag: number } {
    if (area != null) {
      const keys = uniq(slots.map((s) => s.itemKey));
      const rest = area - keys.reduce((sum, k) => sum + (this.itemByKey.get(k)?.expectedAreaFrac ?? 0), 0);
      const hidden = this.cfg.items.filter((it) => !keys.includes(it.key) && !this.slots.some((s) => s.itemKey === it.key && s.state !== "lifted") && rest >= 0.5 * it.expectedAreaFrac);
      if (hidden.length) this.flag("merged_mask", [...keys, ...hidden.map((it) => it.key)], frame.t, frame.index, `${detail}; the mask is larger than those items, so ${hidden.map((it) => it.key).join(", ")} may be inside`, bbox, true);
    }
    let ev = this.merges.find((e) => e.resolvedFrame == null && slots.some((s) => e.slotIds.has(s.id)));
    if (!ev) {
      ev = { id: this.merges.length + 1, slotIds: new Set(), cleanStreak: 0, resolvedFrame: null, box: null };
      this.merges.push(ev);
    }
    for (const s of slots) ev.slotIds.add(s.id);
    ev.cleanStreak = 0;
    const i = this.flag("merged_mask", uniq(slots.map((s) => s.itemKey)), frame.t, frame.index, detail, bbox);
    if (!this.unresolvableFlags.has(i)) this.flagMerges.set(i, new Set([...(this.flagMerges.get(i) ?? []), ev.id]));
    return { ev: ev.id, flag: i };
  }

  /** An oversized mask split: track the item and everything that settles back inside the old box. */
  private startSplit(s: Slot): void {
    const box = s.mergeBox!;
    const ev: MergeEvent = { id: this.merges.length + 1, slotIds: new Set([s.id]), cleanStreak: 0, resolvedFrame: null, box };
    for (const o of this.slots) if (o !== s && o.state !== "lifted" && coverage(o.bbox, box) >= 0.5) ev.slotIds.add(o.id);
    this.merges.push(ev);
    if (s.mergeFlag != null) {
      this.unresolvableFlags.delete(s.mergeFlag);
      this.flagMerges.set(s.mergeFlag, new Set([...(this.flagMerges.get(s.mergeFlag) ?? []), ev.id]));
    }
    s.mergeBox = null;
    s.mergeFlag = null;
  }

  /** A slot that (re)settles inside an open split's box is one of the items that came out of it. */
  private joinSplits(s: Slot): void {
    for (const ev of this.merges) if (ev.box && ev.resolvedFrame == null && coverage(s.bbox, ev.box) >= 0.5) ev.slotIds.add(s.id);
  }

  /** A merge resolves once every slot in it is seen on its own for a settle window with no merged mask over them. */
  private advanceMerges(frame: Frame, mergerSeen: Set<number>): void {
    for (const ev of this.merges) {
      if (ev.resolvedFrame != null) continue;
      // A split must show at least two items on their own; one item shrinking back proves nothing about the other.
      const allSeen = ev.slotIds.size >= 2 && [...ev.slotIds].every((id) => this.matchedThisFrame.has(id));
      ev.cleanStreak = !mergerSeen.has(ev.id) && allSeen ? ev.cleanStreak + 1 : 0;
      if (ev.cleanStreak >= this.cfg.settleFrames) ev.resolvedFrame = frame.index;
    }
  }

  /** Merge HOLDs whose every merge split back cleanly become informational. */
  private resolveMergeFlags(): void {
    this.flags = this.flags.map((f, i) => {
      const evs = this.flagMerges.get(i);
      if (f.code !== "merged_mask" || !evs || this.unresolvableFlags.has(i)) return f;
      const done = [...evs].map((id) => this.merges.find((e) => e.id === id)!);
      if (!done.every((e) => e.resolvedFrame != null)) return f;
      const at = Math.max(...done.map((e) => e.resolvedFrame!));
      return { ...f, code: "merge_resolved" as const, detail: `${f.detail}; resolved at frame ${at}: each item seen again on its own, at its spot and size` };
    });
  }

  private updatePending(frame: Frame, trayItems: Array<{ key: string; m: Mask }>, hands: BBox[]): void {
    for (const p of this.pending) p.matched = false;
    if (this.cfg.handBlocksTray && hands.some((h) => this.handInTray(h))) {
      // A hand is over the tray: every settle restarts once it has left.
      this.pending = [];
      return;
    }
    for (const { key, m } of trayItems) {
      // An item still gripped by a hand hasn't been set down yet.
      if (hands.some((h) => coverage(m.bbox, h) >= this.cfg.gripCoverage)) continue;
      // Masks already explained by a present slot don't start a new settle.
      if (this.slots.some((s) => s.state === "present" && s.itemKey === key && iou(m.bbox, s.bbox) >= this.cfg.slotIoU)) continue;
      // Nor does the oversized mask an item is already known to sit inside.
      if (this.slots.some((s) => s.mergeBox && s.itemKey === key && iou(m.bbox, s.mergeBox) >= this.cfg.slotIoU)) continue;
      const c = centroid(m.bbox);
      const p = this.pending.find((q) => !q.matched && q.itemKey === key && dist(centroid(q.bbox), c) <= this.cfg.settleMotion);
      if (p) {
        p.streak++;
        p.bbox = m.bbox;
        p.area = m.area;
        p.matched = true;
        p.trackIds.add(String(m.trackId));
        p.label = betterLabel(p.label, m.label);
      } else {
        this.pending.push({
          itemKey: key,
          bbox: m.bbox,
          area: m.area,
          streak: 1,
          trackIds: new Set([String(m.trackId)]),
          label: m.label,
          matched: true,
        });
      }
    }
    const settled = this.pending.filter((p) => p.matched && p.streak >= this.cfg.settleFrames);
    this.pending = this.pending.filter((p) => p.matched && p.streak < this.cfg.settleFrames);
    for (const p of settled) this.onSettle(frame, p);
  }

  private handInTray(h: BBox): boolean {
    const z = this.cfg.trayZone;
    return h[0] < z.x1 && h[0] + h[2] > z.x0 && h[1] < z.y1 && h[1] + h[3] > z.y0;
  }

  private onSettle(frame: Frame, p: Pending): void {
    // 1. Same spot as an existing slot of this item → re-bind (occlusion, ID churn).
    const same = this.slots.find((s) => s.itemKey === p.itemKey && iou(p.bbox, s.bbox) >= this.cfg.slotIoU);
    if (same) {
      const over = this.checkOversize(frame, p.itemKey, p.area, p.bbox);
      this.rebind(same, p);
      if (over === null && same.mergeBox) this.startSplit(same);
      this.joinSplits(same);
      return;
    }

    // 1b. Normal-size and inside the oversized mask this item was counted as → the merge split; same item.
    const parent = this.slots.find((s) => s.itemKey === p.itemKey && s.mergeBox && coverage(p.bbox, s.mergeBox) >= 0.5);
    if (parent && p.area < this.cfg.mergeAreaRatio * (this.itemByKey.get(p.itemKey)?.expectedAreaFrac ?? 0)) {
      parent.bbox = p.bbox;
      this.rebind(parent, p);
      this.startSplit(parent);
      return;
    }

    // 2. Covers two or more existing slots → two items read as one mask.
    const covered = this.coveredSlots(p.bbox);
    if (covered.length >= 2) {
      if (covered.some((s) => s.itemKey === p.itemKey)) this.noteMerge(frame, covered, p.bbox, `one ${p.itemKey} mask covers ${covered.length} counted items`, p.area);
      else this.flag("merged_mask", uniq([p.itemKey, ...covered.map((s) => s.itemKey)]), frame.t, frame.index, `one ${p.itemKey} mask covers ${covered.length} counted items`, p.bbox, true);
      return;
    }

    // 3. Same spot as a slot of a DIFFERENT item → the segmenter changed its mind about what this is.
    // Includes slots that just emptied: a different label on the same spot is never a fresh item.
    const other = this.slots.find((s) => s.itemKey !== p.itemKey && iou(p.bbox, s.bbox) >= this.cfg.slotIoU);
    if (other) {
      this.flag("concept_conflict", uniq([p.itemKey, other.itemKey]), frame.t, frame.index, `the item counted as ${other.itemKey} is now read as ${p.itemKey}`, p.bbox);
      return;
    }

    // 4. Oversized for one item → likely a merge with something not yet counted. Still one slot:
    // the existing slot of this item if the big mask contains it, else a new one marked as merged.
    const over = this.checkOversize(frame, p.itemKey, p.area, p.bbox);
    if (over !== null) {
      const inside = this.slots.find((s) => s.itemKey === p.itemKey && coverage(s.bbox, p.bbox) >= 0.5);
      const s = inside ?? this.newSlot(frame, p);
      if (inside) {
        inside.state = "occluded";
        inside.emptyFrames = 0;
      }
      s.mergeBox = p.bbox;
      s.mergeFlag = this.unresolvableFlags.has(over) ? over : null;
      return;
    }

    // 5. A lifted slot of this item with a matching size → the same item put back.
    const lifted = this.slots
      .filter((s) => s.itemKey === p.itemKey && s.state === "lifted")
      .find((s) => Math.abs(s.area - p.area) <= this.cfg.liftAreaTolerance * Math.max(s.area, 1e-9));
    if (lifted) {
      this.flag("reentry_rebound", [p.itemKey], frame.t, frame.index, `${p.itemKey} was picked up and put back; counted once`, p.bbox);
      lifted.bbox = p.bbox;
      this.rebind(lifted, p);
      this.joinSplits(lifted);
      return;
    }

    // 6. A new item in the tray.
    this.joinSplits(this.newSlot(frame, p));
  }

  /** A mask far bigger than its item is two items read as one: hold it and anything not yet counted. */
  /** Returns the HOLD's flag index, or null when the mask is a normal size. */
  private checkOversize(frame: Frame, itemKey: string, area: number, bbox: BBox): number | null {
    const item = this.itemByKey.get(itemKey);
    if (!item || item.expectedAreaFrac <= 0 || area < this.cfg.mergeAreaRatio * item.expectedAreaFrac) return null;
    // Explained by two counted items under one mask: a merge that can resolve when they split.
    const covered = this.coveredSlots(bbox);
    if (covered.length >= 2 && covered.some((s) => s.itemKey === itemKey)) {
      return this.noteMerge(frame, covered, bbox, `${itemKey} mask is ${(area / item.expectedAreaFrac).toFixed(1)}× its expected size and covers ${covered.map((s) => s.itemKey).join(", ")}`, area).flag;
    }
    const uncounted = this.cfg.items
      .filter((it) => it.key !== itemKey && !this.slots.some((s) => s.itemKey === it.key && s.state !== "lifted"))
      .map((it) => it.key);
    // Something not yet counted may be inside it: this hold never resolves on its own.
    return this.flag("merged_mask", [itemKey, ...uncounted], frame.t, frame.index, `${itemKey} mask is ${(area / item.expectedAreaFrac).toFixed(1)}× its expected size`, bbox, true);
  }

  private rebind(s: Slot, p: Pending): void {
    s.state = "present";
    s.emptyFrames = 0;
    s.occludedFrames = 0;
    s.liftedAtFrame = null;
    s.area = p.area;
    for (const id of p.trackIds) s.trackIds.add(id);
    s.bestLabel = betterLabel(s.bestLabel, p.label);
  }

  private newSlot(frame: Frame, p: Pending): Slot {
    const s: Slot = {
      id: `slot-${++this.slotSeq}`,
      itemKey: p.itemKey,
      bbox: p.bbox,
      area: p.area,
      state: "present",
      emptyFrames: 0,
      occludedFrames: 0,
      longOcclusionFlagged: false,
      liftedAtFrame: null,
      trackIds: new Set(p.trackIds),
      bestLabel: p.label,
      mergeBox: null,
      mergeFlag: null,
    };
    this.slots.push(s);
    this.arrivals.push({ slotId: s.id, itemKey: s.itemKey, t: frame.t, frameIndex: frame.index, bbox: s.bbox, area: s.area });
    return s;
  }

  /** Raise a flag once per code + items; returns its index. `unresolvable` pins a merge HOLD so it is never downgraded. */
  private flag(code: FlagCode, itemKeys: string[], t: number, frameIndex: number, detail: string, bbox?: BBox, unresolvable = false): number {
    const k = `${code}:${[...itemKeys].sort().join(",")}`;
    let i = this.flags.findIndex((f) => `${f.code}:${[...f.itemKeys].sort().join(",")}` === k);
    if (!this.flagKeys.has(k)) {
      this.flagKeys.add(k);
      i = this.flags.push({ code, itemKeys, t, frameIndex, detail, ...(bbox ? { bbox } : {}) }) - 1;
    }
    if (unresolvable) {
      this.unresolvableFlags.add(i);
      this.flagMerges.delete(i);
    }
    return i;
  }
}

const norm = (s: string) => s.trim().toLowerCase();
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** Count a whole clip. */
export function countClip(clipId: string, frames: Frame[], cfg: TrayCounterConfig): CountResult {
  const c = new TrayCounter(cfg);
  for (const f of frames) c.push(f);
  return c.finish(clipId);
}

/** Which item keys a count result forces to HELD, with the flags that did it. */
export function holdingFlagsByItem(result: CountResult): Map<string, CounterFlag[]> {
  const out = new Map<string, CounterFlag[]>();
  for (const f of result.flags) {
    if (!HOLDING_FLAGS.has(f.code)) continue;
    for (const k of f.itemKeys) out.set(k, [...(out.get(k) ?? []), f]);
  }
  return out;
}

export { boxArea };
