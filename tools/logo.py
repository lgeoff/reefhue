"""Generates web/logo.svg: a manta ray whose tail turns into the looping
red-orange-yellow trail of a flip. Run: python3 tools/logo.py
PNG icons (web/icon-180.png, icon-512.png) are rendered from it with a browser."""
import re
# left half, head up; slimmer, swept-back pointed wings
HALF = [('M',[(0,-16)]),('C',[(-2,-16.5),(-4,-16.5),(-5.5,-16.5)]),('C',[(-6.5,-19),(-6.8,-22.5),(-5.5,-26)]),
        ('C',[(-8.5,-24.5),(-10.5,-21),(-10.5,-16)]),('C',[(-23,-15),(-38,-5),(-49,13)]),
        ('C',[(-39,5),(-27,4),(-16,11)]),('C',[(-11.5,14.5),(-8.5,20),(-6,22.5)]),('C',[(-4.5,25.5),(-2.5,26.5),(0,26.5)])]
CHEV = [('M',[(-9,-11)]),('C',[(-16,-11.5),(-25,-7),(-31,0)]),('C',[(-25,-1.5),(-19,0),(-14.5,3.5)]),('C',[(-13.5,-1),(-11.5,-6.5),(-9,-11)])]
def fmt(segs, f=lambda p:p):
    return ' '.join(c+' '+' '.join('%.2f %.2f'%f(p) for p in ps) for c,ps in segs)
def body(rk=1.0, rdy=0.0):
    # right half = mirrored left, x scaled by rk (wing turned away = foreshortened), lifted by rdy at the tip
    left = fmt(HALF)
    segs=[]; last=HALF[0][1][0]
    for c,ps in HALF[1:]: segs.append((c,last,ps)); last=ps[-1]
    rev=[]
    for c,start,ps in reversed(segs): rev.append((c,[ps[1],ps[0],start]))
    f=lambda p:(-p[0]*rk, p[1]+rdy*abs(p[0])/49)
    return left+' '+fmt(rev,f)+' Z'
def chev_r(rk,rdy): return fmt(CHEV, lambda p:(-p[0]*rk, p[1]+rdy*abs(p[0])/49))+' Z'
TAIL="M0 25 C0.3 34 -1 42 1.5 50"
def manta(fill, rot, tx, ty, s, marks=None, rk=1.0, rdy=0.0):
    m=f'<g transform="translate({tx} {ty}) rotate({rot}) scale({s})"><path d="{TAIL}" fill="none" stroke="{fill}" stroke-width="2.8" stroke-linecap="round"/><path d="{body(rk,rdy)}" fill="{fill}"/>'
    if marks: m+=f'<path d="{fmt(CHEV)} Z" fill="{marks}"/><path d="{chev_r(rk,rdy)}" fill="{marks}"/>'
    return m+'</g>'
spectral='<linearGradient id="sp" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff5d4f" stop-opacity="0"/><stop offset=".35" stop-color="#ff5d4f"/><stop offset=".7" stop-color="#f08a2c"/><stop offset="1" stop-color="#f2d23a"/></linearGradient>'
ocean='<linearGradient id="oc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fb5c8"/><stop offset=".55" stop-color="#1667a8"/><stop offset="1" stop-color="#0b2f5c"/></linearGradient>'
arc='<path d="M27 80 A34 34 0 1 1 73 80" fill="none" stroke="url(#sp)" stroke-width="6" stroke-linecap="round"/>'
def badge(m, a=arc): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>{ocean}{spectral}</defs><circle cx="50" cy="50" r="49" fill="url(#oc)"/>{a}{m}</svg>'
W="#f4f1ea"

import math
def lerp(a,b,t): return tuple(a[i]+(b[i]-a[i])*t for i in range(len(a)))
STOPS=[(0,(242,210,58,1)),(0.3,(240,138,44,1)),(0.6,(255,93,79,1)),(1,(255,93,79,1))]
def col(t):
    for (t0,c0),(t1,c1) in zip(STOPS,STOPS[1:]):
        if t<=t1: return lerp(c0,c1,(t-t0)/(t1-t0))
    return STOPS[-1][1]
def loop(cx,cy,r,a0,a1,w,n=36):
    out=''
    for i in range(n):
        t0=i/n; t1=(i+1.15)/n
        A0=math.radians(a0+(a1-a0)*t0); A1=math.radians(a0+(a1-a0)*min(1,t1))
        x0,y0=cx+r*math.cos(A0),cy+r*math.sin(A0); x1,y1=cx+r*math.cos(A1),cy+r*math.sin(A1)
        c=col((i+.5)/n)
        out+=f'<path d="M{x0:.2f} {y0:.2f} A{r} {r} 0 0 0 {x1:.2f} {y1:.2f}" fill="none" stroke="rgb({c[0]:.0f},{c[1]:.0f},{c[2]:.0f})" stroke-opacity="{c[3]:.2f}" stroke-width="{w}" stroke-linecap="{'round' if i==0 else 'butt'}"/>'
    return out
def logo(fill, marks=None, s=0.55, ty=40, r=37, w=5.5, start=62, sweep=300):
    mx=manta(fill,0,50,ty,s,marks).replace(f'<path d="{TAIL}"','<path d="M0 0"')
    tb=ty+25*s
    jx,jy=50+r*math.cos(math.radians(start)),50+r*math.sin(math.radians(start))
    tail=f'<path d="M50 {tb:.1f} C50 {tb+12:.1f} {jx-12:.1f} {jy+2:.1f} {jx:.1f} {jy:.1f}" fill="none" stroke="url(#tl)" stroke-width="{w*0.6:.2f}" stroke-linecap="round"/>'
    grad=f'<linearGradient id="tl" gradientUnits="userSpaceOnUse" x1="50" y1="{tb:.1f}" x2="{jx:.1f}" y2="{jy:.1f}"><stop offset="0" stop-color="{fill}"/><stop offset="1" stop-color="#f2d23a"/></linearGradient>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>{ocean}{grad}<linearGradient id="fg" gradientUnits="userSpaceOnUse" x1="0" y1="34" x2="0" y2="86"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="url(#fg)"/><rect x="47" y="0" width="53" height="100" fill="#fff"/><rect x="0" y="0" width="100" height="34" fill="#fff"/></mask></defs><circle cx="50" cy="50" r="49" fill="url(#oc)"/><g mask="url(#fade)">{loop(50,50,r,start,start-sweep,w)}</g>{tail}{mx}</svg>'

import os
open(os.path.join(os.path.dirname(__file__), "..", "web", "logo.svg"), "w").write(logo(W))
print("wrote web/logo.svg")
