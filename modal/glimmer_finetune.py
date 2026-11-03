"""
ReturnWitness: QLoRA fine-tune of Muse Glimmer (meta-models/Muse-Glimmer-30B) on reviewer corrections,
on ONE Modal L40S. The adapter it writes is served by name by modal/glimmer_app.py.

NOT RUN. Running it is GPU spend on Sidra's Modal credits and needs her typed OK:
  npx tsx scripts/glimmer-eval.ts export                       # builds .data/finetune/glimmer-<date>.jsonl, prints the quote
  modal run modal/glimmer_finetune.py --dataset .data/finetune/glimmer-<date>.jsonl --run-name rw-labels-<date> --confirm-spend
Without --confirm-spend, or below the row floors, it refuses BEFORE any remote call (and the GPU function
refuses again on its own, so a direct `.remote()` can't skip the gate).

What it does
- Input: one {messages, meta} per line (lib/learning/glimmer-eval.ts toModalJsonl): the crop the reader
  saw, the live reader's exact prompt, and the PERSON's serial/SKU as the answer.
- Split by LABEL ID (the printed/rendered label's serial, charger-<n>, or the case for old rows) with a fixed
  seed: sha256(f"{seed}:{labelId}") first 32 bits / 2**32 < fraction -> held out; the real sheet's labels
  (FORCED_HELDOUT_LABELS) always held out. The TypeScript exporter computes the same split; any disagreement refuses the run. Held-out rows
  are NEVER trained on; they are read by the base and by the adapter after training.
- QLoRA: the base loaded in 4-bit NF4 (bitsandbytes, double quantization, BF16 compute); the vision tower,
  vision adapter/projection and lm_head stay unquantized and frozen; LoRA rank 16 on the LANGUAGE MODEL's
  attention (q/k/v/o) and MLP (gate/up/down) projections only.
- Writes /adapters/<run-name>/: adapter_config.json + adapter_model.safetensors (PEFT), metrics.json,
  heldout_reads.base.json, heldout_reads.adapter.json, split.json. It trains in a dot-staging directory
  (never served: the name fails the adapter pattern) and renames it into place only when complete.

Library choice
- transformers 5.19.0: models/muse_glimmer ships since v5.15.0 (MuseGlimmerForConditionalGeneration;
  model.vision_tower, model.language_model, model.vision_adapter, model.vision_projection; text attention
  q/k/v/o_proj + an attention output gate named gate_proj; text MLP gate/up/down_proj; vision attention
  q/k/v_proj + proj, vision MLP fc1/fc2; supports_gradient_checkpointing; _no_split_modules set).
- bitsandbytes 0.50.2 + peft 0.21.2: neither has architecture-specific code. transformers' bnb integration
  swaps nn.Linear for Linear4bit by module name, and PEFT LoRA wraps Linear4bit by module name, so support
  follows from the module layout above. Independent evidence that 4-bit + LoRA works on this model:
  Unsloth's release notes say Glimmer 30B "can run locally on 20GB" and can be fine-tuned "on 20GB VRAM"
  (only possible at ~4-bit). This exact stack has not been run by us yet.
- Why the attention gate is NOT a LoRA target: vLLM 0.32.0 renames the checkpoint's self_attn.gate_proj to
  output_gate_proj, while its LoRA loader validates adapter modules by their last name segment and packs
  gate_proj into the MLP's gate_up_proj. An adapter touching the attention gate could be loaded onto the
  wrong layer. The target regex names the six safe projections explicitly.
- Fallback if 4-bit loading or training fails on the first run: plain LoRA on the BF16 base on one
  A100-80GB ($2.50/h vs $1.95/h for the L40S, +28% per GPU-hour; the A100 is also faster per step, so the
  per-run difference is unmeasured). 59.6 GB of BF16 weights do not fit an L40S at all.

No `from __future__ import annotations` in Modal apps (it broke FastAPI request models in sam31_app.py).
"""

import hashlib
import json
import math
import os
import pathlib
import re
import time

