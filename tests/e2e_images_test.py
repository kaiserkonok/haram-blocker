#!/usr/bin/env python3
"""End-to-end test for image hiding: Chromium + extension + GPU helper.

Usage: python tests/e2e_images_test.py eval.json image_dir

eval.json lists photos with a "group" of female / male / mixed / none
(see helper/test_vision.py). With "I am a man" selected, the test page shows
photos of each group; half come from another origin so both ways of reading
an image are used (page canvas, and download by the extension).

Checks:
  * every image is hidden from the very first painted frame until checked
  * no photo with a woman is shown in ANY frame (records every frame)
  * hidden photos are really covered (screenshot pixels are black)
  * photos without people are shown
  * changing an image's source hides it again at once
  * logos are shown: the project's SVG logo (from another origin, so the
    extension downloads and draws it itself) and transparent PNG logos
  * pictures drawn as CSS backgrounds (how X/Twitter shows photos: a box
    with background-image plus an invisible <img> of the same picture) are
    covered in every frame unless allowed, and a background swapped to a
    woman's photo is never shown
"""

import functools
import http.server
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
PER_GROUP = 8


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve(directory):
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(CORSHandler, directory=directory))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


# Runs in the page before anything else: records, for every frame, which
# images were visible (data-hb="ok").
WATCH_JS = """
window.__frames = [];
(function tick() {
  const shown = [...document.querySelectorAll('img[data-group]')].filter((i) => i.getAttribute('data-hb') === 'ok').map((i) => i.dataset.group + ':' + i.dataset.n);
  const hiddenStyle = [...document.querySelectorAll('img[data-group]')].map((i) => getComputedStyle(i).objectPosition);
  // background pictures count as shown when the page actually paints them
  const bgShown = [...document.querySelectorAll('div[data-bg]')].filter((d) => getComputedStyle(d).backgroundImage !== 'none').map((d) => d.dataset.group + ':' + d.dataset.n);
  window.__frames.push({ t: performance.now(), shown, hiddenStyle, bgShown });
  requestAnimationFrame(tick);
})();
"""


