# Gate clip spec (technical)

**What the clips are for:** the gate test (spec §3 hole 1). With the tray zone on, does each physical item get exactly **one** counted arrival, even when SAM 3.1 gives an item several track IDs because of hands, kraft paper or an item being picked up again? The PASS/FAIL rule is pre-registered in `scripts/gate/RULE.md` (committed before any run). The same rig then films the two demo clips.

## Camera: iPhone 16 Pro Max overhead, used as the Mac webcam

- **Feed:** iPhone 16 Pro Max as a Continuity Camera into the Mac. The bench station picks it from a device list (`enumerateDevices`); it's never hardcoded, so whatever name macOS gives it is fine.
- **In Control Centre → Video Effects on the Mac, turn OFF: Center Stage, Portrait, Studio Light, Reactions, Desk View.** Center Stage pans and crops, which moves the box and tray zones mid-clip and breaks the counter. This is the most important line on the card.
- **Mount:** phone flat, screen up, rear camera pointing straight down, landscape (long side along the bench). Rear camera **60–80 cm** above the bench top. Use the main 1× lens, not ultra-wide (distortion at the edges skews the zones).
- **Framing:** the whole bench mat fills the frame with ~5 cm margin. Nothing else in frame: no face, no screen, no other products, no logos if avoidable. Only hands and forearms come in.
- **Capture:** record at **1080p, 30 fps** (QuickTime → New Movie Recording → pick the iPhone, or the bench station's Record button). The harness downsamples to **720p, 5 fps** itself, so don't pre-process.
- **Don't move the phone between clips.** If it moves, film a new 3-second empty-mat clip (`g0-empty.mov`) so the zones can be re-fixed.

## Bench

- **Surface:** one plain, matte mat that contrasts with the items (light grey or white if the items are dark, dark if they are light). No pattern, no gloss.
- **Two zones, marked with tape:** **BOX** on the left ~45% of the frame, **TRAY** on the right ~45%, a ~10% empty strip between them. The box stays in the BOX zone. Items go into the TRAY zone and stay there.
- **Light:** even, soft, from above or both sides. No window glare, no hard hand shadows across the tray. Keep it the same for every clip.
- **Protocol (what a returns worker does):** one item at a time, BOX → TRAY, hand out of the tray after each item. Items in the tray don't touch each other (except clip G6).

## The kit

Three rigid items that read as one kit, plus a box that fits them and kraft paper. Requirements:
- **Clearly different shapes**, and if possible not all the same colour (two black items touching is the merge risk, which is clip G6's job, not every clip's).
- **Each item gets a printed label sticker** with its SKU and a serial, on a flat face (I generate the label sheet from `data/kit.config.ts` once the kit is bought).
- Item names, SKUs, prices and serials live in **one file, `data/kit.config.ts`**; the packing slip, RMA fixtures and labels are generated from it.

## The clips (each 10–25 s; start with 2 s of the empty tray, end with 2 s of hands out)

| File | What happens | Expected outcome |
|---|---|---|
| `g0-empty.mov` | 3 s, empty mat, box closed in the BOX zone | zones fixed; 0 arrivals |
| `g1-clean.mov` | three items, one at a time, BOX → TRAY, normal pace | 3 arrivals, 1 per item |
| `g2-hand-occlusion.mov` | after the lens is in the tray, the hand rests flat over it for ~2 s while the next item is placed beside it | 3 arrivals (the covered lens is not counted again) |
| `g3-kraft-paper.mov` | box packed with kraft paper; paper lifted out and dropped back in the BOX zone; one item comes out wrapped and is unwrapped over the box | 3 arrivals; paper never counted |
| `g4-lift-replace.mov` | lens placed in the tray, picked up again, turned to show its label to the camera for ~2 s, put back in a different spot in the tray | 3 arrivals (lens counted once) |
| `g5-missing-lens.mov` | lens left out of the box; the other two go in the tray | 2 arrivals; lens line HELD (missing) |
| `g6-merge.mov` | battery placed touching the camera body | either 3 arrivals, or a `merged_mask` HOLD. A silent 2 or a 4 is a FAIL |
| `g7-label-covered.mov` | an item placed with its label sticker face down | 3 arrivals; that line HELD (`label_unreadable`) |
| `g8-fast.mov` | all three items moved within ~8 s, still one at a time | 3 arrivals |

## Demo clips (same rig, after the gate)

| File | What happens |
|---|---|
| `d1-rma-20418-lens-missing.mov` | the hero: kit return with the lens missing → $340 held |
| `d2-rma-20419-complete.mov` | the same kit, complete → approve → Stripe test refund |
| `d3-camera-reboxed.mov` (30 s) | **the "where SAM ends and our code begins" beat** (pre-registered): 0–2 s empty tray · camera body lifted out of the box **uncovered**, held over the BOX zone ~2 s · a hand + a sheet of kraft paper cover it **completely** ~2 s · it goes **back into the box**, paper dropped in after it · ~2 s pause · body out again, straight to the TRAY, hand away · lens, then charger, to the tray one at a time · 2 s hands out. **Expected:** camera body 1 arrival (SAM likely 2+ raw IDs), lens 1, charger 1, all OK. On screen: the raw SAM track list (fragmented IDs) beside the tray counter (counted once). Set A labels. |

## Hand-off

Drop the files in `gate/clips/` (git-ignored) with exactly these names. The manifest of expected outcomes is `gate/manifest.json`, already written from this table.
