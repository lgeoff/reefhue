"""Generates web/logo.svg: an oceanic manta ray banking through a roll, lit
from above, after a reference frame of a manta doing a flip.
Run: python3 tools/logo.py  (PNG icons are rendered from the SVG with a browser.)"""
import os
def smooth(pts, k=0.5):
    n = len(pts); d = f'M{pts[0][1][0]:.2f} {pts[0][1][1]:.2f}'
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        p0 = pts[(i - 1) % n][1]; p1 = a[1]; p2 = b[1]; p3 = pts[(i + 2) % n][1]
        if a[0] == '!': c1 = p1
        else: c1 = (p1[0] + (p2[0] - p0[0]) * k / 3, p1[1] + (p2[1] - p0[1]) * k / 3)
        if b[0] == '!': c2 = p2
        else: c2 = (p2[0] - (p3[0] - p1[0]) * k / 3, p2[1] - (p3[1] - p1[1]) * k / 3)
        d += f' C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}'
    return d + ' Z'
ocean = '<linearGradient id="oc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4cc3d3"/><stop offset=".5" stop-color="#1a74b4"/><stop offset="1" stop-color="#0a2c57"/></linearGradient>'
rays = '<linearGradient id="ry" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
RAYS = ''.join(f'<path d="M{a} 0 L{a+w} 0 L{a+w+t} 70 L{a+t} 70 Z" fill="url(#ry)"/>' for a, w, t in [(30, 5, -10), (46, 4, -6), (60, 6, -2), (74, 3, 2)])
PTS = [
 ('!', (9, 29)),                                   # near wingtip, curling up
 ('', (19, 37)), ('', (32, 44)), ('', (45, 46.5)),
 ('!', (51, 45)), ('', (52, 35)), ('!', (54, 17)),  # far wing, swept back
 ('', (62, 28)), ('', (69, 37)), ('', (75, 41.5)),
 ('', (81, 41)), ('', (86.5, 39.5)), ('', (89, 41.5)), ('', (86, 44.5)), ('!', (83.5, 46)),   # upper horn (rounded)
 ('', (86.5, 50)), ('', (89, 53.5)), ('', (86, 55.5)), ('', (81, 54)),                     # lower horn
 ('', (75, 58.5)), ('', (64, 63)), ('', (52, 63.5)),
 ('', (39, 59)), ('', (27, 50.5)), ('', (17, 40)),
]
BODY = smooth(PTS, 1.0)
BELLY = 'M50 62.6 C60 63.4 70 61 78.6 56.4'
TAIL = 'M47 62 C41 68 33 72 22 72.5'
def badge(fill, rot=-10, belly='#d8ecf1', rays_on=True):
    clip = '<clipPath id="cl"><circle cx="50" cy="50" r="49"/></clipPath>'
    b = f'<path d="{BELLY}" fill="none" stroke="{belly}" stroke-width="2.2" stroke-linecap="round"/>' if belly else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>{ocean}{rays}{clip}</defs>'
            f'<circle cx="50" cy="50" r="49" fill="url(#oc)"/><g clip-path="url(#cl)">{RAYS if rays_on else ""}</g>'
            f'<g transform="rotate({rot} 50 50) translate(0 3)"><path d="{TAIL}" fill="none" stroke="{fill}" stroke-width="1.8" stroke-linecap="round"/><path d="{BODY}" fill="{fill}"/>{b}</g></svg>')

if __name__ == '__main__':
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'logo.svg')
    open(path, 'w').write(badge('#0b1a2e', -12))
    print('wrote web/logo.svg')
