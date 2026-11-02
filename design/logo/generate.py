import sys, os
K = 0.3848          # slant of the "vertical" strokes in the ProfitPad mark
W = 3.55            # stroke width of the ProfitPad mark
H = W / 2
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
  return fill([(u + sign * 0.5, y + sign * H), (u + sign * 8.55, y + sign * H), (u + sign * 3.51, y - sign * 0.455)])

_n = [0]
def clipped(body, keep):
  # keep: polygon (unslanted) of the area to keep; ends cut by it stay parallel to bars or edges
  _n[0] += 1
  cid = f"c{_n[0]}"
  return f'<clipPath id="{cid}"><polygon points="{pts(keep)}"/></clipPath><g clip-path="url(#{cid})">{body}</g>'

def svg(body, allpts, pad=5.0):
  xs = [P(u, y)[0] for s in allpts for u, y in s]; ys = [y for s in allpts for u, y in s]
  x0, y0, x1, y1 = min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad
  s = max(x1 - x0, y1 - y0); cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
  return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{cx - s/2:.2f} {cy - s/2:.2f} {s:.2f} {s:.2f}" fill="none">\n'
          f'<g stroke="{BLUE}" stroke-width="{W}" stroke-linejoin="miter" stroke-miterlimit="10">\n'
          + "\n".join(body) + "\n</g>\n</svg>\n")

BIG = 200
concepts = {}

# Contact: a head and shoulders, the shoulders carry the ProfitPad arrow tip
head = [(33, 4), (47, 4), (47, 18), (33, 18)]
body = [(24, 25), (56, 25), (56, 45), (37, 45), (24, 58)]
concepts["contact"] = ([loop(head), loop(body), spur((37, 45), -1)], [head, body])

# Stack: three records stacked back to front, the back one ends in the arrow tip
front = [(16, 28), (46, 28), (46, 48), (29, 48), (16, 61)]
mid = [(25, 28), (25, 19), (55, 19), (55, 39), (46, 39)]
back = [(34, 19), (34, 10), (53, 10), (64, -1), (64, 30), (55, 30)]
concepts["stack"] = ([loop(front), line(mid), line(back), spur((29, 48), -1), spur((53, 10), 1)], [front, mid, back])

# Growth: three rising columns, each cut at 45 degrees into a ProfitPad tip
g1 = [(10, 54), (10, 40), (18, 32), (18, 54)]
g2 = [(25, 54), (25, 25), (33, 17), (33, 54)]
g3 = [(40, 54), (40, 10), (48, 2), (48, 54)]
concepts["growth"] = ([loop(g1), loop(g2), loop(g3)], [g1, g2, g3])

# Connect: two records joined by an association, each carrying one arrow tip
na = [(30, 48), (26, 48), (16, 58), (16, 34), (30, 34)]
nb = [(40, 10), (44, 10), (54, 0), (54, 24), (40, 24)]
link = [(30, 34), (40, 24)]
concepts["connect"] = ([loop(na), loop(nb), line(link)], [na, nb])

for name, (b, allp) in concepts.items():
  open(os.path.join(OUT, f"crm_{name}.svg"), "w").write(svg(b, allp))
print("done")
