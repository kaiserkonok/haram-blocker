# Image classifier: how it was made

The helper decides whether an image shows a woman (or a man) with two small
classifiers on top of [CLIP](https://github.com/openai/CLIP) ViT-B/16
embeddings (CLIP itself is unchanged), plus the Faster R-CNN person finder:

- **whole**: whole image → P(a woman is in it), P(a man is in it)
- **close-up**: one person found by the finder → P(woman)

`../judge_head.pt` (~1 MB) holds both classifiers and the thresholds for two
strictness levels. Without it, the helper falls back to the older
sentence-based method.

## Data (all public)

| Source | Use | What |
|---|---|---|
| [Open Images V5](https://storage.googleapis.com/openimages/web/index.html) validation split | train / tune | photos with human-drawn Man/Woman/Boy/Girl boxes |
| Open Images V5 test split | **quiz only** | same, never used to choose anything |
| [COCO](https://cocodataset.org) captions | **quiz only** | gender from captions |
| Wikimedia Commons categories | train / tune / quiz | logos, icons, charts, UI, flags, food, buildings; paintings and drawings of women and men |
| [Simple Icons](https://simpleicons.org) (CC0), [Material Design Icons](https://pictogrammaticons.com) (Apache-2.0) | train / tune / quiz | rendered as logo/icon cards (`make_graphics.py`); people icons skipped |
| generated | train / tune / quiz | charts, patterns, banners (`make_graphics.py`) |

Labels were audited by eye: `train_label_fixes.json` (120 most suspicious
training labels, found with cross-validated predictions) and
`quiz_label_fixes.json` (every quiz image where a model and its label
disagreed). Young children and babies whose gender can't be told are excluded.

## Method

1. `build_manifest.py`: list every example with labels and split.
2. `embed.py`: run the finder and CLIP once per image (prepared exactly as
   the extension sends it: white background, ≤512 px, JPEG).
3. `train.py`: 5-fold cross-validation over train+tune gives an
   out-of-fold score for every example; thresholds are chosen on those for a
   leak target (strict 0.1%, balanced 0.2%). Final classifiers are trained
   on all of train+tune. The quiz is scored once at the end, next to the old
   method.
4. `check_consistency.py`: the helper's live code must give the same scores
   and decisions as the training code.

## Quiz results (images never used for training or tuning)

| | old method | balanced | strict |
|---|---|---|---|
| photos with a woman shown ("I am a man") | 0.96% | 0.35% | **0.17%** |
| photos with a man shown ("I am a woman") | 0.87% | 0.35% | **0.26%** |
| Open Images photos without the hidden gender, hidden anyway | 23–30% | 17–18% | 19–27% |
| logos / icons / charts / patterns hidden | 3–50% | ~1% | ~1% |

Remaining misses are mostly very small people in crowds and some drawings,
statues and portraits on banknotes.
