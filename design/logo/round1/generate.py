import sys, os
K = 0.3848          # slant of the "vertical" strokes in the ProfitPad mark
W = 3.55            # stroke width of the ProfitPad mark
BLUE = "#0062FF"
OUT = sys.argv[1]

def P(u, y): return (u - K * y, y)
def pts(seq): return " ".join(f"{x:.3f},{y:.3f}" for x, y in (P(u, y) for u, y in seq))

def loop(seq): return f'<polygon points="{pts(seq)}"/>'
def line(seq): return f'<polyline points="{pts(seq)}"/>'
def fill(seq): return f'<polygon points="{pts(seq)}" stroke="none" fill="{BLUE}"/>'

def spur(d, sign):
  # sharp wedge on the inside of a diagonal-to-bar joint, measured from the original mark
  u, y = d
  return fill([(u + sign * 0.5, y + sign * W / 2), (u + sign * 8.55, y + sign * W / 2), (u + sign * 3.51, y - sign * 0.455)])

def bbox(shapes_pts):
  xs = [P(u, y)[0] for s in shapes_pts for u, y in s]; ys = [y for s in shapes_pts for u, y in s]
  return min(xs), min(ys), max(xs), max(ys)

def svg(body, allpts, size=None, pad=5.0):
  x0, y0, x1, y1 = bbox(allpts)
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
  w, h = x1 - x0, y1 - y0; s = max(w, h)
  cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
  vb = f"{cx - s/2:.2f} {cy - s/2:.2f} {s:.2f} {s:.2f}"
  return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" fill="none">\n'
          f'<g stroke="{BLUE}" stroke-width="{W}" stroke-linejoin="miter" stroke-miterlimit="10">\n'
          + "\n".join(body) + "\n</g>\n</svg>\n")

# Original ProfitPad loop (center line, unslanted coordinates)
L, R, T, B = 23.7, 59.94, 18.235, 37.45
T1, D1, TL, T2, D2, BR = (R, 5.11), (46.8, T), (L, T), (L, 50.57), (36.84, B), (R, B)
orig = [T1, D1, TL, T2, D2, BR]

concepts = {}

# 1. Rows: the ProfitPad loop split into two records by a middle bar
M = (T + B) / 2
concepts["rows"] = ([loop(orig), line([(L, M), (R, M)]), spur(D1, 1), spur(D2, -1)], [orig])

# 2. C: the loop with the right side opened, keeping both arrow tips
c_path = [(R, T + W / 2), T1, D1, TL, T2, D2, (R + W * 0.53, B)]
concepts["c"] = ([
  f'<clipPath id="cut"><polygon points="{pts([(-50, -50), (R + 1.9, -50), (R + 1.9, 120), (-50, 120)])}"/></clipPath>',
  f'<clipPath id="stub"><polygon points="{pts([(-50, -50), (120, -50), (120, T + W / 2), (R - 2.5, T + W / 2), (R - 2.5, 120), (-50, 120)])}"/></clipPath>',
  f'<g clip-path="url(#stub)">{line([(R, T + 6)] + c_path[1:-1])}</g>',
  f'<g clip-path="url(#cut)" stroke-linecap="square">{line([D2, c_path[-1]])}</g>',
  spur(D1, 1), spur(D2, -1),
], [orig])

# 3. Linked: two frames, each with one ProfitPad arrow tip, interlocking
A = [(22, 24), (46, 24), (46, 40), (35, 40), (22, 53)]
Bf = [(58, 1), (58, 30), (34, 30), (34, 14), (45, 14)]
concepts["linked"] = ([loop(A), loop(Bf), spur((45, 14), 1), spur((35, 40), -1)], [A, Bf])

for name, (body, allp) in concepts.items():
  open(os.path.join(OUT, f"crm_{name}.svg"), "w").write(svg(body, allp))
print("done")
