"""Turns the clean card renders into phone-like photos (see README.md).

out/photo/<id>.jpg: a fair phone snap (card on a table, slight angle and tilt,
uneven light, a little blur, JPEG). out/hard/<id>.jpg: a bad one (steeper
angle, glare, more blur and noise, heavy JPEG). Seeded, so reruns match.

  scripts/card-bench/.venv/bin/python -I scripts/card-bench/photos.py
"""
import json
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

LEVELS = {
    "photo": dict(corner=0.05, rotate=6, blur=(0.4, 1.0), noise=4, light=0.25, glare=0.0, quality=(70, 85)),
    "hard": dict(corner=0.11, rotate=14, blur=(1.0, 1.9), noise=9, light=0.45, glare=0.4, quality=(45, 60)),
}


def table(rng, w, h):
    # a plain, slightly textured surface in a random dull colour
    base = rng.integers(60, 170) + rng.integers(-25, 25, size=3)
    img = np.ones((h, w, 3), np.float32) * base
    img += rng.normal(0, 6, (h, w, 1))
    img = cv2.GaussianBlur(img, (0, 0), 3)
    return img


def shoot(card, rng, lv):
    ch, cw = card.shape[:2]
    W, H = (1600, 1200) if cw > ch else (1200, 1600)
    scale = 0.72 * min(W / cw, H / ch)
    w, h = cw * scale, ch * scale
    cx, cy = W / 2 + rng.uniform(-0.05, 0.05) * W, H / 2 + rng.uniform(-0.05, 0.05) * H
    a = np.deg2rad(rng.uniform(-lv["rotate"], lv["rotate"]))
    pts = []
    for dx, dy in [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]:
        dx += rng.uniform(-1, 1) * lv["corner"] * w
        dy += rng.uniform(-1, 1) * lv["corner"] * h
        pts.append([cx + dx * np.cos(a) - dy * np.sin(a), cy + dx * np.sin(a) + dy * np.cos(a)])
    src = np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]])
    M = cv2.getPerspectiveTransform(src, np.float32(pts))
    bg = table(rng, W, H)
    warped = cv2.warpPerspective(card.astype(np.float32), M, (W, H))
    mask = cv2.warpPerspective(np.ones((ch, cw), np.float32), M, (W, H))[..., None]
    # a soft shadow under the card
    shadow = cv2.GaussianBlur(mask[..., 0], (0, 0), 12)
    img = bg * (1 - 0.35 * np.roll(shadow, (8, 8), axis=(0, 1))[..., None])
    img = img * (1 - mask) + warped * mask
    # uneven light: a gradient across the frame
    gx, gy = np.meshgrid(np.linspace(-1, 1, W), np.linspace(-1, 1, H))
    t = rng.uniform(0, 2 * np.pi)
    light = 1 + lv["light"] * 0.5 * (np.cos(t) * gx + np.sin(t) * gy)
    img = img * light[..., None]
    # glare: a bright soft blob somewhere on the card
    if lv["glare"] > 0:
        px, py = pts[rng.integers(0, 4)]
        gxp, gyp = (px + cx) / 2, (py + cy) / 2
        r = rng.uniform(0.12, 0.2) * W
        blob = np.exp(-(((np.arange(W)[None, :] - gxp) ** 2 + (np.arange(H)[:, None] - gyp) ** 2) / (2 * r * r)))
        img = img + 255 * lv["glare"] * blob[..., None] * mask
    img = cv2.GaussianBlur(img, (0, 0), rng.uniform(*lv["blur"]))
    img = img + rng.normal(0, lv["noise"], img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    corners = [[round(float(x) / W, 5), round(float(y) / H, 5)] for x, y in pts]
    return img, int(rng.integers(*lv["quality"])), corners


def main():
    truth = json.load(open(os.path.join(OUT, "truth.json")))
    for level, lv in LEVELS.items():
        os.makedirs(os.path.join(OUT, level), exist_ok=True)
        corners = {}
        for i, t in enumerate(truth):
            rng = np.random.default_rng(1000 * (1 + list(LEVELS).index(level)) + i)
            card = cv2.imread(os.path.join(OUT, "clean", f"{t['id']}.png"))
            img, q, corners[t["id"]] = shoot(card, rng, lv)
            cv2.imwrite(os.path.join(OUT, level, f"{t['id']}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, q])
        # where the card's corners really are: top left, top right, bottom right, bottom left, as fractions of the photo
        json.dump(corners, open(os.path.join(OUT, level, "corners.json"), "w"), indent=1)
    print(f"wrote {len(truth)} photos per level: {', '.join(LEVELS)}", file=sys.stderr)


if __name__ == "__main__":
    main()