import modal

APP_NAME = "returnwitness-glimmer-finetune"
MODEL_ID = "meta-models/Muse-Glimmer-30B"
MODEL_REVISION = os.environ.get("RW_GLIMMER_REVISION", "cec94fcfd6512f2cfe708138c32533b346ea4f69")  # same pin as glimmer_app.py
GPU = "L40S"
GPU_USD_PER_HOUR = 1.95  # Modal list price; re-read the pricing page before a paid run

# Mirrors lib/learning/glimmer-eval.ts (tests/glimmer-eval.test.ts and modal/check_glimmer_web.py check both sides).
MIN_TRAIN_ROWS = 50  # below this a ~96M-parameter LoRA memorises the crops instead of learning label fonts
MIN_HELDOUT_ROWS = 20  # below this one row is more than 5 points: the switch margin would be noise
HELDOUT_FRACTION = 0.2
SPLIT_SEED = 1729
# The real printed sheet's four serials and two charger labels: always held out, never trained on.
FORCED_HELDOUT_LABELS = ("BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298", "charger-1", "charger-2")
LABEL_CONFIDENCE_FLOOR = 0.7
FT_SECONDS_PER_ROW_EPOCH = 1.2  # measured 1.11 s on the L40S, run rw-labels-2026-10-29 (was an 8 s estimate)
FT_LOAD_SECONDS = 60  # measured 26–46 s for the NF4 load from the cached volume (was a 360 s estimate)
FT_EVAL_SECONDS_PER_GENERATION = 5

LORA_RANK = 16
LORA_ALPHA = 32
LORA_DROPOUT = 0.05
LEARNING_RATE = 1e-4
GRAD_ACCUM = 8
MAX_NEW_TOKENS = 256
N_TEXT_LAYERS = 52
# Language model only: six projections per layer, never the vision tower (its q/k/v_proj share names) and
# never the attention output gate (self_attn.gate_proj; see the header).
LORA_TARGET_REGEX = r"model\.language_model\.layers\.\d+\.(self_attn\.(q_proj|k_proj|v_proj|o_proj)|mlp\.(gate_proj|up_proj|down_proj))"
EXPECTED_LORA_MODULES = N_TEXT_LAYERS * 7
# transformers 5.x matches each pattern with re.match from the START of the full module name, or as a suffix
# (quantizers_utils.should_convert_module), not as a substring as 4.x did. A bare "vision_tower" never matches
# "model.vision_tower.patch_embedder.patch_embedding", so the first run quantized the whole vision
# tower to 4-bit and crashed in its first LayerNorm. ".*" makes each pattern match anywhere in the name.
SKIP_QUANT_MODULES = [r".*vision_tower", r".*vision_adapter", r".*vision_projection", "lm_head"]
VISION_MODULE_PREFIXES = ("model.vision_tower", "model.vision_adapter", "model.vision_projection")


def skipped_by_bnb(full_name: str, patterns: list[str] = SKIP_QUANT_MODULES) -> bool:
    """transformers 5.19's rule (quantizers_utils.should_convert_module), copied so the contract check can run it."""
    return any(re.match(f"{key}\\.", full_name) or re.match(f"{key}", full_name) or full_name.endswith(key) for key in patterns)
RUN_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$", re.I)  # = the served adapter name pattern


class BudgetExceeded(RuntimeError):
    """The wall-clock budget (max_minutes) would be or was passed."""


class SpendRefused(Exception):
    pass


# ---------------------------------------------------------------- pure helpers (no torch; checked locally)


def split_score(case_id: str, seed: int = SPLIT_SEED) -> float:
    return int(hashlib.sha256(f"{seed}:{case_id}".encode()).hexdigest()[:8], 16) / 2**32


def split_of(case_id: str, seed: int = SPLIT_SEED, fraction: float = HELDOUT_FRACTION) -> str:
    return "heldout" if split_score(case_id, seed) < fraction else "train"


