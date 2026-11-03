"""
ReturnWitness: Muse Glimmer open weights (meta-models/Muse-Glimmer-30B) on a Modal GPU, the LABEL READER.

DEPLOYED on one L40S (vLLM 0.32.0, FP8) and read live, including the label crops of the filmed bench clips. Each deploy
or change on Modal is a cloud write that needs Sidra's typed OK (see modal/README.md). The HTTP layer is checked locally by modal/check_glimmer_web.py (modal, vllm
and torch stubbed, a fake engine), `npm run check:glimmer-web`.

What it serves: vLLM 0.32.0's OpenAI-compatible server for Glimmer on ONE L40S, the weights quantized
to FP8 at load, with LoRA enabled so a fine-tuned adapter (modal/glimmer_finetune.py writes it to the
adapters volume) is served BY NAME next to the base model on the same GPU. A small FastAPI front puts a
bearer-token check in front of it.

Contract (the TypeScript client lib/openweights/glimmer-modal.ts speaks exactly this):
  POST /v1/chat/completions   Authorization: Bearer <MODAL_GLIMMER_TOKEN>
    an OpenAI chat-completions body; `model` = the base id or a served adapter name; no streaming;
    at most MAX_IMAGES images
    -> vLLM's response, plus `gpu_seconds` (wall clock this request spent in the engine, measured here;
       NOT a Modal billing figure)
  GET  /healthz              (no auth, no data) -> {ok, ready, model, revision, gpu, adapters, vllm, load_s}
  A cold app boots a GPU container to answer either one; that time is billed.

Facts this file relies on:
- config.json at the pinned revision: MuseGlimmerForConditionalGeneration, 52 text layers, 2 KV heads,
  head_dim 128, sliding_window 2048 on three of every four layers (13 full-attention layers), BF16.
- processor_config.json: max_image_tokens 4096 per image (14 px patches, 2x2 merge, so a 28x28 px
  square per token after the merge).
- vLLM v0.32.0 registry maps MuseGlimmerForConditionalGeneration to models/muse_glimmer.py
  (MuseGlimmerForCausalLM: SupportsLoRA, SupportsMultiModal, SupportsPP); its requirements pin
  torch==2.13.0 and transformers>=5.16.1,<5.20.0; fastapi[standard]>=0.133,<0.137.
What only a first GPU run can prove: FP8 online quantization of this architecture on Ada loads cleanly,
LoRA on top of the FP8 base serves a QLoRA-trained adapter correctly, the cold-start time, and the
KV-cache figure vLLM reports at start (compare it with the math at MAX_MODEL_LEN).
"""

import hmac
import json
import os
import pathlib
import re
import subprocess
import time

import modal

APP_NAME = "returnwitness-glimmer"
MODEL_ID = "meta-models/Muse-Glimmer-30B"
# Pin the Hugging Face revision: an unpinned `main` would silently change the weights under a running
# product. cec94fcf = head of main. Override only after re-checking.
MODEL_REVISION = os.environ.get("RW_GLIMMER_REVISION", "cec94fcfd6512f2cfe708138c32533b346ea4f69")
VLLM_VERSION = "0.32.0"
GPU = "L40S"  # 48 GB, Ada (sm_89): FP8 tensor cores, so `--quantization fp8` runs natively. BF16 (59.6 GB) does not fit.

