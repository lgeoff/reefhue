// A pool of workers, each with its own copy of the engine, so big photos are
// processed on every CPU core. Bands of rows are handed out as workers free
// up and their pixel buffers are transferred, not copied. The result is
// identical to processing on one core (same settings, same thumbnail grid).
// Where workers can't start (single-file build, old browsers) callers fall
// back to the main thread.

let poolPromise = null;

export function cores() {
  return Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));
}

function startWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('worker did not start')); }, 15000);
    w.onmessage = ({ data }) => {
      if (data.type === 'ready') { clearTimeout(timer); w.onmessage = null; resolve(w); }
      else if (data.type === 'error') { clearTimeout(timer); w.terminate(); reject(new Error(data.error)); }
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'worker failed')); };
    const wasm = globalThis.REEFHUE_WASM_B64 ? Uint8Array.from(atob(globalThis.REEFHUE_WASM_B64), (c) => c.charCodeAt(0)) : null;
    w.postMessage({ type: 'init', wasm });
  });
}

/** The shared pool, or null when workers aren't available here. */
export function getPool() {
  poolPromise ||= (async () => {
    if (typeof Worker === 'undefined' || globalThis.REEFHUE_NO_WORKERS) return null;
    const n = cores();
    const workers = (await Promise.allSettled(Array.from({ length: n }, startWorker))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!workers.length) { console.info('[reefhue] workers unavailable, processing on one core'); return null; }
    console.info(`[reefhue] ${workers.length} worker${workers.length > 1 ? 's' : ''} ready`);
    return new Pool(workers);
  })().catch(() => null);
  return poolPromise;
}

let nextJob = 1;
class Pool {
  constructor(workers) { this.workers = workers.map((w) => ({ w, job: -1 })); this.size = workers.length; }

  /**
   * Process an image band by band.
   * read(y, rows) -> ImageData, write(imageData, y): run on this thread.
   */
  run({ settings, thumb, tw, th, w, h, band, read, write, onProgress }) {
    const job = nextJob++;
    const bands = [];
    for (let y = 0; y < h; y += band) bands.push([y, Math.min(band, h - y)]);
    let next = 0, done = 0, failed = null;
    return new Promise((resolve, reject) => {
      const feed = (slot) => {
        if (failed) return;
        if (next >= bands.length) return;
        const [y0, rows] = bands[next++];
        const img = read(y0, rows);
        const first = slot.job !== job;
        slot.job = job;
        const id = `${job}:${y0}`;
        slot.w.onmessage = ({ data }) => {
          if (failed) return; // a band failed elsewhere: ignore late results
          if (data.type === 'error') { failed = new Error(data.error); slot.job = -1; reject(failed); return; }
          try {
            write(new ImageData(new Uint8ClampedArray(data.buf), w, rows), y0);
            this.engineMs = (this.engineMs || 0) + (data.ms || 0);
            done++; // not inside onProgress?.(): that would skip the count when there's no callback
            onProgress?.(done / bands.length);
            if (done === bands.length) resolve();
            else feed(slot);
          } catch (e) { failed = e; reject(e); }
        };
        const buf = img.data.buffer;
        slot.w.postMessage({ type: 'rows', job, id, buf, w, rows, y0, fullH: h, ...(first ? { settings, thumb, tw, th } : {}) }, [buf]);
      };
      for (const slot of this.workers) {
        // a worker that dies (e.g. out of memory) fails the job instead of stalling it
        slot.w.onerror = (e) => { if (!failed) { failed = new Error(e.message || 'worker crashed'); reject(failed); } };
        try { feed(slot); } catch (e) { failed = e; reject(e); return; }
      }
    });
  }
}
