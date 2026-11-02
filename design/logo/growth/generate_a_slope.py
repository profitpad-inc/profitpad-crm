import sys, os
# usage: generate_a_slope.py <out dir>, reads the shared helpers from ../generate.py
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "generate.py")).read()
src = src[:src.index("concepts = {}")]
OUT = sys.argv[1]
exec(src)

PITCH, WIDTH, BASE, FIRST_TIP = 15, 8, 54, 32   # first column keeps the height of the original A

def three(rise):
  # tips sit on one line rising `rise` per column; each top is cut at that same slope
  drop = WIDTH * rise / PITCH
  cols = []
  for i in range(3):
    l, r = 10 + PITCH * i, 10 + PITCH * i + WIDTH
    tip = FIRST_TIP - rise * i
    cols.append([(l, BASE), (l, tip + drop), (r, tip), (r, BASE)])
  return cols

for rise in (12, 10, 8):
  cols = three(rise)
  open(os.path.join(OUT, f"growth_a_slope{rise}.svg"), "w").write(svg([loop(c) for c in cols], cols))