def load_lines(text: str) -> list:
    lines = []
    for i, raw in enumerate(text.splitlines()):
        raw = raw.strip()
        if not raw:
            continue
        o = json.loads(raw)
        meta = o.get("meta") or {}
        msgs = o.get("messages")
        if not isinstance(msgs, list) or [m.get("role") for m in msgs] != ["system", "user", "assistant"] or not meta.get("rowId") or not meta.get("caseId"):
            raise ValueError(f"line {i + 1} is not a {{messages: [system, user, assistant], meta}} training line")
        lines.append(o)
    ids = [line["meta"]["rowId"] for line in lines]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate rowId in the dataset")
    return lines


def split_key(meta: dict) -> str:
    """The split groups on the physical/rendered label (no serial in both splits); older rows without one group by case."""
    return meta.get("labelId") or meta["caseId"]


def split_of_meta(meta: dict, seed: int = SPLIT_SEED, fraction: float = HELDOUT_FRACTION) -> str:
    key = split_key(meta)
    return "heldout" if key in FORCED_HELDOUT_LABELS else split_of(key, seed, fraction)


def plan_split(lines: list, seed: int = SPLIT_SEED, fraction: float = HELDOUT_FRACTION) -> dict:
    """Recompute the split; refuse if the exporter labelled any row differently (the rule must be identical)."""
    if not 0 < fraction < 1:
        raise ValueError("fraction must be between 0 and 1")
    train, heldout, mismatched = [], [], []
    for line in lines:
        meta = line["meta"]
        s = split_of_meta(meta, seed, fraction)
        if meta.get("split") is not None and meta["split"] != s:
            mismatched.append(meta["rowId"])
        (heldout if s == "heldout" else train).append(line)
    if mismatched:
        raise ValueError(f"{len(mismatched)} row(s) labelled with a different split than seed {seed} / fraction {fraction} gives (e.g. {mismatched[0]}); re-export")
    train_keys = {split_key(line["meta"]) for line in train}
    leaked = sorted({split_key(line["meta"]) for line in heldout} & train_keys)
    if leaked:
        raise ValueError(f"label id(s) in both splits: {leaked[:3]}")
    return {"train": train, "heldout": heldout}


def quote(train_rows: int, heldout_rows: int, epochs: int) -> dict:
    seconds = FT_LOAD_SECONDS + train_rows * epochs * FT_SECONDS_PER_ROW_EPOCH + heldout_rows * 2 * FT_EVAL_SECONDS_PER_GENERATION
    return {"seconds": seconds, "gpu_hours": round(seconds / 3600, 3), "usd": round(seconds / 3600 * GPU_USD_PER_HOUR, 2), "gpu": GPU}


def check_gates(confirm_spend: bool, plan: dict, run_name: str, epochs: int) -> None:
    """Every gate before any GPU second: name, epochs, row floors, then the explicit spend confirmation."""
    if not RUN_NAME.fullmatch(run_name or ""):
        raise SpendRefused(f"run name {run_name!r} must match {RUN_NAME.pattern} (it becomes the served adapter name)")
    if not isinstance(epochs, int) or not 1 <= epochs <= 10:
        raise SpendRefused("epochs must be a whole number from 1 to 10")
    if len(plan["train"]) < MIN_TRAIN_ROWS:
        raise SpendRefused(f"refusing: {len(plan['train'])} training rows; at least {MIN_TRAIN_ROWS} are needed (see MIN_TRAIN_ROWS)")
    if len(plan["heldout"]) < MIN_HELDOUT_ROWS:
        raise SpendRefused(f"refusing: {len(plan['heldout'])} held-out rows; at least {MIN_HELDOUT_ROWS} are needed for the switch test")
    if confirm_spend is not True:
        raise SpendRefused("refusing: confirm_spend=True not given (a fine-tune run is GPU spend on Modal credits)")


def lr_factor(step: int, warm: int, total: int) -> float:
    if step < warm:
        return (step + 1) / warm
    return max(0.0, (total - step) / max(1, total - warm))


