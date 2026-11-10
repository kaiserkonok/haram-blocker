#!/usr/bin/env python3
"""Find likely label errors in the training pool (standard "confident
learning"): examples labeled as containing a woman/man that a cross-validated
model (which never saw them) scores lowest. These are then checked by eye and
corrections go into train_label_fixes.json.

Usage: python find_label_errors.py embeds.pt [...] --n 60 --sheets OUTDIR
"""

import argparse
import json
import os
import sys

import torch
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import train  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("embeds", nargs="+")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--sheets", required=True)
    a = ap.parse_args()
    data = train.apply_fixes(train.load(a.embeds))
    pool = [d for d in data if d["split"] in ("train", "tune")]
    oof = []
    for k in range(5):
        w, c = train.train_heads([d for d in pool if train.fold_of(d) != k], 256)
        te = [d for d in pool if train.fold_of(d) == k]
        oof += list(zip(te, train.scores(te, w, c)))
    os.makedirs(a.sheets, exist_ok=True)
    listing = []
    for g, i, cs in (("female", 0, "cf"), ("male", 1, "cm")):
        pos = sorted(((max(s["w"][i], s[cs]), d) for d, s in oof if d[g]), key=lambda x: x[0])[: a.n]
        for j in range(0, len(pos), 20):
            W = 240
            sheet = Image.new("RGB", (W * 5, W * 4), "white")
            for k, (score, d) in enumerate(pos[j : j + 20]):
                im = Image.open(d["path"]).convert("RGBA")
                im.thumbnail((W - 4, W - 18))
                bg = Image.new("RGBA", im.size, "white")
                bg.alpha_composite(im)
                sheet.paste(bg.convert("RGB"), ((k % 5) * W, (k // 5) * W))
                idx = len(listing)
                listing.append({"path": d["path"], "label": g, "female": d["female"], "male": d["male"], "score": float(score)})
                ImageDraw.Draw(sheet).text(((k % 5) * W + 2, (k // 5) * W + W - 16),
                                           f"#{idx} labeled {g} F={d['female']} M={d['male']} s={score:.2f}", fill="red")
            sheet.save(os.path.join(a.sheets, f"{g}_{j // 20}.jpg"))
    json.dump(listing, open(os.path.join(a.sheets, "listing.json"), "w"))
    print(len(listing), "suspects written to", a.sheets)


if __name__ == "__main__":
    main()
