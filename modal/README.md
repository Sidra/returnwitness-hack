# SAM 3.1 open weights on Modal (failover segmenter)

**Status: deployed and smoke-tested on the L40S: /healthz 200, /segment 200, late item picked up on the frame it appears.** The app scales to zero after 2 minutes idle; each deploy or run spends Modal credits, so it runs only with the account owner's OK.

## What it is

Live segmentation normally goes to Meta's hosted SAM 3.1 (`lib/meta/sam.ts`). When that call fails or takes longer than its time budget, `FailoverSegmenter` (`lib/vision/failover-segmenter.ts`) sends the same prepared clip to **this** app: Meta's open SAM 3.1 weights (`facebook/sam3.1`) running on my own Modal GPU. The client is `ModalSamSegmenter` (`lib/openweights/modal-sam.ts`).

- A failover result is labelled **LIVE · Meta open weights on a partner GPU** (`LIVE_OPEN_WEIGHTS`), never "LIVE · Meta".
- The case's provenance says why: `failover: sam-3.1 (Meta Model API) failed (<reason>) → SAM 3.1 open weights on Modal (failover), N concepts, X ms`.
- If both engines fail, the pipeline holds the case (`pipeline_error`). It never approves anything.

## The contract (this app defines it, the client parses exactly this)

```
POST /segment            Authorization: Bearer <MODAL_SAM_TOKEN>
  {clipId, fps, concepts: [str], video_b64}
→ {frames: [{frame_index, objects: [{track_id, concept, box: [x0,y0,x1,y1] (pixels), score, area}]}],
   width, height, model, gpu_seconds, request_id}

GET /healthz             → {ok, model, gpu, loaded, load_s}   (no auth, returns no data)
```

`gpu_seconds` is the wall-clock time one request held the GPU container, measured inside the app. It is **not** a Modal billing figure. The call log records it as a unit with `costUsd: null`, so `spend` lists these calls as unpriced, which is correct until we have a verified price.

## GPU choice: L40S

SAM 3 is CUDA-only: the code has hard CUDA calls and triton kernels throughout. The app asks Modal for a CUDA GPU and fails the container at start if none is present. There is no CPU or MPS path, and none should be added.

SAM 3.1 is a sub-1B-parameter model. Its video tracking memory grows with frame count and object count, and a 5 fps / 720p clip of up to ~80 s with 5 concepts fits easily in 48 GB. An L40S has that much memory. A100-80GB is the next step up if long clips run out of memory; an H100 would also allow FlashAttention 3. **Check Modal's GPU price page on deploy day.** These notes quote no prices.

## Checked against the real repo

`sam31_app.py` was checked against facebookresearch/sam3 at the pinned commit **`f1647e8d0c1d280991f4d1b7d974c2704537fe66`** (head of `main`; SAM 3.1 shipped) and the `facebook/sam3.1` Hugging Face file list. What changed:

| # | Item | Assumed before | What the repo says | Fix |
|---|---|---|---|---|
| 1 | Builder | `build_sam3_video_predictor(checkpoint_path=…)` | That builds **SAM 3** (Nov 2025). SAM 3.1 is `build_sam3_multiplex_video_predictor(checkpoint_path, …)` (`sam3/model_builder.py`, used by `examples/sam3.1_video_predictor_example.ipynb`) | switched builder |
| 2 | Checkpoint | first `.pt`/`.safetensors` found in a full snapshot | `facebook/sam3.1` holds `sam3.1_multiplex.pt` + `config.json` (the same names `download_ckpt_from_hf("sam3.1")` fetches) | download exactly those two files |
| 3 | FlashAttention 3 | not considered | the multiplex builder defaults to `use_fa3=True`; `sam3/perflib/fa3.py` casts to float8 and calls `flash_attn_interface` (FA3 is a Hopper/H100 kernel) | `use_fa3=False` on the L40S (Ada); on an H100 it could be turned on with `flash-attn-3` |
| 4 | Request types | `start_session` / `add_prompt(text=)` / `propagate_in_video` (stream) / `close_session` | all four exist with those names in `sam3/model/sam3_base_predictor.py`; also `reset_session` | unchanged |
| 5 | Several prompts in one session | unknown; one session per concept | the 3.1 notebook: switching text prompts requires `reset_session` first, "otherwise the results would be wrong" | one session per clip (the video is decoded once), `reset_session` before each concept |
| 6 | Output fields | `out_obj_ids`, `out_probs`, `out_boxes_xywh` (assumed normalised), `out_binary_masks` | same keys; boxes are normalised XYWH (`visualization_utils.py` multiplies by width/height); masks are resized to the clip's resolution | unchanged; mask area now scaled by the mask's own shape |
| 7 | torch / CUDA | `torch==2.7.1`, `torchvision==0.22.1` | README at the pin: Python 3.12, `torch==2.10.0 torchvision` from the cu128 index; CUDA 12.6+ | `torch==2.10.0` + matching torchvision from `whl/cu128` |
| 8 | Other deps | `numpy<2.3`, unpinned opencv | `pyproject.toml` pins `numpy>=1.26,<2`; mp4 is read with cv2 by default; `model_builder` imports `pkg_resources` | `numpy>=1.26,<2`, `opencv-python-headless==4.10.0.84` (numpy 1.x), `setuptools<81` |
| 9 | Commit pin | none; deploy refused without one | — | default `RW_SAM3_COMMIT` = the sha above; still overridable |

Optional speed-ups the repo lists and this app leaves out: `cc_torch` (it falls back to a triton connected-components kernel) and FA3 (Hopper only).

**What only a first run on the GPU can prove:** that the checkpoint loads without missing keys (the builder prints any); that a text prompt on frame 0 picks up items that appear later in the clip (the detector runs per frame in dense tracking, but it needs checking on a real bench clip); the latency on an L40S; and memory headroom for an 80 s clip with 5 concepts at `max_num_objects=16`.

## Deploy steps (each is a cloud write: only with the account owner's OK)

Modal workspace: yours (`<workspace>` below).

```bash
pip install modal && modal setup                      # log in to your Modal workspace
# 1. Hugging Face token for the gated facebook/sam3.1 repo. Access is "manual": Meta reviews each request, so request it early. Keep the token in your local secrets file (never in git); it goes into this Modal Secret only at deploy time.
modal secret create returnwitness-hf HF_TOKEN=<your Hugging Face token>
# 2. The bearer token our client sends; generate a fresh one, keep it out of git
modal secret create returnwitness-sam-token MODAL_SAM_TOKEN=$(openssl rand -hex 32)
# 3. Deploy (the sam3 commit is pinned in the file: f1647e8d…; override with RW_SAM3_COMMIT only after re-checking)
modal deploy modal/sam31_app.py
```

The deploy prints the web endpoint URL (something like `https://<workspace>--returnwitness-sam31-sam31-web.modal.run`). Then add these to `.env.local`:

| Env var | Value |
|---|---|
| `RETURNWITNESS_SAM_FAILOVER` | `modal` (turns the failover on) |
| `MODAL_SAM_URL` | the endpoint base URL from the deploy output (no trailing `/segment`) |
| `MODAL_SAM_TOKEN` | the same token you put in the `returnwitness-sam-token` secret |
| `MODAL_SAM_MODEL` | optional, defaults to `facebook/sam3.1` |
| `RETURNWITNESS_SAM_TIMEOUT_MS` | optional: Meta's time budget before the failover takes over (default 60000) |

The Modal token must never go to the public Vercel deployment. The public profile runs on fixtures only.

## Check it and stress it

```bash
npx tsx --env-file=.env.local scripts/check-modal.ts        # GET /healthz: status + latency (a cold start boots a GPU, which is billed)
npx tsx --env-file=.env.local scripts/stress-sweep.ts --modal --clips gate/clips/*.mp4
```

The `--modal` sweep runs each real gate clip through 12 ffmpeg variants (brightness, blur, downscale, frame drop) plus the unperturbed clip. That is 13 GPU calls per clip. It refuses to run unless the failover is configured. Without `--modal`, the sweep is the free deterministic one (synthetic segmentation, no model).