def main():
    items = json.load(open(sys.argv[1]))
    folder = sys.argv[2]
    random.seed(7)
    work = tempfile.mkdtemp(prefix="hb-img-")
    a_dir, b_dir = os.path.join(work, "a"), os.path.join(work, "b")
    os.makedirs(a_dir)
    os.makedirs(b_dir)
    port_b = serve(b_dir)

    picks = []
    for g in ("female", "mixed", "male", "none"):
        for k, it in enumerate(random.sample([i for i in items if i["group"] == g], PER_GROUP)):
            name = os.path.basename(it["url"])
            cross = k % 2 == 1
            shutil.copy(os.path.join(folder, name), os.path.join(b_dir if cross else a_dir, name))
            src = f"http://127.0.0.1:{port_b}/{name}" if cross else name
            picks.append((g, k, src))
    # Logos: the project's SVG logo and generated transparent PNG logos,
    # served from the other origin.
    from PIL import Image, ImageDraw

    shutil.copy(os.path.join(ROOT, "docs", "assets", "logo.svg"), os.path.join(b_dir, "logo.svg"))
    picks.append(("logo", 0, f"http://127.0.0.1:{port_b}/logo.svg"))
    for k, (shape, color) in enumerate([("circle", "#1f6feb"), ("square", "#d1242f"), ("ring", "#111111")], start=1):
        im = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        if shape == "circle":
            d.ellipse([28, 28, 228, 228], fill=color)
        elif shape == "square":
            d.rounded_rectangle([40, 40, 216, 216], 30, fill=color)
        else:
            d.ellipse([28, 28, 228, 228], outline=color, width=24)
        im.save(os.path.join(b_dir, f"logo{k}.png"))
        picks.append(("logo", k, f"http://127.0.0.1:{port_b}/logo{k}.png"))

    # a photo with a woman, used for the "source changes" check
    swap = next(os.path.basename(i["url"]) for i in items if i["group"] == "female")
    shutil.copy(os.path.join(folder, swap), os.path.join(a_dir, "swap.jpg"))

    tags = "".join(
        f"<img data-group='{g}' data-n='{k}' src='{src}' width='200' height='150' style='object-fit:cover'>"
        for g, k, src in picks
    )
    # X/Twitter style: the visible picture is the box's background; the <img>
    # on top is see-through (opacity 0).
    bg_picks = [p for p in picks if p[0] in ("female", "mixed", "none", "logo")][::2]
    tags += "".join(
        f"<div data-bg data-group='{g}' data-n='{k}' style='position:relative;display:inline-block;width:200px;height:150px;"
        f"background-size:cover;background-image:url(\"{src}\")'>"
        f"<img src='{src}' style='position:absolute;inset:0;width:100%;height:100%;opacity:0'></div>"
        for g, k, src in bg_picks
    )
    with open(os.path.join(a_dir, "index.html"), "w") as f:
        f.write(f"<!doctype html><html><head><script>{WATCH_JS}</script></head>"
                f"<body style='margin:0;background:#fff'>{tags}</body></html>")
    port_a = serve(a_dir)

    profile = os.path.join(work, "profile")
    os.makedirs(os.path.join(profile, "NativeMessagingHosts"))
    # Register the helper from THIS checkout (not the installed one).
    with open(os.path.join(profile, "NativeMessagingHosts", "com.haram_blocker.cleaner.json"), "w") as f:
        json.dump({
            "name": "com.haram_blocker.cleaner",
            "description": "Haram Blocker GPU helper (test)",
            "path": os.path.join(ROOT, "helper", "run.sh"),
            "type": "stdio",
            "allowed_origins": ["chrome-extension://dlhalfnkadcmncbhilghjipnpjmaaocb/"],
        }, f)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile,
            headless=True,
            executable_path=os.environ.get("HB_CHROMIUM") or None,
            # Test runs log to their own folder, never into the real helper's log.
            env={**os.environ, "HB_LOG_DIR": os.path.join(work, "logs")},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            viewport={"width": 1600, "height": 1000},
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        # Wait for the extension's first-run setup (it stores default
        # settings), then choose "I am a man".
        while not sw.evaluate("chrome.storage.local.get('lipSync').then((v) => 'lipSync' in v)"):
            time.sleep(0.1)
        sw.evaluate("chrome.storage.local.set({ imageMode: 'male' })")
        t0 = time.time()
        while not sw.evaluate("helper.state === 'ready' && !!imagesReady"):
            if time.time() - t0 > 90:
                print("helper not ready:", sw.evaluate("helper"), sw.evaluate("({mode: settings.imageMode, warm: String(imagesReady), native: !!native})"), sw.evaluate("chrome.storage.local.get(null)"))
                return 1
            time.sleep(0.5)
        sw.evaluate("imagesReady")  # wait until the image models are on the GPU
        print(f"helper + image models ready after {time.time()-t0:.1f}s")

        page = ctx.new_page()
        t_nav = time.time()
        page.goto(f"http://127.0.0.1:{port_a}/index.html")
        page.wait_for_function(
            "[...document.querySelectorAll('img[data-group]')].every((i) => i.getAttribute('data-hb'))", timeout=30000
        )
        try:
            page.wait_for_function(
                "[...document.querySelectorAll('div[data-bg]')].every((i) => i.getAttribute('data-hb'))", timeout=15000
            )
        except Exception:
            print("background pictures were never decided")
        took = time.time() - t_nav
        time.sleep(0.5)
        frames = page.evaluate("window.__frames")
        result = page.evaluate(
            "[...document.querySelectorAll('img[data-group]')].map((i) => [i.dataset.group, i.dataset.n, i.getAttribute('data-hb')])"
        )
        bg_result = page.evaluate(
            "[...document.querySelectorAll('div[data-bg]')].map((d) => [d.dataset.group, d.dataset.n, getComputedStyle(d).backgroundImage !== 'none'])"
        )
        # Background swap: a shown logo box gets a woman's photo as background.
        bg_swap = page.evaluate(
            """async () => {
              const d = [...document.querySelectorAll('div[data-bg]')].find((x) => x.dataset.group === 'logo' && getComputedStyle(x).backgroundImage !== 'none');
              if (!d) return null;
              const seen = [];
              d.style.backgroundImage = 'url("swap.jpg")';
              for (let i = 0; i < 90; i++) {
                await new Promise((r) => requestAnimationFrame(r));
                seen.push(getComputedStyle(d).backgroundImage.includes('swap.jpg'));
              }
              return seen;
            }"""
        )

        # Pixel check: hidden images must be solid black on screen.
        dark = []
        for g, n, state in result:
            if state == "hide":
                shot = page.locator(f"img[data-group='{g}'][data-n='{n}']").screenshot()
                from io import BytesIO

                from PIL import Image

                im = Image.open(BytesIO(shot)).convert("L")
                dark.append(max(im.get_flattened_data() if hasattr(im, "get_flattened_data") else im.getdata()) < 20)

        # Source change: a shown image gets a photo of a woman.
        target = next((f"img[data-group='{g}'][data-n='{n}']" for g, n, s in result if s == "ok"), None)
        swap_frames = None
        if target:
            swap_frames = page.evaluate(
                """async (sel) => {
                  const img = document.querySelector(sel);
                  const seen = [];
                  img.src = 'swap.jpg';
                  for (let i = 0; i < 90; i++) {
                    await new Promise((r) => requestAnimationFrame(r));
                    seen.push(img.getAttribute('data-hb') === 'ok' && img.complete && img.currentSrc.endsWith('swap.jpg'));
                  }
                  return seen;
                }""",
                target,
            )
        ctx.close()

    # first frame in which the images exist on the page
    first = next(f for f in frames if len(f["hiddenStyle"]) == len(result))
    leaked = sorted({s for f in frames for s in f["shown"] if s.split(":")[0] in ("female", "mixed")})
    by = {}
    for g, n, s in result:
        by.setdefault(g, []).append(s)
    print(f"all {len(result)} images decided in {took:.2f}s (page load included)")
    print(f"first painted frame: {len(first['shown'])} images shown, "
          f"{sum(p.startswith('-99999px') for p in first['hiddenStyle'])}/{len(result)} covered")
    for g in ("female", "mixed", "male", "none", "logo"):
        print(f"  {g:6s}: hidden {by[g].count('hide')}/{len(by[g])}")
    print(f"photos with women shown in any frame: {leaked or 'none'}  ({len(frames)} frames recorded)")
    print(f"hidden images black on screen: {sum(dark)}/{len(dark)}")
    if swap_frames is not None:
        print(f"source changed to a woman's photo: shown in {sum(swap_frames)}/{len(swap_frames)} frames")

    bg_leaked = sorted({s for f in frames for s in f.get("bgShown", []) if s.split(":")[0] in ("female", "mixed")})
    bg_by = {}
    for g, n, shown in bg_result:
        bg_by.setdefault(g, []).append(shown)
    print(f"background pictures shown at the end: " + ", ".join(f"{g} {sum(v)}/{len(v)}" for g, v in bg_by.items()))
    print(f"background photos with women shown in any frame: {bg_leaked or 'none'}")
    if bg_swap is not None:
        print(f"background changed to a woman's photo: shown in {sum(bg_swap)}/{len(bg_swap)} frames")

    ok = True
    ok &= not bg_leaked
    ok &= sum(bg_by.get("logo", [])) == len(bg_by.get("logo", []))  # background logos must show
    ok &= sum(bg_by.get("none", [])) >= len(bg_by.get("none", [])) // 2
    ok &= bg_swap is not None and not any(bg_swap)
    ok &= len(first["shown"]) == 0
    ok &= all(p.startswith("-99999px") for p in first["hiddenStyle"])
    ok &= not leaked
    ok &= all(dark)
    ok &= by["none"].count("hide") <= PER_GROUP // 2
    ok &= by["logo"].count("hide") == 0  # SVG and transparent logos must show
    ok &= swap_frames is None or not any(swap_frames)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