def first_json_object(text: str):
    """The first balanced {...} after any <think>…</think> block, parsed; None if there is none."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    start = text.find("{")
    while start != -1:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def parse_read(text: str, item_key: str):
    """A Glimmer answer -> the item dict for item_key (schema-checked), or None."""
    o = first_json_object(text)
    items = o.get("items") if isinstance(o, dict) else None
    if not isinstance(items, list):
        return None
    good = []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("itemKey"), str) or not isinstance(it.get("legible"), bool):
            continue
        c = it.get("confidence")
        if isinstance(c, bool) or not isinstance(c, (int, float)) or not 0 <= c <= 1:
            continue
        s, k = it.get("serialRead"), it.get("skuRead")
        if (s is not None and not isinstance(s, str)) or (k is not None and not isinstance(k, str)):
            continue
        good.append({"itemKey": it["itemKey"], "serialRead": s, "skuRead": k, "legible": it["legible"], "confidence": float(c)})
    return next((g for g in good if g["itemKey"] == item_key), good[0] if good else None)


def _norm(s):
    return re.sub(r"[^A-Za-z0-9]", "", s).upper() if isinstance(s, str) else ""


def _same(a, b) -> bool:
    return isinstance(a, str) and isinstance(b, str) and _norm(a) != "" and _norm(a) == _norm(b)


def judge_row(meta: dict, read, floor: float = LABEL_CONFIDENCE_FLOOR) -> dict:
    """Port of judgeRow in lib/learning/glimmer-eval.ts (the TypeScript side decides the switch)."""
    truth, exp = meta["truth"], meta["expected"]
    if read is None:
        return {"read": False, "serialExact": False, "skuMatch": None if truth.get("sku") is None else False, "falseClear": None}
    trusted = bool(read["legible"]) and read["confidence"] >= floor
    ts = read["serialRead"] if trusted and (read.get("serialRead") or "").strip() else None
    tk = read["skuRead"] if trusted and (read.get("skuRead") or "").strip() else None
    exact = ts is None if (truth.get("serialUnreadable") or truth.get("serial") is None) else _same(ts, truth["serial"])
    sku = None if truth.get("sku") is None else _same(tk, truth["sku"])
    truth_passes = not truth.get("serialUnreadable") and _same(truth.get("serial"), exp.get("serial"))
    serial_fc = bool(exp.get("requiresSerial")) and exp.get("serial") is not None and _same(ts, exp["serial"]) and not truth_passes
    sku_fc = exp.get("sku") is not None and truth.get("sku") is not None and not _same(truth["sku"], exp["sku"]) and _same(tk, exp["sku"])
    return {"read": True, "serialExact": exact, "skuMatch": sku, "falseClear": "serial" if serial_fc else "sku" if sku_fc else None}


def evaluate(metas: list, reads: list) -> dict:
    by_id = {}
    for r in reads:
        by_id.setdefault(r["rowId"], r)
    js = [dict(rowId=m["rowId"], **judge_row(m, (by_id.get(m["rowId"]) or {}).get("read"))) for m in metas]
    n = len(js)
    sku_rows = [j for j in js if j["skuMatch"] is not None]
    fc = [j for j in js if j["falseClear"]]
    exact = sum(1 for j in js if j["serialExact"])
    return {
        "rows": n,
        "exactSerial": exact,
        "exactSerialRate": exact / n if n else 0,
        "skuRows": len(sku_rows),
        "skuMatch": sum(1 for j in sku_rows if j["skuMatch"]),
        "falseClears": {"serial": sum(1 for j in fc if j["falseClear"] == "serial"), "sku": sum(1 for j in fc if j["falseClear"] == "sku"), "total": len(fc)},
        "errors": sum(1 for j in js if not j["read"]),
    }


def decode_data_url(url: str):
    import base64
    import io

    from PIL import Image

    if not url.startswith("data:image/") or ";base64," not in url:
        raise ValueError("crop is not a base64 data URL")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1], validate=True))).convert("RGB")


def to_hf_messages(messages: list, with_answer: bool) -> list:
    """OpenAI-style rows -> the processor's chat format (images as PIL), the same turns vLLM renders."""
    out = []
    for m in messages:
        if m["role"] == "assistant" and not with_answer:
            continue
        c = m["content"]
        if isinstance(c, str):
            parts = [{"type": "text", "text": c}]
        else:
            parts = []
            for p in c:
                if p["type"] == "text":
                    parts.append({"type": "text", "text": p["text"]})
                elif p["type"] == "image_url":
                    parts.append({"type": "image", "image": decode_data_url(p["image_url"]["url"])})
        msg = {"role": m["role"], "content": parts}
        # Recipe v2: the rationale rides as reasoning_content, which the chat template renders as the thinking block.
        if m["role"] == "assistant" and m.get("reasoning_content"):
            msg["reasoning_content"] = m["reasoning_content"]
        out.append(msg)
    return out