# ---- Context length, from the KV-cache math -------------------------------------------------------
# One label read = the system prompt + kit list (~600 tokens) + up to 4 crops + a JSON answer (the
# client caps max_tokens at 2048). The image processor caps an image at 4,096 tokens (a 1024 px crop is
# ~1,000: 1024/28 x 768/28), and vLLM profiles memory with the cap, so budget the cap:
#   4 images x 4,096 + 1,024 prompt + 2,048 answer = 19,456  ->  MAX_MODEL_LEN = 20,480 (20 x 1,024).
# KV per token per layer = 2 (K,V) x 2 KV heads x 128 head_dim x 2 bytes (BF16 KV) = 1,024 B.
#   13 full-attention layers keep every token:    13 x 1,024 B x 20,480        = 273 MB per sequence
#   39 sliding layers keep at most 2,048 tokens:  39 x 1,024 B x 2,048         =  82 MB per sequence
#   -> ~355 MB per max-length sequence (1.09 GB if the allocator kept all 52 layers at full length).
# Memory: 48 GB x 0.90 utilization = 43.2 GB; FP8 weights ~30 GB (the vision tower may stay BF16);
# activations, the encoder cache and CUDA graphs ~4 GB  ->  ~9 GB for KV = 25+ max-length sequences
# (8 even in the pessimistic case). MAX_NUM_SEQS = 4 leaves the headroom for LoRA slots and long prompts.
# A longer context buys nothing a label read uses; the full 131k would only enlarge profiling.
MAX_IMAGES = 4
MAX_MODEL_LEN = 20_480
MAX_NUM_SEQS = 4
GPU_MEMORY_UTILIZATION = 0.90
MAX_LORA_RANK = 16  # glimmer_finetune.py trains rank 16; vLLM refuses an adapter above this rank
MAX_LORAS = 1  # adapters resident on the GPU per batch, beside the base
MAX_CPU_LORAS = 4
MAX_BODY_BYTES = 8 * 1024 * 1024  # 4 crops of ~200 KB base64 each, with lots of room
MAX_TOKENS_CAP = 4096
ENGINE_PORT = 8000
ADAPTER_DIR = "/adapters"
ADAPTER_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$", re.I)  # same pattern as the TS client

image = (
    modal.Image.debian_slim(python_version="3.12")
    # vLLM 0.32.0 brings torch==2.13.0 / torchvision==0.28.0 (its own pins). The rest are pinned here
    # inside vLLM's declared ranges, so pip has exactly one solution.
    .pip_install(
        f"vllm=={VLLM_VERSION}",
        "transformers==5.19.0",  # vLLM 0.32.0: >=5.16.1,<5.20.0; muse_glimmer ships in transformers since 5.15.0
        "huggingface_hub==1.33.0",  # vLLM 0.32.0: >=1.31.0
        "fastapi[standard]==0.136.3",  # vLLM 0.32.0: >=0.133.0,<0.137.0
        "httpx==0.28.1",
    )
    .env(
        {
            "HF_HOME": "/cache/hf",
            "HF_XET_HIGH_PERFORMANCE": "1",
            "VLLM_CACHE_ROOT": "/cache/vllm",  # torch.compile / CUDA graph caches survive cold starts
            # FlashInfer's top-k/top-p sampler JIT-compiles a CUDA kernel on first use and needs nvcc, which this
            # slim image doesn't have: the first cold start died in sampler warm-up with "Could not
            # find nvcc". 0 = vLLM's native top-k/top-p path (vllm/v1/sample/ops/topk_topp_sampler.py at 0.32.0).
            # The reader runs at temperature 0, so the sampler can't change a read.
            "VLLM_USE_FLASHINFER_SAMPLER": "0",
        }
    )
)

app = modal.App(APP_NAME)
# Weights (59.6 GB BF16) persist on a volume so a cold start reads them from Modal, not Hugging Face.
weights = modal.Volume.from_name("returnwitness-glimmer-weights", create_if_missing=True)
# Fine-tuned LoRA adapters, one directory per served name (written by glimmer_finetune.py).
adapters_vol = modal.Volume.from_name("returnwitness-glimmer-adapters", create_if_missing=True)


def discover_adapters(root: str = ADAPTER_DIR) -> dict:
    """{name: path} for every <root>/<name>/ holding a PEFT adapter trained on THIS base model."""
    found = {}
    base = pathlib.Path(root)
    if not base.is_dir():
        return found
    for d in sorted(base.iterdir()):
        cfg = d / "adapter_config.json"
        if not d.is_dir() or not ADAPTER_NAME.fullmatch(d.name) or not cfg.is_file() or not (d / "adapter_model.safetensors").is_file():
            continue
        try:
            meta = json.loads(cfg.read_text())
        except (OSError, ValueError):
            continue
        if meta.get("base_model_name_or_path") != MODEL_ID or int(meta.get("r", 0)) > MAX_LORA_RANK:
            continue  # trained on another base, or a rank vLLM was not started for: never serve it
        found[d.name] = str(d)
    return found


