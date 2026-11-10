#!/usr/bin/env python3
"""Accuracy test for the image check, on labeled photos.

Usage: .venv/bin/python test_vision.py eval.json image_dir [--sweep]

eval.json: [{"url": ..., "group": "female" | "male" | "mixed" | "none"}, ...]
(groups come from the photos' human-written captions; see README).

For each setting ("I am male" hides women, "I am female" hides men) it
reports:
  leaks       photos with the hidden gender that were SHOWN (want ~0)
  over-hide   photos without the hidden gender that were hidden (lower is nicer)
Photos are re-encoded at 384 px like the extension sends them.
"""

import io
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vision  # noqa: E402


def load_small(path):
    img = Image.open(path).convert("RGB")
    img.thumbnail((384, 384))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def evaluate(items, feats, verbose=True):
    results = {}
    for me, hide in (("male", "female"), ("female", "male")):
        contains = [it["group"] in (hide, "mixed") for it in items]
        hidden = [vision.ImageJudge.decide(f, hide)[0] for f in feats]
        c = np.array(contains)
        h = np.array(hidden)
        leaks = int((c & ~h).sum())
        over = int((~c & h).sum())
        results[me] = (leaks, int(c.sum()), over, int((~c).sum()))
        if verbose:
            same = [it["group"] == me for it in items]
            none = [it["group"] == "none" for it in items]
            s, n = np.array(same), np.array(none)
            print(f"I am {me} (hide {hide}s):")
            print(f"  leaks:      {leaks}/{c.sum()} photos with {hide}s shown "
                  f"({100*leaks/c.sum():.1f}%)")
            print(f"  over-hide:  {int((s & h).sum())}/{s.sum()} {me}-only photos hidden, "
                  f"{int((n & h).sum())}/{n.sum()} no-people photos hidden")
    return results


def main():
    items = json.load(open(sys.argv[1]))
    folder = sys.argv[2]
    import torch

    judge = vision.ImageJudge(torch.device("cuda"))
    datas = [load_small(os.path.join(folder, os.path.basename(it["url"]))) for it in items]
    images = [judge.decode(d) for d in datas]
    judge.features(images[:8])  # warm up
    torch.cuda.synchronize()
    t = time.perf_counter()
    feats = []
    for i in range(0, len(images), 8):
        feats += judge.features(images[i : i + 8])
    torch.cuda.synchronize()
    ms = (time.perf_counter() - t) / len(images) * 1000
    print(f"{len(images)} photos, {ms:.1f} ms per photo, "
          f"VRAM peak {torch.cuda.max_memory_allocated() // 2**20} MB")
    evaluate(items, feats)

    if "--sweep" in sys.argv:
        print("\nthreshold sweep (person, whole): leaks male/female, over-hide male/female")
        for ph in (0.1, 0.15, 0.2, 0.25, 0.3, 0.4):
            for wh in (0.05, 0.1, 0.15, 0.2, 0.3):
                vision.PERSON_HIDE, vision.WHOLE_HIDE = ph, wh
                r = evaluate(items, feats, verbose=False)
                print(f"  {ph:.2f} {wh:.2f}:  leaks {r['male'][0]:3d}/{r['male'][1]} "
                      f"{r['female'][0]:3d}/{r['female'][1]}   over-hide "
                      f"{r['male'][2]:3d}/{r['male'][3]} {r['female'][2]:3d}/{r['female'][3]}")
        json.dump(feats, open("/tmp/hbs/coco/feats.json", "w"))


if __name__ == "__main__":
    main()
