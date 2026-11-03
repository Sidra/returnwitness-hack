# Gate test: pre-registered PASS/FAIL rule

Registered before the harness ran on any clip and before the Meta key existed. Changing this rule after a run requires a new section below, never an edit of this one.

**Question (spec §3 hole 1):** with the tray zone on, does each physical item get exactly one counted arrival, even when SAM 3.1 fragments its track IDs under hands, kraft paper, or an item being picked up again?

**Inputs:** the clips in `gate/CLIP-SPEC.md` (g1–g8), their expected outcomes in `gate/manifest.json`, SAM 3.1 via the Meta Model API at 5 fps / 720p, the tray counter with the config committed at the time of the run (its git hash is recorded in the result).

**Per clip, per physical item:**
- `arrivals` = counted arrivals for that item from the tray counter.
- `samIds` = distinct raw SAM track IDs that item received (reported, not judged).

**FAIL** if ANY of these happen on ANY clip g1–g8:
1. A physical item gets **more than one** counted arrival.
2. An item that settled in the tray gets **zero** arrivals **and** no HOLD flag on its line (a silent miss).
3. On g6 (merge), the counter reports 2 or 4 arrivals with no `merged_mask` HOLD.
4. On g5 (missing lens), the lens line is anything other than HELD/MISSING.

**PASS** otherwise. A HOLD on a hard clip whose expected outcome lists HOLD as acceptable is a correct result.

**Reported, not pass/fail:** `samIds` per item (fragmentation), per-stage latency, cost, frames sent.

**What happens next:** PASS → wire SAM 3.1, Muse Spark 1.3, Muse Wonder 1.0 live. If the gate fails, the next step is the builder's decision.

**Tuning guard:** the counter's thresholds may be tuned on g0–g4 only if the tuned config is committed before g5–g8 are scored, and both runs (before/after) are kept in `gate/results/`.

## Addendum: item sizes calibrated from g1 (before any real run)

Nothing above changes. The live run on g0–g8 counts with kit.config's estimated item sizes and **is** the gate result as registered. After it, item sizes are measured from g1 by the rule in `evals/CALIBRATION-PREREG.md`, committed, and the same recorded runs are re-scored free with them (`run-gate.ts --from-recordings --calibrated`). That second run reports g1 as "calibration, not scored" and is shown beside the first, never in place of it. This is the tuning guard above applied to one input: the tuned value comes from g0–g4 (g1) and is committed before g5–g8 are scored on it.

## Addendum: a run on fewer clips (before any real run)

Nothing above changes. Written before any bench clip exists, after the filming was cut to the phone and four must-film clips (g0, g1, d1, d2); g2–g8 may not be filmed.

- **The gate is all of g0–g8.** A run that scores fewer clips can't answer the question above (fragmentation under hands, kraft paper, merges, a lift-and-replace, a missing lens): its result is **INCOMPLETE ("not run as registered")**, never PASS, and it names the clips that weren't run.
- **A FAIL is still a FAIL.** If any clip that was scored meets a FAIL condition above, the result is FAIL, however few clips ran.
- **The calibrated re-score** owes every registered clip but g1 (the calibration clip): with g2–g8 missing it scores g0 only and is INCOMPLETE.
- **Reported as it stands:** each scored clip's row, losses kept, beside "not run: g2–g8 not filmed". Nothing on the site, the video or the form calls a partial run a gate pass.
- **"What happens next" above** assumed a full run. With an INCOMPLETE gate the live models still run on the demo clips (they were already wired); the claim the gate would have backed, that the counter holds up under the hard cases on real footage, is not made from real footage. The synthetic gate and the stress sweep remain what backs it, labelled as synthetic.

## Addendum 2: item words chosen on g1 (before any scored run)

Nothing above changes. Written after a smoke test on the first real take of g1 (not scored, not the gate) and before any clip is scored.

- **What was seen:** on that take, SAM 3.1 found no mask in any frame for kit.config's words "film camera" and "battery charger", though both items sat in the tray. The stand-in props don't look like their product names to SAM (the camera prop's label sticker covers its top). A SAM-only probe of other words on the same take found "mint green object" tracks the camera prop and "battery" tracks the charger; "camera", "charger" and seven other words found nothing.
- **The change:** `samConcept` for camera_body → "mint green object", battery → "battery" (lens stays "camera lens"). These words are per-SKU store config: what a store sets so SAM can find each SKU on its own bench, like a price or a label format. The product's own name stays in the slip and the UI.
- **Disclosed as tuning on g1, the calibration clip:** the words were chosen on g1's first take, so a g1 result is not an independent test of them. g1 is already outside the calibrated verdict; this commit is the registration time for the words, before g0, d1, d2 or a new take of g1 is scored. Every public line about it says the words were chosen on g1 because the defaults found nothing on the stand-in props.
- **The first take is trimmed to 0–16.0 s** (its last ~2 s, where the phone moved, were cut after the smoke result; the 18 s original is kept in `gate/clips/raw/`). It stays a smoke clip and a backup: the phone was moved after it, so the calibration comes from the take of g1 filmed with g0, d2 and d1.
- **Unchanged:** the first scored run counts with the estimated sizes and without the hand rule, as registered; the hand rule may be applied only after a FAIL, as written above, and both runs are reported, the loss first.
