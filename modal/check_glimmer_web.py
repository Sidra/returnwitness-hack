"""
Local contract check for modal/glimmer_app.py's HTTP layer and modal/glimmer_finetune.py's gates.
No GPU, no Modal account, no network, no weights.

It imports the REAL app files with `modal`, `vllm` and `torch` stubbed, swaps the vLLM server for a fake
engine, and drives /healthz and /v1/chat/completions through FastAPI's TestClient. It also checks the
`vllm serve` command line, adapter discovery, the CUDA start check, and the fine-tune's pure helpers
(the split, the spend/row-floor gates, answer parsing, metrics) against the same vectors the TypeScript
tests use (tests/glimmer-eval.test.ts).

  npm run check:glimmer-web
"""

import asyncio
import importlib.util
import json
import pathlib
import re
import sys
import tempfile
import types

HERE = pathlib.Path(__file__).resolve().parent
TOKEN = "check-glimmer-token"
MODEL = "meta-models/Muse-Glimmer-30B"


def stub_modules(cuda: bool = True) -> None:
    modal = types.ModuleType("modal")

    class _Image:
        envs: dict = {}  # every .env({...}) the app's image definition sets, for the checks below

        @staticmethod
        def debian_slim(**_):
            return _Image()

        def env(self, d: dict):
            _Image.envs.update(d)
            return self

        def __getattr__(self, _):
            return lambda *a, **k: self

    passthrough = lambda *a, **k: (lambda f: f)  # noqa: E731

    class _App:
        def __init__(self, *_a, **_k):
            pass

        cls = function = staticmethod(passthrough)

        def local_entrypoint(self, *_a, **_k):
            return lambda f: f

    vol = types.SimpleNamespace(commit=lambda: None, reload=lambda: None)
    modal.Image = _Image
    modal.App = _App
    modal.Volume = types.SimpleNamespace(from_name=lambda *_a, **_k: vol)
    modal.Secret = types.SimpleNamespace(from_name=lambda *_a, **_k: None)
    modal.concurrent = passthrough
    modal.enter = passthrough
    modal.exit = passthrough
    modal.asgi_app = passthrough
    modal.is_local = lambda: False
    sys.modules["modal"] = modal

    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda, get_device_name=lambda _i: "fake L40S")
    sys.modules["torch"] = torch
    vllm = types.ModuleType("vllm")
    vllm.__version__ = "0.32.0"
    sys.modules["vllm"] = vllm


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeEngine:
    def __init__(self) -> None:
        self.bodies: list = []
        self.fail = False
        self.status = 200

    async def chat(self, body: dict):
        if self.fail:
            raise ConnectionError("engine down")
        self.bodies.append(body)
        await asyncio.sleep(0)
        content = json.dumps({"items": [{"itemKey": "lens", "serialRead": "BW-LN-80311", "skuRead": None, "legible": True, "confidence": 0.93}]})
        return self.status, {"id": "chatcmpl-fake", "object": "chat.completion", "model": body["model"], "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}], "usage": {"prompt_tokens": 1500, "completion_tokens": 60}}


def chat_body(model: str = MODEL, images: int = 3, **extra) -> dict:
    parts = [{"type": "text", "text": "Items in this kit: []"}]
    for i in range(images):
        parts += [{"type": "text", "text": f"Crop {i + 1}"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/AA=="}}]
    return {"model": model, "messages": [{"role": "system", "content": "You transcribe printed labels"}, {"role": "user", "content": parts}], "response_format": {"type": "json_object"}, "temperature": 0, **extra}


def check_app() -> None:
    from fastapi.testclient import TestClient

    src = (HERE / "glimmer_app.py").read_text()
    assert not re.search(r"^from __future__ import annotations", src, re.M), "never in Modal apps (broke FastAPI request models in sam31_app.py)"
    app_mod = load("glimmer_app")
    assert app_mod.APP_NAME == "returnwitness-glimmer" and app_mod.MODEL_ID == MODEL

    engine = FakeEngine()
    info = {"ready": True, "gpu": "fake L40S", "adapters": {"rw-labels-test": "/adapters/rw-labels-test"}, "vllm": "0.32.0", "load_s": 1.0}
    client = TestClient(app_mod.build_api(engine, info, TOKEN))
    auth = {"Authorization": f"Bearer {TOKEN}"}

    h = client.get("/healthz")
    assert h.status_code == 200, h.text
    hb = h.json()
    assert hb["model"] == MODEL and hb["gpu"] == "fake L40S" and hb["adapters"] == ["rw-labels-test"] and hb["ready"] is True, hb
    assert "token" not in json.dumps(hb).lower()

    assert client.post("/v1/chat/completions", json=chat_body()).status_code == 401, "no token must be refused"
    assert client.post("/v1/chat/completions", json=chat_body(), headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/v1/chat/completions", json=chat_body(), headers={"Authorization": TOKEN}).status_code == 401, "a bare token without 'Bearer ' is refused"
    assert not engine.bodies, "nothing reaches the engine without auth"

    r = client.post("/v1/chat/completions", json=chat_body(), headers=auth)
    assert r.status_code == 200, r.text
    out = r.json()
    assert isinstance(out["gpu_seconds"], (int, float)) and out["gpu_seconds"] >= 0, out
    assert json.loads(out["choices"][0]["message"]["content"])["items"][0]["serialRead"] == "BW-LN-80311"
    assert engine.bodies[-1]["max_tokens"] == 2048 and engine.bodies[-1]["model"] == MODEL, engine.bodies[-1]

    r = client.post("/v1/chat/completions", json=chat_body("rw-labels-test", max_tokens=99999), headers=auth)
    assert r.status_code == 200 and engine.bodies[-1]["model"] == "rw-labels-test" and engine.bodies[-1]["max_tokens"] == app_mod.MAX_TOKENS_CAP, r.text

    assert client.post("/v1/chat/completions", json=chat_body("rw-labels-other"), headers=auth).status_code == 404, "unknown adapter"
    assert client.post("/v1/chat/completions", json=chat_body(stream=True), headers=auth).status_code == 400, "no streaming"
    assert client.post("/v1/chat/completions", json=chat_body(images=5), headers=auth).status_code == 400, "at most 4 images"
    assert client.post("/v1/chat/completions", json=chat_body(max_tokens=0), headers=auth).status_code == 400
    assert client.post("/v1/chat/completions", content=b"{not json", headers={**auth, "Content-Type": "application/json"}).status_code == 400
    assert client.post("/v1/chat/completions", json={"model": MODEL, "messages": []}, headers=auth).status_code == 400
    big = chat_body()
    big["messages"][1]["content"][2]["image_url"]["url"] = "data:image/jpeg;base64," + "A" * (app_mod.MAX_BODY_BYTES + 10)
    assert client.post("/v1/chat/completions", json=big, headers=auth).status_code == 413
    engine.status = 500
    assert client.post("/v1/chat/completions", json=chat_body(), headers=auth).status_code == 500, "engine errors pass through"
    engine.status, engine.fail = 200, True
    assert client.post("/v1/chat/completions", json=chat_body(), headers=auth).status_code == 503, "engine down is a 503, never a hang"

    try:
        app_mod.build_api(engine, info, "")
        raise AssertionError("an empty token must refuse to serve")
    except RuntimeError:
        pass

    # The vllm serve command line.
    cmd = app_mod.vllm_command({"rw-labels-test": "/adapters/rw-labels-test"})
    flag = lambda f: cmd[cmd.index(f) + 1]  # noqa: E731
    assert cmd[:3] == ["vllm", "serve", MODEL], cmd
    assert flag("--quantization") == "fp8" and flag("--max-model-len") == "20480" and flag("--host") == "127.0.0.1"
    assert flag("--revision") == app_mod.MODEL_REVISION and len(app_mod.MODEL_REVISION) == 40
    assert "--enable-lora" in cmd and flag("--max-lora-rank") == "16"
    assert json.loads(flag("--limit-mm-per-prompt")) == {"image": 4, "video": 0}
    assert json.loads(flag("--lora-modules")) == {"name": "rw-labels-test", "path": "/adapters/rw-labels-test", "base_model_name": MODEL}
    assert "--lora-modules" not in app_mod.vllm_command({})
    # max_model_len covers the worst case it was sized for: 4 images at the processor's cap + prompt + answer.
    assert app_mod.MAX_MODEL_LEN >= app_mod.MAX_IMAGES * 4096 + 1024 + 2048

    # Adapter discovery: only complete adapters trained on this base, with a servable name and rank.
    with tempfile.TemporaryDirectory() as d:
        root = pathlib.Path(d)

        def adapter(name: str, base: str = MODEL, r: int = 16, weights: bool = True) -> None:
            p = root / name
            p.mkdir()
            (p / "adapter_config.json").write_text(json.dumps({"base_model_name_or_path": base, "r": r}))
            if weights:
                (p / "adapter_model.safetensors").write_bytes(b"x")

        adapter("rw-labels-good")
        adapter("rw-labels-otherbase", base="someone/else")
        adapter("rw-labels-rank64", r=64)
        adapter("rw-labels-partial", weights=False)
        adapter(".staging-rw-labels-wip")
        (root / "notes.txt").write_text("not an adapter")
        assert app_mod.discover_adapters(d) == {"rw-labels-good": str(root / "rw-labels-good")}, app_mod.discover_adapters(d)
    assert app_mod.discover_adapters("/nonexistent-dir") == {}

    # CUDA check: a container without a GPU fails at start.
    inst = app_mod.Glimmer()
    sys.modules["torch"].cuda.is_available = lambda: False
    try:
        inst.start()
        raise AssertionError("start() must fail without CUDA")
    except RuntimeError as e:
        assert "CUDA" in str(e), e
    sys.modules["torch"].cuda.is_available = lambda: True
    sys.modules["vllm"].__version__ = "0.31.9"
    try:
        inst.start()
        raise AssertionError("start() must refuse a vLLM version other than the pin")
    except RuntimeError as e:
        assert "0.32.0" in str(e), e
    sys.modules["vllm"].__version__ = "0.32.0"


def line(case_id: str, row_id: str, split=None) -> dict:
    meta = {"rowId": row_id, "caseId": case_id, "itemKey": "lens", "truth": {"serial": "BW-LN-80311", "sku": None, "serialUnreadable": False}, "expected": {"serial": "BW-LN-80311", "sku": "CK-LENS", "requiresSerial": True}}
    if split:
        meta["split"] = split
    return {"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": [{"type": "text", "text": "u"}]}, {"role": "assistant", "content": "{}"}], "meta": meta}


def check_finetune() -> None:
    src = (HERE / "glimmer_finetune.py").read_text()
    assert not re.search(r"^from __future__ import annotations", src, re.M)
    ft = load("glimmer_finetune")

    # Split: identical formula to lib/learning/glimmer-eval.ts (vectors asserted there too).
    expected_scores = json.loads((HERE / "glimmer_split_vectors.json").read_text())
    for cid, score in expected_scores.items():
        assert abs(ft.split_score(cid, 1729) - score) < 1e-12, (cid, ft.split_score(cid, 1729), score)
    assert ft.split_of("x", 1729, 0.2) in ("train", "heldout")

    # Gates: run name, epochs, both row floors, then confirm_spend, all before any GPU second.
    ids = [f"c{i}" for i in range(400)]
    lines = [line(c, f"r{i}") for i, c in enumerate(ids)]
    plan = ft.plan_split(lines)
    assert len(plan["train"]) >= ft.MIN_TRAIN_ROWS and len(plan["heldout"]) >= ft.MIN_HELDOUT_ROWS
    for kwargs, needle in [
        (dict(confirm_spend=False, plan=plan, run_name="rw-labels-1", epochs=3), "confirm_spend"),
        (dict(confirm_spend=True, plan=plan, run_name="../etc", epochs=3), "run name"),
        (dict(confirm_spend=True, plan=plan, run_name="rw-labels-1", epochs=0), "epochs"),
        (dict(confirm_spend=True, plan={"train": plan["train"][:49], "heldout": plan["heldout"]}, run_name="rw-labels-1", epochs=3), "training rows"),
        (dict(confirm_spend=True, plan={"train": plan["train"], "heldout": plan["heldout"][:19]}, run_name="rw-labels-1", epochs=3), "held-out rows"),
        (dict(confirm_spend="yes", plan=plan, run_name="rw-labels-1", epochs=3), "confirm_spend"),
    ]:
        try:
            ft.check_gates(**kwargs)
            raise AssertionError(f"gate should refuse: {needle}")
        except ft.SpendRefused as e:
            assert needle in str(e), (needle, str(e))
    ft.check_gates(True, plan, "rw-labels-1", 3)  # all gates pass
    import inspect

    sig = inspect.signature(ft.finetune).parameters
    assert sig["max_minutes"].default == 0.0 and sig["inprocess_eval"].default is True, "budget and optional in-process eval"
    assert issubclass(ft.BudgetExceeded, RuntimeError)
    # The bnb skip list under transformers 5.19's matching rule: every vision module and lm_head stays BF16, the
    # language model's linears are quantized. The bare names the first run used would fail this.
    for name in ["model.vision_tower.patch_embedder.patch_embedding", "model.vision_tower.blocks.0.attn.qkv", "model.vision_adapter.proj", "model.vision_projection", "lm_head"]:
        assert ft.skipped_by_bnb(name), f"{name} would be quantized"
    for name in ["model.language_model.layers.0.self_attn.q_proj", "model.language_model.layers.51.mlp.down_proj"]:
        assert not ft.skipped_by_bnb(name), f"{name} would stay BF16 (the 4-bit base needs it quantized)"
    assert not ft.skipped_by_bnb("model.vision_tower.patch_embedder.patch_embedding", ["vision_tower", "vision_adapter", "vision_projection", "lm_head"]), "bare names must fail under 5.x (the bug)"

    # A row the exporter labelled with another split refuses the run.
    bad = [line("c0", "r0", split="heldout" if ft.split_of("c0") == "train" else "train")]
    try:
        ft.plan_split(bad)
        raise AssertionError("a split mismatch must refuse")
    except ValueError as e:
        assert "different split" in str(e)
    # Split by label id: the printed sheet's labels are always held out, whatever their hash says.
    for lid in ("BW-CB-55120", "BW-LN-80311", "BW-CB-55107", "BW-LN-80298", "charger-1", "charger-2"):
        assert ft.split_of_meta({"labelId": lid, "caseId": "any"}) == "heldout", lid
    assert ft.split_of_meta({"labelId": "BW-CB-10001", "caseId": "c"}) == ft.split_of("BW-CB-10001")
    assert ft.split_of_meta({"caseId": "case_a1"}) == ft.split_of("case_a1"), "rows without a labelId group by case"
    same = [line(f"c{i}", f"s{i}") for i in range(30)]
    for x in same:
        x["meta"]["labelId"] = "BW-LN-42424"
    p2 = ft.plan_split(same)
    assert sorted([len(p2["train"]), len(p2["heldout"])]) == [0, 30], "one label id never straddles the split"
    try:
        ft.load_lines(json.dumps(line("c1", "r1")) + "\n" + json.dumps(line("c2", "r1")))
        raise AssertionError("duplicate row ids must refuse")
    except ValueError:
        pass

    # Answer parsing: reasoning ignored, schema enforced, the asked item picked.
    good = '<think>{"items":[{"itemKey":"lens","serialRead":"WRONG","legible":true,"confidence":1}]}</think>{"items":[{"itemKey":"camera_body","serialRead":"BW-CB-55120","skuRead":null,"legible":true,"confidence":0.9},{"itemKey":"lens","serialRead":"BW-LN-80311","skuRead":"say \\"hi\\" }","legible":true,"confidence":0.8}]}'
    r = ft.parse_read(good, "lens")
    assert r and r["serialRead"] == "BW-LN-80311" and r["skuRead"] == 'say "hi" }', r
    assert ft.parse_read("no json here", "lens") is None
    assert ft.parse_read('{"items":[{"itemKey":"lens","legible":"yes","confidence":3}]}', "lens") is None

    # Metrics: same vector as tests/glimmer-eval.test.ts ("python port agrees").
    metas = [
        {"rowId": "a", "truth": {"serial": "BW-LN-80311", "sku": None, "serialUnreadable": False}, "expected": {"serial": "BW-LN-80311", "sku": "CK-LENS", "requiresSerial": True}},
        {"rowId": "b", "truth": {"serial": "BW-LN-99999", "sku": None, "serialUnreadable": False}, "expected": {"serial": "BW-LN-80311", "sku": "CK-LENS", "requiresSerial": True}},
        {"rowId": "c", "truth": {"serial": None, "sku": None, "serialUnreadable": True}, "expected": {"serial": "BW-CB-55120", "sku": "CK-BODY", "requiresSerial": True}},
        {"rowId": "d", "truth": {"serial": None, "sku": "XX-KNOCK", "serialUnreadable": False}, "expected": {"serial": None, "sku": "CK-BATT", "requiresSerial": False}},
    ]
    rd = lambda s, k=None, c=0.95, leg=True: {"itemKey": "x", "serialRead": s, "skuRead": k, "legible": leg, "confidence": c}  # noqa: E731
    reads = [{"rowId": "a", "read": rd("bw ln 80311")}, {"rowId": "b", "read": rd("BW-LN-80311")}, {"rowId": "c", "read": rd("BW-CB-55120", c=0.5)}, {"rowId": "d", "read": rd(None, "CK-BATT")}]
    m = ft.evaluate(metas, reads)
    assert m == {"rows": 4, "exactSerial": 3, "exactSerialRate": 0.75, "skuRows": 1, "skuMatch": 0, "falseClears": {"serial": 1, "sku": 1, "total": 2}, "errors": 0}, m

    q = ft.quote(160, 40, 3)
    assert q["seconds"] == 60 + 160 * 3 * 1.2 + 40 * 2 * 5 and q["usd"] == round(q["seconds"] / 3600 * 1.95, 2), q
    assert ft.lr_factor(0, 10, 100) == 0.1 and ft.lr_factor(10, 10, 100) == 1.0 and ft.lr_factor(100, 10, 100) == 0.0
    assert ft.EXPECTED_LORA_MODULES == 364

    names = ["model.language_model.layers.0.self_attn.q_proj", "model.language_model.layers.51.mlp.down_proj", "model.language_model.layers.3.self_attn.gate_proj", "model.vision_tower.layers.0.self_attn.q_proj", "model.vision_adapter.fc1", "lm_head"]
    assert [bool(re.fullmatch(ft.LORA_TARGET_REGEX, n)) for n in names] == [True, True, False, False, False, False], "LoRA targets: language q/k/v/o + MLP only; never the attention gate or the vision side"


def check_generated_label_set() -> str:
    """If this machine generated the bench label set, the Python job must agree with the TS split on it and its floors must pass."""
    f = HERE.parent / ".data" / "label-set" / "label-set.jsonl"
    if not f.exists():
        return "bench label set not generated here (skipped)"
    ft = sys.modules.get("glimmer_finetune") or load("glimmer_finetune")
    lines = ft.load_lines(f.read_text())
    plan = ft.plan_split(lines)  # raises on any split mismatch or label leakage
    ft.check_gates(True, plan, "rw-labels-check", 3)  # floors met honestly, no gate lowered
    return f"bench label set: {len(plan['train'])} train / {len(plan['heldout'])} held out, Python split agrees"


def main() -> None:
    stub_modules()
    check_app()
    check_finetune()
    print(check_generated_label_set())
    # The image has no CUDA toolkit; FlashInfer's sampler JIT needs nvcc and killed the first cold start.
    image_env = sys.modules["modal"].Image.debian_slim().envs
    assert image_env.get("VLLM_USE_FLASHINFER_SAMPLER") == "0", f"image env must disable the FlashInfer sampler: {image_env}"
    print("glimmer contract: PASS (FlashInfer sampler off in the image, healthz, auth 401s, chat 200 + gpu_seconds, adapter by name, 404/400/413/503, vllm flags, adapter discovery, CUDA + version checks; fine-tune split vectors, spend/row-floor gates, answer parsing, metrics, LoRA targets)")


if __name__ == "__main__":
    main()
