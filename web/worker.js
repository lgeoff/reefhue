// One engine per worker: processes bands of rows for the pool in pool.js.
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
      // settings and the analysis thumbnail come with a worker's first band of a job
      if (m.settings) { eng.begin(m.settings, m.thumb, m.tw, m.th); job = m.job; }
      if (job !== m.job) throw new Error('band without settings');
      const t0 = performance.now();
      eng.rows(new Uint8ClampedArray(m.buf), m.w, m.rows, m.y0, m.fullH);
      self.postMessage({ type: 'rows', id: m.id, buf: m.buf, ms: performance.now() - t0 }, [m.buf]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, error: String(e?.message || e) });
  }
};
