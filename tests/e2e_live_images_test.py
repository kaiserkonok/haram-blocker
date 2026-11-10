#!/usr/bin/env python3
"""Live check on a real page (needs internet): which images are shown/hidden.

Usage: python tests/e2e_live_images_test.py [url] [--expect-shown SUBSTRING ...]

Opens the page with "I am a man" selected, waits for every image to be
decided and prints each one. With --expect-shown, the test fails unless every
image whose address contains one of the substrings is shown.
"""

import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")


def main():
    args = sys.argv[1:]
    expect = []
    if "--expect-shown" in args:
        i = args.index("--expect-shown")
        expect, args = args[i + 1:], args[:i]
    url = args[0] if args else "https://github.com/kaiserkonok/haram-blocker"
    work = tempfile.mkdtemp(prefix="hb-live-")
    profile = os.path.join(work, "profile")
    os.makedirs(os.path.join(profile, "NativeMessagingHosts"))
    with open(os.path.join(profile, "NativeMessagingHosts", "com.haram_blocker.cleaner.json"), "w") as f:
        json.dump({"name": "com.haram_blocker.cleaner", "description": "test", "type": "stdio",
                   "path": os.path.join(ROOT, "helper", "run.sh"),
                   "allowed_origins": ["chrome-extension://dlhalfnkadcmncbhilghjipnpjmaaocb/"]}, f)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile, headless=True, executable_path=os.environ.get("HB_CHROMIUM") or None,
            env={**os.environ, "HB_LOG_DIR": os.path.join(work, "logs")},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            viewport={"width": 1400, "height": 1000})
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        while not sw.evaluate("chrome.storage.local.get('lipSync').then((v) => 'lipSync' in v)"):
            time.sleep(0.1)
        sw.evaluate("chrome.storage.local.set({ imageMode: 'male' })")
        while not sw.evaluate("helper.state === 'ready' && !!imagesReady"):
            time.sleep(0.5)
        sw.evaluate("imagesReady")
        page = ctx.new_page()
        page.goto(url, wait_until="load")
        time.sleep(4)
        imgs = page.evaluate("""[...document.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().width > 0)
            .map((i) => ({ src: (i.currentSrc || i.src).slice(0, 110), alt: (i.alt || '').slice(0, 30),
                           w: i.naturalWidth, h: i.naturalHeight, state: i.getAttribute('data-hb') }))""")
        ctx.close()
    ok = True
    for im in imgs:
        need = any(e in im["src"] for e in expect)
        bad = need and im["state"] != "ok"
        ok &= not bad
        print(f"{(im['state'] or 'pending'):7s} {im['w']:4d}x{im['h']:<4d} {im['alt']:30s} {im['src']}{'  <-- should be shown' if bad else ''}")
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
