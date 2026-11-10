#!/usr/bin/env python3
"""Generate "harmless website graphics" examples: logos, icons, charts,
patterns, banners. No people in any of them.

Usage (needs Playwright + Chromium for drawing SVGs):
  python make_graphics.py --simple-icons DIR --mdi DIR --out DIR [--n 1500]

Sources: Simple Icons (brand logos, CC0) and Material Design Icons
(Apache-2.0). Icons whose names suggest people, faces, bodies or clothing
are skipped so the "no person" label is reliable.
Writes DIR/*.png and DIR/items.json ([{"file", "kind"}]).
"""

import argparse
import base64
import json
import math
import os
import random
import re

from PIL import Image, ImageDraw, ImageFont

PEOPLE = re.compile(
    r"human|account|face|woman|women|man\b|men\b|-man|-men|person|people|baby|child|kid|gender|user|"
    r"hand|eye|ear|body|mustache|beard|lipstick|dress|tshirt|shirt|hanger|walk|run|swim|bike|skate|"
    r"ski|yoga|meditation|dance|karate|wheelchair|pregnant|toilet|human|head|skull|tooth|foot|"
    r"lips|hair|nose|emoticon|smile|sad|happy|kiss|heart-pulse|doctor|nurse|police|military|"
    r"ninja|robot|alien|ghost|account|contacts|card-account|badge-account|clipboard-account|"
    r"family|guy|girl|boy|lady|king|queen|santa|bride|crown",
    re.I,
)

PALETTE = ["#111111", "#ffffff", "#1f6feb", "#d1242f", "#1a7f37", "#8250df", "#bf8700", "#0a3069",
           "#f6f8fa", "#24292f", "#e36209", "#0969da", "#57606a", "#fff8c5", "#ddf4ff"]
WORDS = ["Cloud", "Studio", "Labs", "Pay", "Docs", "Market", "News", "Shop", "Data", "Sync", "Hub",
         "Stream", "Code", "Build", "Mail", "Bank", "Travel", "Learn", "Health", "Store"]


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def render_svgs(svgs, size_px):
    """Draw SVG files to RGBA images with Chromium (accurate SVG rendering)."""
    from playwright.sync_api import sync_playwright

    out = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get("HB_CHROMIUM") or None)
        page = b.new_page()
        page.set_content("<canvas id=c></canvas>")
        for path, color in svgs:
            svg = open(path).read()
            if color:  # colour the icon (Simple Icons / MDI are single-colour paths)
                svg = svg.replace("<svg ", f'<svg fill="{color}" ', 1)
            data = "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()
            png = page.evaluate(
                """async ([src, s]) => { const i = new Image(); i.src = src; await i.decode();
                   const c = document.getElementById('c'); c.width = s; c.height = s;
                   const g = c.getContext('2d'); g.clearRect(0, 0, s, s); g.drawImage(i, 0, 0, s, s);
                   return c.toDataURL('image/png'); }""",
                [data, size_px],
            )
            out.append(Image.open(__import__("io").BytesIO(base64.b64decode(png.split(",")[1]))).convert("RGBA"))
        b.close()
    return out


