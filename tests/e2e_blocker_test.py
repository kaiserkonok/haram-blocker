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
  * "I sometimes need this site": a 10 s pause and a typed intention open it
    in that tab only (and tabs it opens); leaving the site or closing the tab
    blocks it again; the "Still working?" check-in can continue or close;
    marking a site as needed takes the full pause; a porn site can never be
    opened this way

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
NEED = "I am opening this site for a real need, and I will not look at anything haram. Allah sees me."
MARK = "I really need this site, and I will only use it for that need."
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

        print("needed sites (one visit, one tab):")
        r = send({"t": "block", "site": "need-test.com", "needed": True})
        st = sw.evaluate("chrome.storage.local.get('neededSites')")
        check("added as needed", "need-test.com" in st["neededSites"], str(r))

        def titles():
            return sw.evaluate("chrome.tabs.query({}).then((t) => t.map((x) => x.title))")

        def wait_title(t, timeout=4.0):
            end = time.time() + timeout
            while time.time() < end:
                if t in titles():
                    return True
                time.sleep(0.05)
            return False

        def session_rules():
            return sw.evaluate("chrome.declarativeNetRequest.getSessionRules()")

        def nav(pg, url):
            try:
                pg.goto(url)
            except Exception:
                pass  # moved to the extension's page

        def open_for_need(pg, url):
            """Blocked page -> "I need it" -> pause -> intention -> open."""
            nav(pg, url)
            pg.wait_for_selector("#need", state="visible")
            pg.click("#need")
            pg.wait_for_selector("#unblockVerse .ar")
            pg.wait_for_selector("#typeStep", state="visible", timeout=20000)
            pg.fill("#sentence", NEED)
            pg.click("#confirm")

        goto("http://blocked-test.com/x")
        page.wait_for_selector("#verse .ar")
        time.sleep(0.3)
        check("not-needed site: no 'I need it' option", not page.locator("#need").is_visible())
        goto("http://xvideos.com/x")
        page.wait_for_selector("#verse .ar")
        time.sleep(0.3)
        check("adult site: no 'I need it' option", not page.locator("#need").is_visible())

        goto("http://need-test.com/page")
        page.wait_for_selector("#need", state="visible")
        check("needed site: 'I need it for something' offered", True)
        page.click("#need")
        page.wait_for_selector("#unblockVerse .ar")
        check("shows 'Allah sees' (96:14)", page.locator("#unblockVerse").get_attribute("data-ref").endswith("96:14"),
              page.locator("#unblockVerse").get_attribute("data-ref"))
        early = page.evaluate("(m) => chrome.runtime.sendMessage(m)",
                              {"t": "unblockFinish", "target": "need:need-test.com", "text": NEED})
        check("asking early is refused", "wait" in early.get("error", "").lower(), str(early))
        t = time.time()
        page.wait_for_selector("#typeStep", state="visible", timeout=20000)
        waited = time.time() - t
        check("pause is about 10 s", 8.5 < waited < 11.5, f"{waited:.1f}s")
        page.fill("#sentence", SENTENCE)
        check("the 'desire' sentence doesn't open it", page.locator("#confirm").is_disabled())
        page.fill("#sentence", NEED)
        page.click("#confirm")
        check("opens the site in this tab", wait_title("site need-test.com/page"), str(titles()))
        rules = session_rules()
        check("allowed for this one tab only", len(rules) == 1 and len(rules[0]["condition"]["tabIds"]) == 1, str(rules))

        other = ctx.new_page()
        nav(other, "http://need-test.com/elsewhere")
        check("still blocked in other tabs",
              wait_tab(BLOCKED + "?site=need-test.com#http://need-test.com/elsewhere") is not None, str(tab_urls()))
        other.close()
        nav(page, "http://need-test.com/other")
        nav(page, "http://m.need-test.com/")
        check("browsing the site in that tab works", wait_title("site m.need-test.com/"), str(titles()))
        page.evaluate("window.open('http://need-test.com/opened-by-site')")
        check("a tab the site opens is part of the visit", wait_title("site need-test.com/opened-by-site"),
              f"{titles()} {sw.evaluate('JSON.stringify(visitsCache)')} "
              f"{sw.evaluate('chrome.tabs.query({}).then((t) => t.map((x) => [x.id, x.openerTabId, x.url.slice(0, 60)]))')}")
        for pg in ctx.pages:
            if pg.url.endswith("/opened-by-site"):
                pg.close()
        nav(page, "http://example.com/left")
        nav(page, "http://need-test.com/again")
        check("leaving the site ends the visit",
              wait_tab(BLOCKED + "?site=need-test.com#http://need-test.com/again") is not None, str(tab_urls()))
        time.sleep(0.5)
        check("no openings left", session_rules() == [], str(session_rules()))

        p2 = ctx.new_page()
        open_for_need(p2, "http://need-test.com/visit2")
        ok2 = wait_title("site need-test.com/visit2")
        p2.close()
        time.sleep(0.5)
        p3 = ctx.new_page()
        nav(p3, "http://need-test.com/after-close")
        check("closing the tab ends the visit", ok2 and session_rules() == []
              and wait_tab(BLOCKED + "?site=need-test.com#http://need-test.com/after-close") is not None,
              f"{ok2} {session_rules()}")

        print("'Still working?' check-in (shortened to 3 s for the test):")
        sw.evaluate("chrome.storage.session.set({ testCheckinMs: 3000 })")
        open_for_need(p3, "http://need-test.com/work")
        wait_title("site need-test.com/work")
        go_btn = p3.locator("#haram-blocker-checkin .go")
        try:
            go_btn.wait_for(state="visible", timeout=10000)
            shown = True
        except Exception:
            shown = False
        check("check-in appears", shown)
        if shown:
            check("check-in reminds that Allah sees", "96:14" in p3.locator("#haram-blocker-checkin .v").inner_text())
            go_btn.click()
            time.sleep(0.5)
            check("'Still working' keeps the site open", len(session_rules()) == 1 and "site need-test.com/work" in titles())
            done_btn = p3.locator("#haram-blocker-checkin .close")
            done_btn.wait_for(state="visible", timeout=10000)
            done_btn.click()
            moved = wait_tab(BLOCKED + "?site=need-test.com#http://need-test.com/work") is not None
            time.sleep(0.3)
            check("'I'm done' closes it", moved and session_rules() == [], str(tab_urls()))
        sw.evaluate("chrome.storage.session.remove('testCheckinMs')")
        p3.close()

        print("marking a site as needed:")
        send({"t": "block", "site": "mark-test.com"})
        nav(page, f"{BLOCKED}?unblock=need-mark:mark-test.com")
        page.wait_for_selector("#unblockVerse .ar")
        t = time.time()
        page.wait_for_selector("#typeStep", state="visible", timeout=40000)
        waited = time.time() - t
        page.fill("#sentence", MARK)
        page.click("#confirm")
        page.wait_for_selector("#done", state="visible")
        st = sw.evaluate("chrome.storage.local.get('neededSites')")
        check("takes the full 30 s pause, then marked", waited > 28 and "mark-test.com" in st["neededSites"], f"{waited:.0f}s")
        send({"t": "unneed", "site": "mark-test.com"})
        st = sw.evaluate("chrome.storage.local.get('neededSites')")
        check("'Not needed' is immediate", "mark-test.com" not in st["neededSites"])

        print("a porn site can't be opened as 'needed':")
        send({"t": "block", "site": "xnxx.com", "needed": True})
        u = goto("http://xnxx.com/")
        page.wait_for_selector("#verse .ar")
        time.sleep(0.3)
        check("adult block wins, no 'I need it' option",
              u.startswith(BLOCKED + "?list=adult") and not page.locator("#need").is_visible(), u[:70])
        # Even asking the background directly from this tab doesn't open it.
        page.evaluate("(m) => chrome.runtime.sendMessage(m)", {"t": "unblockStart", "target": "need:xnxx.com"})
        time.sleep(10.5)
        r = page.evaluate("(m) => chrome.runtime.sendMessage(m)", {"t": "unblockFinish", "target": "need:xnxx.com", "text": NEED})
        u = goto("http://xnxx.com/again")
        check("still blocked even with a visit", u.startswith(BLOCKED + "?list=adult"), f"{r} {u[:60]}")
        ctx.close()

    print("PASS" if all(results) else f"FAIL ({results.count(False)} failed)")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
