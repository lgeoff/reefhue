// A pool of workers, each with its own copy of the engine, so big photos are
// processed on every CPU core. Work goes through one queue: whichever worker
// is free takes the next task. Pixel buffers are transferred, not copied.
// Results are identical to processing on one core.
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
  constructor(workers) {
    this.slots = workers.map((w) => ({ w, task: null, job: -1 }));
    this.size = workers.length;
    this.queue = [];
    for (const s of this.slots) {
      s.w.onmessage = ({ data }) => this._done(s, data);
      // a worker that dies (e.g. out of memory) fails its task instead of stalling it
      s.w.onerror = (e) => { e.preventDefault?.(); this._done(s, { type: 'error', error: e.message || 'worker crashed' }); s.job = -1; };
    }
  }

  /**
   * Queue one message for the next free worker; resolves with its reply.
   * `init` ({job, data}) is merged into the message when that worker hasn't
   * seen `job` yet (settings for a run of bands).
   */
  submit(msg, transfer = [], init = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({ msg, transfer, init, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    for (const s of this.slots) {
      if (s.task || !this.queue.length) continue;
      const t = this.queue.shift();
      s.task = t;
      let m = t.msg;
      if (t.init && s.job !== t.init.job) { m = { ...m, ...t.init.data }; s.job = t.init.job; }
      try { s.w.postMessage(m, t.transfer); } catch (e) { s.task = null; t.reject(e); }
    }
  }

  _done(s, data) {
    const t = s.task;
    s.task = null;
    if (t) {
      if (data.type === 'error') { s.job = -1; t.reject(new Error(data.error)); } else t.resolve(data);
    }
    this._pump();
  }

  /**
   * Colour-correct an image band by band. read(y, rows) -> ImageData and
   * write(imageData, y, brightness) run on this thread. `luma` ('half' or
   * 'full') also returns each band's brightness for backscatter detection;
   * bands then have an even number of rows.
   */
  async run({ settings, thumb, tw, th, w, h, band, read, write, onProgress, luma = null }) {
    const job = nextJob++;
    const init = { job, data: { settings, thumb, tw, th } };
    if (luma === 'half') band += band & 1;
    const bands = [];
    for (let y = 0; y < h; y += band) bands.push([y, Math.min(band, h - y)]);
    let next = 0, done = 0, failed = false, inflight = 0;
    await new Promise((resolve, reject) => {
      const feed = () => {
        // a few bands per worker in flight: enough to keep them busy, little memory
        while (!failed && next < bands.length && inflight < this.size * 2) {
          const [y0, rows] = bands[next++];
          let img;
          try { img = read(y0, rows); } catch (e) { failed = true; reject(e); return; }
          inflight++;
          this.submit({ type: 'rows', job, buf: img.data.buffer, w, rows, y0, fullH: h, luma }, [img.data.buffer], init).then((d) => {
            inflight--;
            if (failed) return;
            this.engineMs = (this.engineMs || 0) + (d.ms || 0);
            write(new ImageData(new Uint8ClampedArray(d.buf), w, rows), y0, d.l ? new Uint8Array(d.l) : null);
            done++;
            onProgress?.(done / bands.length);
            if (done === bands.length) resolve(); else feed();
          }).catch((e) => { inflight--; if (!failed) { failed = true; reject(e); } });
        }
      };
      feed();
    });
  }
}
