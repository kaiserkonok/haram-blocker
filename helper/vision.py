"""Image check: does a picture show a person of the gender the user wants hidden?

Two models, both on the GPU:
  1. Finder  - Faster R-CNN MobileNetV3 320 (torchvision, BSD) finds the
               people in the image.
  2. Judge   - CLIP ViT-B/16 (OpenAI, MIT) looks at each person close up and
               scores "woman/girl" against "man/boy". It also looks at the
               whole image, which catches people the finder missed (drawings,
               very small or cropped people).

The rule leans towards hiding: if the opposite gender is at all likely, or a
person is seen but can't be judged, the image stays hidden.
"""

from __future__ import annotations

import io
import logging

import numpy as np

log = logging.getLogger("helper")

FEMALE = ["a photo of a woman", "a photo of a girl", "a photo of a lady", "a drawing of a woman"]
MALE = ["a photo of a man", "a photo of a boy", "a photo of a gentleman", "a drawing of a man"]
OTHER = [
    "a photo of an object",
    "a photo of food",
    "a photo of an animal",
    "a photo of a landscape",
    "a photo of a building",
    "a photo of a vehicle",
    "a photo of a room",
    "a photo of a street",
    "a screenshot of text",
    "a logo or an icon",
]

# Decision thresholds (tuned on COCO photos, see test_vision.py).
DETECT_SCORE = 0.30  # finder: how sure it must be that something is a person
PERSON_HIDE = 0.25  # judge on a person crop: hide if P(opposite gender) >= this
WHOLE_HIDE = 0.15  # judge on the whole image: hide if P(opposite gender) >= this
MAX_PEOPLE = 6  # close-ups judged per image
MIN_CROP = 20  # px; smaller people can't be judged -> counted as "unclear"


class ImageJudge:
    def __init__(self, device):
        import open_clip
        import torch
        from torchvision.models.detection import (
            FasterRCNN_MobileNet_V3_Large_320_FPN_Weights,
            fasterrcnn_mobilenet_v3_large_320_fpn,
        )

        self.torch = torch
        self.device = device
        self.detector = (
            fasterrcnn_mobilenet_v3_large_320_fpn(
                weights=FasterRCNN_MobileNet_V3_Large_320_FPN_Weights.DEFAULT
            )
            .to(device)
            .eval()
        )
        model, _, _ = open_clip.create_model_and_transforms("ViT-B-16", pretrained="openai")
        self.clip = model.to(device).eval().half()
        tok = open_clip.get_tokenizer("ViT-B-16")
        with torch.inference_mode():
            t = self.clip.encode_text(tok(FEMALE + MALE + OTHER).to(device))
            self.text = t / t.norm(dim=-1, keepdim=True)
        self.nf, self.nm = len(FEMALE), len(MALE)
        self.mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device).view(3, 1, 1)
        self.std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device).view(3, 1, 1)
        log.info("image judge ready")

    # -- helpers ---------------------------------------------------------
    @staticmethod
    def decode(data: bytes):
        from PIL import Image

        img = Image.open(io.BytesIO(data))
        img.draft("RGB", (448, 448))  # fast JPEG downscale while decoding
        return img.convert("RGB")

    def to_tensor(self, img):
        a = np.asarray(img, dtype=np.uint8)
        return self.torch.from_numpy(a).to(self.device).permute(2, 0, 1).float() / 255.0

    def clip_input(self, t):
        """Letterbox a [3,H,W] 0..1 tensor to 224x224 (keeps whole bodies)."""
        torch = self.torch
        _, h, w = t.shape
        s = 224 / max(h, w)
        nh, nw = max(1, round(h * s)), max(1, round(w * s))
        t = torch.nn.functional.interpolate(t[None], size=(nh, nw), mode="bilinear", align_corners=False)[0]
        out = torch.zeros(3, 224, 224, device=self.device)
        y, x = (224 - nh) // 2, (224 - nw) // 2
        out[:, y : y + nh, x : x + nw] = t
        return (out - self.mean) / self.std

    def clip_probs(self, batch):
        torch = self.torch
        f = self.clip.encode_image(batch.half())
        f = f / f.norm(dim=-1, keepdim=True)
        p = (100.0 * f @ self.text.T).float().softmax(dim=-1)
        female = p[:, : self.nf].sum(-1)
        male = p[:, self.nf : self.nf + self.nm].sum(-1)
        return female.cpu().numpy(), male.cpu().numpy()

    # -- main ------------------------------------------------------------
    def features(self, images):
        """Per image: people found and their female/male scores, plus whole-image scores."""
        torch = self.torch
        with torch.inference_mode():
            tensors = [self.to_tensor(im) for im in images]
            dets = self.detector(tensors)
            crops, owner, whole = [], [], []
            info = []
            for i, (t, d) in enumerate(zip(tensors, dets)):
                keep = (d["labels"] == 1) & (d["scores"] >= DETECT_SCORE)
                boxes = d["boxes"][keep][:MAX_PEOPLE].round().int().tolist()
                scores = d["scores"][keep][:MAX_PEOPLE].tolist()
                _, H, W = t.shape
                people = []
                for (x0, y0, x1, y1), sc in zip(boxes, scores):
                    pw, ph = x1 - x0, y1 - y0
                    if min(pw, ph) < MIN_CROP:
                        people.append({"score": sc, "unclear": True})
                        continue
                    px, py = int(pw * 0.15), int(ph * 0.15)
                    c = t[:, max(0, y0 - py) : min(H, y1 + py), max(0, x0 - px) : min(W, x1 + px)]
                    crops.append(self.clip_input(c))
                    owner.append((i, len(people)))
                    people.append({"score": sc})
                whole.append(self.clip_input(t))
                info.append({"people": people})
            wf, wm = self.clip_probs(torch.stack(whole))
            for i in range(len(images)):
                info[i]["whole_female"], info[i]["whole_male"] = float(wf[i]), float(wm[i])
            if crops:
                cf, cm = self.clip_probs(torch.stack(crops))
                for (i, j), f, m in zip(owner, cf, cm):
                    tot = max(f + m, 1e-6)  # gender share among the gender prompts
                    info[i]["people"][j]["female"] = float(f / tot)
                    info[i]["people"][j]["male"] = float(m / tot)
        return info

    @staticmethod
    def decide(info, hide: str) -> tuple[bool, str]:
        """hide: "female" or "male" — the gender the user wants hidden."""
        for p in info["people"]:
            if p.get("unclear"):
                return True, "person too small to judge"
            if p[hide] >= PERSON_HIDE:
                return True, f"{hide} person ({p[hide]:.2f})"
        whole = info["whole_" + hide]
        if whole >= WHOLE_HIDE:
            return True, f"{hide} in image ({whole:.2f})"
        return False, "clear"

    def judge(self, datas, hide):
        images = [self.decode(d) for d in datas]
        return [self.decide(i, hide) for i in self.features(images)]
