#!/usr/bin/env python3
"""Training/serving consistency: the helper's live code must score images
exactly like the training/quiz code did, or the quiz numbers wouldn't
describe what users actually run.

Usage: python check_consistency.py manifest.json head.pt [n_images]

Runs n images through (a) embed.py + train.scores and (b) vision.ImageJudge
with the same classifier file, and compares the decision inputs.
"""

import json
import os
import random
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import embed  # noqa: E402
import train  # noqa: E402
import vision  # noqa: E402


def main():
    items = json.load(open(sys.argv[1]))
    head = sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    random.seed(3)
    items = random.sample(items, n)

    vision.HEAD_PATH = head
    judge = vision.ImageJudge(torch.device("cuda"))
    ck = torch.load(head)
    w = train.Head(2, ck["hidden"])
    w.load_state_dict(ck["whole"])
    w.eval()
    c = train.Head(1, ck["hidden"])
    c.load_state_dict(ck["crop"])
    c.eval()

    worst = {"w": 0.0, "c": 0.0}
    mismatched_decisions = 0
    for it in items:
        data = embed.prepare(it["path"])
        live = judge.trained_features([judge.decode(data)])[0]
        # offline path: embed.py's way of computing embeddings, train.py's scoring
        img = judge.decode(data)
        t = judge.to_tensor(img)
        with torch.inference_mode():
            d = judge.detector([t])[0]
            keep = (d["labels"] == 1) & (d["scores"] >= 0.2)
            boxes = d["boxes"][keep][: vision.MAX_PEOPLE].round().int().tolist()
            scores = d["scores"][keep][: vision.MAX_PEOPLE].tolist()
            inputs, det = [judge.clip_input(t)], []
            for b, s in zip(boxes, scores):
                small = min(b[2] - b[0], b[3] - b[1]) < vision.MIN_CROP
                det.append({"score": s, "small": small, "emb": None if small else len(inputs)})
                if not small:
                    inputs.append(embed.crop(judge, t, b))
            embs = embed.embed(judge, inputs)
        row = {"whole": embs[0].half(), "det": [{**x, "emb": None if x["emb"] is None else embs[x["emb"]].half()} for x in det]}
        off = train.scores([row], w, c)[0]
        worst["w"] = max(worst["w"], max(abs(a - b) for a, b in zip(live["w"], off["w"])))
        worst["c"] = max(worst["c"], abs(live["cf"] - off["cf"]))
        for hide in ("female", "male"):
            th = ck["thresholds"]["strict"][hide]
            a = judge.decide(live, hide, "strict")[0]
            b = train.hidden(off, hide, th["whole"], th["crop"], th["small"], th.get("crowd", 99))
            mismatched_decisions += a != b
    print(f"{n} images: largest score difference whole {worst['w']:.4f}, close-up {worst['c']:.4f}; "
          f"decisions that differ: {mismatched_decisions}/{2 * n}")
    ok = worst["w"] < 0.01 and worst["c"] < 0.01 and mismatched_decisions == 0
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
