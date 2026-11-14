#!/usr/bin/env python3
"""Build the built-in adult-site list: extension/rules/adult.json.

Sources (downloaded fresh each run):
  * Block List Project, porn list (public domain / Unlicense)
    https://github.com/blocklistproject/Lists
  * Steven Black hosts, porn-only (MIT)
    https://github.com/StevenBlack/hosts
Cleaning:
  * invalid names dropped
  * public suffixes dropped (Public Suffix List, used at build time only):
    blocking one would block thousands of unrelated sites
  * exclude.txt: reviewed sites whose main purpose is not porn
  * subdomains of listed domains dropped (a domain rule covers them)

Output: one Chrome declarativeNetRequest rule per chunk of domains. Each
rule redirects the page (and embedded frames) to the extension's blocked
page, carrying the original address.

Usage: python tools/adult-list/build.py [--check-top tranco.csv]
"""

import argparse
import json
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, "extension", "rules", "adult.json")
SOURCES = [
    "https://blocklistproject.github.io/Lists/alt-version/porn-nl.txt",
    "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts",
]
PSL = "https://publicsuffix.org/list/public_suffix_list.dat"
EXT_ID = "dlhalfnkadcmncbhilghjipnpjmaaocb"  # fixed by the manifest "key"
CHUNK = 50000
FIRST_ID = 1
VALID = re.compile(r"^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$")
# Sites that must never be blocked by the built-in list (sanity check).
NEVER = ["google.com", "youtube.com", "x.com", "twitter.com", "reddit.com", "facebook.com",
         "instagram.com", "wikipedia.org", "github.com", "github.io", "amazon.com", "microsoft.com",
         "apple.com", "whatsapp.com", "telegram.org", "quran.com", "linkedin.com", "bing.com",
         "duckduckgo.com", "yahoo.com", "tiktok.com", "blogspot.com", "wordpress.com", "medium.com",
         "cloudflare.com", "amazonaws.com", "googleusercontent.com", "gstatic.com", "twimg.com"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "haram-blocker-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8", "replace")


def parse(text):
    out = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if not line:
            continue
        parts = line.split()
        d = parts[1] if parts[0] in ("0.0.0.0", "127.0.0.1") and len(parts) > 1 else parts[-1]
        out.add(d.strip(".").removeprefix("www."))
    return out


def public_suffixes(text):
    out = set()
    for line in text.splitlines():
        line = line.strip().lower()
        if line and not line.startswith("//"):
            out.add(line.lstrip("!*."))
    return out


def parents(d):
    p = d.split(".")
    for i in range(1, len(p) - 1):
        yield ".".join(p[i:])


def covered(d, domains):
    return d in domains or any(q in domains for q in parents(d))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check-top", help="Tranco CSV: report blocked sites among the top 30,000")
    a = ap.parse_args()

    raw = set()
    for url in SOURCES:
        got = parse(fetch(url))
        print(f"{len(got):8d}  {url}")
        raw |= got
    psl = public_suffixes(fetch(PSL))
    exclude = {l.split("#")[0].strip().lower() for l in open(os.path.join(HERE, "exclude.txt"))} - {""}

    valid = {d for d in raw if VALID.match(d)}
    no_psl = {d for d in valid if d not in psl}
    # exact names only: a porn site hosted under an excluded name stays listed
    kept = no_psl - exclude
    final = sorted(d for d in kept if not any(q in kept for q in parents(d)))
    print(f"{len(raw):8d}  combined")
    print(f"{len(raw) - len(valid):8d}  invalid names dropped")
    print(f"{len(valid) - len(no_psl):8d}  public suffixes dropped")
    print(f"{len(no_psl) - len(kept):8d}  excluded (exclude.txt)")
    print(f"{len(final):8d}  final (subdomains of listed domains merged)")

    final_set = set(final)
    bad = [d for d in NEVER if covered(d, final_set)]
    if bad:
        raise SystemExit(f"refusing to build: list would block {bad}")
    wrongly = [d for d in exclude if d in final_set]
    assert not wrongly, wrongly

    if a.check_top:
        top = [l.strip().split(",")[1] for l, _ in zip(open(a.check_top), range(30000))]
        hits = [d for d in top if covered(d, final_set)]
        print(f"blocked among the top 30,000 sites: {len(hits)}")

    rules = []
    for i in range(0, len(final), CHUNK):
        rules.append({
            "id": FIRST_ID + i // CHUNK,
            # Above a "needed" one-visit opening (4) and the user's own blocks
            # (3): a porn site can't be opened that way. Below the user's
            # deliberate unblock of one listed site (6).
            "priority": 5,
            "action": {"type": "redirect", "redirect": {
                "regexSubstitution": f"chrome-extension://{EXT_ID}/blocker/blocked.html?list=adult#\\0"}},
            "condition": {
                "regexFilter": "^.+$",
                "requestDomains": final[i : i + CHUNK],
                "resourceTypes": ["main_frame", "sub_frame"],
            },
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(rules, f, separators=(",", ":"))
    with open(os.path.join(os.path.dirname(OUT), "adult-count.json"), "w") as f:
        json.dump({"sites": len(final)}, f)
    print(f"wrote {OUT}: {len(rules)} rules, {os.path.getsize(OUT) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
