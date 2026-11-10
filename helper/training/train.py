#!/usr/bin/env python3
"""Train the image classifier on top of CLIP and test it honestly.

Usage: python train.py embeds.pt [more.pt ...] --out ../judge_head.pt

Two small classifiers on CLIP embeddings (CLIP itself is not changed):
  whole  : whole image -> P(a woman is in it), P(a man is in it)
  crop   : one person close-up -> P(this person is a woman)

Data splits (fixed in the manifest):
  train  learn the classifiers
  tune   choose thresholds (leak target) and the model size
  quiz   only for the final report; never used to choose anything

Decision for a user who wants gender G hidden: hide if the whole-image
classifier says G is likely, or any person close-up looks like G, or a person
is too small to judge.
"""

import argparse
import collections
import json
import os
import sys

import numpy as np
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

LEAK_TARGET = 0.005  # at most 0.5% of images with the hidden gender may be shown
torch.manual_seed(0)


# --------------------------------------------------------------------------- models
class Head(torch.nn.Module):
    def __init__(self, outputs, hidden=0, dropout=0.2):
        super().__init__()
        if hidden:
            self.net = torch.nn.Sequential(
                torch.nn.Linear(512, hidden), torch.nn.GELU(), torch.nn.Dropout(dropout),
                torch.nn.Linear(hidden, outputs))
        else:
            self.net = torch.nn.Linear(512, outputs)
        self.hidden, self.outputs = hidden, outputs

    def forward(self, x):
        return self.net(x)


def fit(xtr, ytr, xtu, ytu, outputs, hidden, epochs=300):
    """Full-batch training with early stopping on the tuning set."""
    m = Head(outputs, hidden)
    opt = torch.optim.AdamW(m.parameters(), lr=1e-3 if hidden else 3e-3, weight_decay=1e-2)
    pos = ytr.mean(0).clamp(1e-3, 1 - 1e-3)
    lossf = torch.nn.BCEWithLogitsLoss(pos_weight=(1 - pos) / pos)  # balance classes
    best, best_state, bad = 1e9, None, 0
    for _ in range(epochs):
        m.train()
        opt.zero_grad()
        lossf(m(xtr), ytr).backward()
        opt.step()
        m.eval()
        with torch.no_grad():
            v = lossf(m(xtu), ytu).item()
        if v < best - 1e-4:
            best, best_state, bad = v, {k: t.clone() for k, t in m.state_dict().items()}, 0
        else:
            bad += 1
            if bad > 30:
                break
    m.load_state_dict(best_state)
    m.eval()
    return m, best


# --------------------------------------------------------------------------- data
def load(paths):
    data = []
    for p in paths:
        data += torch.load(p)
    return data


FIXES = json.load(open(os.path.join(HERE, "quiz_label_fixes.json")))["fixes"]


def apply_fixes(data):
    """Quiz labels corrected by the visual audit (see quiz_label_fixes.json)."""
    out = []
    for d in data:
        f = FIXES.get(os.path.basename(d["path"])) if d["split"] == "quiz" else None
        if f == "exclude":
            continue
        if f:
            d = {**d, "female": f["female"], "male": f["male"]}
        out.append(d)
    return out


def tensors(data, split):
    rows = [d for d in data if d["split"] == split]
    x = torch.stack([d["whole"].float() for d in rows])
    y = torch.tensor([[d["female"], d["male"]] for d in rows], dtype=torch.float32)
    return rows, x, y


def crops(data, split):
    xs, ys = [], []
    for d in data:
        if d["split"] != split:
            continue
        for g in d["gt"]:
            xs.append(g["emb"].float())
            ys.append([1.0 if g["gender"] == "female" else 0.0])
    return torch.stack(xs), torch.tensor(ys)


# --------------------------------------------------------------------------- decide
def scores(rows, whole, crop):
    """Per image: whole-image probabilities and the strongest close-up per gender."""
    with torch.no_grad():
        pw = torch.sigmoid(whole(torch.stack([d["whole"].float() for d in rows]))).numpy()
    out = []
    for d, w in zip(rows, pw):
        cf, cm, small = [], [], False
        crowd = sum(1 for p in d["det"] if p["score"] >= 0.5)
        for p in d["det"]:
            if p["small"]:
                small = small or p["score"] >= 0.5
                continue
            if p["score"] < 0.3:
                continue
            with torch.no_grad():
                f = torch.sigmoid(crop(p["emb"].float()[None]))[0, 0].item()
            cf.append(f)
            cm.append(1 - f)
        out.append({"w": w, "cf": max(cf, default=0.0), "cm": max(cm, default=0.0), "small": small, "crowd": crowd})
    return out


def hidden(s, hide, tw, tc, small_rule=True, crowd=99):
    i = 0 if hide == "female" else 1
    c = s["cf"] if hide == "female" else s["cm"]
    return s["w"][i] >= tw or c >= tc or (small_rule and s["small"]) or s["crowd"] >= crowd


def evaluate(rows, sc, hide, tw, tc, small_rule=True, crowd=99):
    key = hide
    pos = [hidden(s, hide, tw, tc, small_rule, crowd) for d, s in zip(rows, sc) if d[key]]
    neg = [hidden(s, hide, tw, tc, small_rule, crowd) for d, s in zip(rows, sc) if not d[key]]
    leak = 1 - np.mean(pos) if pos else 0.0
    over = np.mean(neg) if neg else 0.0
    return leak, over, len(pos), len(neg)


def choose(rows, sc, hide):
    """Thresholds meeting the leak target on the TUNING set with fewest false hides."""
    best = None
    grid = [0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7]
    for crowd in (99, 8, 6, 5, 4):
        for small_rule in (False, True):
            for tw in grid:
                for tc in grid + [1.01]:
                    leak, over, _, _ = evaluate(rows, sc, hide, tw, tc, small_rule, crowd)
                    if leak <= LEAK_TARGET and (best is None or over < best[0]):
                        best = (over, tw, tc, small_rule, crowd)
    return best


