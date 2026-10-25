"""Generates web/logo.svg: a white manta ray seen from below (open mouth,
cephalic fins forward) on a flat blue rounded square.
Run: python3 tools/logo.py  (PNG icons are rendered from the SVG with a browser.)"""
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

BLUE, WHITE = '#1565b0', '#ffffff'
H2 = [('!', (0, -19.6)), ('', (-3.2, -19.7)), ('!', (-5.4, -19.4)),
      ('', (-5.9, -23)), ('!', (-6.4, -30)), ('', (-9.4, -28.4)), ('', (-11.2, -23)), ('!', (-11.4, -16.5))] + HALF[8:]
TOP = smooth(sym(H2))
def mini(shape='square', gills=False, s=0.92, ty=46, bg=BLUE):
    # white silhouette; the open mouth is cut out in the background colour
    m = f'<path d="M0 25 C0.4 34 -1 42 1.6 50" fill="none" stroke="{WHITE}" stroke-width="3.2" stroke-linecap="round"/><path d="{TOP}" fill="{WHITE}"/>'
    m += f'<rect x="-5.6" y="-16.8" width="11.2" height="5.4" rx="2.7" fill="{bg}"/>'
    if gills:
        m += ''.join(f'<path d="M{-8.5 - i * 0.6:.1f} {-5 + i * 3:.1f} q-2.6 0.8 -3.6 2.4" fill="none" stroke="{bg}" stroke-width="1.1" stroke-linecap="round"/>'
                     f'<path d="M{8.5 + i * 0.6:.1f} {-5 + i * 3:.1f} q2.6 0.8 3.6 2.4" fill="none" stroke="{bg}" stroke-width="1.1" stroke-linecap="round"/>' for i in range(5))
    back = f'<rect width="100" height="100" rx="22" fill="{bg}"/>' if shape == 'square' else f'<circle cx="50" cy="50" r="50" fill="{bg}"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{back}<g transform="translate(50 {ty}) scale({s})">{m}</g></svg>'

if __name__ == '__main__':
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'logo.svg'), 'w').write(mini())
    print('wrote web/logo.svg')
