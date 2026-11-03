"""
ReturnWitness: SAM 3.1 open weights (facebook/sam3.1) on a Modal GPU, the FAILOVER segmenter.

DEPLOYED on one L40S; its smoke test passed on a synthetic 25-frame clip, and it has not segmented the filmed bench clips.
Each deploy or change on Modal is a cloud write that needs Sidra's typed OK (see modal/README.md). The SAM 3.1 calls below were checked against facebookresearch/sam3
at the pinned commit: the builder `build_sam3_multiplex_video_predictor`, the request
types in `sam3/model/sam3_base_predictor.py`, the output keys and normalised XYWH boxes in
`sam3/visualization_utils.py`, the checkpoint name in `download_ckpt_from_hf`, and the install pins
in the repo README. What only a first run can prove is listed in modal/README.md.

Contract (the TypeScript client lib/openweights/modal-sam.ts parses exactly this):
  POST /segment   Authorization: Bearer <MODAL_SAM_TOKEN>
    request  {clipId, fps, concepts: [str], video_b64}
    response {frames: [{frame_index, objects: [{track_id, concept, box: [x0,y0,x1,y1] (pixels), score, area}]}],
              width, height, model, gpu_seconds, peak_gpu_mb, request_id}
  GET  /healthz   -> {ok, model, gpu, loaded}   (no auth, no data; boots a GPU container when cold)

`gpu_seconds` is the wall-clock time this request held the GPU container (decode + inference),
measured here. It is NOT a Modal billing figure; Modal's usage page is the source of truth for cost.
"""


import base64
import hmac
import os
import re
import tempfile
import time
import uuid

import modal

APP_NAME = "returnwitness-sam31"
MODEL_ID = "facebook/sam3.1"
GPU = "L40S"  # 48 GB, Ada (sm_89). FlashAttention 3 is Hopper-only, so it is off here (USE_FA3); see README.
# SAM 3.1's FA3 path (sam3/perflib/fa3.py) casts q/k/v to float8 and calls flash_attn_interface,
# built for Hopper. On an H100 it could be turned on with `pip install flash-attn-3`.
USE_FA3 = False
CKPT_FILE = "sam3.1_multiplex.pt"  # facebook/sam3.1 file list; also what sam3's download_ckpt_from_hf fetches
MAX_VIDEO_BYTES = 25 * 1024 * 1024  # same cap as the client; a prepared 5 fps / 720p clip is a few MB
MAX_CONCEPTS = 16

# Pin the facebookresearch/sam3 commit at deploy: RW_SAM3_COMMIT=<40-char sha> modal deploy modal/sam31_app.py
# An unpinned `main` would silently change the model code under a running product.
# Pinned: f1647e8d "Remove unused type error suppressions", the head of main
# when the API below was checked; it carries SAM 3.1 multiplex. Override only after re-checking.
SAM3_COMMIT = os.environ.get("RW_SAM3_COMMIT", "f1647e8d0c1d280991f4d1b7d974c2704537fe66")
if modal.is_local() and not re.fullmatch(r"[0-9a-f]{40}", SAM3_COMMIT):
    raise RuntimeError("Set RW_SAM3_COMMIT to a 40-character facebookresearch/sam3 commit sha before deploying (see modal/README.md).")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "libgl1", "libglib2.0-0")
    # The sam3 README at the pin: Python 3.12, `torch==2.10.0 torchvision` from the cu128 index (CUDA 12.8).
    # torchvision is left to resolve to the build that matches torch 2.10.0.
    .pip_install("torch==2.10.0", "torchvision", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        "numpy>=1.26,<2",  # sam3's own pin (pyproject.toml)
        "opencv-python-headless==4.10.0.84",  # sam3 reads mp4 with cv2 by default; the last line that supports numpy 1.x
        "setuptools<81",  # sam3.model_builder imports pkg_resources
        # Imported at module level on the builder's import path but missing from sam3's own
        # dependencies (einops is only in its `notebooks` extra). The first deploy crash-looped on
        # einops; psutil and pycocotools were found by tracing every import from sam3/__init__ and
        # model_builder at the pin. decord/torchcodec are not needed: the multiplex path reads mp4 with cv2.
        "einops",
        "psutil",
        "pycocotools",
        "huggingface_hub",
        "fastapi[standard]",
        "pydantic>=2",
    )
    .pip_install(f"git+https://github.com/facebookresearch/sam3.git@{SAM3_COMMIT}")
    .env({"HF_HOME": "/cache/hf", "HF_XET_HIGH_PERFORMANCE": "1"})  # HF_HUB_ENABLE_HF_TRANSFER is deprecated (huggingface_hub now downloads via Xet)
)

