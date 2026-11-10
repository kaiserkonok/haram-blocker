#!/usr/bin/env python3
"""End-to-end test: real Chromium + the extension + the GPU helper.

Usage: python tests/e2e_test.py music_file speech_file

Builds a 14 s test video: 0-3 s music only, 3-14 s speech over music.
Plays it in Chromium with the extension loaded and records, every 50 ms, the
loudness going into the cleaner and coming out to the speakers. Checks:
  * nothing at all comes out during the first second (no leak at start)
  * the music-only part comes out (almost) silent
  * the speech part comes out clearly
  * cleaned audio arrives on time (no gaps once playing)
  * the lip-sync overlay is shown over the video
Requires: playwright (python) with its Chromium, and install.sh already run.
Set HB_CHROMIUM to use a specific Chromium binary.
"""

import functools
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
MUSIC_ONLY = 3.0
DURATION = 14.0
DELAY = 1.0


def make_media(music: str, speech: str, out_dir: str) -> None:
    subprocess.run(
        [
            "ffmpeg", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=30:duration={DURATION}",
            "-i", music, "-i", speech,
            "-filter_complex",
            f"[1:a]aresample=48000,volume=0.5,atrim=0:{DURATION}[m];"
            f"[2:a]aresample=48000,volume=4,adelay={int(MUSIC_ONLY*1000)}:all=1,"
            f"apad,atrim=0:{DURATION}[s];"
            "[m][s]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=c0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "libvpx", "-b:v", "500k",
            "-c:a", "libopus", "-t", str(DURATION), os.path.join(out_dir, "test.webm"),
        ],
        check=True,
    )
    with open(os.path.join(out_dir, "index.html"), "w") as f:
        f.write(
            "<!doctype html><html data-haram-blocker-test><body style='margin:0;background:#222'>"
            "<div style='position:relative;width:640px;height:360px'>"
            "<video id=v src=test.webm width=640 height=360 playsinline></video></div>"
            "</body></html>"
        )


def serve(directory: str) -> int:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


def main() -> int:
    music, speech = sys.argv[1], sys.argv[2]
    work = tempfile.mkdtemp(prefix="hb-e2e-")
    make_media(music, speech, work)
    port = serve(work)

    # Chromium looks for the helper registration inside its profile folder.
    profile = os.path.join(work, "profile")
    os.makedirs(os.path.join(profile, "NativeMessagingHosts"))
    shutil.copy(
        os.path.expanduser("~/.config/google-chrome/NativeMessagingHosts/com.haram_blocker.cleaner.json"),
        os.path.join(profile, "NativeMessagingHosts"),
    )

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile,
            headless=True,
            executable_path=os.environ.get("HB_CHROMIUM") or None,
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--autoplay-policy=no-user-gesture-required",
            ],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        print("extension loaded:", sw.url.split("/")[2])

        t0 = time.time()
        while True:
            state = sw.evaluate("helper")
            if state.get("state") == "ready":
                break
            if state.get("state") == "error" or time.time() - t0 > 60:
                print("helper failed:", state)
                return 1
            time.sleep(0.5)
        print(f"helper ready after {time.time()-t0:.1f}s on {state.get('gpu')}")

        page = ctx.new_page()
        page.on("console", lambda m: m.text.startswith("[haram") and print("  page:", m.text))
        page.goto(f"http://127.0.0.1:{port}/index.html")
        page.wait_for_function("document.querySelector('video').readyState >= 3")
        page.mouse.click(10, 10)  # user gesture, as a real user would
        time.sleep(0.5)
        page.evaluate("document.getElementById('v').play()")
        time.sleep(1.5)
        overlay = page.evaluate(
            "(() => { const c = document.querySelector('canvas[data-haram-blocker]');"
            " return c ? getComputedStyle(c).display : 'missing'; })()"
        )
        page.screenshot(path=os.path.join(work, "playing.png"))
        time.sleep(DURATION - 0.5)
        log = page.evaluate("window.__haramBlockerTest || []")
        status = sw.evaluate("({helper, lastPong})")
        ctx.close()

    if not log:
        print("FAIL: no measurements (cleaner never started)")
        return 1
    t = np.array([e["ctxTime"] for e in log])
    rin = np.array([e["in"] for e in log])
    rout = np.array([e["out"] for e in log])

    start = t[np.argmax(rin > 1e-3)]  # media starts making sound

    def mean_at(arr, a, b):
        sel = (t >= start + a) & (t < start + b)
        return float(arr[sel].mean()) if sel.any() else float("nan")

    first_second = float(rout[(t >= start) & (t < start + DELAY - 0.1)].max())
    music_in = mean_at(rin, 0.3, MUSIC_ONLY - 0.3)
    music_out = mean_at(rout, 0.3 + DELAY, MUSIC_ONLY - 0.3 + DELAY)
    speech_in = mean_at(rin, MUSIC_ONLY + 0.5, 11)
    speech_out = mean_at(rout, MUSIC_ONLY + 0.5 + DELAY, 11 + DELAY)
    gaps = int(((rout < 1e-4) & (t > start + MUSIC_ONLY + DELAY + 0.5) & (t < start + 11)).sum())

    db = lambda x: 20 * np.log10(max(x, 1e-9))
    print(f"first second, loudest output: {db(first_second):6.1f} dB  (should be silence)")
    print(f"music-only part:  in {db(music_in):6.1f} dB -> out {db(music_out):6.1f} dB")
    print(f"speech part:      in {db(speech_in):6.1f} dB -> out {db(speech_out):6.1f} dB")
    print(f"silent 50 ms samples during speech: {gaps}")
    print(f"lip-sync overlay: {overlay}")
    print(f"helper: {status}")
    print(f"screenshot: {os.path.join(work, 'playing.png')}")

    ok = True
    ok &= first_second < 1e-4
    ok &= db(music_out) < db(music_in) - 30
    ok &= db(speech_out) > db(music_out) + 20
    ok &= overlay == "block"
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
