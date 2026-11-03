"""
Local contract check for modal/sam31_app.py's HTTP layer. No GPU, no Modal account, no network.

It imports the REAL app file with `modal` and `torch` stubbed, swaps the SAM 3.1 predictor for a fake
that streams two frames, and drives /healthz and /segment through FastAPI's TestClient. It exists
because the first live smoke run returned HTTP 422 on /segment: `from __future__ import annotations`
turned the request model (defined inside web()) into an unresolvable string, so FastAPI read the body
as a query parameter. Nothing in the TypeScript mocks could see that.

  uv run --no-project --with fastapi --with httpx --with pydantic --with opencv-python-headless \
      --with numpy python -I modal/check_web.py
"""

import base64
import importlib.util
import pathlib
import sys
import tempfile
import types

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
TOKEN = "check-web-token"


def stub_modules() -> None:
    modal = types.ModuleType("modal")

    class _Image:
        @staticmethod
        def debian_slim(**_):
            return _Image()

        def __getattr__(self, _):
            return lambda *a, **k: self

    passthrough = lambda *a, **k: (lambda f: f)  # noqa: E731
    modal.Image = _Image
    modal.App = lambda *_a, **_k: types.SimpleNamespace(cls=passthrough)
    modal.Volume = types.SimpleNamespace(from_name=lambda *_a, **_k: types.SimpleNamespace(commit=lambda: None))
    modal.Secret = types.SimpleNamespace(from_name=lambda *_a, **_k: None)
    modal.concurrent = passthrough
    modal.enter = passthrough
    modal.asgi_app = passthrough
    modal.is_local = lambda: False
    sys.modules["modal"] = modal

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(reset_peak_memory_stats=lambda: None, max_memory_allocated=lambda: 5 * 1048576)
    torch.bfloat16 = "bfloat16"

    class autocast:  # noqa: N801 - mirrors torch.autocast; records whether the request thread is inside it
        active = 0

        def __init__(self, device_type: str, dtype=None) -> None:
            assert device_type == "cuda" and dtype == "bfloat16", (device_type, dtype)

        def __enter__(self):
            autocast.active += 1

        def __exit__(self, *exc):
            autocast.active -= 1

    torch.autocast = autocast
    sys.modules["torch"] = torch


class FakePredictor:
    """Two frames; the object appears on frame 1 only, like an item entering late."""

    def __init__(self) -> None:
        self.requests: list[str] = []

    def handle_request(self, request: dict) -> dict:
        self.requests.append(request["type"])
        return {"session_id": "s1"} if request["type"] == "start_session" else {}

    def handle_stream_request(self, request: dict):
        self.requests.append(request["type"])
        # The real predictor enters bf16 autocast in its constructor's thread only; the request thread must enter it again.
        assert sys.modules["torch"].autocast.active > 0, "propagate_in_video ran outside bf16 autocast (thread-local; see segment_video)"
        yield {"frame_index": 0, "outputs": {"out_obj_ids": np.array([]), "out_probs": np.array([]), "out_boxes_xywh": np.zeros((0, 4)), "out_binary_masks": np.zeros((0, 4, 8), bool)}}
        mask = np.zeros((1, 4, 8), bool)
        mask[0, :2, :4] = True  # a quarter of the frame
        yield {"frame_index": 1, "outputs": {"out_obj_ids": np.array([7]), "out_probs": np.array([0.9]), "out_boxes_xywh": np.array([[0.0, 0.0, 0.5, 0.5]]), "out_binary_masks": mask}}


def tiny_mp4() -> bytes:
    import cv2

    with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
        w = cv2.VideoWriter(f.name, cv2.VideoWriter_fourcc(*"mp4v"), 5, (64, 48))
        for _ in range(2):
            w.write(np.zeros((48, 64, 3), np.uint8))
        w.release()
        return pathlib.Path(f.name).read_bytes()


def main() -> None:
    stub_modules()
    import os

    os.environ["MODAL_SAM_TOKEN"] = TOKEN
    spec = importlib.util.spec_from_file_location("sam31_app", HERE / "sam31_app.py")
    app_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app_mod)

    from fastapi.testclient import TestClient

    inst = app_mod.Sam31()
    inst.predictor = FakePredictor()
    inst.gpu_name, inst.load_s = "fake", 0.0
    client = TestClient(inst.web())

    h = client.get("/healthz")
    assert h.status_code == 200 and h.json()["loaded"] is True, h.text

    body = {"clipId": "check", "fps": 5, "concepts": ["paper bag"], "video_b64": base64.b64encode(tiny_mp4()).decode()}
    assert client.post("/segment", json=body).status_code == 401, "no token must be refused"
    assert client.post("/segment", json=body, headers={"Authorization": "Bearer wrong"}).status_code == 401
    r = client.post("/segment", json=body, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200, f"/segment returned {r.status_code}: {r.text[:300]}"
    out = r.json()
    assert (out["width"], out["height"]) == (64, 48), out
    assert [len(f["objects"]) for f in out["frames"]] == [0, 1], out["frames"]
    obj = out["frames"][1]["objects"][0]
    assert obj["track_id"] == 7 and obj["concept"] == "paper bag", obj
    assert obj["box"] == [0.0, 0.0, 32.0, 24.0], obj["box"]  # normalised XYWH → pixel XYXY
    assert obj["area"] == 64 * 48 // 4, obj["area"]
    assert out["peak_gpu_mb"] == 5 and out["model"] == "facebook/sam3.1", out
    assert inst.predictor.requests == ["start_session", "reset_session", "add_prompt", "propagate_in_video", "close_session"], inst.predictor.requests

    # The init_state shim: a model whose init_state lacks offload_state_to_cpu (the real SAM 3.1 multiplex model).
    class Model31:
        def init_state(self, resource_path, offload_video_to_cpu=False, async_loading_frames=False):
            return {"path": resource_path}

    m = Model31()
    assert app_mod._compat_init_state(m) == ["offload_state_to_cpu"]
    assert m.init_state(resource_path="x.mp4", offload_video_to_cpu=False, offload_state_to_cpu=False, async_loading_frames=True) == {"path": "x.mp4"}

    bad = client.post("/segment", json={**body, "video_b64": "%%%"}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert bad.status_code == 400, bad.text
    none = client.post("/segment", json={**body, "concepts": ["  "]}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert none.status_code == 400, none.text
    print("modal web contract: PASS (healthz, auth 401s, segment 200 + late object on frame 1, box/area scaling, init_state shim, bf16 autocast in the request thread, 400s)")


if __name__ == "__main__":
    main()