def recipe_of(lines: list) -> str:
    """v2 when the training rows carry reasoning targets (scripts/glimmer-eval.ts export --recipe v2), else v1."""
    flags = {bool(l["messages"][2].get("reasoning_content")) for l in lines}
    if len(flags) > 1:
        raise ValueError("mixed recipes: some training rows carry reasoning_content and some don't")
    return "v2-reasoning-targets" if flags == {True} else "v1-answer-only"


# ---------------------------------------------------------------- Modal

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch==2.13.0",  # the torch vLLM 0.32.0 pins, so training and serving share a kernel stack
        "torchvision==0.28.0",
        "transformers==5.19.0",  # muse_glimmer since 5.15.0; same version as the serving image
        "peft==0.21.2",
        "bitsandbytes==0.50.2",
        "accelerate==1.15.0",
        "safetensors==0.8.0",
        "huggingface_hub==1.33.0",
        "pillow==12.3.0",
    )
    .env({"HF_HOME": "/cache/hf", "HF_XET_HIGH_PERFORMANCE": "1"})
)

app = modal.App(APP_NAME)
weights = modal.Volume.from_name("returnwitness-glimmer-weights", create_if_missing=True)  # shared with glimmer_app.py
adapters_vol = modal.Volume.from_name("returnwitness-glimmer-adapters", create_if_missing=True)


