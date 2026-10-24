"""Quantitative check of the engine against ground truth.

Takes colour reference photos, simulates underwater capture with an
attenuation + backscatter model (Akkaynak & Treibitz style, per channel),
restores them with the real engine.wasm (auto preset) and reports CIEDE2000
error vs. the original, next to a plain grey-world baseline.

Run:  python3 -I tests/eval.py  (needs numpy, scikit-image, node)
"""
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from skimage import color, data, io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "out")
os.makedirs(OUT, exist_ok=True)

WATERS = {
    # name: (beta per m for R,G,B, backscatter colour, path length m)
    "blue_shallow": ((0.35, 0.07, 0.05), (0.03, 0.22, 0.40), 3),
    "blue_10m": ((0.35, 0.07, 0.05), (0.02, 0.20, 0.38), 8),
    "blue_deep": ((0.40, 0.08, 0.05), (0.01, 0.16, 0.34), 14),
    "green_lake": ((0.45, 0.12, 0.28), (0.05, 0.30, 0.18), 6),
}


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def degrade(img, beta, veil, path):
    lin = srgb_to_lin(img)
    t = np.exp(-np.array(beta) * path)
    tb = np.exp(-np.array(beta) * 2.5)  # backscatter over ~2.5 m horizontal range
    out = lin * t + np.array(veil) ** 2.2 * (1 - tb)
    # camera auto-exposure: put the 99th percentile luminance near 0.9
    lum = out @ np.array([0.2126, 0.7152, 0.0722])
    out = out * (0.8 / max(np.percentile(lum, 99), 1e-3))
    return lin_to_srgb(out)


def grey_world(img):
    m = img.reshape(-1, 3).mean(0)
    return np.clip(img * (m.mean() / m), 0, 1)


def run_engine(img, preset="auto"):
    h, w, _ = img.shape
    rgba = np.concatenate([np.round(img * 255).astype(np.uint8), np.full((h, w, 1), 255, np.uint8)], 2)
    with tempfile.TemporaryDirectory() as d:
        a, b, m = (os.path.join(d, n) for n in ("in.rgba", "out.rgba", "m.json"))
        rgba.tofile(a)
        subprocess.run(["node", os.path.join(ROOT, "tests", "run_engine.mjs"), a, str(w), str(h), b, preset, m], check=True)
        out = np.fromfile(b, np.uint8).reshape(h, w, 4)[..., :3] / 255.0
        return out, json.load(open(m))


def de(a, b):
    return float(color.deltaE_ciede2000(color.rgb2lab(a), color.rgb2lab(b)).mean())


def main():
    refs = {"coffee": data.coffee(), "astronaut": data.astronaut(), "chelsea": data.chelsea()}
    rows = []
    for rname, ref in refs.items():
        ref = ref[..., :3] / 255.0
        for wname, (beta, veil, path) in WATERS.items():
            uw = degrade(ref, beta, veil, path)
            ours, m = run_engine(uw)
            gw = grey_world(uw)
            rows.append((rname, wname, de(uw, ref), de(gw, ref), de(ours, ref), m["before"]["uciqe"], m["after"]["uciqe"], m["ms"]))
            strip = np.concatenate([uw, ours, ref], 1)
            io.imsave(os.path.join(OUT, f"{rname}_{wname}.jpg"), (strip * 255).astype(np.uint8), quality=88)
    print(f"{'image':10} {'water':13} {'ΔE input':>9} {'ΔE greyw':>9} {'ΔE ours':>8} {'UCIQE in→out':>14} {'ms':>6}")
    for r in rows:
        print(f"{r[0]:10} {r[1]:13} {r[2]:9.1f} {r[3]:9.1f} {r[4]:8.1f} {r[5]:7.3f}→{r[6]:.3f} {r[7]:6.1f}")
    arr = np.array([r[2:5] for r in rows])
    print("mean ΔE2000  input %.1f   grey-world %.1f   reefhue %.1f" % tuple(arr.mean(0)))


if __name__ == "__main__":
    sys.exit(main())