## Cost controls built in

- `min_containers=0` and `scaledown_window=120`: no GPU runs while idle. A warm container shuts down 2 minutes after its last request.
- `max_containers=2`: a hard ceiling on parallel GPU spend.
- `@modal.concurrent(max_inputs=1)`: one clip per GPU at a time.
- A 25 MB clip cap on both sides, and the client refuses an unprepared clip before uploading it.
- The weights are cached on a Modal Volume (`returnwitness-sam31-weights`), so a cold start doesn't download them from Hugging Face again.

---

# Muse Glimmer open weights on Modal (label reader + correction fine-tune)

**Status: deployed and read live; first fine-tune run; adapter kept off by the switch rule.** See the run notes below. Fireworks granted no credits, so the Muse Glimmer label reader and the reviewer-correction fine-tune run on my own Modal GPU instead. Every step below that creates or changes anything on Modal (volumes, secrets, deploy, `modal run`) **needs Sidra's typed OK**. No weights have been downloaded to the Mac.

| File | What it is |
|---|---|
| `modal/glimmer_app.py` | Modal app `returnwitness-glimmer`: vLLM 0.32.0 serving `meta-models/Muse-Glimmer-30B` on one L40S, FP8 at load, LoRA adapters served by name, behind a bearer token |
| `modal/glimmer_finetune.py` | Modal app `returnwitness-glimmer-finetune`: QLoRA on one L40S from the correction rows, writes the adapter + `metrics.json` to the adapters volume |
| `modal/check_glimmer_web.py` | Local contract check (`npm run check:glimmer-web`): the real app files with `modal`, `vllm` and `torch` stubbed, a fake engine, the fine-tune gates |
| `lib/openweights/glimmer-modal.ts` | The reader (`RETURNWITNESS_LABEL_READER=modal`) |
| `lib/learning/glimmer-eval.ts`, `scripts/glimmer-eval.ts` | Dataset export, held-out metrics, the switch rule |
| `scripts/check-glimmer.ts` | `GET /healthz` (also the way to warm the reader before a bench session) |

## The contract

```
POST /v1/chat/completions   Authorization: Bearer <MODAL_GLIMMER_TOKEN>
  OpenAI chat-completions body; model = "meta-models/Muse-Glimmer-30B" or a served adapter name;
  no streaming; at most 4 images; max_tokens capped at 4096
→ vLLM's chat completion + gpu_seconds (wall clock in the engine, measured in the app; not a bill)

GET /healthz                → {ok, ready, model, revision, gpu, adapters, vllm, load_s}   (no auth, no data)
```

The reader sends the same prompt, schema and crops as the Fireworks reader (`lib/openweights/glimmer.ts`), with `temperature: 0`. Results are labelled **LIVE · Meta open weights on a partner GPU** (`LIVE_OPEN_WEIGHTS`) and only after a real call; until then Settings says "built and mock-tested; not deployed". The reader can only raise holds, is never required, and times out at 15 s with no retry.

## Serving choices (vLLM flags)