def vllm_command(adapters: dict) -> list:
    """The `vllm serve` command line. Every flag is explained where its value is defined above."""
    cmd = [
        "vllm",
        "serve",
        MODEL_ID,
        "--revision",
        MODEL_REVISION,
        "--served-model-name",
        MODEL_ID,
        "--host",
        "127.0.0.1",  # only the FastAPI front (same container) can reach the engine
        "--port",
        str(ENGINE_PORT),
        "--quantization",
        "fp8",  # dynamic FP8 weights at load: ~30 GB instead of 59.6 GB, runs on Ada FP8 tensor cores
        "--max-model-len",
        str(MAX_MODEL_LEN),
        "--max-num-seqs",
        str(MAX_NUM_SEQS),
        "--gpu-memory-utilization",
        str(GPU_MEMORY_UTILIZATION),
        "--limit-mm-per-prompt",
        json.dumps({"image": MAX_IMAGES, "video": 0}),  # crops only; no video budget reserved
        "--enable-lora",
        "--max-lora-rank",
        str(MAX_LORA_RANK),
        "--max-loras",
        str(MAX_LORAS),
        "--max-cpu-loras",
        str(MAX_CPU_LORAS),
        "--generation-config",
        "vllm",  # don't inherit the model's sampling defaults (temperature 1.0); the client sends temperature 0
    ]
    # KV cache stays BF16 (the default): the math above shows it fits, and an FP8 KV cache would be a
    # second precision loss on exact character transcription for no gain at 4 sequences.
    for name, path in adapters.items():
        cmd += ["--lora-modules", json.dumps({"name": name, "path": path, "base_model_name": MODEL_ID})]
    return cmd


def require_cuda() -> str:
    """vLLM's FP8 path needs a CUDA GPU: fail the container at start rather than limp along on CPU."""
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError(f"Muse Glimmer serving needs a CUDA GPU; this container has none (requested gpu={GPU!r})")
    return torch.cuda.get_device_name(0)


def count_images(messages) -> int:
    n = 0
    for m in messages if isinstance(messages, list) else []:
        content = m.get("content") if isinstance(m, dict) else None
        if isinstance(content, list):
            n += sum(1 for p in content if isinstance(p, dict) and p.get("type") in ("image_url", "image", "input_image"))
    return n


class HttpEngine:
    """The vLLM server in this container, over loopback HTTP."""

    def __init__(self, port: int = ENGINE_PORT) -> None:
        import httpx

        self.client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=120.0)

    async def chat(self, body: dict):
        r = await self.client.post("/v1/chat/completions", json=body)
        try:
            return r.status_code, r.json()
        except ValueError:
            return 502, {"error": {"message": f"engine returned non-JSON (HTTP {r.status_code})"}}


def build_api(engine, info: dict, token: str):
    """The public HTTP layer: auth, request limits, the engine call, gpu_seconds. Pure enough to test."""
    from fastapi import Depends, FastAPI, Header, HTTPException, Request
    from fastapi.responses import JSONResponse

    if not token:
        raise RuntimeError("MODAL_GLIMMER_TOKEN is empty: refusing to serve without a bearer token")
    expected = token.encode()
    api = FastAPI(title="ReturnWitness Muse Glimmer (open weights)")

    def auth(authorization: str | None = Header(default=None)) -> None:
        given = (authorization or "").removeprefix("Bearer ").encode()
        # Constant-time compare: the token is the only thing between the internet and my GPU bill.
        if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(given, expected):
            raise HTTPException(status_code=401, detail="bad or missing bearer token")

    @api.get("/healthz")
    def healthz() -> dict:
        return {
            "ok": True,
            "ready": bool(info.get("ready")),
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "gpu": info.get("gpu"),
            "adapters": sorted(info.get("adapters", {})),
            "vllm": info.get("vllm"),
            "load_s": info.get("load_s"),
        }

    @api.post("/v1/chat/completions", dependencies=[Depends(auth)])
    async def chat(request: Request):
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail=f"request over {MAX_BODY_BYTES // 1048576} MB")
        try:
            body = json.loads(raw)
        except ValueError:
            raise HTTPException(status_code=400, detail="body is not JSON")
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list) or not body["messages"]:
            raise HTTPException(status_code=400, detail="messages is required")
        model = body.get("model")
        served = {MODEL_ID, *info.get("adapters", {})}
        if model not in served:
            raise HTTPException(status_code=404, detail=f"model {str(model)[:80]!r} is not served here (served: {sorted(served)})")
        if body.get("stream"):
            raise HTTPException(status_code=400, detail="streaming is not supported by this endpoint")
        if count_images(body["messages"]) > MAX_IMAGES:
            raise HTTPException(status_code=400, detail=f"at most {MAX_IMAGES} images per request")
        mt = body.get("max_tokens")
        if mt is not None and (not isinstance(mt, int) or mt < 1):
            raise HTTPException(status_code=400, detail="max_tokens must be a positive integer")
        body["max_tokens"] = min(mt or 2048, MAX_TOKENS_CAP)
        t0 = time.perf_counter()
        try:
            status, out = await engine.chat(body)
        except Exception as e:  # engine down / restarting: say so, never hang
            raise HTTPException(status_code=503, detail=f"engine unavailable: {type(e).__name__}")
        if isinstance(out, dict):
            out["gpu_seconds"] = round(time.perf_counter() - t0, 3)
        return JSONResponse(status_code=status, content=out)

    return api


