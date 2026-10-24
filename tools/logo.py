"""Generates web/logo.svg: an oceanic manta seen from below (white belly, gill
slits, open mouth, cephalic fins forward) inside the red-orange-yellow trail of
a loop. Run: python3 tools/logo.py  (PNG icons are rendered from the SVG.)"""
import os
import math
DARK, BELLY, MARGIN, LIP, MOUTH = '#0b1a2e', '#eef3f1', '#243447', '#e3f0f3', '#121822'

def smooth(pts, closed=True):
    n = len(pts); d = f'M{pts[0][1][0]:.2f} {pts[0][1][1]:.2f}'
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        a, b = pts[i], pts[(i + 1) % n]
        p0 = pts[(i - 1) % n][1]; p1 = a[1]; p2 = b[1]; p3 = pts[(i + 2) % n][1]
        c1 = p1 if a[0] == '!' else (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = p2 if b[0] == '!' else (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f' C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}'
    return d + (' Z' if closed else '')

def sym(half):
    """half: left side from front centre to rear centre; returns closed symmetric outline."""
    right = [(k, (-x, y)) for k, (x, y) in reversed(half[1:-1])]
    return half + right

# ---- top-down manta (local coords, head up, span +-49) -------------------
HALF = [('!', (0, -15)), ('', (-3, -15.6)), ('!', (-5.6, -16)),
        ('', (-6.3, -21)), ('!', (-6.6, -28.5)), ('', (-9.3, -27)), ('', (-11, -22)), ('!', (-11.2, -16.5)),
        ('', (-22, -15)), ('', (-36, -6)), ('!', (-49, 13)),
        ('', (-38, 6)), ('', (-27, 5)), ('', (-16, 11)),
        ('', (-11, 15)), ('', (-8, 21)), ('', (-5, 24)), ('!', (0, 26.5))]
TOP = smooth(sym(HALF))
TAIL = 'M0 25 C0.4 34 -1 42 1.6 50'
CHEV = smooth([('!', (-9.5, -11)), ('', (-17, -11)), ('!', (-30, -0.5)), ('', (-22, -1)), ('!', (-14.5, 3.5)), ('', (-12.5, -3))])
GILLS = ''.join(f'<path d="M{-8.5 - i * 0.6:.1f} {-6 + i * 3:.1f} q-2.6 0.8 -3.6 2.4" fill="none" stroke="{MARGIN}" stroke-width="0.9" stroke-linecap="round"/>'
                f'<path d="M{8.5 + i * 0.6:.1f} {-6 + i * 3:.1f} q2.6 0.8 3.6 2.4" fill="none" stroke="{MARGIN}" stroke-width="0.9" stroke-linecap="round"/>' for i in range(5))

def dorsal(marks=True):
    m = f'<path d="{TAIL}" fill="none" stroke="{DARK}" stroke-width="2.6" stroke-linecap="round"/><path d="{TOP}" fill="{DARK}"/>'
    if marks: m += f'<path d="{CHEV}" fill="{BELLY}"/><path d="{CHEV}" fill="{BELLY}" transform="scale(-1 1)"/>'
    # open mouth seen from above: a pale lip around a dark gap at the front edge
    m += f'<path d="M-5.6 -16 C-3 -19.5 3 -19.5 5.6 -16 C3 -14.4 -3 -14.4 -5.6 -16 Z" fill="{MOUTH}" stroke="{LIP}" stroke-width="1.3"/>'
    return m

def ventral():
    m = f'<path d="{TAIL}" fill="none" stroke="{MARGIN}" stroke-width="2.6" stroke-linecap="round"/><path d="{TOP}" fill="{MARGIN}"/>'
    m += f'<path d="{TOP}" fill="{BELLY}" transform="translate(0 1.5) scale(0.86)"/>'
    m += GILLS
    # spots typical of an oceanic manta belly
    m += ''.join(f'<circle cx="{x}" cy="{y}" r="1.1" fill="{MARGIN}"/>' for x, y in [(-3, 8), (2.5, 11), (-1, 15)])
    m += f'<rect x="-6" y="-19" width="12" height="6" rx="3" fill="{MOUTH}" stroke="{LIP}" stroke-width="1.2"/>'
    return m

# ---- front (head-on) view, badge coords ----------------------------------
def front(droop=0.0, far=1.0, belly=True):
    """Head-on: open mouth, cephalic fins either side, wings out. droop bends the wings down (downstroke)."""
    def wing(sign, k):
        cx = 50
        X = lambda x: cx + sign * (x - cx) * (k if sign > 0 else 1)
        tipy = 37 + droop * 32
        up = [('!', (X(38), 44)), ('', (X(30), 40 + droop * 4)), ('', (X(18), 37 + droop * 14)), ('!', (X(5), tipy)),
              ('', (X(16), tipy + 5 - droop * 2)), ('', (X(28), 50 + droop * 6)), ('!', (X(38), 57))]
        return smooth(up)
    s = ''
    for sign, k in ((-1, 1.0), (1, far)):
        s += f'<path d="{wing(sign, k)}" fill="{DARK}"/>'
        if belly:
            X = lambda x: 50 + sign * (x - 50) * (k if sign > 0 else 1)
            tipy = 37 + droop * 32
            s += f'<path d="M{X(37):.1f} 55.5 C{X(28):.1f} {49 + droop * 6:.1f} {X(17):.1f} {tipy + 4.2 - droop * 2:.1f} {X(7):.1f} {tipy + 0.8:.1f}" fill="none" stroke="{BELLY}" stroke-width="1.4" stroke-linecap="round" opacity=".85"/>'
    head = smooth([('', (36.5, 46)), ('', (42, 41.5)), ('', (50, 40.5)), ('', (58, 41.5)), ('', (63.5, 46)),
                   ('', (64.5, 54)), ('', (60, 61)), ('', (50, 63)), ('', (40, 61)), ('', (35.5, 54))])
    s += f'<path d="{head}" fill="{DARK}"/>'
    # cephalic fins: unrolled paddles hanging beside the mouth
    for sign in (-1, 1):
        X = lambda x: 50 + sign * (x - 50)
        fin = smooth([('!', (X(38), 45)), ('', (X(34), 50)), ('', (X(33), 59)), ('', (X(35.5), 66)), ('', (X(39), 66.5)), ('', (X(39.5), 60)), ('!', (X(40.5), 51))])
        s += f'<path d="{fin}" fill="{DARK}"/><path d="M{X(36.2):.1f} 52 C{X(35.4):.1f} 57 {X(35.8):.1f} 62 {X(37.4):.1f} 64.6" fill="none" stroke="{BELLY}" stroke-width="1" stroke-linecap="round" opacity=".8"/>'
        s += f'<circle cx="{X(41.5):.1f}" cy="47" r="1.3" fill="{LIP}"/>'
    # big open mouth with gill rakers
    s += f'<rect x="42" y="49" width="16" height="11" rx="5" fill="{MOUTH}" stroke="{LIP}" stroke-width="1.6"/>'
    s += ''.join(f'<path d="M{x} 51.5 V57.5" stroke="#3b4a5c" stroke-width="0.8"/>' for x in (46, 48.6, 51.4, 54))
    return s

ocean = '<linearGradient id="oc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4cc3d3"/><stop offset=".5" stop-color="#1a74b4"/><stop offset="1" stop-color="#0a2c57"/></linearGradient>'
deep = '<linearGradient id="dp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a8fc4"/><stop offset="1" stop-color="#061d3d"/></linearGradient>'
rays = '<linearGradient id="ry" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
RAYS = ''.join(f'<path d="M{a} 0 L{a + w} 0 L{a + w + t} 72 L{a + t} 72 Z" fill="url(#ry)"/>' for a, w, t in [(28, 5, -10), (45, 4, -6), (60, 6, -2), (75, 3, 3)])

def loop_trail(start=62, sweep=300, r=40, w=5):
    stops = [(0, (242, 210, 58)), (0.35, (240, 138, 44)), (0.7, (255, 93, 79)), (1, (255, 93, 79))]
    def col(t):
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t <= t1: f = (t - t0) / (t1 - t0); return tuple(c0[i] + (c1[i] - c0[i]) * f for i in range(3))
    out, n = '', 36
    for i in range(n):
        a0 = math.radians(start - sweep * i / n); a1 = math.radians(start - sweep * min(1, (i + 1.1) / n))
        c = col((i + .5) / n); op = 1 if i < n * 0.6 else max(0.05, 1 - (i - n * 0.6) / (n * 0.4))
        out += (f'<path d="M{50 + r * math.cos(a0):.2f} {50 + r * math.sin(a0):.2f} A{r} {r} 0 0 0 {50 + r * math.cos(a1):.2f} {50 + r * math.sin(a1):.2f}" '
                f'fill="none" stroke="rgb({c[0]:.0f},{c[1]:.0f},{c[2]:.0f})" stroke-opacity="{op:.2f}" stroke-width="{w}"/>')
    return out

def badge(inner, bg='oc', with_rays=True, under=''):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>{ocean}{deep}{rays}<clipPath id="cl"><circle cx="50" cy="50" r="49"/></clipPath></defs>'
            f'<circle cx="50" cy="50" r="49" fill="url(#{bg})"/><g clip-path="url(#cl)">{RAYS if with_rays else ""}{under}{inner}</g></svg>')

def g(content, tx=50, ty=50, rot=0, sx=1, sy=None):
    return f'<g transform="translate({tx} {ty}) rotate({rot}) scale({sx} {sy if sy is not None else sx})">{content}</g>'


if __name__ == '__main__':
    svg = badge(g(ventral(), 50, 45, 0, 0.6), with_rays=False, under=loop_trail())
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'logo.svg'), 'w').write(svg)
    print('wrote web/logo.svg')
