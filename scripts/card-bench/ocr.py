"""Runs the open-source text readers over the card photos (see README.md).

For each image: find the card in the photo and flatten it (what the scanner
page would do before reading), then read the text with Tesseract, EasyOCR and
PaddleOCR. Writes out/ocr/<engine>/<level>/<id>.json: the text lines in
reading order with their boxes, plus the seconds the engine took.

  scripts/card-bench/.venv/bin/python -I scripts/card-bench/ocr.py [engine ...]
"""
import json
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
LEVELS = ["clean", "photo", "hard"]


def order(pts):
    s, d = pts.sum(1), np.diff(pts, axis=1)[:, 0]
    return np.float32([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]])


def flatten(img):
    """Finds the largest four-sided shape (the card) and warps it flat; the
    image unchanged when there is none."""
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 30, 90)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if cv2.contourArea(c) < 0.15 * w * h:
            break
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) == 4:
            best = order(approx.reshape(4, 2).astype(np.float32))
            break
    if best is None:
        return img, False
    tl, tr, br, bl = best
    cw = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    ch = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    scale = 1600 / max(cw, ch)
    cw, ch = int(cw * scale), int(ch * scale)
    M = cv2.getPerspectiveTransform(best, np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]]))
    return cv2.warpPerspective(img, M, (cw, ch)), True


def to_lines(words):
    """words: [(text, x0, y0, x1, y1)] -> lines in reading order, words on
    about the same height joined left to right; far-apart words stay apart."""
    words = [w for w in words if w[0].strip()]
    words.sort(key=lambda w: (w[2] + w[4]) / 2)
    rows = []
    for w in words:
        cy, hgt = (w[2] + w[4]) / 2, w[4] - w[2]
        for r in rows:
            if abs(r["cy"] - cy) < 0.5 * max(hgt, r["h"]):
                r["words"].append(w)
                break
        else:
            rows.append({"cy": cy, "h": hgt, "words": [w]})
    lines = []
    for r in rows:
        ws = sorted(r["words"], key=lambda w: w[1])
        # split a row where the gap is wide (two columns side by side)
        group = [ws[0]]
        for prev, cur in zip(ws, ws[1:]):
            if cur[1] - prev[3] > 2.5 * r["h"]:
                lines.append(group)
                group = []
            group.append(cur)
        lines.append(group)
    out = []
    for g in lines:
        out.append({"text": " ".join(w[0] for w in g).strip(), "box": [min(w[1] for w in g), min(w[2] for w in g), max(w[3] for w in g), max(w[4] for w in g)]})
    out.sort(key=lambda l: (round(l["box"][1] / 20), l["box"][0]))
    return out


def tesseract(img):
    import pytesseract
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # dark cards: read light text on dark as dark on light
    if gray.mean() < 110:
        gray = 255 - gray
    d = pytesseract.image_to_data(gray, lang="eng", config="--psm 11", output_type=pytesseract.Output.DICT)
    words = [(t, x, y, x + w, y + h) for t, x, y, w, h, c in zip(d["text"], d["left"], d["top"], d["width"], d["height"], d["conf"]) if float(c) > 30]
    return to_lines(words)


_easy = None


def easyocr_read(img):
    global _easy
    import easyocr
    if _easy is None:
        _easy = easyocr.Reader(["en", "fr"], gpu=False, verbose=False)
    res = _easy.readtext(img)
    words = []
    for box, text, conf in res:
        if conf < 0.2:
            continue
        xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
        words.append((text, min(xs), min(ys), max(xs), max(ys)))
    return to_lines(words)


_paddle = None


def paddle(img):
    global _paddle
    from paddleocr import PaddleOCR
    if _paddle is None:
        _paddle = PaddleOCR(lang="en", use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=True)
    res = _paddle.predict(img)
    r = res[0]
    words = []
    for text, poly, score in zip(r["rec_texts"], r["rec_polys"], r["rec_scores"]):
        if score < 0.3:
            continue
        poly = np.asarray(poly)
        words.append((text, float(poly[:, 0].min()), float(poly[:, 1].min()), float(poly[:, 0].max()), float(poly[:, 1].max())))
    return to_lines(words)


ENGINES = {"tesseract": tesseract, "easyocr": easyocr_read, "paddleocr": paddle}


def main():
    engines = sys.argv[1:] or list(ENGINES)
    truth = json.load(open(os.path.join(OUT, "truth.json")))
    for name in engines:
        for level in LEVELS:
            d = os.path.join(OUT, "ocr", name, level)
            os.makedirs(d, exist_ok=True)
            for t in truth:
                ext = "png" if level == "clean" else "jpg"
                img = cv2.imread(os.path.join(OUT, level, f"{t['id']}.{ext}"))
                flat, found = (img, True) if level == "clean" else flatten(img)
                start = time.time()
                lines = ENGINES[name](flat)
                took = time.time() - start
                json.dump({"lines": lines, "seconds": round(took, 2), "card_found": found}, open(os.path.join(d, f"{t['id']}.json"), "w"), indent=1)
            print(f"{name} {level} done", file=sys.stderr)


if __name__ == "__main__":
    main()
