// Fit Reefhue slider settings to a preset's "after" image.
// Usage: node fit.mjs <before.rgba> <after.rgba> <w> <h> <out.json> [out_auto.rgba out_fit.rgba]
// Inputs are raw RGBA at analysis size (e.g. 300x200). Uses the real engine.wasm.
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, buildSettings, PRESETS, DEFAULTS } from '../../web/engine.js';

const [bp, ap, w, h, outp, autoOut, fitOut] = process.argv.slice(2);
const W = +w, H = +h, N = W * H;
const eng = await Engine.load(readFileSync(new URL('../../web/engine.wasm', import.meta.url)));
const before = new Uint8ClampedArray(readFileSync(bp));
const after = new Uint8ClampedArray(readFileSync(ap));

// ---- CIEDE2000 (Sharma et al. 2005) -------------------------------------
const lin = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
function toLab(rgba) {
  const L = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = lin[rgba[i * 4]], g = lin[rgba[i * 4 + 1]], b = lin[rgba[i * 4 + 2]];
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    L[i * 3] = 116 * fy - 16; L[i * 3 + 1] = 500 * (fx - fy); L[i * 3 + 2] = 200 * (fy - fz);
  }
  return L;
}
const RAD = Math.PI / 180;
function de2000(L1, a1, b1, L2, a2, b2) {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  let h1p = Math.atan2(b1, a1p) / RAD; if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) / RAD; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += h2p + h1p < 360 ? 360 : -360; hbp /= 2; }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * RAD) + 0.24 * Math.cos(2 * hbp * RAD) + 0.32 * Math.cos((3 * hbp + 6) * RAD) - 0.2 * Math.cos((4 * hbp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
const target = toLab(after);
function meanDE(rgba) {
  const L = toLab(rgba);
  let s = 0;
  for (let i = 0; i < N; i++) s += de2000(L[i * 3], L[i * 3 + 1], L[i * 3 + 2], target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
  return s / N;
}

// ---- engine evaluation ---------------------------------------------------
// The app analyses a <=256 px thumbnail; at 300x200 we analyse the image itself.
function render(u) {
  const auto = eng.analyze(before, W, H, u.red / 100, u.balance / 100);
  return eng.process(before, W, H, buildSettings(auto, u));
}
const SPACE = {
  strength: [0, 100], red: [0, 200], balance: [0, 150], dehaze: [0, 200], exposure: [-2, 2],
  contrast: [-100, 100], shadows: [-100, 100], highlights: [-100, 100], temp: [-100, 100], tint: [-100, 100],
  saturation: [-100, 100], vibrance: [-100, 100], water: [-100, 100], clarity: [0, 100],
  ...(process.env.V1 ? {} : { waterHue: [-100, 100], waterLum: [-100, 100] }),
};
const keys = Object.keys(SPACE);
const clampU = (u) => { const o = { ...u }; for (const k of keys) o[k] = Math.min(SPACE[k][1], Math.max(SPACE[k][0], o[k])); return o; };
let evals = 0;
const cost = (u) => { evals++; return meanDE(render(clampU(u))); };

// Pattern search (coordinate descent with shrinking steps) from several starts.
function search(start) {
  let u = clampU(start), best = cost(u);
  let step = 0.25; // fraction of range
  while (step > 0.004) {
    let improved = false;
    for (const k of keys) {
      const span = SPACE[k][1] - SPACE[k][0];
      for (const dir of [1, -1]) {
        const v = { ...u, [k]: u[k] + dir * step * span };
        const c = cost(v);
        if (c < best - 1e-4) { best = c; u = clampU(v); improved = true; break; }
      }
    }
    if (!improved) step /= 2;
  }
  return { u, best };
}

const t0 = Date.now();
const res = { input: meanDE(before) };
const autoU = { ...DEFAULTS };
const autoImg = render(autoU);
res.auto = meanDE(autoImg);
res.presets = {};
let bestFit = null;
for (const [name, p] of Object.entries(PRESETS)) {
  const u = Object.fromEntries(keys.map((k) => [k, p[k] ?? 0]));
  res.presets[name] = cost(u);
}
const starts = Object.entries(res.presets).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([n]) => PRESETS[n]);
for (const s of starts) {
  const r = search(Object.fromEntries(keys.map((k) => [k, s[k] ?? 0])));
  if (!bestFit || r.best < bestFit.best) bestFit = r;
}
res.fit = bestFit.best;
res.fitSettings = Object.fromEntries(keys.map((k) => [k, Math.round(bestFit.u[k] * (k === 'exposure' ? 100 : 1)) / (k === 'exposure' ? 100 : 1)]));
res.evals = evals;
res.seconds = (Date.now() - t0) / 1000;
writeFileSync(outp, JSON.stringify(res, null, 1));
if (autoOut) writeFileSync(autoOut, autoImg);
if (fitOut) writeFileSync(fitOut, render(clampU(bestFit.u)));
console.log(JSON.stringify({ input: res.input.toFixed(2), auto: res.auto.toFixed(2), fit: res.fit.toFixed(2), evals, s: res.seconds }));
