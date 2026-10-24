// Benchmark + validate the export pipeline in headless Chromium.
// node tests/pipeline/pipe.mjs http://localhost:8000/ <clip under web/> [mode...]
// modes: fast-gpu fast-cpu compat-gpu compat-cpu; writes the outputs to ./
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [base, clip, ...modes] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => { if (!/ERR_TUNNEL/.test(m.text())) console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(base + 'index.html');
await page.waitForFunction(() => window.reefhue?.eng, null, { timeout: 30000 });
for (const mode of modes.length ? modes : ['fast-gpu']) {
  const r = await page.evaluate(async ({ clip, mode }) => {
    const { Engine, DEFAULTS } = await import('./engine.js');
    const { GpuRenderer } = await import('./gpu.js');
    const { exportVideo } = await import('./pipeline.js');
    const eng = await Engine.load('engine.wasm');
    const gpu = mode.endsWith('gpu') ? GpuRenderer.create() : null;
    const blob = await (await fetch(clip)).blob();
    const file = new File([blob], clip.split('/').pop(), { type: blob.type });
    let last = null;
    const res = await exportVideo({ file, eng, gpu, user: { ...DEFAULTS }, locked: null, opts: { forceCompat: mode.startsWith('compat'), fps: 30 }, onProgress: (p) => { last = p; } });
    const buf = new Uint8Array(await res.blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    window.__out = btoa(s);
    return { ...res.info, bytes: res.blob.size, renderer: gpu ? 'webgl2' : 'wasm' };
  }, { clip, mode });
  console.log(mode, JSON.stringify(r));
  const b64 = await page.evaluate(() => window.__out);
  writeFileSync(`./${mode}.${r.container}`, Buffer.from(b64, 'base64'));
}
await browser.close();
