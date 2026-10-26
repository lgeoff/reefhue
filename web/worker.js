// One engine per worker. The pool sends bands of rows (colour correction,
// optionally returning their brightness for backscatter detection), whole
// detection jobs, and bands to fill specks in.
import { Engine } from './engine.js';

let eng = null;
let job = -1;

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      eng = await Engine.load(m.wasm || new URL('engine.wasm', import.meta.url));
      self.postMessage({ type: 'ready' });
      return;
    }
    if (m.type === 'rows') {
      if (m.settings) { eng.begin(m.settings, m.thumb, m.tw, m.th); job = m.job; }
      if (job !== m.job) throw new Error('band without settings');
      const t0 = performance.now();
      const px = new Uint8ClampedArray(m.buf);
      eng.rows(px, m.w, m.rows, m.y0, m.fullH);
      // brightness for backscatter detection: half resolution of a full-size
      // band, or as is when the image is already at half resolution
      const l = m.luma === 'half' ? eng.lumaHalf(px, m.w, m.rows) : m.luma === 'full' ? eng.luma(px) : null;
      const out = { type: 'rows', buf: m.buf, ms: performance.now() - t0 };
      if (l) out.l = l.buffer;
      self.postMessage(out, l ? [m.buf, l.buffer] : [m.buf]);
      return;
    }
    if (m.type === 'detect') {
      const r = eng.detectSpecks(new Uint8Array(m.l), m.w2, m.h2, m.maxdim, m.sens);
      self.postMessage({ type: 'detect', mask: r.mask.buffer, blobs: r.blobs.buffer, count: r.count }, [r.mask.buffer, r.blobs.buffer]);
      return;
    }
    if (m.type === 'fill') {
      const px = new Uint8ClampedArray(m.buf);
      eng.fillSpecks(px, m.w, m.rows, new Uint8Array(m.mask2), m.w2, m.h2, m.y2, m.oy, m.sp, m.yLo, m.yHi);
      self.postMessage({ type: 'fill', buf: m.buf }, [m.buf]);
      return;
    }
    throw new Error(`unknown message ${m.type}`);
  } catch (e) {
    self.postMessage({ type: 'error', error: String(e?.message || e) });
  }
};
