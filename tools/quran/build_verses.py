#!/usr/bin/env python3
"""Build extension/blocker/verses.json: the verses shown on the blocked page.

The Arabic text and the English translation are copied verbatim from the
Tanzil Project (https://tanzil.net), never retyped:
  * Arabic: Tanzil Uthmani text
  * English: Mohammed Marmaduke Pickthall (1930, public domain), via Tanzil
Usage: python tools/quran/build_verses.py
"""

import json
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), "extension", "blocker", "verses.json")
ARABIC = ("https://tanzil.net/pub/download/index.php?marks=true&sajdah=true&rub=false&tatweel=true"
          "&quranType=uthmani&outType=txt-2&agree=true")
ENGLISH = "https://tanzil.net/trans/?transID=en.pickthall&type=txt-2"

SURAH = {4: "An-Nisa", 13: "Ar-Ra'd", 17: "Al-Isra", 24: "An-Nur", 29: "Al-Ankabut", 39: "Az-Zumar",
         45: "Al-Jathiyah", 79: "An-Nazi'at", 89: "Al-Fajr", 94: "Ash-Sharh", 96: "Al-Alaq"}

# (surah, first ayah, last ayah, where it is shown)
#   blocked: on the blocked page, one at a time, changing each visit
#   men:     on the blocked page too, when the user chose "I am a man"
#   unblock: while waiting to unblock (desire, the nafs, regret)
#   mercy:   first thing shown after someone unblocked and came back
#   need:    opening a "needed" site for one visit (Allah sees)
PASSAGES = [
    (79, 40, 41, "blocked"), (45, 23, 23, "blocked"), (89, 23, 24, "blocked"), (94, 5, 6, "blocked"),
    (29, 69, 69, "blocked"), (17, 32, 32, "blocked"), (17, 36, 36, "blocked"), (4, 27, 28, "blocked"),
    (13, 28, 28, "blocked"), (24, 30, 30, "men"),
    (45, 23, 23, "unblock"), (79, 40, 41, "unblock"), (89, 23, 24, "unblock"),
    (39, 53, 53, "mercy"),
    (96, 14, 14, "need"),
]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "haram-blocker-build"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode("utf-8")


def table(text):
    rows, notice = {}, []
    for line in text.splitlines():
        if line.startswith("#"):
            notice.append(line[1:].strip())
        elif line.count("|") >= 2:
            s, a, t = line.split("|", 2)
            rows[(int(s), int(a))] = t
    return rows, "\n".join(notice).strip()


def main():
    ar, ar_notice = table(fetch(ARABIC))
    en, en_notice = table(fetch(ENGLISH))
    assert len(ar) == 6236 and len(en) == 6236, (len(ar), len(en))
    out = []
    for s, a0, a1, where in PASSAGES:
        out.append({
            "where": where,
            "ref": f"{SURAH[s]} {s}:{a0}" + (f"-{a1}" if a1 != a0 else ""),
            "ayat": [{"s": s, "a": a, "ar": ar[(s, a)], "en": en[(s, a)], "audio": f"{s:03d}{a:03d}.mp3"}
                     for a in range(a0, a1 + 1)],
        })
    with open(OUT, "w") as f:
        json.dump({
            "source": "Quran text and translation from the Tanzil Project, https://tanzil.net (verbatim, unchanged)",
            "arabic_notice": ar_notice,
            "translation_notice": en_notice,
            "passages": out,
        }, f, ensure_ascii=False, indent=1)
    print("wrote", OUT, len(out), "passages")


if __name__ == "__main__":
    main()