| Flag | Value | Why |
|---|---|---|
| GPU | one L40S (48 GB, Ada) | BF16 weights are 59.6 GB and don't fit; FP8 (~30 GB) does, and Ada has FP8 tensor cores |
| `--quantization` | `fp8` | dynamic FP8 weights at load from the official BF16 checkpoint (there is no official FP8 repo) |
| `--max-model-len` | `20480` | 4 crops × 4,096 (the processor's per-image cap, which vLLM profiles with) + 1,024 prompt + 2,048 answer = 19,456. KV per token per layer is 2 × 2 KV heads × 128 × 2 B = 1,024 B; 13 full-attention layers hold every token (273 MB) and 39 sliding-window layers at most 2,048 (82 MB), so ~355 MB per max-length sequence (1.09 GB if every layer kept the full length). About 9 GB is left for KV after ~30 GB of FP8 weights at 0.90 utilization, which is far more than 4 sequences need |
| `--max-num-seqs` | `4` | a bench sends one inspection at a time; headroom for LoRA slots |
| `--limit-mm-per-prompt` | `{"image":4,"video":0}` | crops only; no video budget reserved |
| `--enable-lora`, `--max-lora-rank 16`, `--max-loras 1`, `--max-cpu-loras 4` | | a fine-tuned adapter is served by name on the same GPU; no second GPU |
| `--lora-modules` | one JSON entry per adapter directory on the adapters volume | listed when the container starts; adapters trained on another base or above rank 16 are skipped |
| `--generation-config vllm` | | don't inherit the model's sampling defaults (temperature 1.0) |
| KV cache dtype | default (BF16) | it fits; an FP8 KV cache would be a second precision loss on exact character transcription |
| `--revision` | `cec94fcf…` | the Hugging Face commit pinned, so the weights can't change under a running product |

Pins: `vllm==0.32.0` (brings `torch==2.13.0`, `torchvision==0.28.0`), `transformers==5.19.0`, `huggingface_hub==1.33.0`, `fastapi[standard]==0.136.3`, `httpx==0.28.1`, all inside vLLM 0.32.0's declared ranges.

## Fine-tune choices (QLoRA)

- **Library:** transformers 5.19.0 (Glimmer ships in transformers since 5.15.0 as `MuseGlimmerForConditionalGeneration`) + bitsandbytes 0.50.2 (NF4, double quantization, BF16 compute) + peft 0.21.2. Neither bitsandbytes nor PEFT has architecture-specific code: both work by module name on `nn.Linear`. Unsloth's release notes say Glimmer 30B can be fine-tuned on 20 GB of VRAM, which is only possible at about 4-bit. We have not run this stack yet.
- **What trains:** LoRA rank 16 (alpha 32, dropout 0.05) on the language model's `q/k/v/o_proj` and `gate/up/down_proj` in all 52 layers (364 modules, ~96M trainable parameters). The vision tower, vision adapter/projection and `lm_head` stay BF16 and frozen. The attention's output gate (`self_attn.gate_proj`) is deliberately excluded: vLLM renames it `output_gate_proj` and validates LoRA modules by their last name segment, so an adapter on it could be loaded onto the MLP's `gate_up_proj`.
- **Data:** `npx tsx scripts/glimmer-eval.ts export` writes one `{messages, meta}` per line: the crop, the live reader's exact prompt, and the truth as the answer. The rows are the **bench label set · truth from the printed label design** (below) plus any reviewer corrections (source `correction`). Split by **label id** with seed 1729, 20% held out, so no serial is ever in both splits; the real sheet's four serials and two charger labels are always held out. The Modal job recomputes the split, refuses on any mismatch or leak, and never trains on a held-out row.
- **The bench label set** (`lib/learning/label-set.ts`, `npx tsx scripts/build-label-set.ts`; free, local, headless Chrome): every row's truth is the label that was printed or rendered, never a model's read.
  - `sheet`: the 10 labels on the printed sheet, cropped from `labels/preview.png`: one view as printed plus 3 seeded augmentations each (40 rows, all held out; 4 distinct serials + 2 chargers).
  - `render`: the sheet's own HTML/CSS re-rendered with 60 new seeded serials in the real format (30 `BW-CB-#####`, 30 `BW-LN-#####`) × 3 augmentations, plus 6 charger labels × 2 (192 rows).
  - `bench`: camera body and lens crops at their settled frames in d1–d3, once a clip and its `data/recordings/<clipId>.sam.json` both exist; truth from that RMA's packing slip. 0 rows today. These carry the printed serials, so they are always held out.
  - Augmentations in the page, seeded per row: rotation and perspective within ±25°, scale 0.6–1.1, blur ≤ 1.6 px, a glare gradient, a finger-like bar or packing paper covering ≤ 30% of the label, JPEG quality 35–92. An occluder touching the serial makes the truth "unreadable" (the reader is taught to abstain). On about half the serial rows the slip's serial is a near-miss of the printed one (one look-alike digit; on the sheet, the other set's serial, the real d1 stand-in), so a read equal to the slip counts as a false clear.
  - Today: **232 rows, 150 train / 82 held out**; 46 distinct serials in train, 18 held out (incl. all 4 printed ones), none in both. Images in `.data/label-set/images/` (gitignored); the committed summary is `data/label-set.manifest.json`.
