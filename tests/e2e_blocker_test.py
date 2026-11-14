#!/usr/bin/env python3
"""End-to-end test for the site blocker (Chromium + extension; no GPU needed).

Every website name is pointed at a local test server, so real addresses
(pornhub.com, youtube.com, ...) can be used without touching the internet.

Checks:
  * built-in adult list: blocked (with subdomains), shown as the blocked page
    with a verse, its recitation and the reminder; embedded in another site,
    the frame is blocked quietly
  * popular normal sites are never blocked
  * the user's own site: blocked with subdomains, an already-open tab moves
    to the blocked page, similar names are not blocked
  * part of a site (spa.com/shorts): blocked on load AND when the page moves
    there without loading (like YouTube Shorts), other parts stay usable
  * "Go back" leaves the blocked page
  * unblocking: impossible before the 30 s pause (also when asking the
    background directly), wrong sentence refused, right sentence unblocks
    and opens the site
  * after unblocking, the next blocked page starts with the mercy verse
  * unblocking one adult site leaves the others blocked; turning the adult
    list off and on works

Usage: python tests/e2e_blocker_test.py
"""

import http.server
import json
import os
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
EXT_ID = "dlhalfnkadcmncbhilghjipnpjmaaocb"
BLOCKED = f"chrome-extension://{EXT_ID}/blocker/blocked.html"
SENTENCE = "I am choosing my desire over what I know is better."
VERSES = json.load(open(os.path.join(EXT, "blocker", "verses.json")))["passages"]


