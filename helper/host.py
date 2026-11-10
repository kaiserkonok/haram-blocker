#!/usr/bin/env python3
"""Haram Blocker helper.

Chrome starts this program through "native messaging". The extension sends it
small pieces of a video's sound; it removes the music with an AI model running
on the NVIDIA GPU and sends back only the voice.

Streaming design
----------------
Audio arrives in chunks of C samples. For every chunk we keep a sliding window
of the most recent W samples and run the model over the whole window, but we
only return a slice that ends L samples ("lookahead") before the newest sample.
That way every returned sample was separated with plenty of past *and* future
context, which keeps quality close to offline separation. Consecutive slices
are crossfaded to hide seams.

The browser plays the returned audio a fixed delay D after it was captured,
with D > L + C + processing time, so the voice is always ready in time. If it
is not, the browser plays silence: it never falls back to the original audio.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import queue
import struct
import sys
import threading
import time

import numpy as np

# stdout carries the native-messaging protocol; nothing else may write to it.
PROTO_IN = sys.stdin.buffer
PROTO_OUT = sys.stdout.buffer
sys.stdout = sys.stderr

LOG_DIR = os.environ.get("HB_LOG_DIR") or os.path.expanduser("~/.local/state/haram-blocker")
os.makedirs(LOG_DIR, exist_ok=True)
logging.basicConfig(
    filename=os.path.join(LOG_DIR, "helper.log"),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("helper")

MODEL_NAME = os.environ.get("HB_MODEL", "htdemucs_ft")
WINDOW_SEC = float(os.environ.get("HB_WINDOW_SEC", "4.0"))  # context the model sees
LOOKAHEAD_SEC = float(os.environ.get("HB_LOOKAHEAD_SEC", "0.4"))  # future context
XFADE = 1024  # samples crossfaded between consecutive slices
SILENCE = 1e-5


# --------------------------------------------------------------------------- #
# Native messaging I/O
# --------------------------------------------------------------------------- #
_write_lock = threading.Lock()


def send(msg: dict) -> None:
    data = json.dumps(msg, separators=(",", ":")).encode()
    with _write_lock:
        PROTO_OUT.write(struct.pack("=I", len(data)))
        PROTO_OUT.write(data)
        PROTO_OUT.flush()


def read_messages(q: queue.Queue) -> None:
    """Reader thread: push each incoming message onto the queue; None on EOF."""
    try:
        while True:
            header = PROTO_IN.read(4)
            if len(header) < 4:
                break
            (length,) = struct.unpack("=I", header)
            body = PROTO_IN.read(length)
            if len(body) < length:
                break
            q.put(json.loads(body))
    except Exception:  # pragma: no cover - logged for diagnosis
        log.exception("reader failed")
    q.put(None)


# --------------------------------------------------------------------------- #
# Separation model
# --------------------------------------------------------------------------- #
class Separator:
    """Runs only the vocals part of a Demucs model on the GPU."""

    def __init__(self, model_name: str = MODEL_NAME):
        import torch
        from demucs.apply import BagOfModels
        from demucs.pretrained import get_model

        self.torch = torch
        # The work happens on the GPU. Extra CPU threads only spin while
        # waiting (68% of a core vs 18% with one thread, same speed).
        torch.set_num_threads(1)
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU not available")
        self.device = torch.device("cuda")
        # cudnn autotuning spikes VRAM by several GB for no real gain here.
        torch.backends.cudnn.benchmark = False

        bag = get_model(model_name)
        models = bag.models if isinstance(bag, BagOfModels) else [bag]
        weights = (
            bag.weights if isinstance(bag, BagOfModels) else [[1.0] * len(bag.sources)]
        )
        vi = bag.sources.index("vocals")
        # htdemucs_ft is four specialist models; only the vocals specialist is
        # needed, so we skip the other three entirely (4x less GPU work).
        chosen = [(m, w[vi]) for m, w in zip(models, weights) if w[vi] > 0]
        self.models = []
        for m, w in chosen:
            m.to(self.device).eval()
            if hasattr(m, "use_train_segment"):
                m.use_train_segment = False  # allow windows shorter than 7.8s
            self.models.append((m, float(w), m.sources.index("vocals")))
        self.total_weight = sum(w for _, w, _ in self.models)
        self.samplerate = bag.samplerate
        self.name = model_name
        self.gpu = torch.cuda.get_device_name(0)
        log.info("model %s on %s (%d sub-model(s))", model_name, self.gpu, len(self.models))

    def vocals(self, audio: np.ndarray, sr: int) -> np.ndarray:
        """audio: float32 [2, T] at sample rate sr -> vocals float32 [2, T]."""
        torch = self.torch
        import torchaudio.functional as AF

        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16):
            x = torch.from_numpy(audio).to(self.device)
            length = x.shape[-1]
            if sr != self.samplerate:
                x = AF.resample(x, sr, self.samplerate)
            ref = x.mean(0)
            mean, std = ref.mean(), ref.std().clamp_min(1e-6)
            x = (x - mean) / std
            out = None
            for model, weight, vi in self.models:
                v = model(x[None])[0, vi] * weight
                out = v if out is None else out + v
            out = out / self.total_weight * std + mean
            if sr != self.samplerate:
                out = AF.resample(out, self.samplerate, sr)
            if out.shape[-1] < length:
                out = torch.nn.functional.pad(out, (0, length - out.shape[-1]))
            return out[:, :length].float().cpu().numpy()


# --------------------------------------------------------------------------- #
# Per-stream streaming state
# --------------------------------------------------------------------------- #
class Stream:
    def __init__(self, sr: int):
        self.sr = sr
        self.window = int(round(WINDOW_SEC * sr))
        self.lookahead = int(round(LOOKAHEAD_SEC * sr))
        self.reset(None, 0)

    def reset(self, epoch, start: int) -> None:
        self.epoch = epoch
        self.hist = np.zeros((2, self.window), dtype=np.float32)
        self.end = start  # absolute sample index just after the newest sample
        self.tail = None  # (start, samples) carried over for crossfading

    def push(self, sep: Separator, epoch, start: int, data: np.ndarray):
        """Add a chunk; return (out_start, voice) for the slice now ready."""
        n = data.shape[1]
        if epoch != self.epoch or start != self.end:
            self.reset(epoch, start)
        self.hist = np.concatenate([self.hist[:, n:], data], axis=1)
        self.end = start + n

        out_start = self.end - self.lookahead - n
        offset = self.window - self.lookahead - n
        need = n + XFADE
        if np.abs(self.hist).max() < SILENCE:
            seg = np.zeros((2, need), dtype=np.float32)
        else:
            seg = sep.vocals(self.hist, self.sr)[:, offset : offset + need]

        if self.tail is not None and self.tail[0] == out_start:
            fade = np.linspace(0.0, 1.0, XFADE, dtype=np.float32)
            seg[:, :XFADE] = self.tail[1] * (1 - fade) + seg[:, :XFADE] * fade
        self.tail = (out_start + n, seg[:, n : n + XFADE].copy())
        return out_start, seg[:, :n]


# --------------------------------------------------------------------------- #
# PCM helpers (interleaved 16-bit stereo, base64)
# --------------------------------------------------------------------------- #
def decode_pcm(b64: str) -> np.ndarray:
    pcm = np.frombuffer(base64.b64decode(b64), dtype="<i2").astype(np.float32) / 32768.0
    return np.ascontiguousarray(pcm.reshape(-1, 2).T)


def encode_pcm(audio: np.ndarray) -> str:
    pcm = (np.clip(audio.T, -1.0, 1.0) * 32767.0).astype("<i2")
    return base64.b64encode(pcm.tobytes()).decode()


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def main() -> None:
    log.info("helper starting (pid %d)", os.getpid())
    send({"t": "status", "state": "loading"})
    try:
        sep = Separator()
        # Warm up so the first real chunk isn't slow (CUDA init, cudnn tuning).
        for sr in (48000, 44100):
            sep.vocals(np.random.randn(2, int(WINDOW_SEC * sr)).astype(np.float32) * 0.1, sr)
    except Exception as e:
        log.exception("model load failed")
        send({"t": "status", "state": "error", "error": str(e)})
        sep = None

    if sep is not None:
        send(
            {
                "t": "status",
                "state": "ready",
                "gpu": sep.gpu,
                "model": sep.name,
                "lookahead": LOOKAHEAD_SEC,
                "window": WINDOW_SEC,
            }
        )

    q: queue.Queue = queue.Queue()
    threading.Thread(target=read_messages, args=(q,), daemon=True).start()

    streams: dict[str, Stream] = {}
    stats = {"chunks": 0, "busy": 0.0, "max_ms": 0.0, "images": 0, "since": time.time()}
    images: list = []  # pending image checks; sound always goes first
    judge = None

    def get_judge():
        nonlocal judge
        if judge is None:
            import vision

            import torch

            judge = vision.ImageJudge(sep.device if sep else torch.device("cuda"))
        return judge

    def handle(msg) -> None:
        t = msg.get("t")
        if t == "chunk" and sep is not None:
            sid = msg["sid"]
            sr = int(msg["sr"])
            st = streams.get(sid)
            if st is None or st.sr != sr:
                st = streams[sid] = Stream(sr)
            n = int(msg["n"])
            data = (
                np.zeros((2, n), dtype=np.float32)
                if msg.get("silent")
                else decode_pcm(msg["pcm"])
            )
            t0 = time.perf_counter()
            try:
                out_start, voice = st.push(sep, msg.get("epoch"), int(msg["start"]), data)
            except Exception:
                log.exception("processing failed")
                return  # browser plays silence for this slice
            ms = (time.perf_counter() - t0) * 1000
            stats["chunks"] += 1
            stats["busy"] += ms / 1000
            stats["max_ms"] = max(stats["max_ms"], ms)
            reply = {"t": "out", "sid": sid, "epoch": msg.get("epoch"), "start": out_start, "n": n}
            if np.abs(voice).max() < SILENCE:
                reply["silent"] = True
            else:
                reply["pcm"] = encode_pcm(voice)
            send(reply)
        elif t == "img":
            images.append(msg)
        elif t == "imgwarm":
            try:
                get_judge()
                send({"t": "imgready"})
            except Exception as e:
                log.exception("image models failed to load")
                send({"t": "imgready", "error": str(e)})
        elif t == "close":
            streams.pop(msg.get("sid"), None)
        elif t == "ping":
            elapsed = max(time.time() - stats["since"], 1e-6)
            send(
                {
                    "t": "pong",
                    "streams": len(streams),
                    "gpu_busy": round(stats["busy"] / elapsed, 3),
                    "max_ms": round(stats["max_ms"], 1),
                    "chunks": stats["chunks"],
                    "images": stats["images"],
                }
            )
            stats.update(chunks=0, busy=0.0, max_ms=0.0, images=0, since=time.time())

    def check_images() -> None:
        """Check up to 8 images in one GPU batch (a few ms), then let sound in."""
        batch = images[:8]
        del images[:8]
        t0 = time.perf_counter()
        try:
            j = get_judge()
            by_hide: dict[str, list] = {}
            for m in batch:
                by_hide.setdefault(m.get("hide", "female"), []).append(m)
            for hide, ms in by_hide.items():
                datas = [base64.b64decode(m["data"]) for m in ms]
                try:
                    results = j.judge(datas, hide)
                except Exception:
                    # One bad image shouldn't fail the others: retry singly.
                    results = []
                    for d in datas:
                        try:
                            results += j.judge([d], hide)
                        except Exception:
                            results.append((True, "could not read image"))
                for m, (h, why) in zip(ms, results):
                    send({"t": "imgres", "id": m["id"], "hide": bool(h), "why": why})
        except Exception as e:
            log.exception("image check failed")
            for m in batch:  # fail closed: keep hidden
                send({"t": "imgres", "id": m["id"], "hide": True, "why": f"error: {e}"})
        stats["images"] += len(batch)
        stats["busy"] += time.perf_counter() - t0

    while True:
        if images and q.empty():
            check_images()
            continue
        msg = q.get()
        if msg is None:
            break
        handle(msg)
        # Handle everything already waiting (sound first) before more images.
        while not q.empty():
            msg = q.get()
            if msg is None:
                images.clear()
                break
            handle(msg)
        if msg is None:
            break
    log.info("helper exiting")


if __name__ == "__main__":
    main()