@app.function(gpu=GPU, image=image, volumes={"/cache": weights, "/adapters": adapters_vol}, timeout=6 * 3600, max_containers=1)
def finetune(dataset_jsonl: str, run_name: str, confirm_spend: bool = False, epochs: int = 3, seed: int = SPLIT_SEED, fraction: float = HELDOUT_FRACTION, inprocess_eval: bool = True, max_minutes: float = 0.0) -> dict:
    """max_minutes > 0: a wall-clock budget for the whole job (load + train + optional eval). The job projects its
    finish after the first rows and stops before training on if the projection is over budget, and stops at the
    budget in any case; a stopped run leaves no servable adapter (only complete runs are renamed into place)."""
    lines = load_lines(dataset_jsonl)
    plan = plan_split(lines, seed, fraction)
    check_gates(confirm_spend, plan, run_name, epochs)  # again here: a direct .remote() can't skip it

    import random

    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoProcessor, BitsAndBytesConfig, MuseGlimmerForConditionalGeneration, set_seed

    if not torch.cuda.is_available():
        raise RuntimeError(f"QLoRA needs a CUDA GPU; this container has none (requested gpu={GPU!r})")
    final_dir = pathlib.Path("/adapters") / run_name
    if final_dir.exists():
        raise SpendRefused(f"/adapters/{run_name} already exists; choose a new run name (adapters are never overwritten)")
    stage = pathlib.Path("/adapters") / f".staging-{run_name}"
    stage.mkdir(parents=True, exist_ok=True)
    t_start = time.perf_counter()
    set_seed(seed)
    random.seed(seed)

    processor = AutoProcessor.from_pretrained(MODEL_ID, revision=MODEL_REVISION)
    model = MuseGlimmerForConditionalGeneration.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            llm_int8_skip_modules=SKIP_QUANT_MODULES,  # also applies to 4-bit: the vision side stays BF16
        ),
        dtype=torch.bfloat16,
        device_map={"": 0},
        attn_implementation="sdpa",
    )
    weights.commit()
    load_s = time.perf_counter() - t_start
    # Fail before any training second if any vision module was quantized (it must stay BF16 and frozen).
    import bitsandbytes as bnb

    quantized_vision = [n for n, m in model.named_modules() if n.startswith(VISION_MODULE_PREFIXES) and isinstance(m, bnb.nn.Linear4bit)]
    if quantized_vision:
        raise RuntimeError(f"{len(quantized_vision)} vision modules were quantized to 4-bit (e.g. {quantized_vision[0]}); the skip list did not match")
    pe = model.model.vision_tower.patch_embedder.patch_embedding.weight.dtype
    if pe != torch.bfloat16:
        raise RuntimeError(f"vision patch embedding is {pe}, expected bfloat16")
    for p in model.parameters():
        p.requires_grad = False  # everything frozen; LoRA adds the only trainable weights
    model.config.use_cache = False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    matched = [n for n, _ in model.named_modules() if re.fullmatch(LORA_TARGET_REGEX, n)]
    if len(matched) != EXPECTED_LORA_MODULES:
        raise RuntimeError(f"LoRA target regex matched {len(matched)} modules, expected {EXPECTED_LORA_MODULES}: the module layout changed; re-check before training")
    model = get_peft_model(model, LoraConfig(r=LORA_RANK, lora_alpha=LORA_ALPHA, lora_dropout=LORA_DROPOUT, bias="none", target_modules=LORA_TARGET_REGEX, task_type="CAUSAL_LM"))
    trainable = [n for n, p in model.named_parameters() if p.requires_grad]
    if not trainable or any("vision" in n for n in trainable):
        raise RuntimeError("the vision tower must stay frozen and only LoRA weights may train")
    n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)

    def encode(line: dict):
        full = processor.apply_chat_template(to_hf_messages(line["messages"], True), tokenize=True, return_dict=True, return_tensors="pt")
        prompt = processor.apply_chat_template(to_hf_messages(line["messages"], False), tokenize=True, return_dict=True, return_tensors="pt", add_generation_prompt=True)
        n = prompt["input_ids"].shape[1]
        if not torch.equal(full["input_ids"][:, :n], prompt["input_ids"]):
            raise RuntimeError("the chat template's prompt is not a prefix of prompt+answer; loss masking would be wrong")
        rationale = line["messages"][2].get("reasoning_content")
        if rationale:
            # The guide's point is that the reasoning is IN the target; refuse rather than silently train answer-only.
            target_text = processor.tokenizer.decode(full["input_ids"][0, n:], skip_special_tokens=False)
            if rationale[:48] not in target_text:
                raise RuntimeError("recipe v2: the chat template did not render reasoning_content in the target; not training")
        labels = full["input_ids"].clone()
        labels[:, :n] = -100  # learn the answer (and, in recipe v2, its rationale) only, never the prompt or the image tokens
        full["labels"] = labels
        return full

    recipe = recipe_of(plan["train"])
    print(f"recipe: {recipe} · sample packing: off (one row per step)")
    train = [encode(line) for line in plan["train"]]
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=LEARNING_RATE, weight_decay=0.0)
    total = max(1, math.ceil(len(train) * epochs / GRAD_ACCUM))
    warm = max(1, total // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: lr_factor(s, warm, total))  # linear warm-up, then linear decay
    rng = random.Random(seed)
    model.train()
    epoch_loss, t_train = [], time.perf_counter()
    step = 0
    rows_total = len(train) * epochs
    eval_estimate_s = len(plan["heldout"]) * 2 * FT_EVAL_SECONDS_PER_GENERATION if inprocess_eval else 0
    budget_s = max_minutes * 60 if max_minutes and max_minutes > 0 else None
    print(f"loaded in {load_s:.0f}s; training {len(train)} rows x {epochs} epochs ({rows_total} rows), budget {f'{budget_s:.0f}s' if budget_s else 'none'}", flush=True)
    done = 0
    for e in range(epochs):
        order = list(range(len(train)))
        rng.shuffle(order)
        losses = []
        for i, idx in enumerate(order):
            if budget_s is not None:
                elapsed = time.perf_counter() - t_start
                if done >= 16:
                    per_row = (time.perf_counter() - t_train) / done
                    projected = elapsed + per_row * (rows_total - done) + eval_estimate_s
                    if projected > budget_s:
                        raise BudgetExceeded(f"projected {projected:.0f}s (at {per_row:.1f}s/row after {done} rows) is over the {budget_s:.0f}s budget; stopped before spending it")
                if elapsed > budget_s:
                    raise BudgetExceeded(f"{elapsed:.0f}s elapsed, over the {budget_s:.0f}s budget")
            batch = {k: (v.to(0, dtype=torch.bfloat16) if k == "pixel_values" else v.to(0)) for k, v in train[idx].items()}
            loss = model(**batch).loss
            (loss / GRAD_ACCUM).backward()
            losses.append(float(loss.detach()))
            done += 1
            if done % 10 == 0 or done == rows_total:
                tr = time.perf_counter() - t_train
                print(f"epoch {e + 1}/{epochs} row {i + 1}/{len(order)} · {tr:.0f}s training · {tr / done:.1f}s/row · loss {sum(losses[-10:]) / len(losses[-10:]):.4f} · projected job {time.perf_counter() - t_start + tr / done * (rows_total - done) + eval_estimate_s:.0f}s", flush=True)
            if (i + 1) % GRAD_ACCUM == 0 or i + 1 == len(order):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
                step += 1
        epoch_loss.append(round(sum(losses) / max(1, len(losses)), 5))
    train_s = time.perf_counter() - t_train
    model.save_pretrained(str(stage))

    # Held-out reads: never trained on; the same rows read by the base (adapter disabled) and the adapter.
    model.eval()
    model.config.use_cache = True

    def read_row(line: dict):
        inputs = processor.apply_chat_template(to_hf_messages(line["messages"], False), tokenize=True, return_dict=True, return_tensors="pt", add_generation_prompt=True)
        inputs = {k: (v.to(0, dtype=torch.bfloat16) if k == "pixel_values" else v.to(0)) for k, v in inputs.items()}
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=False)
        text = processor.decode(out[0, inputs["input_ids"].shape[1] :], skip_special_tokens=True)
        r = parse_read(text, line["meta"]["itemKey"])
        return {"rowId": line["meta"]["rowId"], "read": r, **({} if r else {"error": "answer didn't match the schema"})}

    t_eval = time.perf_counter()
    base_reads: list = []
    adapter_reads: list = []
    if inprocess_eval:
        with model.disable_adapter():
            base_reads = [read_row(line) for line in plan["heldout"]]
        adapter_reads = [read_row(line) for line in plan["heldout"]]
    eval_s = time.perf_counter() - t_eval
    metas = [line["meta"] for line in plan["heldout"]]
    total_s = time.perf_counter() - t_start
    import peft
    import transformers

    metrics = {
        "run": run_name,
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "seed": seed,
        "heldout_fraction": fraction,
        "epochs": epochs,
        "rows": {"train": len(plan["train"]), "heldout": len(plan["heldout"]), "total": len(lines)},
        "dataset_sha256": hashlib.sha256(dataset_jsonl.encode()).hexdigest(),
        "recipe": recipe,
        "sample_packing": False,
        "lora": {"rank": LORA_RANK, "alpha": LORA_ALPHA, "dropout": LORA_DROPOUT, "targets": LORA_TARGET_REGEX, "modules": len(matched), "trainable_params": n_trainable},
        "optim": {"lr": LEARNING_RATE, "grad_accum": GRAD_ACCUM, "steps": step},
        "train_loss_by_epoch": epoch_loss,
        "heldout_inprocess": (
            {
                "note": "NF4 base, HF generate, greedy. Informational: the switch is decided by scripts/glimmer-eval.ts on reads through the served FP8 endpoint.",
                "base": evaluate(metas, base_reads),
                "adapter": evaluate(metas, adapter_reads),
            }
            if inprocess_eval
            else {"skipped": "inprocess_eval=False (informational only; the served FP8 endpoint decides the switch)"}
        ),
        "seconds": {"load": round(load_s, 1), "train": round(train_s, 1), "eval": round(eval_s, 1), "total": round(total_s, 1), "per_row_epoch": round(train_s / max(1, len(train) * epochs), 2)},
        "gpu": {"name": torch.cuda.get_device_name(0), "peak_mb": round(torch.cuda.max_memory_allocated() / 1048576), "usd_at_list_price": round(total_s / 3600 * GPU_USD_PER_HOUR, 2)},
        "versions": {"torch": str(torch.__version__), "transformers": str(transformers.__version__), "peft": str(peft.__version__)},  # str(): TorchVersion pickles as a torch object, which the local client (no torch) cannot load
    }
    (stage / "metrics.json").write_text(json.dumps(metrics, indent=1))
    (stage / "heldout_reads.base.json").write_text(json.dumps(base_reads, indent=1))
    (stage / "heldout_reads.adapter.json").write_text(json.dumps(adapter_reads, indent=1))
    (stage / "split.json").write_text(json.dumps({"seed": seed, "fraction": fraction, "train": [line["meta"]["rowId"] for line in plan["train"]], "heldout": [m["rowId"] for m in metas]}))
    os.replace(stage, final_dir)  # only a complete adapter ever gets a servable name
    adapters_vol.commit()
    return metrics