@app.function(image=image, volumes={"/cache": weights}, timeout=3600)
def download_weights() -> dict:
    """Fill the weights volume on a CPU container (no GPU billed while 59.6 GB download). Run once before
    the first deploy: `modal run modal/glimmer_app.py::download_weights` (a cloud write: Sidra's typed OK)."""
    from huggingface_hub import snapshot_download

    t0 = time.perf_counter()
    path = snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=["*.json", "*.jinja", "*.safetensors"])
    weights.commit()
    return {"path": path, "seconds": round(time.perf_counter() - t0, 1)}


@app.cls(
    gpu=GPU,
    image=image,
    volumes={"/cache": weights, ADAPTER_DIR: adapters_vol},
    secrets=[modal.Secret.from_name("returnwitness-glimmer-token")],  # MODAL_GLIMMER_TOKEN
    min_containers=0,  # idle costs nothing
    scaledown_window=120,  # a warm container lives 2 min after its last request, then scales to zero
    max_containers=1,  # hard ceiling: one L40S at most, ever
    timeout=600,
    startup_timeout=1800,  # first boot reads 59.6 GB, quantizes to FP8 and compiles; minutes, not seconds
)
@modal.concurrent(max_inputs=8)  # requests share the one container; vLLM batches up to MAX_NUM_SEQS
class Glimmer:
    @modal.enter()
    def start(self) -> None:
        t0 = time.perf_counter()
        self.info = {"ready": False, "adapters": {}, "gpu": require_cuda()}
        import vllm

        if vllm.__version__ != VLLM_VERSION:
            raise RuntimeError(f"vLLM {vllm.__version__} in the image, {VLLM_VERSION} pinned")
        self.info["vllm"] = vllm.__version__
        adapters_vol.reload()  # see adapters written since this container's volume snapshot
        self.info["adapters"] = discover_adapters(ADAPTER_DIR)
        self.proc = subprocess.Popen(vllm_command(self.info["adapters"]))
        self._wait_ready(deadline=time.monotonic() + 1700)
        self.engine = HttpEngine()
        self.info["ready"] = True
        self.info["load_s"] = round(time.perf_counter() - t0, 1)
        weights.commit()  # keep anything vLLM downloaded or compiled for the next cold start

    def _wait_ready(self, deadline: float) -> None:
        import httpx

        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"vllm serve exited with code {self.proc.returncode} during start")
            try:
                if httpx.get(f"http://127.0.0.1:{ENGINE_PORT}/health", timeout=2).status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(2)
        raise RuntimeError("vllm serve was not ready before the start deadline")

    @modal.exit()
    def stop(self) -> None:
        proc = getattr(self, "proc", None)
        if proc and proc.poll() is None:
            proc.terminate()

    @modal.asgi_app()
    def web(self):
        return build_api(self.engine, self.info, os.environ["MODAL_GLIMMER_TOKEN"])
