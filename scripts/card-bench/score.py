"""Scores every reader against the known answers (see README.md) and writes
out/results.md.

Two numbers per open-source engine: "read" is the share of answers that
appear anywhere in its raw text (how good the engine's eyes are), "fields" is
the share our rules (parse.py) put in the right field. Claude only has
"fields". A field counts as right when it matches after ignoring case,
spacing, punctuation and accents; phones compare digits; a field the card
does not show must be left empty.

  scripts/card-bench/.venv/bin/python -I scripts/card-bench/score.py
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse import norm, parse  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
LEVELS = ["clean", "photo", "hard"]
FIELDS = ["first_name", "last_name", "job_title", "company", "email", "phone", "website", "address_city", "address_province", "address_postalcode", "address_country"]


def digits(s):
    d = re.sub(r"\D", "", re.sub(r"(ext|x).*$", "", s or "", flags=re.I))
    return d[1:] if len(d) == 11 and d.startswith("1") else d


def same(field, got, want):
    got = got or ""
    if field == "phone":
        return digits(got) == want
    if field == "website":
        got = re.sub(r"^(https?://)?(www\.)?", "", got.strip().lower()).rstrip("/")
        want = re.sub(r"^www\.", "", want.lower())
    return norm(got) == norm(want)


def in_text(field, want, text):
    if not want or field == "address_country":
        return None
    if field == "phone":
        return want in re.sub(r"\D", "", text)
    return norm(want) in norm(text)


def main():
    truth = json.load(open(os.path.join(OUT, "truth.json")))
    readers = {}
    for engine in ["tesseract", "easyocr", "paddleocr"]:
        if os.path.isdir(os.path.join(OUT, "ocr", engine)):
            readers[engine] = ("ocr", engine)
    for d in sorted(glob.glob(os.path.join(OUT, "claude", "*"))):
        readers[os.path.basename(d)] = ("claude", os.path.basename(d))

    rows, misses = [], {}
    for name, (kind, key) in readers.items():
        for level in LEVELS:
            right = total = seen = seen_total = 0
            secs, n = 0.0, 0
            per_field = {f: [0, 0] for f in FIELDS}
            for t in truth:
                path = os.path.join(OUT, kind, key, level, f"{t['id']}.json")
                if not os.path.exists(path):
                    continue
                data = json.load(open(path))
                secs += data.get("seconds", 0)
                n += 1
                if kind == "ocr":
                    fields = parse(data["lines"])
                    text = " ".join(l["text"] for l in data["lines"])
                else:
                    fields = data["fields"]
                    text = None
                for f in FIELDS:
                    ok = same(f, fields.get(f, ""), t[f])
                    right += ok
                    total += 1
                    per_field[f][0] += ok
                    per_field[f][1] += 1
                    if not ok:
                        misses.setdefault((name, level), []).append(f"{t['id']} {f}: got {fields.get(f, '')!r}, want {t[f]!r}")
                    if text is not None:
                        s = in_text(f, t[f], text)
                        if s is not None:
                            seen += s
                            seen_total += 1
            if n:
                rows.append((name, level, n, right / total, seen / seen_total if seen_total else None, secs / n, per_field))

    lines = ["# Card reader comparison", "", f"{len(truth)} synthetic cards, three levels: clean render, fair phone photo, bad phone photo.", "",
             "| Reader | Level | Cards | Fields right | Answers in raw text | Seconds per card |", "|---|---|---|---|---|---|"]
    for name, level, n, acc, seen, secs, _ in rows:
        lines.append(f"| {name} | {level} | {n} | {acc:.0%} | {'' if seen is None else f'{seen:.0%}'} | {secs:.1f} |")
    lines += ["", "## Fields right, by field (fair phone photos)", "", "| Reader | " + " | ".join(FIELDS) + " |", "|---|" + "---|" * len(FIELDS)]
    for name, level, n, acc, seen, secs, pf in rows:
        if level == "photo":
            lines.append(f"| {name} | " + " | ".join(f"{a / b:.0%}" if b else "" for a, b in pf.values()) + " |")
    lines += ["", "## Misses (fair phone photos)", ""]
    for (name, level), ms in misses.items():
        if level == "photo":
            lines += [f"### {name}", ""] + [f"- {m}" for m in ms] + [""]
    open(os.path.join(OUT, "results.md"), "w").write("\n".join(lines))
    print("\n".join(lines[:4 + len(rows) + 2]))


if __name__ == "__main__":
    main()
