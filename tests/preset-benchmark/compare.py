"""Compare Reefhue with published preset before/after pairs.

For each pair:
  input   ΔE2000(before, preset after)       how big the preset's edit is
  auto    ΔE2000(Reefhue Auto, preset after)
  fit     ΔE2000(Reefhue best-fit sliders, preset after)
  lut     ΔE2000(best *global* colour mapping, preset after)  - ceiling for any
          position-independent tool (3D LUT fitted on the pair itself)
Also: highlight cast and UCIQE of each result, and a visual strip.

The example images are not included (they belong to their authors). Put the
before/after pairs from https://thepresetsroom.com/free-lightroom-presets/underwater/
(…/wp-content/uploads/2022/11/<Name>_a.jpg = before, _b.jpg = after) into
./presets as tpr_<Name>_a.jpg / tpr_<Name>_b.jpg, then run:
    python3 -I tests/preset-benchmark/compare.py
Set V1=1 to search only the original 14 sliders (no water hue/brightness).
"""
import json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image
from skimage import color

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 300, 200
PAIRS = [("Ocean Lights", "tpr_Ocean_Lights"), ("Diving Close-up", "tpr_Diving_close-up"), ("Maldives Islands", "tpr_Maldives_Islands")]
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)


def load(p):
    return np.asarray(Image.open(p).convert("RGB").resize((W, H), Image.LANCZOS))


def rgba(a):
    return np.concatenate([a, np.full(a.shape[:2] + (1,), 255, np.uint8)], 2)


def de(a, b):
    return float(color.deltaE_ciede2000(color.rgb2lab(a / 255.0), color.rgb2lab(b / 255.0)).mean())


def lut_ceiling(src, dst, bins=12):
    """Best position-independent mapping: average target colour per source-colour bin."""
    s = src.reshape(-1, 3).astype(np.int32) * bins // 256
    idx = s[:, 0] * bins * bins + s[:, 1] * bins + s[:, 2]
    d = dst.reshape(-1, 3).astype(np.float64)
    sums = np.zeros((bins ** 3, 3)); cnt = np.zeros(bins ** 3)
    np.add.at(sums, idx, d); np.add.at(cnt, idx, 1)
    mapped = (sums[idx] / cnt[idx, None]).reshape(src.shape)
    return np.clip(mapped, 0, 255).astype(np.uint8)


def highlight_cast(a):
    lab = color.rgb2lab(a / 255.0).reshape(-1, 3)
    top = lab[lab[:, 0] >= np.percentile(lab[:, 0], 80)]
    return float(np.hypot(top[:, 1].mean(), top[:, 2].mean()))


def main():
    rows, strips = [], []
    for title, stem in PAIRS:
        b = load(os.path.join(HERE, "presets", stem + "_a.jpg"))
        a = load(os.path.join(HERE, "presets", stem + "_b.jpg"))
        with tempfile.TemporaryDirectory() as d:
            pb, pa, pj, po, pf = (os.path.join(d, n) for n in ("b", "a", "j", "o", "f"))
            rgba(b).tofile(pb); rgba(a).tofile(pa)
            subprocess.run(["node", os.path.join(HERE, "fit.mjs"), pb, pa, str(W), str(H), pj, po, pf], check=True)
            r = json.load(open(pj))
            ours = np.fromfile(po, np.uint8).reshape(H, W, 4)[..., :3]
            fit = np.fromfile(pf, np.uint8).reshape(H, W, 4)[..., :3]
        lut = lut_ceiling(b, a)
        r.update(title=title, check_input=de(b, a), check_auto=de(ours, a), check_fit=de(fit, a), lut=de(lut, a),
                 cast={k: highlight_cast(v) for k, v in (("before", b), ("preset", a), ("auto", ours), ("fit", fit))})
        rows.append(r)
        strips.append(np.concatenate([b, a, ours, fit], 1))
        json.dump(rows, open(os.path.join(OUT, "compare.json"), "w"), indent=1)
    Image.fromarray(np.concatenate(strips, 0)).save(os.path.join(OUT, "compare.jpg"), quality=90)
    print(f"{'preset':18} {'edit size':>9} {'Auto':>6} {'best fit':>8} {'global ceiling':>14}   highlight cast before/preset/auto/fit")
    for r in rows:
        c = r["cast"]
        print(f"{r['title']:18} {r['input']:9.1f} {r['auto']:6.1f} {r['fit']:8.1f} {r['lut']:14.1f}   "
              f"{c['before']:.0f}/{c['preset']:.0f}/{c['auto']:.0f}/{c['fit']:.0f}")
        print("   fit settings:", r["fitSettings"])


if __name__ == "__main__":
    sys.exit(main())
