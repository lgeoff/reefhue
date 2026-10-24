// Usage: node run_engine.mjs <in.rgba> <width> <height> <out.rgba> [preset] [metrics.json]
// Runs the real engine.wasm with the same auto/preset logic as the web app.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Engine, buildSettings, PRESETS } from '../web/engine.js';

const [inp, w, h, outp, presetName = 'auto', metricsOut] = process.argv.slice(2);
const W = +w, H = +h;
const wasm = readFileSync(fileURLToPath(new URL('../web/engine.wasm', import.meta.url)));
const eng = await Engine.load(wasm);
const src = new Uint8ClampedArray(readFileSync(inp));
const p = PRESETS[presetName];

// Same as the app: analyse a <=256 px thumbnail (nearest-neighbour here).
const scale = Math.min(1, 256 / Math.max(W, H));
const tw = Math.max(1, Math.round(W * scale)), th = Math.max(1, Math.round(H * scale));
const thumb = new Uint8ClampedArray(tw * th * 4);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
  const sx = Math.min(W - 1, Math.floor(x / scale)), sy = Math.min(H - 1, Math.floor(y / scale));
  thumb.set(src.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * tw + x) * 4);
}
const t0 = performance.now();
const auto = eng.analyze(thumb, tw, th, p.red / 100, p.balance / 100);
const out = eng.process(src, W, H, buildSettings(auto, p));
const ms = performance.now() - t0;
writeFileSync(outp, out);
if (metricsOut) {
  const strip = (m) => ({ ...m, hist: undefined });
  writeFileSync(metricsOut, JSON.stringify({ ms, before: strip(eng.metrics(src, W, H)), after: strip(eng.metrics(out, W, H)), auto: Array.from(auto) }));
}