@app.local_entrypoint()
def main(dataset: str, run_name: str, confirm_spend: bool = False, epochs: int = 3, seed: int = SPLIT_SEED, fraction: float = HELDOUT_FRACTION, inprocess_eval: bool = True, max_minutes: float = 0.0) -> None:
    text = pathlib.Path(dataset).read_text()
    lines = load_lines(text)
    plan = plan_split(lines, seed, fraction)
    q = quote(len(plan["train"]), len(plan["heldout"]), epochs)
    print(f"{len(lines)} rows: {len(plan['train'])} train, {len(plan['heldout'])} held out (seed {seed}, fraction {fraction})")
    print(f"Quote: ~${q['usd']:.2f} for ~{q['gpu_hours']} GPU-hours on one {q['gpu']} at ${GPU_USD_PER_HOUR}/h (estimates; metrics.json records the measured seconds)")
    try:
        check_gates(confirm_spend, plan, run_name, epochs)
    except SpendRefused as e:
        print(str(e))
        raise SystemExit(2)
    if max_minutes:
        print(f"Budget: stops at {max_minutes:g} min of GPU wall clock (about ${max_minutes / 60 * GPU_USD_PER_HOUR:.2f}), or earlier if the projection after 16 rows is over it")
    metrics = finetune.remote(text, run_name, confirm_spend=True, epochs=epochs, seed=seed, fraction=fraction, inprocess_eval=inprocess_eval, max_minutes=max_minutes)
    print(json.dumps({k: metrics[k] for k in ("run", "rows", "train_loss_by_epoch", "heldout_inprocess", "seconds", "gpu")}, indent=1))
    print(f"Adapter at /adapters/{run_name} on volume returnwitness-glimmer-adapters. Next: redeploy glimmer_app.py (it lists adapters at start),")
    print(f"then: npx tsx --env-file=.env.local scripts/glimmer-eval.ts live --data {dataset} --adapter-name {run_name} --confirm-spend --record")