- **Floors:** at least **50 training rows** (fewer, and a ~96M-parameter adapter memorises the crops; it would also cost GPU time to make an adapter the switch rule rejects) and at least **20 held-out rows** (fewer, and one row is more than the 5-point margin).
- **Gates:** `--confirm-spend` is required; without it, or below a floor, the local entrypoint refuses before any remote call, and the GPU function refuses again on its own.
- **Output:** `/adapters/<run-name>/` on volume `returnwitness-glimmer-adapters`: `adapter_config.json`, `adapter_model.safetensors`, `metrics.json` (row counts, loss per epoch, measured seconds, peak memory, in-process held-out numbers), `heldout_reads.base.json`, `heldout_reads.adapter.json`, `split.json`. It trains in a dot-staging directory, which is never served, and is renamed into place when complete.
- **Fallback** if 4-bit loading or training fails on the first run: plain LoRA on the BF16 base on one A100-80GB, which costs $2.50/h against $1.95/h for the L40S (+28% per GPU-hour; the A100 is also faster per step, so the per-run difference is unmeasured).

### Quote for one learning run on today's set (estimates; L40S $1.95/h)

Printed by `scripts/build-label-set.ts` and `scripts/glimmer-eval.ts export` for the real row counts:

- (a) base Glimmer on the 82 held-out rows: ≈ $0.41 (0.21 GPU-hours) · 300 s cold start + 82 reads × 4 s + 120 s idle = 748 s (estimate)
- (b) QLoRA on the 150 training rows × 3 epochs: ≈ $2.59 (1.33 GPU-hours) · 360 s load + 150 × 3 × 8 s + 82 held-out × 2 in-process reads × 5 s = 4,780 s (estimate; `metrics.json` records the measured seconds)
- (c) the adapter on the same 82 held-out rows: ≈ $0.41 (0.21 GPU-hours), the same 748 s (estimate; 420 s less if it runs right after (a) on the warm container)

## The switch rule (adapter only after the held-out test)

The adapter is used only if, on the same held-out rows (at least 20) and with at least 50 rows trained on, it **beats the base on exact-serial match by at least 5 percentage points and at least 2 rows**, AND it has **no more false clears than the base**. A false clear is a trusted read that matches the packing slip when the person says the item doesn't (a stand-in, a swapped unit, an unreadable label): the app would pass a line that should hold. Otherwise the base stays; a tie keeps the base. The rule is `decideSwitch` in `lib/learning/glimmer-eval.ts`.

The deciding reads go **through the served endpoint** (FP8 base with and without the LoRA): the adapter is trained on an NF4 base and served on an FP8 base, so only the served stack is a fair test. The Modal job's own held-out numbers (NF4, in process) are in `metrics.json` for information.

## Cost (Modal list prices: L40S $1.95/h, A100-80GB $2.50/h, H100 $3.95/h)

The workspace runs on credits with a $0 spend limit. Every time below except the list prices is an estimate until the first run measures it.

| What | Math | Estimate |
|---|---|---|
| Serving, warm | one L40S | **$1.95 per hour** |
| One inspection after idle | ~300 s cold start (FP8 load + compile, estimated) + ~4 s read + 120 s scale-down window = ~424 s | **~$0.23** (and the read itself misses its 15 s budget on a cold container unless the reader was warmed first with `scripts/check-glimmer.ts`) |
| One inspection on a warm container | ~4 s of GPU | ~$0.002 of GPU time; at 30 inspections an hour the container never idles, so **~$0.065 per inspection** ($1.95 / 30) |
| A bench shift kept warm | 8 h × $1.95 | $15.60; the $30/month Starter credits cover about two shifts |
| Fine-tune, 200 corrected crops (160 train / 40 held out), 3 epochs | 360 s load + 160 × 3 × 8 s + 40 × 2 × 5 s = 4,600 s ≈ 1.28 h | **~$2.49** on the L40S (A100-80GB fallback at the same seconds: $3.19) |
| Fine-tune, 1,000 crops, 3 epochs | 21,560 s ≈ 6.0 h | ~$11.68; this is at the job's 6 h timeout, so use 2 epochs or raise the timeout |
| Live held-out read for the switch test, 40 rows | 300 s cold + 40 × 2 × 4 s + 120 s = 740 s | ~$0.40 |
| Weights download | on a CPU container (`download_weights`), no GPU | cents |

