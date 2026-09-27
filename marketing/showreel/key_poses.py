"""Keys Mana's Live2D pose renders (cubism-render-snapshots/pose-*.png, magenta
background, from Mana's own Cubism renderer) to transparent PNGs with the
magenta spill removed, in three crops: head, bust (waist-up presenter) and
full body. Run: python key_poses.py  ->  avatar/<pose>-<crop>.png
"""

import pathlib

import numpy as np
from PIL import Image

HERE = pathlib.Path(__file__).parent
SRC = HERE.parents[1] / "cubism-render-snapshots"
OUT = HERE / "avatar"
CROPS = {"head": 0.42, "bust": 0.62, "full": 1.0}  # fraction of body height, from the top


def key(path):
    a = np.array(Image.open(path).convert("RGBA")).astype(float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    alpha = np.clip((np.sqrt((r - 255) ** 2 + g ** 2 + (b - 255) ** 2) - 60) / 80, 0, 1)
    # despill: magenta is red+blue in excess of green; strongest on the soft edge
    spill = np.clip(np.minimum(r, b) - g, 0, None)
    k = np.clip(1 - alpha + 0.35, 0, 1)
    a[..., 0], a[..., 2], a[..., 3] = r - spill * k, b - spill * k, alpha * 255
    img = Image.fromarray(a.clip(0, 255).astype("uint8"), "RGBA")
    return img.crop(img.getbbox())


def main():
    OUT.mkdir(exist_ok=True)
    for src in sorted(SRC.glob("pose-*.png")):
        body = key(src)
        w, h = body.size
        name = src.stem.removeprefix("pose-")
        for crop, frac in CROPS.items():
            body.crop((0, 0, w, int(h * frac))).save(OUT / f"{name}-{crop}.png")
        print(name, body.size)


if __name__ == "__main__":
    main()
