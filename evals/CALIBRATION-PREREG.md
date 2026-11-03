# Item-size calibration from g1: pre-registered rule

Registered before any bench clip was filmed. At the live run the only new input is g1's recorded masks. Changing anything below after the gate run needs a new section, never an edit of this one. Companion to the gate rule (`scripts/gate/RULE.md`) and its tuning guard.

**Why:** the tray counter counts settlement in a tray zone set as fractions of the frame, which doesn't depend on the camera. One input does: each item's `expectedAreaFrac` (its mask area as a fraction of the frame, kit.config estimates), used only by the merge, oversize and hidden-item checks. Its real value depends on how high the camera is. No printed markers: the clean clip measures it.

## The rule

- **Clip:** g1 only (clean, one item at a time). The script takes no clip argument.
- **Input:** g1's recorded SAM 3.1 segmentation from the gate run (`data/recordings/gate-g1.sam.json`), counted with the kit.config estimates and the gate's live settings (label checks left to the reader model). No new model call.
- **Per kit item:**
  1. The item must have exactly one counted arrival in g1; otherwise its estimate is kept.
  2. Qualifying frames: from the arrival's frame to the end of the clip, the item's concept masks whose centre is in the tray zone; in each frame the one whose centre is nearest the arrival's; a frame is dropped if any hand mask overlaps that mask.
  3. It needs at least 5 qualifying frames; otherwise the estimate is kept.
  4. **Statistic:** the median of those masks' `area` (an even count averages the middle two), rounded to 4 significant digits.
  5. **Formula:** `expectedAreaFrac := median`, applied only if median / estimate is within 1/4× to 4×; otherwise the estimate is kept and the measured value reported.
- **Where it applies:** real footage only (live runs and replays of recorded real runs). Synthetic scenes were built at the estimates and keep them, so the synthetic gate and the stress sweep don't move.

## Order of the live run

1. Live gate run on g0–g8 with the **estimates**: scored exactly as RULE.md says, g1 included. Result kept.
2. `npx tsx scripts/calibrate-areas.ts --write` → `data/kit-calibration.json` (per item: estimate, measured, frames, applied, reason). Committed.
3. `run-gate.ts --from-recordings --calibrated`: a free re-score of the same recorded runs with the committed sizes. It refuses if the file isn't committed (the tuning guard). **g1 is the calibration clip and is reported "calibration, not scored"**; the verdict is over g0 and g2–g8.
4. Both gate rows are reported side by side, losses kept: estimates (g0–g8) and calibrated (g0, g2–g8).
5. d1–d3 and the same-input A/B run on the calibrated sizes.

`scripts/first-live-run.ts` runs steps 1–3 and 5 in that order and commits the calibration file locally between them.
