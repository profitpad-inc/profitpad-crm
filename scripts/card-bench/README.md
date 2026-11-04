# Card reader comparison

Compares ways of reading business card photos for the card scanner
(`api/src/card-scan.ts`): open-source text readers (Tesseract, EasyOCR,
PaddleOCR) plus rule-based field sorting (`parse.py`), against Claude reading
the photo directly (the scanner's own `readCard`).

The cards are synthetic: 24 fictional people and companies in 12 layouts
(dark backgrounds, logos, two columns, portrait, script names, military
ranks, bilingual, dense small print), each as a clean render, a fair phone
photo and a bad one (steeper angle, glare, blur, heavy JPEG). Real cards will
score lower for every reader.

## Run

```bash
python3 -m venv scripts/card-bench/.venv   # /usr/bin/python3 (3.9) works
scripts/card-bench/.venv/bin/pip install easyocr paddleocr paddlepaddle pytesseract pillow numpy opencv-python-headless
brew install tesseract
node scripts/card-bench/cards.mjs                                   # out/clean, out/truth.json
scripts/card-bench/.venv/bin/python -I scripts/card-bench/photos.py  # out/photo, out/hard
scripts/card-bench/.venv/bin/python -I scripts/card-bench/ocr.py     # out/ocr/<engine>/<level>
(cd api && npx tsx --env-file=.env ../scripts/card-bench/claude.mts claude-haiku-5-5 claude-opus-5-5)
scripts/card-bench/.venv/bin/python -I scripts/card-bench/score.py   # out/results.md
```

`claude.mts` needs `ANTHROPIC_API_KEY` in `api/.env` and skips photos it
already read. Everything under `out/` and `.venv/` is ignored by git.

## Results (2026-11-03, MacBook, CPU only)

Share of 11 fields filed correctly per card (name, title, company, email,
phone, website, city, province, postal code, country):

| Reader | Clean | Fair photo | Bad photo | Seconds per card |
|---|---|---|---|---|
| Claude Haiku 5.5 | 99% | 98% | 92% | about 2 |
| Claude Opus 5.5 | 98% | 98% | 92% | about 3 |
| PaddleOCR + rules | 99% | 97% | 71% | about 7 |
| Tesseract + rules | 94% | 91% | 45% | 0.2 |
| EasyOCR + rules | 78% | 66% | 38% | 2 to 7 |

Claude's phone misses are mostly by design: the prompt prefers a direct line
or mobile, the answer key the first number printed. EasyOCR read 94% of the
answers on fair photos; most of its low field score is `parse.py` tripping on
how it splits text. `parse.py` was deliberately not tuned to these cards.
