# Same-input A/B: pre-registered rule

Registered before either arm ran on any clip and before any bench clip was filmed. Changing anything below after the first arm result needs a new section, never an edit of this one.

**Question:** on the same returns and the same frames, does the ReturnWitness pipeline approve fewer refunds it shouldn't than Muse Spark 1.3 asked on its own, and what does that caution cost in holds on complete kits?

## Arms

| | Arm A · Muse Spark 1.3 alone | Arm B · the ReturnWitness pipeline |
|---|---|---|
| Frames | the clip's four key frames at 20/45/70/95 % of its length, 1280 px wide: the same images, from the same helper (`keyFrameImages`), that Arm B's Spark reader gets | every frame at 5 fps through SAM 3.1, then the same four key frames plus one crop per counted item for its Spark reader |
| Text | the packing slip, the return policy, the RMA (customer's reason, requested amount) | the same, plus the tray counter's output; on d1–d3 also the returns lead's transcribed voice note |
| Question | "is this kit complete? refund or hold?" (prompt frozen in `lib/evals/same-input-ab.ts`, `ARM_A_SYSTEM`, sha256 `db19d8212987cd527991dd1087c333f068951fa9038e26f08a14604a1b7b8a31`) | none: its answer is the state the pipeline leaves the case in |
| Answer | `decision: refund \| hold` (strict JSON schema) | Held = hold · AwaitingApproval = refund recommended |
| Calls | one Spark call per clip, no retry | d1–d3: the live inspections of the same run · g0–g8: the gate run's recorded SAM 3.1 output (same run, no new SAM call), then live Spark and Wonder |

Arm A doesn't get the voice note: it's Spark alone, and the transcript is another model's output. Neither arm moves money: in the product a refund still needs a person's typed-name, single-use signed approval. "Refund" below means the arm's answer before that person.

## Clips and truth

All 12 bench clips: g0–g8 (contents from `gate/manifest.json`) and d1–d3 (d1 lens missing, d2 complete, d3 complete). Gate clips carry no RMA, so both arms get the complete kit's packing slip and the reason "Return requested."

- **must hold:** a packing-slip item isn't in the box (g0 empty, g5 lens missing, d1 lens missing).
- **hold acceptable:** complete kit on a clip whose manifest accepts a hold (g6 merged masks, g7 label covered). Either answer counts as correct, for both arms.
- **complete:** every other clip. A hold here is a false hold.

## Scoring, per arm, per clip

| answer | must hold | hold acceptable | complete |
|---|---|---|---|
| hold | correct hold | accepted hold | **false hold** |
| refund | **wrong refund** | correct refund | correct refund |
| no answer (call failed or reply out of schema) | **no answer** | **no answer** | **no answer** |

Losses (wrong refunds, false holds, no answer) are all published, row by row, on /dashboard/evals and in `data/ab/<runId>.json`. A failed call is never re-run and never counted as a hold or a refund.

**Headline:** wrong refunds for each arm, next to false holds for each arm. The pipeline's claim is "wrong refunds: 0" only if its row count says 0; if it isn't 0, that is the headline.

**Reported, not judged:** which items Arm A named as missing, Arm B's hold codes, latency, cost per arm.

## What this can and can't show

Twelve clips, three of them must-hold, filmed by one person on one bench. It can show a difference on these returns; it can't estimate a rate. Arm A is asked a plain question with the same information a reviewer has on screen; a better Arm A prompt might do better, and this one is frozen so the comparison can't be tuned after the fact.

Run: `scripts/first-live-run.ts` step 3 (on by default, `--no-ab` skips it). Extra spend, worst case: 12 + 9 Spark calls and 9 Wonder runs ≈ $1.30 (Arm A ≈ $0.17, Arm B on the gate clips ≈ $1.13), inside the $9.40 Meta cap.

## Addendum: fewer clips (before any run)

Nothing above changes. Written before any bench clip exists. The filming was cut to four must-film clips (g0 empty, g1 clean, d1 lens missing, d2 complete); g2–g8 and d3 may not come.

- **The A/B runs on the clips that were filmed**, each scored exactly as above. Clips not filmed are listed as not filmed, never as no answer.
- With only those four: two must-hold (g0, d1) and two complete (g1, d2). That can show the two arms differ on these four returns; it can't support a rate, and nothing says it does.
- **g1 is the calibration clip.** Arm B on g1 counts with item sizes measured on g1 itself (they touch only the merge, oversize and hidden-item checks). Its row is kept and marked as the calibration clip; the headline gives Arm B's wrong refunds and false holds with and without g1.