app = modal.App(APP_NAME)
# Weights persist across containers so a cold start reads ~GBs from the volume, not from Hugging Face.
weights = modal.Volume.from_name("returnwitness-sam31-weights", create_if_missing=True)


@app.cls(
    gpu=GPU,
    image=image,
    volumes={"/cache": weights},
    secrets=[
        modal.Secret.from_name("returnwitness-hf"),  # HF_TOKEN (facebook/sam3.1 is gated)
        modal.Secret.from_name("returnwitness-sam-token"),  # MODAL_SAM_TOKEN
    ],
    min_containers=0,  # idle costs nothing
    scaledown_window=120,  # keep a warm container 2 min after the last request, then scale to zero
    max_containers=2,  # hard ceiling on parallel GPU spend
    timeout=600,
)
@modal.concurrent(max_inputs=1)  # one clip per GPU at a time: video tracking state is per session
class Sam31:
    @modal.enter()
    def load(self) -> None:
        """Load the model once per container, not once per request."""
        import torch
        from huggingface_hub import hf_hub_download

        # SAM 3 is CUDA-only (hard CUDA calls and triton kernels throughout): fail the container at
        # start rather than limp along on CPU. There is deliberately no CPU or MPS path.
        if not torch.cuda.is_available():
            raise RuntimeError(f"SAM 3.1 needs a CUDA GPU; this container has none (requested gpu={GPU!r})")
        t0 = time.perf_counter()
        token = os.environ["HF_TOKEN"]
        hf_hub_download(MODEL_ID, "config.json", token=token)
        ckpt = hf_hub_download(MODEL_ID, CKPT_FILE, token=token)
        weights.commit()
        # SAM 3.1 has its own entry point; build_sam3_video_predictor() is the SAM 3 (Nov 2025) model.
        from sam3.model_builder import build_sam3_multiplex_video_predictor

        self.predictor = build_sam3_multiplex_video_predictor(checkpoint_path=ckpt, use_fa3=USE_FA3)
        _compat_init_state(self.predictor.model)
        self.gpu_name = torch.cuda.get_device_name(0)
        self.load_s = round(time.perf_counter() - t0, 2)

    def segment_video(self, video_path: str, concepts: list[str]) -> tuple[list[dict], int, int]:
        """One session per clip; each concept is its own text prompt, propagated through the whole clip. Frame-major, pixels."""
        import cv2
        import torch

        # The predictor turns on bf16 autocast once, in its constructor (sam3_multiplex_video_predictor.py), and autocast
        # is thread-local: it holds in the @modal.enter thread, not in the worker thread FastAPI runs this request on.
        # Without re-entering it here the image encoder gets bf16 activations against fp32 weights ("mat1 and mat2 must
        # have the same dtype"), as the first smoke run showed. Same context the predictor uses.
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            return self._segment_video(video_path, concepts)

    def _segment_video(self, video_path: str, concepts: list[str]) -> tuple[list[dict], int, int]:
        import cv2

        cap = cv2.VideoCapture(video_path)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        if width <= 0 or height <= 0 or n_frames <= 0:
            raise ValueError("could not decode the clip (width/height/frame count is 0)")

        frames: dict[int, list[dict]] = {i: [] for i in range(n_frames)}
        # A session holds one text prompt at a time; the sam3.1 example notebook says to send
        # reset_session before switching prompts "otherwise the results would be wrong". So: one
        # session (the clip is decoded once), reset before every concept, closed at the end.
        session_id = self.predictor.handle_request(request=dict(type="start_session", resource_path=video_path))["session_id"]
        try:
            for concept in concepts:
                self.predictor.handle_request(request=dict(type="reset_session", session_id=session_id))
                self.predictor.handle_request(request=dict(type="add_prompt", session_id=session_id, frame_index=0, text=concept))
                for resp in self.predictor.handle_stream_request(request=dict(type="propagate_in_video", session_id=session_id)):
                    fi = int(resp["frame_index"])
                    out = resp["outputs"]
                    ids = _as_list(out.get("out_obj_ids"))
                    probs = _as_list(out.get("out_probs"))
                    boxes = _as_list(out.get("out_boxes_xywh"))  # normalised XYWH (visualization_utils multiplies by width/height)
                    masks = out.get("out_binary_masks")
                    for j, oid in enumerate(ids):
                        x, y, w, h = (float(v) for v in boxes[j])
                        # Masks come back at the clip's resolution (sam3_multiplex_base resizes to orig_vid_height/width);
                        # scale by the mask's own shape anyway so the area fraction stays right if that changes.
                        area = None
                        if masks is not None:
                            mh, mw = masks[j].shape[-2:]
                            area = int(round(float(masks[j].sum()) * (width * height) / max(1, int(mh) * int(mw))))
                        frames.setdefault(fi, []).append(
                            {
                                "track_id": int(oid),
                                "concept": concept,
                                "box": [x * width, y * height, (x + w) * width, (y + h) * height],
                                "score": float(probs[j]) if j < len(probs) else 1.0,
                                **({"area": area} if area is not None else {}),
                            }
                        )
        finally:
            self.predictor.handle_request(request=dict(type="close_session", session_id=session_id))
        return [{"frame_index": i, "objects": frames[i]} for i in sorted(frames)], width, height

    @modal.asgi_app()
    def web(self):
        from fastapi import Depends, FastAPI, Header, HTTPException
        from pydantic import BaseModel, Field

        api = FastAPI(title="ReturnWitness SAM 3.1 (open weights)")
        expected = os.environ["MODAL_SAM_TOKEN"].encode()

        def auth(authorization: str | None = Header(default=None)) -> None:
            given = (authorization or "").removeprefix("Bearer ").encode()
            # Constant-time compare: the token is the only thing between the internet and my GPU bill.
            if not authorization or not authorization.startswith("Bearer ") or not hmac.compare_digest(given, expected):
                raise HTTPException(status_code=401, detail="bad or missing bearer token")

        class SegmentRequest(BaseModel):
            clipId: str = Field(min_length=1, max_length=200)
            fps: float = Field(gt=0, le=60)
            concepts: list[str] = Field(min_length=1, max_length=MAX_CONCEPTS)
            video_b64: str = Field(min_length=1)

        @api.get("/healthz")
        def healthz() -> dict:
            return {"ok": True, "model": MODEL_ID, "gpu": self.gpu_name, "loaded": hasattr(self, "predictor"), "load_s": self.load_s}

        @api.post("/segment", dependencies=[Depends(auth)])
        def segment(req: SegmentRequest) -> dict:
            if len(req.video_b64) > MAX_VIDEO_BYTES * 4 // 3 + 4:
                raise HTTPException(status_code=413, detail=f"clip over {MAX_VIDEO_BYTES // 1048576} MB")
            try:
                raw = base64.b64decode(req.video_b64, validate=True)
            except ValueError:
                raise HTTPException(status_code=400, detail="video_b64 is not valid base64")
            if len(raw) > MAX_VIDEO_BYTES:
                raise HTTPException(status_code=413, detail=f"clip over {MAX_VIDEO_BYTES // 1048576} MB")
            concepts = [c.strip() for c in req.concepts if c.strip()]
            if not concepts:
                raise HTTPException(status_code=400, detail="no concepts")
            import torch

            torch.cuda.reset_peak_memory_stats()
            t0 = time.perf_counter()
            with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
                f.write(raw)
                f.flush()
                try:
                    frames, width, height = self.segment_video(f.name, concepts)
                except ValueError as e:
                    raise HTTPException(status_code=422, detail=str(e))
            return {
                "frames": frames,
                "width": width,
                "height": height,
                "model": MODEL_ID,
                "gpu_seconds": round(time.perf_counter() - t0, 3),
                # PyTorch's allocator peak for this request (weights + activations); nvidia-smi reads a little higher.
                "peak_gpu_mb": round(torch.cuda.max_memory_allocated() / 1048576),
                "request_id": f"{APP_NAME}-{uuid.uuid4().hex[:16]}",
            }

        return api


def _compat_init_state(model) -> list[str]:
    """
    Upstream regression at the pinned commit: Sam3BasePredictor.start_session always passes
    `offload_state_to_cpu` to model.init_state, but the SAM 3.1 multiplex model's init_state doesn't take it
    (TypeError on the first live start_session; the official 3.1 notebook makes the same call).
    sam3 already filters add_prompt / propagate_in_video kwargs by inspect.signature; this applies the same
    filter to init_state only. Returns the names it would drop (for the log). Remove when upstream fixes it.
    """
    import inspect

    orig = model.init_state
    params = inspect.signature(orig).parameters
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return []

    def init_state(**kwargs):
        dropped = [k for k in kwargs if k not in params]
        if dropped:
            print(f"init_state: dropping kwargs the model doesn't accept: {dropped}")
        return orig(**{k: v for k, v in kwargs.items() if k in params})

    model.init_state = init_state
    return [n for n in ("offload_state_to_cpu",) if n not in params]


def _as_list(v) -> list:
    if v is None:
        return []
    if hasattr(v, "tolist"):
        return v.tolist()
    return list(v)
