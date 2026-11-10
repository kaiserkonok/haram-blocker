#!/usr/bin/env python3
"""Checks the helper with a real song.

Usage: .venv/bin/python test_stream.py music_file speech_file

The speech is mixed on top of the music, so we know exactly what the perfect
result is (the speech alone).

1. Voice kept: streams the mix in small live-sized chunks and compares the
   output with the original speech. Also compares with separating the whole
   file at once (the best the model can do).
2. Music leak: streams the music alone and measures how loud the output is
   compared with the input. Lower is better.
3. Protocol + timing: runs host.py exactly as Chrome does (native messaging
   over stdin/stdout) and checks that every slice comes back well inside the
   1 second playback delay.
"""

import base64
import json
import os
import struct
import subprocess
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import host  # noqa: E402

SR = 48000
CHUNK = 9600  # 0.2 s, same as the extension
DELAY_SEC = 1.0


def load(path: str) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-ar", str(SR), "-ac", "2", "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2).T.copy()


def db(x: float) -> float:
    return 10 * np.log10(max(x, 1e-12))


def stream_through(sep, audio: np.ndarray) -> np.ndarray:
    st = host.Stream(SR)
    out = np.zeros_like(audio)
    n_total = audio.shape[1]
    padded = np.concatenate([audio, np.zeros((2, SR), dtype=np.float32)], axis=1)
    for start in range(0, n_total + SR - CHUNK + 1, CHUNK):
        o, v = st.push(sep, 1, start, padded[:, start : start + CHUNK])
        lo, hi = max(o, 0), min(o + CHUNK, n_total)
        if hi > lo:
            out[:, lo:hi] = v[:, lo - o : hi - o]
    return out


def protocol_test(audio: np.ndarray) -> None:
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "host.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    )

    def read():
        n = struct.unpack("=I", proc.stdout.read(4))[0]
        return json.loads(proc.stdout.read(n))

    def write(m):
        b = json.dumps(m).encode()
        proc.stdin.write(struct.pack("=I", len(b)) + b)
        proc.stdin.flush()

    while True:
        m = read()
        if m.get("state") in ("ready", "error"):
            print(f"  helper status: {m}")
            break
    assert m["state"] == "ready", m

    # Send chunks in real time and measure when each slice is ready vs. when
    # the browser would need to play it.
    margins = []
    t0 = time.perf_counter()
    n_chunks = min(audio.shape[1] // CHUNK, 50)  # 10 s
    for k in range(n_chunks):
        start = k * CHUNK
        captured_at = (start + CHUNK) / SR  # chunk complete at this time
        while time.perf_counter() - t0 < captured_at:
            time.sleep(0.001)
        pcm = (np.clip(audio[:, start : start + CHUNK].T, -1, 1) * 32767).astype("<i2")
        write({"t": "chunk", "sid": "test", "epoch": 1, "start": start, "sr": SR, "n": CHUNK,
               "pcm": base64.b64encode(pcm.tobytes()).decode()})
        r = read()
        ready_at = time.perf_counter() - t0
        play_at = r["start"] / SR + DELAY_SEC  # first sample of the slice plays here
        margins.append(play_at - ready_at)
    write({"t": "ping"})
    print(f"  stats: {read()}")
    proc.stdin.close()
    proc.wait(timeout=10)
    margins = np.array(margins)
    print(f"  slices ready with {margins.min()*1000:.0f} ms to spare at worst "
          f"(median {np.median(margins)*1000:.0f} ms)")
    assert margins.min() > 0.05, "slices arrive too late for the 1 s delay"


def main() -> None:
    music, speech = load(sys.argv[1]), load(sys.argv[2])
    n = min(music.shape[1], speech.shape[1])
    music, speech = music[:, :n], speech[:, :n]
    speech *= np.sqrt((music**2).mean() / (speech**2).mean())  # equally loud
    audio = music + speech
    print(f"mix: {n/SR:.1f} s, speech and music equally loud")
    sep = host.Separator()

    def quality(out):  # how close to the clean speech, in dB
        return db((speech**2).mean()) - db(((out - speech) ** 2).mean())

    print("1) voice kept")
    whole = sep.vocals(audio, SR)
    t = time.perf_counter()
    streamed = stream_through(sep, audio)
    took = time.perf_counter() - t
    print(f"  input mix vs clean speech:  {quality(audio):5.1f} dB")
    print(f"  whole-file separation:      {quality(whole):5.1f} dB  (best case)")
    print(f"  live streaming separation:  {quality(streamed):5.1f} dB")
    print(f"  processed {n/SR:.1f} s of audio in {took:.1f} s")
    assert quality(streamed) > quality(whole) - 2, "streaming is much worse than best case"

    print("2) music leak")
    leaked = stream_through(sep, music)
    leak_db = db((leaked**2).mean()) - db((music**2).mean())
    print(f"  music-only input comes out {-leak_db:.1f} dB quieter "
          f"(about {100*10**(leak_db/20):.1f}% of the original loudness)")
    assert leak_db < -30, "too much music comes through"

    print("3) helper over native messaging, in real time")
    protocol_test(audio)
    print("all checks passed")


if __name__ == "__main__":
    main()
