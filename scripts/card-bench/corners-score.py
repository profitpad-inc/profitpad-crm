"""Scores where Claude put the card's corners (corners.mts) against the true
corners (photos.py), next to the browser corner finder that was removed from
the scanner (the same algorithm, in Python) and not cropping at all. Writes
out/corners/results.md and out/corners/examples.jpg.

  scripts/card-bench/.venv/bin/python -I scripts/card-bench/corners-score.py [model]
"""
import glob
import json
import os
import sys

import cv2
import numpy as np
from shapely.geometry import Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
MODEL = sys.argv[1] if len(sys.argv) > 1 else "claude-haiku-5-5"
LEVELS = [("photo", "Fair phone photo"), ("hard", "Bad phone photo")]
# Haiku 5.5 list prices, US$ per million tokens
PRICE_IN, PRICE_OUT = 0.10, 0.50


def finder(img):
    """The removed browser corner finder (web/src/lib/card-image.ts findCard)."""
    from scipy import ndimage
    h, w = img.shape[:2]
    s = 400 / max(h, w)
    small = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA).astype(np.float32)
    sh, sw = small.shape[:2]
    b = max(2, int(0.04 * min(sh, sw)))
    border = np.concatenate([small[:b].reshape(-1, 3), small[-b:].reshape(-1, 3), small[:, :b].reshape(-1, 3), small[:, -b:].reshape(-1, 3)])
    diff = np.sqrt(((small - np.median(border, axis=0)) ** 2).sum(2))
    hist, edges = np.histogram(diff, 64)
    p = hist / hist.sum()
    mids = (edges[:-1] + edges[1:]) / 2
    best, thr = -1, diff.mean()
    for k in range(1, 64):
        w0, w1 = p[:k].sum(), p[k:].sum()
        if w0 == 0 or w1 == 0:
            continue
        v = w0 * w1 * ((p[:k] * mids[:k]).sum() / w0 - (p[k:] * mids[k:]).sum() / w1) ** 2
        if v > best:
            best, thr = v, edges[k]
    lab, n = ndimage.label(diff > thr)
    if n == 0:
        return None
    sizes = ndimage.sum(diff > thr, lab, range(1, n + 1))
    comp = lab == (np.argmax(sizes) + 1)
    if comp.sum() < 0.1 * sh * sw:
        return None
    ys, xs = np.nonzero(comp)
    a, d = xs + ys, xs - ys
    pts = [(xs[a.argmin()], ys[a.argmin()]), (xs[d.argmax()], ys[d.argmax()]), (xs[a.argmax()], ys[a.argmax()]), (xs[d.argmin()], ys[d.argmin()])]
    return [[(x + 0.5) / sw, (y + 0.5) / sh] for x, y in pts]


def kept_by_scanner(q):
    """What cardCorners in api/src/card-scan.ts keeps: clockwise, convex, at least 4% of the photo, not the whole photo."""
    if q is None:
        return None
    q = [[min(1, max(0, x)), min(1, max(0, y))] for x, y in q]
    area = sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1] for i in range(4)) / 2
    if area < 0.04:
        return None
    for i in range(4):
        a, b, d = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        if (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]) <= 0:
            return None
    if all(abs(q[i][0] - [0, 1, 1, 0][i]) < 0.01 and abs(q[i][1] - [0, 0, 1, 1][i]) < 0.01 for i in range(4)):
        return None
    return q


def measure(true, got, w, h):
    """Corner errors as % of the photo's diagonal, share of the card inside the crop, extra background, right way round."""
    T = np.array(true) * [w, h]
    G = np.array(got) * [w, h]
    diag = np.hypot(w, h)
    err = np.hypot(*(T - G).T) / diag * 100
    tp, gp = Polygon(T), Polygon(G)
    inter = tp.intersection(gp).area if gp.is_valid else 0
    # the right way round: no other rotation of the four labels fits better
    rot = min(range(4), key=lambda k: np.hypot(*(T - np.roll(G, k, axis=0)).T).mean())
    return {"mean_err": float(err.mean()), "max_err": float(err.max()), "card_kept": inter / tp.area * 100,
            "extra": (gp.area - inter) / tp.area * 100 if gp.is_valid else 0, "upright": rot == 0}


def summary(rows):
    if not rows:
        return "| -- | -- | -- | -- | -- | -- |"
    e = np.array([r["mean_err"] for r in rows])
    m = np.array([r["max_err"] for r in rows])
    kept = np.array([r["card_kept"] for r in rows])
    extra = np.array([r["extra"] for r in rows])
    good = np.mean([(r["max_err"] <= 2) for r in rows]) * 100
    ok = np.mean([(r["card_kept"] >= 98 and r["extra"] <= 10) for r in rows]) * 100
    return (f"| {np.median(e):.1f}% | {np.median(m):.1f}% (worst {m.max():.1f}%) | {good:.0f}% | {np.median(kept):.1f}% (worst {kept.min():.1f}%) "
            f"| {np.median(extra):.1f}% | {ok:.0f}% |")