class Site(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        host = self.headers.get("Host", "").split(":")[0]
        body = f"<title>site {host}{self.path}</title><h1 id=ok>{host}{self.path}</h1>"
        if host == "embed-host.com":
            body += "<iframe id=f src='http://pornhub.com/embed/123' width=400 height=200></iframe>"
        if host == "spa.com":
            body += "<script>window.go = (p) => history.pushState({}, '', p);</script>"
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  [{'ok' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))


def main():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    work = tempfile.mkdtemp(prefix="hb-block-")

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            os.path.join(work, "profile"),
            headless=True,
            executable_path=os.environ.get("HB_CHROMIUM") or None,
            env={**os.environ, "HB_LOG_DIR": os.path.join(work, "logs")},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}",
                  f"--host-resolver-rules=MAP * 127.0.0.1:{port}"],
        )
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        t0 = time.time()
        while not sw.evaluate("chrome.storage.local.get('blockAdult').then((v) => 'blockAdult' in v)"):
            if time.time() - t0 > 20:
                print("settings never initialised")
                return 1
            time.sleep(0.1)
        time.sleep(0.5)
        page = ctx.new_page()
        menu = ctx.new_page()
        menu.goto(f"chrome-extension://{EXT_ID}/popup/popup.html")

        def send(msg):
            return menu.evaluate("(m) => chrome.runtime.sendMessage(m)", msg)

        def goto(url):
            try:
                page.goto(url, wait_until="load")
            except Exception:
                pass  # redirected to the extension page
            page.wait_for_load_state("load")
            return page.url

        def loads_site(url):
            u = goto(url)
            return u.startswith("http") and page.locator("#ok").count() == 1

        # Chrome's own record of where each tab is (Playwright doesn't always
        # notice a tab being moved by the extension).
        def tab_urls():
            return sw.evaluate("chrome.tabs.query({}).then((t) => t.map((x) => x.url))")

        def wait_tab(url, timeout=3.0, prefix=False):
            t = time.time()
            while time.time() - t < timeout:
                if any(u.startswith(url) if prefix else u == url for u in tab_urls()):
                    return time.time() - t
                time.sleep(0.02)
            return None

        def wait_url(prefix, pg=None, timeout=3.0):
            pg = pg or page
            t = time.time()
            while time.time() - t < timeout:
                if pg.url.startswith(prefix):
                    return time.time() - t
                time.sleep(0.02)
            return None

        print("built-in adult list:")
        for url in ["http://pornhub.com/view?x=1", "http://www.xvideos.com/", "http://m.xhamster.com/videos"]:
            u = goto(url)
            check(f"{url} blocked", u.startswith(BLOCKED + "?list=adult#" + url), u[:90])
        page.wait_for_selector("#verse .ar")
        ref = page.locator("#verse").get_attribute("data-ref")
        passage = next((v for v in VERSES if v["ref"] == ref), None)
        check("verse shown (Arabic + English + reference)", passage is not None
              and page.locator("#verse .en").inner_text() == " ".join(a["en"] for a in passage["ayat"]), ref)
        check("reminder shown", "brick in the person you're becoming" in page.locator(".reminder").inner_text())
        time.sleep(1.0)
        check("recitation playing", page.locator("#verse .play").inner_text() == "■ Stop",
              page.locator("#verse .play").inner_text())
        goto("http://pornhub.com/again")
        page.wait_for_selector("#verse .ar")
        check("next visit shows a different verse", page.locator("#verse").get_attribute("data-ref") != ref)

        goto("http://embed-host.com/")
        time.sleep(0.5)
        frame = next((f for f in page.frames if f != page.main_frame), None)
        check("embedded adult video blocked", frame is not None and frame.url.startswith(BLOCKED),
              frame.url[:80] if frame else "no frame")
        check("embedded: quiet notice, no recitation", frame is not None
              and frame.locator("#frameNotice").is_visible() and not frame.locator("#page").is_visible())
        check("host page itself loads", page.locator("#ok").count() == 1)

        print("normal sites stay open:")
        never = ["google.com", "youtube.com", "x.com", "reddit.com", "wikipedia.org", "quran.com",
                 "github.com", "facebook.com", "instagram.com", "amazon.com"]
        opened = [d for d in never if loads_site(f"http://{d}/")]
        check(f"{len(opened)}/{len(never)} popular sites open", len(opened) == len(never),
              ", ".join(sorted(set(never) - set(opened))))

        print("your own blocked site:")
        other = ctx.new_page()
        other.goto("http://blocked-test.com/already-open")
        r = send({"t": "block", "site": "https://www.Blocked-Test.com/"})
        check("added (normalised)", r.get("site") == "blocked-test.com", str(r))
        moved = wait_tab(BLOCKED + "?site=blocked-test.com#http://blocked-test.com/already-open")
        check("already-open tab moves to the blocked page", moved is not None,
              f"{moved:.2f}s" if moved is not None else str(tab_urls()))
        other.close()
        u = goto("http://sub.blocked-test.com/page")
        check("subdomain blocked", u.startswith(BLOCKED + "?site=blocked-test.com#"), u[:80])
        check("similar names not blocked", loads_site("http://notblocked-test.com/") and loads_site("http://blocked-test.co/"))
        check("bad address refused", "error" in send({"t": "block", "site": "not a site"}))

        print("part of a site (like YouTube Shorts):")
        send({"t": "block", "site": "spa.com/shorts"})
        check("other parts open", loads_site("http://spa.com/watch?v=1"))
        u = goto("http://spa.com/shorts/abc")
        check("loading the part blocked", u.startswith(BLOCKED + "?site=spa.com%2Fshorts#"), u[:80])
        check("'/shortsx' not blocked", loads_site("http://spa.com/shortsx"))
        loads_site("http://spa.com/watch?v=2")
        page.evaluate("go('/Shorts/xyz')")
        took = wait_tab(BLOCKED + "?site=spa.com%2Fshorts#http://spa.com/Shorts/xyz")
        check("moving there without a reload is caught", took is not None,
              f"{took:.2f}s" if took is not None else str(tab_urls()))
        page.wait_for_selector("#back")
        page.click("#back")
        page.wait_for_load_state("load")
        check("'Go back' goes to the site's home", page.url == "http://spa.com/", page.url)

        loads_site("http://example.com/start")
        goto("http://blocked-test.com/x")
        page.wait_for_selector("#back")
        page.click("#back")
        time.sleep(0.8)
        check("'Go back' returns to the previous page", page.url == "http://example.com/start", page.url)

        print("unblocking:")
        goto("http://blocked-test.com/page")
        page.click("#unblock")
        page.wait_for_selector("#unblockVerse .ar")
        uref = page.locator("#unblockVerse").get_attribute("data-ref")
        check("unblock verse is about desire/regret", any(v["ref"] == uref and v["where"] == "unblock" for v in VERSES), uref)
        check("sentence box hidden during the pause", not page.locator("#typeStep").is_visible())
        early = page.evaluate("(m) => chrome.runtime.sendMessage(m)",
                              {"t": "unblockFinish", "target": "site:blocked-test.com", "text": SENTENCE})
        check("asking early is refused", "error" in early and "wait" in early["error"].lower(), str(early))
        time.sleep(25)
        check("still waiting after 25 s", not page.locator("#typeStep").is_visible())
        page.wait_for_selector("#typeStep", state="visible", timeout=10000)
        page.fill("#sentence", "I want it")
        check("wrong sentence: button stays off", page.locator("#confirm").is_disabled())
        page.fill("#sentence", "i am choosing my desire over what I know is better")
        check("right sentence: button on", page.locator("#confirm").is_enabled())
        page.click("#confirm")
        took = wait_tab("http://blocked-test.com/page", timeout=5)
        titles = []
        for _ in range(50):  # wait for it to finish loading
            titles = sw.evaluate("chrome.tabs.query({}).then((t) => t.map((x) => x.title))")
            if "site blocked-test.com/page" in titles:
                break
            time.sleep(0.1)
        check("unblocked and opened the site", took is not None and "site blocked-test.com/page" in titles,
              str(tab_urls()))
        st = sw.evaluate("chrome.storage.local.get(['blockedSites', 'slipped'])")
        check("removed from the list", "blocked-test.com" not in st["blockedSites"], str(st))

        print("mercy after unblocking:")
        send({"t": "block", "site": "blocked-test.com"})
        goto("http://blocked-test.com/again")
        page.wait_for_selector("#verse .ar")
        check("next blocked page starts with 39:53",
              page.locator("#verse").get_attribute("data-ref").endswith("39:53") and page.locator("#mercy").is_visible(),
              page.locator("#verse").get_attribute("data-ref"))
        goto("http://blocked-test.com/again2")
        page.wait_for_selector("#verse .ar")
        check("only once", not page.locator("#mercy").is_visible())

        print("adult list exceptions and switch:")
        goto("http://pornhub.com/one")
        page.click("#unblock")
        page.wait_for_selector("#typeStep", state="visible", timeout=40000)
        page.fill("#sentence", SENTENCE)
        page.click("#confirm")
        wait_url("http://pornhub.com/one", timeout=5)
        page.wait_for_load_state("load")
        check("one adult site unblocked", page.locator("#ok").count() == 1, page.url)
        u = goto("http://xvideos.com/")
        check("other adult sites still blocked", u.startswith(BLOCKED), u[:60])

        page.goto(f"{BLOCKED}?unblock=adult-list")
        page.wait_for_selector("#typeStep", state="visible", timeout=40000)
        page.fill("#sentence", SENTENCE)
        page.click("#confirm")
        page.wait_for_selector("#done", state="visible")
        check("adult list off", loads_site("http://xvideos.com/"))
        send({"t": "blockAdult"})
        u = goto("http://xvideos.com/")
        check("adult list back on", u.startswith(BLOCKED), u[:60])
        ctx.close()

    print("PASS" if all(results) else f"FAIL ({results.count(False)} failed)")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
