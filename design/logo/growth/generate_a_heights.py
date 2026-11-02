import sys, os
OUT = sys.argv[1]
# usage: generate_a_heights.py <out dir>, reads the shared helpers from ../generate.py
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "generate.py")).read()
src = src[:src.index("concepts = {}")]
sys.argv = [sys.argv[0], OUT]
exec(src)

def three(step, top=2, base=54):
  # columns 8 wide with 7 between, each cut at 45 degrees into a tip; step = rise from one tip to the next
  cols = []
  for i in range(3):
    l, r = 10 + 15 * i, 18 + 15 * i
    tip = top + step * (2 - i)
    cols.append([(l, base), (l, tip + 8), (r, tip), (r, base)])
  return cols

for step in (15, 11, 8, 6):
  cols = three(step)
  open(os.path.join(OUT, f"growth_a_step{step}.svg"), "w").write(svg([loop(c) for c in cols], cols))
