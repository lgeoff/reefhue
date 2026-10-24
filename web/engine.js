// Thin JS wrapper around engine.wasm (Rust, no_std). Works in browsers, workers and Node.
// The page owns memory: buffers are placed above __heap_base and memory grows on demand.

export const NPARAMS = 40;
export const METRICS_LEN = 16 + 768;
export const GPU_LEN = 32;
export const TONE_N = 2048;
const THUMB_BYTES = 256 * 256 * 4;

// Settings-vector slots, mirrored from engine/src/lib.rs
export const S = {
  STRENGTH: 0, KRED: 1, DONOR_G: 2, KBLUE: 3, GAIN: 4, BLACK: 7, WHITE: 10,
  DEHAZE: 13, EXPOSURE: 14, CONTRAST: 15, SHADOWS: 16, HIGHLIGHTS: 17,
  SATURATION: 18, VIBRANCE: 19, CLARITY: 20, WATER_SAT: 21, TEMP: 22, TINT: 23,
  MEAN: 24, GREEN_WATER: 27, OUT_LUMA: 28, VEIL_REF: 29, WATER_HUE: 31, WATER_LUM: 32,
};

// Slots produced by analyze() that video smoothing should average over time.
export const AUTO_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 29];

export class Engine {
  static async load(source) {
    let bytes = source;
    if (typeof source === 'string' || source instanceof URL) {
      bytes = await (await fetch(source)).arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Engine(instance);
  }

  constructor(instance) {
    this.x = instance.exports;
    if (this.x.layout_version() !== NPARAMS * 1000 + METRICS_LEN) {
      throw new Error('engine.wasm does not match engine.js (rebuild the engine)');
    }
    this.mem = this.x.memory;
    const base = (this.x.__heap_base.value + 15) & ~15;
    this.pParams = base; // NPARAMS f32
    this.pGpu = base + 256; // GPU_LEN f32
    this.pOut = base + 512; // METRICS_LEN f32
    this.pT = (this.pOut + METRICS_LEN * 4 + 255) & ~255; // thumbnail (<=256x256)
    this.pA = this.pT + THUMB_BYTES; // image buffer A
    this.capacity = 0; // bytes per image buffer
    this._reserve(1 << 20);
  }

  _reserve(bytes) {
    if (bytes <= this.capacity) return;
    const cap = Math.ceil(bytes / 65536) * 65536;
    const end = this.pA + cap * 2;
    const have = this.mem.buffer.byteLength;
    if (end > have) this.mem.grow(Math.ceil((end - have) / 65536));
    this.capacity = cap;
    this.pB = this.pA + cap;
  }

  get u8() { return new Uint8Array(this.mem.buffer); }
  get f32() { return new Float32Array(this.mem.buffer); }

  /** Auto-correction estimate for an RGBA buffer (ideally a <=256 px thumbnail). */
  analyze(rgba, w, h, alpha = 1, wb = 1) {
    this._reserve(rgba.length);
    this.u8.set(rgba, this.pA);
    this.x.analyze(this.pA, w, h, alpha, wb, this.pParams);
    return this.f32.slice(this.pParams / 4, this.pParams / 4 + NPARAMS);
  }

  /** prepare() + clarity grid from the thumbnail (or from the image itself). */
  _prepare(settings, thumb, tw, th) {
    this.f32.set(settings, this.pParams / 4);
    this.x.prepare(this.pParams);
    if (thumb) {
      if (thumb.length > THUMB_BYTES) throw new Error('thumbnail larger than 256x256');
      this.u8.set(thumb, this.pT);
      this.x.build_grid(this.pT, tw, th);
    }
  }

  /**
   * Apply a full settings vector. Returns a Uint8ClampedArray (or fills `out`).
   * Pass the analysis thumbnail so clarity uses the same grid as the GPU path.
   */
  process(rgba, w, h, settings, out, thumb, tw, th) {
    const n = w * h * 4;
    this._reserve(n);
    this._prepare(settings, thumb, tw, th);
    this.u8.set(rgba, this.pA);
    this.x.process(this.pA, this.pB, w, h);
    const res = out || new Uint8ClampedArray(n);
    res.set(this.u8.subarray(this.pB, this.pB + n));
    return res;
  }

  /**
   * Strip processing for very large photos: begin() once, then rows() per
   * strip. Keeps memory to one strip instead of two full-size copies.
   */
  begin(settings, thumb, tw, th) { this._prepare(settings, thumb, tw, th); }
  rows(rgba, w, rows, y0, fullH) {
    const n = w * rows * 4;
    this._reserve(n);
    this.u8.set(rgba, this.pA);
    this.x.process_rows(this.pA, this.pB, w, rows, y0, fullH);
    rgba.set(this.u8.subarray(this.pB, this.pB + n));
    return rgba;
  }

  /**
   * Everything the WebGL renderer needs for one frame: derived constants,
   * the tone curve and the clarity grid, all computed by the Rust engine.
   */
  gpuFrame(settings, thumb, tw, th) {
    this._prepare(settings, thumb, tw, th);
    this.x.gpu_params(this.pGpu);
    const f = this.f32;
    const params = f.slice(this.pGpu / 4, this.pGpu / 4 + GPU_LEN);
    const tp = this.x.tone_lut() / 4;
    const gp = this.x.grid_data() / 4;
    const gw = params[25], gh = params[26];
    return { params, tone: f.slice(tp, tp + TONE_N), grid: f.slice(gp, gp + gw * gh), gw, gh };
  }

  /** Quality metrics; samples ~`samples` pixels. */
  metrics(rgba, w, h, samples = 120000) {
    const n = w * h;
    this._reserve(rgba.length);
    this.u8.set(rgba, this.pA);
    const step = Math.max(1, Math.floor(n / samples)) | 1; // odd: avoid sampling one column
    this.x.metrics(this.pA, w, h, step, this.pOut);
    const o = this.f32.slice(this.pOut / 4, this.pOut / 4 + METRICS_LEN);
    return {
      meanL: o[0], stdL: o[1], a: o[2], b: o[3], cast: o[4], colorfulness: o[5],
      uciqe: o[6], clipped: o[7], saturation: o[8], stdChroma: o[9], rangeL: o[10],
      frameA: o[14], frameB: o[15],
      mean: [o[11], o[12], o[13]], hist: o.slice(16, 16 + 768),
    };
  }
}

/**
 * Merge the automatic estimate with the user's slider values into the
 * settings vector consumed by `process`. Slider values use UI units.
 */
export function buildSettings(auto, u) {
  const s = new Float32Array(NPARAMS);
  s.set(auto);
  s[S.STRENGTH] = u.strength / 100;
  s[S.DEHAZE] = u.dehaze / 100;
  s[S.EXPOSURE] = u.exposure;
  s[S.CONTRAST] = u.contrast / 100;
  s[S.SHADOWS] = u.shadows / 100;
  s[S.HIGHLIGHTS] = u.highlights / 100;
  s[S.SATURATION] = u.saturation / 100;
  s[S.VIBRANCE] = u.vibrance / 100;
  s[S.CLARITY] = u.clarity / 100;
  s[S.WATER_SAT] = u.water / 100;
  s[S.TEMP] = u.temp / 100;
  s[S.TINT] = u.tint / 100;
  s[S.WATER_HUE] = (u.waterHue ?? 0) / 100;
  s[S.WATER_LUM] = (u.waterLum ?? 0) / 100;
  return s;
}

/**
 * Temporal smoothing of the auto estimate for video (time constant `tau` s).
 * `state` = {smooth, lastT}; returns the smoothed vector.
 */
export function smoothAuto(raw, t, state, tau = 0.7) {
  if (state.smooth && state.lastT != null) {
    const dt = Math.abs(t - state.lastT);
    if (dt > 0 && dt < 1) {
      const a = 1 - Math.exp(-dt / tau);
      const next = raw.slice();
      for (const k of AUTO_SLOTS) next[k] = state.smooth[k] + a * (raw[k] - state.smooth[k]);
      state.smooth = next;
    } else if (dt >= 1) state.smooth = raw;
  } else state.smooth = raw;
  state.lastT = t;
  return state.smooth;
}

/** Slider defaults and presets (UI units). `red` and `balance` feed analyze(). */
export const DEFAULTS = {
  strength: 100, red: 100, balance: 100, dehaze: 100, exposure: 0, contrast: 10,
  shadows: 10, highlights: -10, saturation: 10, vibrance: 20, clarity: 20, water: 0,
  temp: 0, tint: 0, waterHue: 0, waterLum: 0,
};

export const PRESETS = {
  auto: { label: 'Auto', note: 'Balanced restore', ...DEFAULTS },
  shallow: {
    label: 'Shallow', note: '0–5 m', ...DEFAULTS,
    red: 60, balance: 85, dehaze: 80, contrast: 5, vibrance: 15, clarity: 10, water: 10,
  },
  mid: {
    label: 'Mid', note: '5–15 m', ...DEFAULTS,
    red: 110, dehaze: 100, contrast: 12, saturation: 12, vibrance: 22, clarity: 25,
  },
  deep: {
    label: 'Deep', note: '15 m +', ...DEFAULTS,
    red: 150, balance: 110, dehaze: 110, exposure: 0.2, contrast: 15, shadows: 20,
    saturation: 15, vibrance: 25, clarity: 30, water: -20,
  },
  green: {
    label: 'Green water', note: 'Lakes, quarries, coast', ...DEFAULTS,
    red: 120, balance: 110, dehaze: 120, contrast: 15, clarity: 30, water: -10, tint: 15,
  },
  natural: {
    label: 'Natural', note: 'Keep some blue', ...DEFAULTS,
    strength: 80, red: 80, dehaze: 70, contrast: 0, saturation: 0, vibrance: 10, clarity: 10,
  },
  vivid: {
    label: 'Vivid', note: 'Punchy reef colour', ...DEFAULTS,
    contrast: 25, saturation: 25, vibrance: 35, clarity: 45, shadows: 15,
  },
  // Looks: slider settings found by fitting Reefhue to graded examples
  // (tests/preset-benchmark). They are styles, not neutral restoration.
  teal: {
    label: 'Teal matte', note: 'Faded, cool grade', look: true, ...DEFAULTS,
    strength: 76, red: 140, balance: 109, dehaze: 77, exposure: 0, contrast: -22, shadows: 52,
    highlights: 6, temp: -22, tint: 95, saturation: -63, vibrance: -58, water: 83, clarity: 60,
    waterHue: -8, waterLum: 20,
  },
  moody: {
    label: 'Moody blue', note: 'Dark water, clean skin', look: true, ...DEFAULTS,
    strength: 98, red: 184, balance: 27, dehaze: 58, exposure: -0.25, contrast: -4, shadows: -2,
    highlights: -100, temp: -6, tint: 69, saturation: -48, vibrance: -12, water: 100, clarity: 55,
    waterHue: 80, waterLum: -62,
  },
  airy: {
    label: 'Tropical light', note: 'Bright, airy shallows', look: true, ...DEFAULTS,
    strength: 70, red: 3, balance: 131, dehaze: 53, exposure: 0, contrast: 30, shadows: 10,
    highlights: -97, temp: 13, tint: 3, saturation: -52, vibrance: 71, water: -65, clarity: 5,
    waterHue: 84, waterLum: 41,
  },
};
