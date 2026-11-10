#!/usr/bin/env python3
"""Run every example in the manifest through the models once and save what
they see, so training and evaluation take seconds.

Usage: python embed.py manifest.json out.pt

For each image (prepared exactly like the extension sends it: white
background, at most vision.MAX_SIDE px, JPEG):
  whole      CLIP embedding of the whole image
  det        people found by the finder: [(score, box, small)] + embeddings
  gt         (Open Images) embeddings of the labeled people's boxes, with
             their gender: used to train the close-up classifier
"""

import io
import json
import os
import sys

import torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import vision  # noqa: E402


def prepare(path):
    """Same preparation as the extension: flatten on white, <=MAX_SIDE px, JPEG."""
    img = vision.flatten(Image.open(path))
    img.thumbnail((vision.MAX_SIDE, vision.MAX_SIDE))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def crop(judge, t, box_px):
    x0, y0, x1, y1 = box_px
    _, H, W = t.shape
    pw, ph = x1 - x0, y1 - y0
    px, py = int(pw * 0.15), int(ph * 0.15)
    return judge.clip_input(t[:, max(0, y0 - py): min(H, y1 + py), max(0, x0 - px): min(W, x1 + px)])


def embed(judge, batch):
    f = judge.clip.encode_image(torch.stack(batch).half()).float()
    return (f / f.norm(dim=-1, keepdim=True)).cpu()


def main():
    items = json.load(open(sys.argv[1]))
    judge = vision.ImageJudge(torch.device("cuda"))
    out = []
    with torch.inference_mode():
        for k, it in enumerate(items):
            try:
                img = judge.decode(prepare(it["path"]))
            except Exception as e:
                print("skip", it["path"], e)
                continue
            t = judge.to_tensor(img)
            _, H, W = t.shape
            d = judge.detector([t])[0]
            keep = (d["labels"] == 1) & (d["scores"] >= 0.2)
            boxes = d["boxes"][keep][:vision.MAX_PEOPLE].round().int().tolist()
            scores = d["scores"][keep][:vision.MAX_PEOPLE].tolist()
            inputs = [judge.clip_input(t)]
            det = []
            for b, s in zip(boxes, scores):
                small = min(b[2] - b[0], b[3] - b[1]) < vision.MIN_CROP
                det.append({"score": s, "box": b, "small": small, "emb": None if small else len(inputs)})
                if not small:
                    inputs.append(crop(judge, t, b))
            gt = []
            for p in it.get("people", []):
                x0, y0, x1, y1 = p["box"]
                b = [int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)]
                if min(b[2] - b[0], b[3] - b[1]) < vision.MIN_CROP:
                    continue
                gt.append({"gender": p["gender"], "emb": len(inputs)})
                inputs.append(crop(judge, t, b))
            embs = torch.cat([embed(judge, inputs[i:i + 64]) for i in range(0, len(inputs), 64)])
            out.append({
                "path": it["path"], "source": it["source"], "split": it["split"],
                "female": it["female"], "male": it["male"],
                "whole": embs[0].half(),
                "det": [{**x, "emb": None if x["emb"] is None else embs[x["emb"]].half()} for x in det],
                "gt": [{"gender": g["gender"], "emb": embs[g["emb"]].half()} for g in gt],
            })
            if k % 500 == 0:
                print(f"{k}/{len(items)}", flush=True)
    torch.save(out, sys.argv[2])
    print("saved", len(out))


if __name__ == "__main__":
    main()
