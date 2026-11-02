import sys, os
sys.argv = [sys.argv[0], sys.argv[1]]
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "generate.py")).read()
src = src[:src.index("concepts = {}")]
exec(src)
OUT = sys.argv[1]

def solid(seq): return f'<polygon points="{pts(seq)}" fill="{BLUE}"/>'

g1 = [(10, 54), (10, 40), (18, 32), (18, 54)]
g2 = [(25, 54), (25, 25), (33, 17), (33, 54)]
g3 = [(40, 54), (40, 10), (48, 2), (48, 54)]
three = [g1, g2, g3]
v = {}

# A: current
v["a_three"] = ([loop(c) for c in three], three)

# B: two wider columns, simplest, holds up best at favicon size
b1 = [(14, 54), (14, 36), (24, 26), (24, 54)]
b2 = [(31, 54), (31, 12), (41, 2), (41, 54)]
v["b_two"] = ([loop(b1), loop(b2)], [b1, b2])

# C: four narrower columns, a longer climb
f = [[(8 + 12 * i, 54), (8 + 12 * i, 46 - 12 * i), (15 + 12 * i, 39 - 12 * i), (15 + 12 * i, 54)] for i in range(4)]
v["c_four"] = ([loop(c) for c in f], f)

# D: columns on a shared base that ends in the original's bottom-left tip
base = [(48, 54), (21, 54), (10, 65), (10, 54)]
v["d_base"] = ([loop(c) for c in three] + [line(base), spur((21, 54), -1)], three + [base])

# E: tallest column filled as an accent
v["e_accent"] = ([loop(g1), loop(g2), solid(g3)], three)

# F: all columns filled, for very small sizes
v["f_solid"] = ([solid(c) for c in three], three)

for name, (b, allp) in v.items():
  open(os.path.join(OUT, f"growth_{name}.svg"), "w").write(svg(b, allp))
print(" ".join(v))
