#!/usr/bin/env python3
"""Live test on real YouTube (needs internet): play, pause, play.

Usage: python tests/e2e_youtube_test.py [video_url]

The saved settings are seeded with malformed entries (an empty allowed
channel, like ones older versions could save). After every play the cleaner
must be running (not frozen) and cleaned audio must reach the speakers.
"""

import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=jNQXAC9IVRw"

STATE_JS = """() => {
  document.documentElement.setAttribute('data-haram-blocker-test', '');
  window.dispatchEvent(new Event('haram-blocker-test-query'));
  const s = JSON.parse(document.documentElement.getAttribute('data-haram-blocker-state') || 'null');
  const v = document.querySelector('video');
  return { paused: v.paused, frozen: s && s.media.length ? s.media.map((m) => m.frozen) : null };
}"""


def main():
    work = tempfile.mkdtemp(prefix="hb-yt-")
    profile = os.path.join(work, "profile")
    os.makedirs(os.path.join(profile, "NativeMessagingHosts"))
    with open(os.path.join(profile, "NativeMessagingHosts", "com.haram_blocker.cleaner.json"), "w") as f:
        json.dump({"name": "com.haram_blocker.cleaner", "description": "test", "type": "stdio",
                   "path": os.path.join(ROOT, "helper", "run.sh"),
                   "allowed_origins": ["chrome-extension://dlhalfnkadcmncbhilghjipnpjmaaocb/"]}, f)
    steps = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile, headless=True, executable_path=os.environ.get("HB_CHROMIUM") or None,
            env={**os.environ, "HB_LOG_DIR": os.path.join(work, "logs")},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  "--autoplay-policy=no-user-gesture-required"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        while sw.evaluate("helper.state") != "ready":
            time.sleep(0.5)
        time.sleep(1)  # let first-run setup finish, then plant the bad entries
        sw.evaluate("chrome.storage.local.set({ channels: [null, { name: 'no id' }], sites: [null, 5] })")
        page = ctx.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_function("document.querySelector('video') && document.querySelector('video').readyState >= 2", timeout=30000)
        page.mouse.click(5, 400)
        for action in ("play", "pause", "play", "pause", "play"):
            page.evaluate(f"document.querySelector('video').{action}()")
            time.sleep(2.5)
            steps.append((action, page.evaluate(STATE_JS)))
        stats = sw.evaluate("[...pages.values()].map((p) => p.stats).filter(Boolean)")
        errors = page.evaluate("0")
        ctx.close()

    ok = True
    for action, st in steps:
        frozen = st["frozen"] or [None]
        good = (action == "pause") == (frozen[0] is True)
        ok &= good
        print(f"after {action:5s}: video paused={st['paused']}, cleaner frozen={frozen[0]}  {'ok' if good else 'WRONG'}")
    played = sum(s["played"] for s in stats)
    print(f"cleaned audio played in the last 2 s: {played} samples")
    ok &= played > 0
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