# --------------------------------------------------------------------------- baseline
def baseline(rows):
    """The current method (sentence lists + fixed thresholds) on the same quiz."""
    import open_clip

    import vision

    model, _, _ = open_clip.create_model_and_transforms("ViT-B-16", pretrained="openai")
    tok = open_clip.get_tokenizer("ViT-B-16")
    with torch.no_grad():
        t = model.encode_text(tok(vision.FEMALE + vision.MALE + vision.OTHER)).float()
    t = t / t.norm(dim=-1, keepdim=True)
    nf, nm = len(vision.FEMALE), len(vision.MALE)
    print("\nBASELINE (current method) on the same quiz:")
    for hide in ("female", "male"):
        sl = slice(0, nf) if hide == "female" else slice(nf, nf + nm)
        by = collections.defaultdict(lambda: [0, 0, 0, 0])
        for d in rows:
            hid = False
            for p in d["det"]:
                if p["score"] < vision.DETECT_SCORE:
                    continue
                if p["small"]:
                    hid = True
                    break
                pr = (100 * p["emb"].float() @ t[: nf + nm].T).softmax(-1)
                if pr[sl].sum() >= vision.PERSON_HIDE:
                    hid = True
                    break
            if not hid:
                pw = (100 * d["whole"].float() @ t.T).softmax(-1)
                hid = bool(pw[sl].sum() >= vision.WHOLE_HIDE)
            src = d["source"] if d["source"].startswith("commons") else d["source"].split(":")[0]
            b = by[src]
            if d[hide]:
                b[0] += not hid
                b[1] += 1
            else:
                b[2] += hid
                b[3] += 1
        tl = sum(b[0] for b in by.values())
        tp = sum(b[1] for b in by.values())
        print(f"  user wants {hide}s hidden:")
        for src, b in sorted(by.items()):
            print(f"    {src:28s} shown with {hide}: {b[0]:3d}/{b[1]:4d}   hidden without: {b[2]:4d}/{b[3]:4d} ({100*b[2]/max(b[3],1):.0f}%)")
        print(f"    TOTAL leaks {tl}/{tp} ({100*tl/max(tp,1):.2f}%)")


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("embeds", nargs="+")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    data = apply_fixes(load(a.embeds))
    print("examples:", collections.Counter((d["split"], d["source"].split(":")[0]) for d in data))

    _, xtr, ytr = tensors(data, "train")
    _, xtu, ytu = tensors(data, "tune")
    ctr, cytr = crops(data, "train")
    ctu, cytu = crops(data, "tune")
    print(f"close-ups: train {len(ctr)}, tune {len(ctu)}")

    # Model size chosen on the tuning set.
    results = []
    for hidden_size in (0, 256):
        w, wl = fit(xtr, ytr, xtu, ytu, 2, hidden_size)
        c, cl = fit(ctr, cytr, ctu, cytu, 1, hidden_size)
        rows, _, _ = tensors(data, "tune")
        sc = scores(rows, w, c)
        picks = {h: choose(rows, sc, h) for h in ("female", "male")}
        over = sum(p[0] if p else 1.0 for p in picks.values())
        print(f"hidden={hidden_size}: tune loss whole {wl:.3f} crop {cl:.3f}; "
              f"false-hide at leak target: female {picks['female'] and round(picks['female'][0], 3)}, "
              f"male {picks['male'] and round(picks['male'][0], 3)}")
        results.append((over, hidden_size, w, c, picks))
    over, hidden_size, w, c, picks = min(results, key=lambda r: r[0])
    print(f"chosen: hidden={hidden_size}; thresholds {picks}")

    # Final, honest report on the quiz set.
    rows, _, _ = tensors(data, "quiz")
    sc = scores(rows, w, c)
    report = {}
    for hide in ("female", "male"):
        _, tw, tc, small_rule, crowd = picks[hide]
        by = collections.defaultdict(list)
        for d, s in zip(rows, sc):
            by[d["source"].split(":")[0] if not d["source"].startswith("commons") else d["source"]].append((d, s))
        print(f"\nQUIZ — user wants {hide}s hidden (whole>={tw}, close-up>={tc}, small-person rule {small_rule}, crowd>={crowd}):")
        tot_leak = tot_pos = 0
        for src, pairs in sorted(by.items()):
            r = [p[0] for p in pairs]
            s_ = [p[1] for p in pairs]
            leak, over, npos, nneg = evaluate(r, s_, hide, tw, tc, small_rule, crowd)
            tot_leak += round(leak * npos)
            tot_pos += npos
            print(f"  {src:28s} shown with {hide}: {round(leak*npos):3d}/{npos:4d}   hidden without: {round(over*nneg):4d}/{nneg:4d} ({100*over:.0f}%)")
        report[hide] = {"tw": tw, "tc": tc, "small_rule": small_rule, "crowd": crowd, "leaks": tot_leak, "positives": tot_pos}
        print(f"  TOTAL leaks {tot_leak}/{tot_pos} ({100*tot_leak/max(tot_pos,1):.2f}%)")

    baseline(rows)

    torch.save({
        "version": 1,
        "hidden": hidden_size,
        "whole": w.state_dict(),
        "crop": c.state_dict(),
        "thresholds": {h: {"whole": picks[h][1], "crop": picks[h][2], "small": picks[h][3], "crowd": picks[h][4]} for h in picks},
        "quiz": report,
    }, a.out)
    print("\nsaved", a.out, f"({os.path.getsize(a.out)//1024} KB)")


if __name__ == "__main__":
    main()