def compose_icon(icon, rng):
    """Put an icon on a web-like card: background, padding, maybe a name."""
    bg = rng.choice(PALETTE)
    w = rng.choice([96, 128, 192, 256, 320, 400])
    with_text = rng.random() < 0.4
    W = w * 3 if with_text else w
    canvas = Image.new("RGBA", (W, w), bg)
    s = int(w * rng.uniform(0.5, 0.85))
    ic = icon.resize((s, s))
    canvas.alpha_composite(ic, ((w - s) // 2, (w - s) // 2))
    if with_text:
        d = ImageDraw.Draw(canvas)
        txt = rng.choice(WORDS) + rng.choice(["", " " + rng.choice(WORDS)])
        fg = "#ffffff" if bg in ("#111111", "#24292f", "#0a3069", "#1f6feb", "#d1242f", "#8250df", "#0969da") else "#111111"
        d.text((w + 10, w // 2), txt, fill=fg, font=font(max(12, w // 5)), anchor="lm")
    if rng.random() < 0.3:  # transparent background, like many logos
        canvas = canvas.convert("RGBA")
        px = canvas.load()
        bgc = Image.new("RGBA", (1, 1), bg).getpixel((0, 0))
        for y in range(canvas.height):
            for x in range(canvas.width):
                if px[x, y] == bgc:
                    px[x, y] = (0, 0, 0, 0)
    return canvas


def chart(rng):
    W, H = rng.choice([(400, 300), (512, 320), (320, 240)])
    im = Image.new("RGB", (W, H), rng.choice(["#ffffff", "#f6f8fa", "#0d1117"]))
    d = ImageDraw.Draw(im)
    kind = rng.choice(["bar", "line", "pie"])
    cols = rng.sample(PALETTE[2:8], 4)
    if kind == "bar":
        n = rng.randint(4, 10)
        for i in range(n):
            h = rng.randint(20, H - 60)
            x = 30 + i * (W - 60) // n
            d.rectangle([x, H - 30 - h, x + (W - 60) // n - 6, H - 30], fill=rng.choice(cols))
        d.line([25, H - 30, W - 20, H - 30], fill="#888", width=2)
    elif kind == "line":
        for c in cols[: rng.randint(1, 3)]:
            pts = [(30 + i * (W - 60) // 12, rng.randint(30, H - 40)) for i in range(13)]
            d.line(pts, fill=c, width=3)
        d.line([25, H - 30, W - 20, H - 30], fill="#888", width=2)
    else:
        a = 0
        for c in cols:
            b = a + rng.randint(40, 140)
            d.pieslice([W // 2 - 100, H // 2 - 100, W // 2 + 100, H // 2 + 100], a, b, fill=c)
            a = b
    if rng.random() < 0.6:
        d.text((10, 10), rng.choice(WORDS) + " " + str(rng.randint(2019, 2026)), fill="#888", font=font(16))
    return im


def pattern(rng):
    W, H = rng.choice([(400, 300), (512, 512), (300, 300), (640, 200)])
    im = Image.new("RGB", (W, H), rng.choice(PALETTE))
    d = ImageDraw.Draw(im)
    kind = rng.choice(["gradient", "stripes", "dots", "shapes", "banner"])
    if kind == "gradient":
        c1, c2 = [Image.new("RGB", (1, 1), rng.choice(PALETTE)).getpixel((0, 0)) for _ in range(2)]
        for y in range(H):
            t = y / H
            d.line([0, y, W, y], fill=tuple(int(c1[i] * (1 - t) + c2[i] * t) for i in range(3)))
    elif kind == "stripes":
        step = rng.randint(8, 40)
        for x in range(-H, W, step * 2):
            d.polygon([(x, 0), (x + step, 0), (x + step + H, H), (x + H, H)], fill=rng.choice(PALETTE))
    elif kind == "dots":
        r = rng.randint(3, 15)
        for y in range(0, H, r * 3):
            for x in range(0, W, r * 3):
                d.ellipse([x, y, x + r * 2, y + r * 2], fill=rng.choice(PALETTE))
    elif kind == "shapes":
        for _ in range(rng.randint(5, 30)):
            x, y = rng.randint(0, W), rng.randint(0, H)
            s = rng.randint(10, 120)
            f = rng.choice([d.rectangle, d.ellipse])
            f([x, y, x + s, y + s], fill=rng.choice(PALETTE))
    else:
        d.text((W // 2, H // 2), rng.choice(WORDS).upper() + " " + rng.choice(["SALE", "2026", "NEW", "BETA", "DOCS"]),
               fill=rng.choice(PALETTE), font=font(max(20, H // 5)), anchor="mm")
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--simple-icons", required=True)
    ap.add_argument("--mdi", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=1500)
    a = ap.parse_args()
    rng = random.Random(7)
    os.makedirs(a.out, exist_ok=True)

    si_dir = os.path.join(a.simple_icons, "package", "icons")
    si = sorted(f for f in os.listdir(si_dir) if f.endswith(".svg"))
    mdi_dir = os.path.join(a.mdi, "package", "svg")
    mdi = sorted(f for f in os.listdir(mdi_dir) if f.endswith(".svg") and not PEOPLE.search(f))
    print(f"simple-icons {len(si)}, mdi (people-free) {len(mdi)}")
    picks = [(os.path.join(si_dir, f), rng.choice(PALETTE)) for f in rng.sample(si, a.n)]
    picks += [(os.path.join(mdi_dir, f), rng.choice(PALETTE)) for f in rng.sample(mdi, a.n)]
    icons = render_svgs(picks, 256)

    items = []
    for k, (ic, (path, _)) in enumerate(zip(icons, picks)):
        name = f"icon_{k}.png"
        compose_icon(ic, rng).save(os.path.join(a.out, name))
        items.append({"file": name, "kind": "logo" if "simple" in path else "icon"})
    for k in range(a.n // 3):
        name = f"chart_{k}.png"
        chart(rng).save(os.path.join(a.out, name))
        items.append({"file": name, "kind": "chart"})
    for k in range(a.n // 3):
        name = f"pattern_{k}.png"
        pattern(rng).save(os.path.join(a.out, name))
        items.append({"file": name, "kind": "pattern"})
    json.dump(items, open(os.path.join(a.out, "items.json"), "w"))
    print("wrote", len(items))


if __name__ == "__main__":
    main()
