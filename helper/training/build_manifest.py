#!/usr/bin/env python3
"""Build the labeled example list used to train and test the image classifier.

Sources (all public):
  * Open Images V5 (Google), human-drawn boxes labeled Man / Woman / Boy /
    Girl. Images from its "validation" split are used for training and
    tuning; images from its "test" split only for the final quiz.
  * Wikimedia Commons categories: logos, icons, charts, patterns, flags,
    food, buildings (no people), and paintings/drawings of women and men.
    Split 70/30 into training+tuning / quiz.
  * COCO photos labeled from captions (see test_vision.py): quiz only.

Output: manifest.json, a list of
  {"path", "source", "split": train|tune|quiz,
   "female": 0/1, "male": 0/1,            # is someone of that gender in it?
   "people": [{"box": [x0,y0,x1,y1] (0..1), "gender": "female"|"male"}]}
"""

import argparse
import collections
import csv
import json
import os
import random

FEM, MAL = {"Woman", "Girl"}, {"Man", "Boy"}


def open_images(oi_dir, img_dir="img"):
    cls = {r[0]: r[1] for r in csv.reader(open(os.path.join(oi_dir, "class-descriptions-boxable.csv")))}
    picked = json.load(open(os.path.join(oi_dir, "picked.json")))
    want = {x["id"]: x for v in picked.values() for x in v}
    boxes = collections.defaultdict(list)
    for split in ("validation", "test"):
        for r in csv.DictReader(open(os.path.join(oi_dir, f"{split}-annotations-bbox.csv"))):
            if r["ImageID"] not in want:
                continue
            name = cls.get(r["LabelName"], "")
            if name in FEM | MAL:
                boxes[r["ImageID"]].append({
                    "box": [float(r["XMin"]), float(r["YMin"]), float(r["XMax"]), float(r["YMax"])],
                    "gender": "female" if name in FEM else "male",
                })
    rng = random.Random(1)
    out = []
    for iid, x in want.items():
        path = os.path.join(oi_dir, img_dir, iid + ".jpg")
        if not os.path.exists(path):
            continue
        g = x["group"]
        if x["split"] == "test":
            split = "quiz"
        else:
            split = "tune" if rng.random() < 0.2 else "train"
        out.append({
            "path": path, "source": "openimages", "split": split,
            "female": int(g in ("female", "both")), "male": int(g in ("male", "both")),
            "people": boxes.get(iid, []),
        })
    return out


def commons(web_dir):
    items = json.load(open(os.path.join(web_dir, "items.json")))
    rng = random.Random(2)
    out = []
    for it in items:
        path = os.path.join(web_dir, "img", it.get("file", ""))
        if not it.get("file") or not os.path.exists(path) or os.path.getsize(path) < 500:
            continue
        r = rng.random()
        split = "quiz" if r < 0.3 else ("tune" if r < 0.44 else "train")
        out.append({
            "path": path, "source": "commons:" + it["cat"], "split": split,
            "female": int(it["group"] == "female_art"), "male": int(it["group"] == "male_art"),
            "people": [],
        })
    return out


def graphics(g_dir):
    """Generated website graphics (make_graphics.py): no people."""
    rng = random.Random(3)
    out = []
    for it in json.load(open(os.path.join(g_dir, "items.json"))):
        r = rng.random()
        out.append({
            "path": os.path.join(g_dir, it["file"]), "source": "graphics:" + it["kind"],
            "split": "quiz" if r < 0.2 else ("tune" if r < 0.36 else "train"),
            "female": 0, "male": 0, "people": [],
        })
    return out


def coco(coco_dir):
    out = []
    for it in json.load(open(os.path.join(coco_dir, "eval.json"))):
        path = os.path.join(coco_dir, "img", os.path.basename(it["url"]))
        if os.path.exists(path):
            g = it["group"]
            out.append({
                "path": path, "source": "coco", "split": "quiz",
                "female": int(g in ("female", "mixed")), "male": int(g in ("male", "mixed")),
                "people": [],
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--openimages", required=True)
    ap.add_argument("--openimages-dir", default="img", help="image folder inside --openimages")
    ap.add_argument("--commons", required=True)
    ap.add_argument("--coco", required=True)
    ap.add_argument("--graphics", help="folder from make_graphics.py")
    ap.add_argument("--only-graphics", action="store_true", help="write only the graphics items")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.only_graphics:
        items = graphics(a.graphics)
    else:
        items = open_images(a.openimages, a.openimages_dir) + commons(a.commons) + coco(a.coco)
        if a.graphics:
            items += graphics(a.graphics)
    json.dump(items, open(a.out, "w"))
    c = collections.Counter((i["split"], i["source"].split(":")[0], i["female"], i["male"]) for i in items)
    for k in sorted(c):
        print(k, c[k])


if __name__ == "__main__":
    main()