`scripts/glimmer-eval.ts export` prints the fine-tune quote for the real row count. `metrics.json` records the measured seconds per row and epoch; replace `FT_SECONDS_PER_ROW_EPOCH` with it after the first run.

## Deploy and run (each step is a cloud write: only with the account owner's OK)

```bash
# 1. Bearer token for the endpoint (fresh; also goes into .env.local as MODAL_GLIMMER_TOKEN)
modal secret create returnwitness-glimmer-token MODAL_GLIMMER_TOKEN=<openssl rand -hex 32>
# 2. Fill the weights volume on a CPU container (59.6 GB; the model is not gated, so no HF token is needed)
modal run modal/glimmer_app.py::download_weights
# 3. Deploy (creates the volumes on first deploy if missing)
modal deploy modal/glimmer_app.py
# 4. Warm + check (a cold start boots the L40S and is billed)
npx tsx --env-file=.env.local scripts/check-glimmer.ts
```

Then in `.env.local` (never in the production host's environment):

| Env var | Value |
|---|---|
| `RETURNWITNESS_LABEL_READER` | `modal` (takes precedence over `fireworks`) |
| `MODAL_GLIMMER_URL` | the deploy's web endpoint base URL |
| `MODAL_GLIMMER_TOKEN` | the same token as the secret |
| `MODAL_GLIMMER_ADAPTER` | optional; set **only** after the switch rule says to use that adapter |
| `MODAL_GLIMMER_MODEL` | optional, defaults to `meta-models/Muse-Glimmer-30B` |

Fine-tune and switch test:

```bash
npx tsx scripts/glimmer-eval.ts export                                    # free: rows, split, floors, quote
modal run modal/glimmer_finetune.py --dataset .data/finetune/glimmer-<date>.jsonl --run-name rw-labels-<date> --confirm-spend
modal deploy modal/glimmer_app.py                                         # the app lists adapters when a container starts
npx tsx --env-file=.env.local scripts/glimmer-eval.ts live --data .data/finetune/glimmer-<date>.jsonl --adapter-name rw-labels-<date> --confirm-spend --record
```

`--record` appends the decision to the decision log; every decision also goes to `.data/finetune/glimmer-decisions.jsonl`.

## Cost controls built in

- `min_containers=0`, `scaledown_window=120`, `max_containers=1`: nothing runs while idle, and never more than one L40S.
- The container fails at start without a CUDA GPU, and refuses to start if the image's vLLM isn't 0.32.0.
- The engine listens on 127.0.0.1 only; the bearer check (constant-time compare) is in front of it. `/healthz` returns no data.
- Request limits: 8 MB body, 4 images, no streaming, `max_tokens` ≤ 4096, unknown model names 404 before reaching the engine.
- The fine-tune job: `max_containers=1`, 6 h timeout, `confirm_spend=True` and both row floors required, never overwrites an existing adapter.

## What only a first GPU run can prove

That vLLM 0.32.0 quantizes this checkpoint to FP8 on Ada and loads it cleanly; the KV-cache size vLLM reports at start (compare with the math above); the cold-start time; that the QLoRA stack loads Glimmer in 4-bit and that the chat template's prompt is a prefix of prompt + answer (the job checks and stops if not); that vLLM maps the PEFT adapter's tensor names onto its packed `qkv_proj`/`gate_up_proj` layers; and the read latency and accuracy on real bench crops.