def main():
    truth_ids = [t["id"] for t in json.load(open(os.path.join(OUT, "truth.json")))]
    lines = [f"# Where is the card? {MODEL} corners vs the truth", "",
             "48 synthetic phone photos (scripts/card-bench). Corner error is the distance from the true corner as a share of the photo's diagonal "
             "(1% is about 20px on a 1600x1200 photo). Card kept: how much of the card is inside the crop (under 100% means part of it was cut off). "
             "Extra: background inside the crop, as a share of the card. Usable: at least 98% of the card kept and at most 10% extra.", ""]
    examples = []
    for level, label in LEVELS:
        true = json.load(open(os.path.join(OUT, level, "corners.json")))
        claude, find, none = [], [], []
        upright = rejected = found_none = 0
        tok_in = tok_out = n = 0
        for cid in truth_ids:
            img = cv2.imread(os.path.join(OUT, level, f"{cid}.jpg"))
            h, w = img.shape[:2]
            path = os.path.join(OUT, "corners", MODEL, level, f"{cid}.json")
            if os.path.exists(path):
                d = json.load(open(path))
                tok_in += d["usage"]["input_tokens"]
                tok_out += d["usage"]["output_tokens"]
                n += 1
                raw = d["corners"]
                q = [[raw[k]["x"], raw[k]["y"]] for k in ("top_left", "top_right", "bottom_right", "bottom_left")] if raw else None
                kept = kept_by_scanner(q)
                if kept is None:
                    rejected += 1
                    kept = [[0, 0], [1, 0], [1, 1], [0, 1]]
                r = measure(true[cid], kept, w, h)
                upright += r["upright"]
                claude.append(r)
                examples.append((level, cid, img, true[cid], kept, r))
            f = finder(img)
            if f is None:
                found_none += 1
                f = [[0, 0], [1, 0], [1, 1], [0, 1]]
            find.append(measure(true[cid], f, w, h))
            none.append(measure(true[cid], [[0, 0], [1, 0], [1, 1], [0, 1]], w, h))
        lines += [f"## {label}", "",
                  "| Corners from | Corner error (median) | Worst corner per photo (median) | Every corner within 2% | Card kept (median) | Extra (median) | Usable |",
                  "|---|---|---|---|---|---|---|",
                  f"| {MODEL} " + summary(claude), "| Browser finder (removed) " + summary(find), "| No crop (whole photo) " + summary(none), "",
                  f"- {MODEL}: {upright} of {len(claude)} came back the right way round; {rejected} were refused by the scanner's check (whole photo kept).",
                  f"- Browser finder: no card found on {found_none} of {len(find)} (whole photo kept).",
                  f"- Tokens per read with corners: {tok_in / max(n, 1):.0f} in, {tok_out / max(n, 1):.0f} out; about US${(tok_in * PRICE_IN + tok_out * PRICE_OUT) / max(n, 1) / 1e6:.5f} per card.", ""]
    open(os.path.join(OUT, "corners", "results.md"), "w").write("\n".join(lines))
    print("\n".join(lines))

    # examples: true corners green, Claude's red; the 3 best and 5 worst by worst corner
    examples.sort(key=lambda e: e[5]["max_err"])
    pick = examples[:3] + examples[-5:]
    tiles = []
    for level, cid, img, t, c, r in pick:
        h, w = img.shape[:2]
        im = img.copy()
        for quad, color in ((t, (60, 200, 60)), (c, (40, 40, 230))):
            pts = (np.array(quad) * [w, h]).astype(np.int32)
            cv2.polylines(im, [pts], True, color, 5)
        cv2.putText(im, f"{cid} {level}: worst corner {r['max_err']:.1f}%, card kept {r['card_kept']:.0f}%", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (255, 255, 255), 6)
        cv2.putText(im, f"{cid} {level}: worst corner {r['max_err']:.1f}%, card kept {r['card_kept']:.0f}%", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (20, 20, 20), 2)
        scale = 640 / max(h, w)
        im = cv2.resize(im, (int(w * scale), int(h * scale)))
        tile = np.full((640, 640, 3), 255, np.uint8)
        tile[:im.shape[0], :im.shape[1]] = im
        tiles.append(tile)
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
    cv2.imwrite(os.path.join(OUT, "corners", "examples.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])


if __name__ == "__main__":
    main()
