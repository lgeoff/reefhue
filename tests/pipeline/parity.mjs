// GPU (WebGL2 shader) vs CPU (Rust/WASM) parity on raw pixels, several presets.
// node tests/pipeline/parity.mjs [http://localhost:8000/index.html]
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.argv[2] || 'http://localhost:8765/index.html');
await page.waitForFunction(() => window.reefhue?.eng, null, { timeout: 30000 });
const r = await page.evaluate(async () => {
  const { Engine, DEFAULTS, PRESETS, buildSettings } = await import('./engine.js');
  const { GpuRenderer } = await import('./gpu.js');
  const { thumbSize } = await import('./pipeline.js');
  const eng = await Engine.load('engine.wasm');
  const gpu = GpuRenderer.create();
  const { demoPhoto } = await import('./demo.js');
  const bmp = await createImageBitmap(await demoPhoto());
  const W = bmp.width, H = bmp.height;
  const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  const src = g.getImageData(0, 0, W, H).data;
  const [tw, th] = thumbSize(W, H);
  const tc = new OffscreenCanvas(tw, th); const tg = tc.getContext('2d', { willReadFrequently: true }); tg.drawImage(bmp, 0, 0, tw, th);
  const thumb = tg.getImageData(0, 0, tw, th).data;
  const out = {};
  for (const name of ['auto', 'deep', 'vivid', 'teal', 'moody', 'airy']) {
    const u = { ...DEFAULTS, ...PRESETS[name] };
    const s = buildSettings(eng.analyze(thumb, tw, th, u.red / 100, u.balance / 100), u);
    const cpu = eng.process(src, W, H, s, null, thumb, tw, th);
    // feed the GPU the same decoded pixels the CPU saw
    gpu.render(new ImageData(new Uint8ClampedArray(src), W, H), W, H, eng.gpuFrame(s, thumb, tw, th));
    const gp = gpu.read();
    let max = 0, sum = 0, over1 = 0;
    for (let i = 0; i < cpu.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(cpu[i] - gp[i]); sum += d; if (d > max) max = d; if (d > 1) over1++; }
    out[name] = { max, mean: +(sum / (W * H * 3)).toFixed(4), over1 };
  }
  return { size: `${W}x${H}`, renderer: gpu.gl.getParameter(gpu.gl.RENDERER), out };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
