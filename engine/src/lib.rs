//! Reefhue underwater colour-restoration engine.
//!
//! Plain `no_std` Rust with no dependencies, compiled to `wasm32-unknown-unknown`.
//! The page owns all pixel buffers: it writes RGBA bytes into this module's
//! linear memory (above `__heap_base`) and calls the exported functions with
//! pointers. Nothing here allocates.
//!
//! Pipeline (per pixel, values in 0..1):
//!   1. Red (and in green water, blue) channel compensation from the better
//!      preserved green channel — Ancuti et al. 2018, "Color Balance and Fusion
//!      for Underwater Image Enhancement":  Ir' = Ir + a·(mean(Ig) - mean(Ir))·(1 - Ir)·Ig
//!   2. White balance gains (blend of grey-world and white-patch estimates)
//!   3. Per-channel levels / dehaze: black point removes the blue-green veil
//!      (backscatter), white point restores range (what Dive+ / the
//!      "underwater-image-color-correction" filter matrix does)
//!   4. Temperature / tint trims
//!   5. Clarity (large-radius local contrast)
//!   6. Tone curve LUT: exposure, shadows, highlights, contrast
//!   7. Saturation, vibrance and water-only saturation
//!   8. Strength blend with the original
//!
//! Exports: `analyze`, `prepare`, `process`, `metrics` (see each function).

#![cfg_attr(not(test), no_std)]
#![cfg_attr(minicore, feature(no_core, lang_items, intrinsics, rustc_attrs, auto_traits))]
#![cfg_attr(minicore, no_core)]
#![allow(static_mut_refs)]
#![allow(clippy::missing_safety_doc, clippy::too_many_arguments)]

#[cfg(minicore)]
mod minicore;

mod math;
use math::*;

// ---------------------------------------------------------------- params ----

/// Number of f32 slots in the settings / analysis vector shared with JS.
pub const NPARAMS: usize = 40;

// Settings vector layout (index constants are mirrored in web/engine.js).
const S_STRENGTH: usize = 0;
const S_KRED: usize = 1; // red compensation coefficient a·(mean donor - mean red)
const S_DONOR_G: usize = 2; // weight of green vs blue in the red donor
const S_KBLUE: usize = 3; // blue compensation (green water)
const S_GAIN: usize = 4; // 4,5,6 white-balance gains
const S_BLACK: usize = 7; // 7,8,9 black points
const S_WHITE: usize = 10; // 10,11,12 white points
const S_DEHAZE: usize = 13; // multiplier on black points
const S_EXPOSURE: usize = 14; // EV
const S_CONTRAST: usize = 15; // -1..1
const S_SHADOWS: usize = 16; // -1..1
const S_HIGHLIGHTS: usize = 17; // -1..1
const S_SATURATION: usize = 18; // -1..1
const S_VIBRANCE: usize = 19; // -1..1
const S_CLARITY: usize = 20; // 0..1
const S_WATER_SAT: usize = 21; // -1..1, saturation of blue/cyan water only
const S_TEMP: usize = 22; // -1..1
const S_TINT: usize = 23; // -1..1 (+ = magenta)
// analysis-only outputs
const A_MEAN: usize = 24; // 24,25,26 input means
const A_GREEN_WATER: usize = 27; // 1 when the cast is green rather than blue
const A_OUT_LUMA: usize = 28; // estimated mean luma after correction
const S_VEIL_REF: usize = 29; // subject blue-minus-green, reference for the veil test
const S_WATER_HUE: usize = 31; // -1..1, + turns water towards turquoise, - towards deep blue
const S_WATER_LUM: usize = 32; // -1..1, brightness of blue/cyan water only

static mut P: [f32; NPARAMS] = [0.0; NPARAMS];

const TONE_N: usize = 2048; // tone LUT over input 0..2
static mut TONE: [f32; TONE_N] = [0.0; TONE_N];

const GRID_MAX: usize = 64;
static mut GRID: [f32; GRID_MAX * GRID_MAX] = [0.0; GRID_MAX * GRID_MAX];
static mut GRID_TMP: [f32; GRID_MAX * GRID_MAX] = [0.0; GRID_MAX * GRID_MAX];
static mut GRID_N: [f32; GRID_MAX * GRID_MAX] = [0.0; GRID_MAX * GRID_MAX];
static mut GW: usize = 1;
static mut GH: usize = 1;
static mut GRID_READY: bool = false;

const HBINS: usize = 1024;
static mut HIST: [u32; 3 * HBINS] = [0; 3 * HBINS];

static mut LIN: [f32; 256] = [0.0; 256];
static mut LIN_READY: bool = false;
static mut LHIST: [u32; 1000] = [0; 1000];
static mut LAB_A: [f32; 100] = [0.0; 100];
static mut LAB_B: [f32; 100] = [0.0; 100];
static mut LAB_N: [f32; 100] = [0.0; 100];

// ------------------------------------------------------- memory helpers ----

#[inline(always)]
unsafe fn rd(p: *const u8, i: usize) -> f32 {
    *((p as usize + i) as *const u8) as f32 * (1.0 / 255.0)
}

#[inline(always)]
unsafe fn rd8(p: *const u8, i: usize) -> u8 {
    *((p as usize + i) as *const u8)
}

#[inline(always)]
unsafe fn wr8(p: *mut u8, i: usize, v: u8) {
    *((p as usize + i) as *mut u8) = v;
}

#[inline(always)]
unsafe fn rdf(p: *const f32, i: usize) -> f32 {
    *((p as usize + i * 4) as *const f32)
}

#[inline(always)]
unsafe fn wrf(p: *mut f32, i: usize, v: f32) {
    *((p as usize + i * 4) as *mut f32) = v;
}

#[inline(always)]
fn to_u8(v: f32) -> u8 {
    (v * 255.0 + 0.5) as u8 // float->int `as` saturates
}

unsafe fn hist_clear() {
    let mut i = 0;
    while i < 3 * HBINS {
        HIST[i] = 0;
        i += 1;
    }
}

/// Value at which the cumulative histogram of channel `c` reaches `frac`.
/// `scale` maps bin index back to a value (bin = value * scale).
unsafe fn hist_pct(c: usize, total: u32, frac: f32, scale: f32) -> f32 {
    let target = (total as f32 * frac) as u32;
    let mut acc: u32 = 0;
    let mut i = 0;
    while i < HBINS {
        acc += HIST[c * HBINS + i];
        if acc > target {
            return (i as f32 + 0.5) / scale;
        }
        i += 1;
    }
    (HBINS as f32) / scale
}

#[inline(always)]
fn hbin(v: f32, scale: f32) -> usize {
    let b = (v * scale) as i32;
    if b < 0 {
        0
    } else if b >= HBINS as i32 {
        HBINS - 1
    } else {
        b as usize
    }
}

// ------------------------------------------------------------ analysis ----

/// Red donor signal for one pixel. Mostly green (best preserved channel),
/// minus how far blue exceeds green: in blue water those pixels are mostly
/// backscatter veil, and giving them red is what turns open water purple.
/// (The hue-rotation filter used by Dive+-style tools has the same negative
/// blue term.)
#[inline(always)]
fn donor(wg: f32, g: f32, b: f32, vref: f32) -> f32 {
    let d = wg * g + (1.0 - wg) * b;
    // `vref` is how much bluer than green the textured (subject) pixels are on
    // average; only pixels bluer than that count as veil.
    let veil = b - g - vref;
    if veil > 0.0 {
        fmax(d - VEIL_SUPPRESS * veil, 0.0)
    } else {
        d
    }
}
const VEIL_SUPPRESS: f32 = 2.0;
const BLACK_SHARE: f32 = 0.5;
/// How much of the subjects' own blue excess is tolerated before a pixel counts as veil.
const VEIL_REF_SHARE: f32 = 0.25;

/// Channel compensation of the pixel at byte offset `i` (Ancuti et al. eq. 4/5).
#[inline(always)]
unsafe fn comp(src: *const u8, i: usize, wg: f32, k_red: f32, k_blue: f32, vref: f32, o: &mut [f32; 3]) {
    let r = rd(src, i);
    let g = rd(src, i + 1);
    let b = rd(src, i + 2);
    o[0] = r + k_red * (1.0 - r) * donor(wg, g, b, vref);
    o[1] = g;
    o[2] = b + k_blue * (1.0 - b) * g;
}

/// Estimate the automatic correction for an image (normally a ~256 px
/// thumbnail or a downscaled video frame).
///
/// * `src`   – RGBA bytes, `w`×`h` pixels
/// * `alpha` – red-recovery strength chosen by the user (Ancuti's α, 1 = paper default)
/// * `wb`    – how much of the estimated white balance to apply (0..1.5)
/// * `out`   – NPARAMS f32; fills the auto slots (S_KRED..S_WHITE and A_*)
///
/// Statistics are weighted towards textured pixels. Large smooth areas of open
/// water would otherwise dominate plain channel means, and a grey-world
/// correction then turns the water magenta.
#[no_mangle]
pub unsafe extern "C" fn analyze(src: *const u8, w: u32, h: u32, alpha: f32, wb: f32, out: *mut f32) {
    let w = w as usize;
    let h = h as usize;
    let n = w * h;
    if n == 0 {
        return;
    }

    // pass 1: edge-weighted channel means (weight = luma gradient + floor)
    let mut sr = 0.0f32;
    let mut sg = 0.0f32;
    let mut sb = 0.0f32;
    let mut sw = 0.0f32;
    let mut ur = 0.0f32; // unweighted, for the "red left" readout
    let mut ug = 0.0f32;
    let mut ub = 0.0f32;
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let i = (y * w + x) * 4;
            let r = rd(src, i);
            let g = rd(src, i + 1);
            let b = rd(src, i + 2);
            ur += r;
            ug += g;
            ub += b;
            let l = 0.299 * r + 0.587 * g + 0.114 * b;
            let ix = if x + 1 < w { i + 4 } else { i - 4 };
            let iy = if y + 1 < h { i + w * 4 } else { i - w * 4 };
            let lx = 0.299 * rd(src, ix) + 0.587 * rd(src, ix + 1) + 0.114 * rd(src, ix + 2);
            let ly = 0.299 * rd(src, iy) + 0.587 * rd(src, iy + 1) + 0.114 * rd(src, iy + 2);
            let wt = fabs(lx - l) + fabs(ly - l) + 0.01;
            sr += r * wt;
            sg += g * wt;
            sb += b * wt;
            sw += wt;
            x += 1;
        }
        y += 1;
    }
    let mr = sr / sw;
    let mg = sg / sw;
    let mb = sb / sw;
    let inv_n = 1.0 / n as f32;

    // Red donor: green in green water, a green/blue mix in blue water where
    // green is also attenuated.
    let wg = clamp(mg / (mg + mb + 1e-4) * 2.0, 0.5, 1.0);
    let md = wg * mg + (1.0 - wg) * mb;
    let k_red = alpha * fmax(md - mr, 0.0);
    let green_water = ug > ub * 1.05;
    let k_blue = if green_water { alpha * 0.6 * fmax(mg - mb, 0.0) } else { 0.0 };
    let vref = fmax(mb - mg, 0.0) * VEIL_REF_SHARE;

    // pass 2: grey-edge statistics (mean |gradient| per compensated channel)
    // and histograms for the white patch.
    hist_clear();
    let mut er = 0.0f32;
    let mut eg = 0.0f32;
    let mut eb = 0.0f32;
    let mut cr = 0.0f32;
    let mut cg = 0.0f32;
    let mut cb = 0.0f32;
    let mut c0 = [0.0f32; 3];
    let mut c1 = [0.0f32; 3];
    let mut c2 = [0.0f32; 3];
    y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let i = (y * w + x) * 4;
            comp(src, i, wg, k_red, k_blue, vref, &mut c0);
            cr += c0[0];
            cg += c0[1];
            cb += c0[2];
            HIST[hbin(c0[0], 1023.0)] += 1;
            HIST[HBINS + hbin(c0[1], 1023.0)] += 1;
            HIST[2 * HBINS + hbin(c0[2], 1023.0)] += 1;
            if x + 1 < w && y + 1 < h {
                comp(src, i + 4, wg, k_red, k_blue, vref, &mut c1);
                comp(src, i + w * 4, wg, k_red, k_blue, vref, &mut c2);
                // skip clipped highlights: their colour is not the illuminant's
                if c0[0] < 0.98 && c0[1] < 0.98 && c0[2] < 0.98 {
                    er += fabs(c1[0] - c0[0]) + fabs(c2[0] - c0[0]);
                    eg += fabs(c1[1] - c0[1]) + fabs(c2[1] - c0[1]);
                    eb += fabs(c1[2] - c0[2]) + fabs(c2[2] - c0[2]);
                }
            }
            x += 1;
        }
        y += 1;
    }
    cr *= inv_n;
    cg *= inv_n;
    cb *= inv_n;
    let tot = n as u32;

    // White balance: grey-edge blended with white-patch (99th percentile).
    let e_avg = (er + eg + eb) / 3.0;
    let p99r = fmax(hist_pct(0, tot, 0.99, 1023.0), 0.02);
    let p99g = fmax(hist_pct(1, tot, 0.99, 1023.0), 0.02);
    let p99b = fmax(hist_pct(2, tot, 0.99, 1023.0), 0.02);
    let pmax = fmax(p99r, fmax(p99g, p99b));
    let mut gr = pow(e_avg / fmax(er, 1e-4), 0.6) * pow(pmax / p99r, 0.4);
    let mut gg = pow(e_avg / fmax(eg, 1e-4), 0.6) * pow(pmax / p99g, 0.4);
    let mut gb = pow(e_avg / fmax(eb, 1e-4), 0.6) * pow(pmax / p99b, 0.4);
    gr = clamp(pow(gr, wb), 0.4, 5.0);
    gg = clamp(pow(gg, wb), 0.4, 5.0);
    gb = clamp(pow(gb, wb), 0.4, 5.0);
    // keep overall luminance where it was; levels handle the range
    let lum_in = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    let lum_out = 0.2126 * cr * gr + 0.7152 * cg * gg + 0.0722 * cb * gb;
    let norm = lum_in / fmax(lum_out, 1e-4);
    gr *= norm;
    gg *= norm;
    gb *= norm;

    // pass 3: histogram after gains (0..2) for black/white points
    hist_clear();
    let mut i = 0;
    while i < n {
        comp(src, i * 4, wg, k_red, k_blue, vref, &mut c0);
        HIST[hbin(c0[0] * gr, 511.5)] += 1;
        HIST[HBINS + hbin(c0[1] * gg, 511.5)] += 1;
        HIST[2 * HBINS + hbin(c0[2] * gb, 511.5)] += 1;
        i += 1;
    }
    let mut black = [0.0f32; 3];
    let mut white = [0.0f32; 3];
    let mut c = 0;
    let mut max_range = 0.0f32;
    while c < 3 {
        black[c] = hist_pct(c, tot, 0.004, 511.5);
        white[c] = fmax(hist_pct(c, tot, 0.996, 511.5), 0.2);
        if white[c] - black[c] < 0.08 {
            black[c] = fmax(white[c] - 0.08, 0.0);
        }
        max_range = fmax(max_range, white[c] - black[c]);
        c += 1;
    }
    // Pull the black points part-way towards a common value. Fully
    // per-channel black points remove a coloured veil from shadows, but on
    // frames that are mostly open water they also rotate the water's hue
    // (blue water turns violet). Blending keeps both effects in check.
    let bmin = fmin(black[0], fmin(black[1], black[2]));
    c = 0;
    while c < 3 {
        black[c] = black[c] + (bmin - black[c]) * BLACK_SHARE;
        c += 1;
    }
    // Don't let one starved channel be stretched far more than the others
    // (that just amplifies noise in the red channel of deep shots).
    c = 0;
    while c < 3 {
        let min_range = max_range * 0.35;
        if white[c] - black[c] < min_range {
            let mid = (white[c] + black[c]) * 0.5;
            black[c] = fmax(mid - min_range * 0.5, 0.0);
            white[c] = black[c] + min_range;
        }
        c += 1;
    }

    wrf(out, S_KRED, k_red);
    wrf(out, S_DONOR_G, wg);
    wrf(out, S_KBLUE, k_blue);
    wrf(out, S_VEIL_REF, vref);
    wrf(out, S_GAIN, gr);
    wrf(out, S_GAIN + 1, gg);
    wrf(out, S_GAIN + 2, gb);
    c = 0;
    while c < 3 {
        wrf(out, S_BLACK + c, black[c]);
        wrf(out, S_WHITE + c, white[c]);
        c += 1;
    }
    wrf(out, A_MEAN, ur * inv_n);
    wrf(out, A_MEAN + 1, ug * inv_n);
    wrf(out, A_MEAN + 2, ub * inv_n);
    wrf(out, A_GREEN_WATER, if green_water { 1.0 } else { 0.0 });
    let est = 0.2126 * (cr * gr - black[0]) / (white[0] - black[0])
        + 0.7152 * (cg * gg - black[1]) / (white[1] - black[1])
        + 0.0722 * (cb * gb - black[2]) / (white[2] - black[2]);
    wrf(out, A_OUT_LUMA, est);
}

// ------------------------------------------------------------- prepare ----

/// Load a full settings vector (NPARAMS f32 at `s`) and rebuild the tone LUT.
#[no_mangle]
pub unsafe extern "C" fn prepare(s: *const f32) {
    let mut i = 0;
    while i < NPARAMS {
        P[i] = rdf(s, i);
        i += 1;
    }
    GRID_READY = false;
    let ev = exp2(clamp(P[S_EXPOSURE], -3.0, 3.0));
    let sh = clamp(P[S_SHADOWS], -1.0, 1.0);
    let hl = clamp(P[S_HIGHLIGHTS], -1.0, 1.0);
    let p = exp2(clamp(P[S_CONTRAST], -1.0, 1.0) * 1.1);
    i = 0;
    while i < TONE_N {
        let x = i as f32 / (TONE_N as f32 / 2.0);
        let mut v = x * ev;
        if hl < 0.0 && v > 0.5 {
            // pull highlights (and anything over 1) back with a soft shoulder
            let t = (v - 0.5) * 2.0; // 0 at mid-grey, 1 at white, >1 beyond
            let k = -hl;
            v = 0.5 + 0.5 * (t * (1.0 - k) + k * (t / (1.0 + 0.6 * t)) * 1.6);
        }
        v = clamp(v, 0.0, 1.0);
        let u = 1.0 - v;
        // shadow bump peaks at v = 1/3, highlight bump at v = 2/3 (both = 1 there)
        v += sh * 0.3 * 6.75 * v * u * u;
        if hl > 0.0 {
            v += hl * 0.3 * 6.75 * v * v * u;
        }
        v = clamp(v, 0.0, 1.0);
        if p != 1.0 {
            let a = pow(v, p);
            let b = pow(1.0 - v, p);
            v = a / fmax(a + b, 1e-6);
        }
        TONE[i] = v;
        i += 1;
    }
}

// ------------------------------------------------------------- process ----

/// Per-channel affine stage: compensation, gains, levels, temp/tint.
/// Kept in one place so the clarity pre-pass and the main pass agree.
struct Affine {
    vref: f32,
    k_red: f32,
    wg: f32,
    k_blue: f32,
    m: [f32; 3],
    o: [f32; 3],
}

unsafe fn affine() -> Affine {
    let dh = clamp(P[S_DEHAZE], 0.0, 2.0);
    let t = clamp(P[S_TEMP], -1.0, 1.0);
    let tint = clamp(P[S_TINT], -1.0, 1.0);
    let tm = [1.0 + 0.22 * t, 1.0 - 0.18 * tint, 1.0 - 0.22 * t];
    let mut m = [0.0f32; 3];
    let mut o = [0.0f32; 3];
    let mut c = 0;
    while c < 3 {
        let bp = P[S_BLACK + c] * dh;
        let range = fmax(P[S_WHITE + c] - bp, 0.05);
        m[c] = P[S_GAIN + c] / range * tm[c];
        o[c] = -bp / range * tm[c];
        c += 1;
    }
    Affine { vref: P[S_VEIL_REF], k_red: P[S_KRED], wg: P[S_DONOR_G], k_blue: P[S_KBLUE], m: m, o: o }
}

#[inline(always)]
fn apply_affine(a: &Affine, r: f32, g: f32, b: f32, out: &mut [f32; 3]) {
    let r2 = r + a.k_red * (1.0 - r) * donor(a.wg, g, b, a.vref);
    let b2 = b + a.k_blue * (1.0 - b) * g;
    out[0] = r2 * a.m[0] + a.o[0];
    out[1] = g * a.m[1] + a.o[1];
    out[2] = b2 * a.m[2] + a.o[2];
}

/// Maximum water hue rotation, radians (25°).
const WATER_HUE_MAX: f32 = 0.436;

/// RGB rotation about the grey axis by `a` radians (+ = red→green→blue).
fn hue_matrix(a: f32) -> [f32; 9] {
    let c = cos(a);
    let s = sin(a);
    let k = (1.0 - c) / 3.0;
    let q = s * 0.577_350_3;
    [c + k, k - q, k + q, k + q, c + k, k - q, k - q, k + q, c + k]
}

#[inline(always)]
fn luma(c: &[f32; 3]) -> f32 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/// Build the low-resolution luminance grid used by clarity from `src`
/// (normally the analysis thumbnail), with the affine stage of the prepared
/// settings. The grid lives in normalised image coordinates, so a grid built
/// from a thumbnail applies unchanged to the full-size frame, on the CPU here
/// and on the GPU (where it is uploaded as a texture).
unsafe fn grid_from(src: *const u8, w: usize, h: usize, a: &Affine) {
    let longest = if w > h { w } else { h } as f32;
    let cell = fmax(longest / 40.0, 1.0);
    let mut gw = (w as f32 / cell + 0.5) as usize;
    let mut gh = (h as f32 / cell + 0.5) as usize;
    if gw < 1 {
        gw = 1;
    }
    if gh < 1 {
        gh = 1;
    }
    if gw > GRID_MAX {
        gw = GRID_MAX;
    }
    if gh > GRID_MAX {
        gh = GRID_MAX;
    }
    let mut i = 0;
    while i < gw * gh {
        GRID[i] = 0.0;
        GRID_N[i] = 0.0;
        i += 1;
    }
    // keep the sample count around 64k whatever the source size
    let mut step = sqrt((w * h) as f32 / 65536.0) as usize;
    if step < 1 {
        step = 1;
    }
    let mut c3 = [0.0f32; 3];
    let mut total = 0.0f32;
    let mut count = 0.0f32;
    let mut y = 0;
    while y < h {
        let gy = y * gh / h;
        let mut x = 0;
        while x < w {
            let k = (y * w + x) * 4;
            apply_affine(a, rd(src, k), rd(src, k + 1), rd(src, k + 2), &mut c3);
            let l = clamp(luma(&c3), 0.0, 1.5);
            let gi = gy * gw + x * gw / w;
            GRID[gi] += l;
            GRID_N[gi] += 1.0;
            total += l;
            count += 1.0;
            x += step;
        }
        y += step;
    }
    let mean = total / fmax(count, 1.0);
    i = 0;
    while i < gw * gh {
        GRID[i] = if GRID_N[i] > 0.0 { GRID[i] / GRID_N[i] } else { mean };
        i += 1;
    }
    // two 3x3 box passes to smooth cell edges
    let mut pass = 0;
    while pass < 2 {
        let mut gy = 0;
        while gy < gh {
            let mut gx = 0;
            while gx < gw {
                let mut s = 0.0f32;
                let mut cnt = 0.0f32;
                let mut dy: i32 = -1;
                while dy <= 1 {
                    let yy = gy as i32 + dy;
                    if yy >= 0 && yy < gh as i32 {
                        let mut dx: i32 = -1;
                        while dx <= 1 {
                            let xx = gx as i32 + dx;
                            if xx >= 0 && xx < gw as i32 {
                                s += GRID[yy as usize * gw + xx as usize];
                                cnt += 1.0;
                            }
                            dx += 1;
                        }
                    }
                    dy += 1;
                }
                GRID_TMP[gy * gw + gx] = s / cnt;
                gx += 1;
            }
            gy += 1;
        }
        i = 0;
        while i < gw * gh {
            GRID[i] = GRID_TMP[i];
            i += 1;
        }
        pass += 1;
    }
    GW = gw;
    GH = gh;
    GRID_READY = true;
}

/// Build the clarity grid for the prepared settings from an image, normally
/// the ≤256 px analysis thumbnail. Call after `prepare`, before `process`.
#[no_mangle]
pub unsafe extern "C" fn build_grid(src: *const u8, w: u32, h: u32) {
    let a = affine();
    grid_from(src, w as usize, h as usize, &a);
}

/// Bilinear grid lookup at the centre of pixel (x, y) of a w×h image.
/// Matches a LINEAR, CLAMP_TO_EDGE texture fetch at uv = (x+0.5)/w.
#[inline(always)]
unsafe fn grid_sample(x: usize, y: usize, w: usize, h: usize) -> f32 {
    let gw = GW;
    let gh = GH;
    let fx = clamp((x as f32 + 0.5) / w as f32 * gw as f32 - 0.5, 0.0, (gw - 1) as f32);
    let fy = clamp((y as f32 + 0.5) / h as f32 * gh as f32 - 0.5, 0.0, (gh - 1) as f32);
    let x0 = fx as usize;
    let y0 = fy as usize;
    let x1 = if x0 + 1 < gw { x0 + 1 } else { x0 };
    let y1 = if y0 + 1 < gh { y0 + 1 } else { y0 };
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let a = GRID[y0 * gw + x0] * (1.0 - tx) + GRID[y0 * gw + x1] * tx;
    let b = GRID[y1 * gw + x0] * (1.0 - tx) + GRID[y1 * gw + x1] * tx;
    a * (1.0 - ty) + b * ty
}

#[inline(always)]
unsafe fn tone(v: f32) -> f32 {
    let i = v * (TONE_N as f32 / 2.0);
    if i <= 0.0 {
        return TONE[0];
    }
    if i >= (TONE_N - 1) as f32 {
        return TONE[TONE_N - 1];
    }
    let i0 = i as usize;
    let t = i - i0 as f32;
    TONE[i0] * (1.0 - t) + TONE[i0 + 1] * t
}

/// Apply the prepared settings to `w`×`h` RGBA pixels from `src` into `dst`
/// (they may be the same buffer). Alpha is copied.
#[no_mangle]
pub unsafe extern "C" fn process(src: *const u8, dst: *mut u8, w: u32, h: u32) {
    let w = w as usize;
    let h = h as usize;
    let a = affine();
    let clarity = clamp(P[S_CLARITY], 0.0, 1.0) * 1.6;
    if clarity > 0.0 && !GRID_READY {
        grid_from(src, w, h, &a);
    }
    let strength = clamp(P[S_STRENGTH], 0.0, 1.0);
    let sat = 1.0 + clamp(P[S_SATURATION], -1.0, 1.0);
    let vib = clamp(P[S_VIBRANCE], -1.0, 1.0);
    let wsat = clamp(P[S_WATER_SAT], -1.0, 1.0);
    let whue = clamp(P[S_WATER_HUE], -1.0, 1.0);
    let wlum = clamp(P[S_WATER_LUM], -1.0, 1.0);
    let hm = hue_matrix(-whue * WATER_HUE_MAX);
    let mut c3 = [0.0f32; 3];

    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let k = (y * w + x) * 4;
            let r0 = rd(src, k);
            let g0 = rd(src, k + 1);
            let b0 = rd(src, k + 2);
            apply_affine(&a, r0, g0, b0, &mut c3);

            if clarity > 0.0 {
                let yl = clamp(luma(&c3), 0.0, 1.5);
                let yb = grid_sample(x, y, w, h);
                let d = yl - yb;
                // gentle on extremes to limit halos
                let boost = clarity * d / (1.0 + 4.0 * fabs(d));
                c3[0] += boost;
                c3[1] += boost;
                c3[2] += boost;
            }

            let mut r = tone(c3[0]);
            let mut g = tone(c3[1]);
            let mut b = tone(c3[2]);

            if wlum != 0.0 || whue != 0.0 {
                let water = clamp((fmin(g, b) - r) * 3.0, 0.0, 1.0);
                if water > 0.0 {
                    if whue != 0.0 {
                        let nr = hm[0] * r + hm[1] * g + hm[2] * b;
                        let ng = hm[3] * r + hm[4] * g + hm[5] * b;
                        let nb = hm[6] * r + hm[7] * g + hm[8] * b;
                        r += (nr - r) * water;
                        g += (ng - g) * water;
                        b += (nb - b) * water;
                    }
                    if wlum != 0.0 {
                        let k = 1.0 + wlum * 0.6 * water;
                        r *= k;
                        g *= k;
                        b *= k;
                    }
                }
            }

            let yv = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let mx = fmax(r, fmax(g, b));
            let mn = fmin(r, fmin(g, b));
            let s = mx - mn;
            let mut f = sat;
            if vib != 0.0 {
                f *= 1.0 + vib * (1.0 - s) * if vib > 0.0 { 1.0 } else { s + 0.3 };
            }
            if wsat != 0.0 {
                let water = clamp((fmin(g, b) - r) * 3.0, 0.0, 1.0);
                f *= 1.0 + wsat * water;
            }
            r = yv + (r - yv) * f;
            g = yv + (g - yv) * f;
            b = yv + (b - yv) * f;

            if strength < 1.0 {
                r = r0 + (r - r0) * strength;
                g = g0 + (g - g0) * strength;
                b = b0 + (b - b0) * strength;
            }
            let alpha = rd8(src, k + 3);
            wr8(dst, k, to_u8(clamp(r, 0.0, 1.0)));
            wr8(dst, k + 1, to_u8(clamp(g, 0.0, 1.0)));
            wr8(dst, k + 2, to_u8(clamp(b, 0.0, 1.0)));
            wr8(dst, k + 3, alpha);
            x += 1;
        }
        y += 1;
    }
}

// ----------------------------------------------------------- GPU export ----

/// Number of f32 written by `gpu_params`.
pub const GPU_LEN: usize = 32;

/// Derived per-frame constants for the WebGL renderer, which runs the same
/// per-pixel maths as `process` on the GPU. Call after `prepare` and
/// `build_grid`. Layout (mirrored in web/gpu.js):
/// 0..3 m, 3..6 o, 6 k_red, 7 donor green weight, 8 k_blue, 9 veil ref,
/// 10 clarity, 11 strength, 12 saturation factor, 13 vibrance, 14 water sat,
/// 15 water brightness, 16..25 water hue matrix (row-major), 25 grid w,
/// 26 grid h, 27 water hue amount, 28 veil suppression.
#[no_mangle]
pub unsafe extern "C" fn gpu_params(out: *mut f32) {
    let a = affine();
    let mut c = 0;
    while c < 3 {
        wrf(out, c, a.m[c]);
        wrf(out, 3 + c, a.o[c]);
        c += 1;
    }
    wrf(out, 6, a.k_red);
    wrf(out, 7, a.wg);
    wrf(out, 8, a.k_blue);
    wrf(out, 9, a.vref);
    wrf(out, 10, clamp(P[S_CLARITY], 0.0, 1.0) * 1.6);
    wrf(out, 11, clamp(P[S_STRENGTH], 0.0, 1.0));
    wrf(out, 12, 1.0 + clamp(P[S_SATURATION], -1.0, 1.0));
    wrf(out, 13, clamp(P[S_VIBRANCE], -1.0, 1.0));
    wrf(out, 14, clamp(P[S_WATER_SAT], -1.0, 1.0));
    wrf(out, 15, clamp(P[S_WATER_LUM], -1.0, 1.0));
    let whue = clamp(P[S_WATER_HUE], -1.0, 1.0);
    let hm = hue_matrix(-whue * WATER_HUE_MAX);
    let mut i = 0;
    while i < 9 {
        wrf(out, 16 + i, hm[i]);
        i += 1;
    }
    wrf(out, 25, GW as f32);
    wrf(out, 26, GH as f32);
    wrf(out, 27, whue);
    wrf(out, 28, VEIL_SUPPRESS);
}

/// Address of the 2048-entry tone LUT (input 0..2) built by `prepare`.
#[no_mangle]
pub unsafe extern "C" fn tone_lut() -> *const f32 {
    &raw const TONE as *const f32
}

/// Address of the clarity grid (GW×GH f32, row-major) built by `build_grid`.
#[no_mangle]
pub unsafe extern "C" fn grid_data() -> *const f32 {
    &raw const GRID as *const f32
}

// ------------------------------------------------------------- metrics ----

/// Number of f32 written by `metrics`: 16 scalars + 3×256 histogram.
pub const METRICS_LEN: usize = 16 + 768;

unsafe fn ensure_lin() {
    if LIN_READY {
        return;
    }
    let mut i = 0;
    while i < 256 {
        let c = i as f32 / 255.0;
        LIN[i] = if c <= 0.04045 { c / 12.92 } else { pow((c + 0.055) / 1.055, 2.4) };
        i += 1;
    }
    LIN_READY = true;
}

#[inline(always)]
fn lab_f(t: f32) -> f32 {
    if t > 0.008856 {
        cbrt(t)
    } else {
        7.787 * t + 16.0 / 116.0
    }
}

/// Quality metrics of an RGBA image (`n` pixels, every `step`-th sampled).
///
/// out[0]  mean L* (0..100)          out[1]  std L* (global contrast)
/// out[2]  highlight a*              out[3]  highlight b*  (mean of the brightest
/// out[4]  highlight cast |(a*, b*)|         20 %: sand, skin, slate, foam should be
///                                           near neutral; open water may stay blue)
/// out[5]  colourfulness (Hasler–Süsstrunk)
/// out[6]  UCIQE-style score         out[7]  clipped pixels (fraction)
/// out[8]  mean saturation C/L       out[9]  std chroma
/// out[10] L* 1–99 % range           out[11..13] mean R,G,B (0..1)
/// out[14], out[15] plain mean a*, b* of the whole frame
/// out[16..16+768] R,G,B histograms (256 bins each, sampled counts)
#[no_mangle]
pub unsafe extern "C" fn metrics(src: *const u8, w: u32, h: u32, step: u32, out: *mut f32) {
    ensure_lin();
    let w = w as usize;
    let n = w * h as usize;
    let step = if step == 0 { 1 } else { step as usize };
    let mut i = 0;
    while i < METRICS_LEN {
        wrf(out, i, 0.0);
        i += 1;
    }
    i = 0;
    while i < 1000 {
        LHIST[i] = 0;
        i += 1;
    }
    let mut cnt = 0.0f32;
    let (mut sl, mut sl2, mut sa, mut sb) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut sc, mut sc2, mut ss) = (0.0f32, 0.0f32, 0.0f32);
    let (mut srg, mut srg2, mut syb, mut syb2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut mr, mut mg, mut mb) = (0.0f32, 0.0f32, 0.0f32);
    let mut clipped = 0.0f32;
    i = 0;
    while i < 100 {
        LAB_A[i] = 0.0;
        LAB_B[i] = 0.0;
        LAB_N[i] = 0.0;
        i += 1;
    }
    i = 0;
    while i < n {
        let k = i * 4;
        let r8 = rd8(src, k);
        let g8 = rd8(src, k + 1);
        let b8 = rd8(src, k + 2);
        let hr = 16 + r8 as usize;
        let hg = 16 + 256 + g8 as usize;
        let hb = 16 + 512 + b8 as usize;
        wrf(out, hr, rdf(out, hr) + 1.0);
        wrf(out, hg, rdf(out, hg) + 1.0);
        wrf(out, hb, rdf(out, hb) + 1.0);

        let rl = LIN[r8 as usize];
        let gl = LIN[g8 as usize];
        let bl = LIN[b8 as usize];
        let xx = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / 0.95047;
        let yy = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
        let zz = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / 1.08883;
        let fx = lab_f(xx);
        let fy = lab_f(yy);
        let fz = lab_f(zz);
        let l = 116.0 * fy - 16.0;
        let a = 500.0 * (fx - fy);
        let b = 200.0 * (fy - fz);
        let ch = sqrt(a * a + b * b);
        sl += l;
        sl2 += l * l;
        sa += a;
        sb += b;
        let lb = clamp(l, 0.0, 99.0) as usize;
        LAB_A[lb] += a;
        LAB_B[lb] += b;
        LAB_N[lb] += 1.0;
        sc += ch;
        sc2 += ch * ch;
        ss += fmin(ch / fmax(l, 1.0), 1.5);
        let li = clamp(l * 10.0, 0.0, 999.0) as usize;
        LHIST[li] += 1;

        let rf = r8 as f32;
        let gf = g8 as f32;
        let bf = b8 as f32;
        let rg = rf - gf;
        let yb = 0.5 * (rf + gf) - bf;
        srg += rg;
        srg2 += rg * rg;
        syb += yb;
        syb2 += yb * yb;
        mr += rf;
        mg += gf;
        mb += bf;
        if r8 >= 254 || g8 >= 254 || b8 >= 254 || (r8 <= 1 && g8 <= 1 && b8 <= 1) {
            clipped += 1.0;
        }
        cnt += 1.0;
        i += step;
    }
    if cnt == 0.0 {
        return;
    }
    let inv = 1.0 / cnt;
    let ml = sl * inv;
    let std_l = sqrt(fmax(sl2 * inv - ml * ml, 0.0));
    let ma = sa * inv;
    let mbb = sb * inv;
    let mc = sc * inv;
    let std_c = sqrt(fmax(sc2 * inv - mc * mc, 0.0));
    let ms = ss * inv;
    let mrg = srg * inv;
    let myb = syb * inv;
    let srg_sd = sqrt(fmax(srg2 * inv - mrg * mrg, 0.0));
    let syb_sd = sqrt(fmax(syb2 * inv - myb * myb, 0.0));
    let colorful = sqrt(srg_sd * srg_sd + syb_sd * syb_sd) + 0.3 * sqrt(mrg * mrg + myb * myb);

    // L* 1st / 99th percentile
    let lo_t = (cnt * 0.01) as u32;
    let hi_t = (cnt * 0.99) as u32;
    let mut acc: u32 = 0;
    let mut lo = 0.0f32;
    let mut hi = 100.0f32;
    let mut got_lo = false;
    i = 0;
    while i < 1000 {
        acc += LHIST[i];
        if !got_lo && acc > lo_t {
            lo = i as f32 / 10.0;
            got_lo = true;
        }
        if acc > hi_t {
            hi = i as f32 / 10.0;
            break;
        }
        i += 1;
    }
    let con_l = (hi - lo) / 100.0;
    let uciqe = 0.4680 * (std_c / 100.0) + 0.2745 * con_l + 0.2576 * fmin(ms, 1.0);

    wrf(out, 0, ml);
    wrf(out, 1, std_l);
    // highlight cast: mean a*, b* of the brightest 20 % of samples
    let (mut ha, mut hb, mut hn) = (0.0f32, 0.0f32, 0.0f32);
    let mut li = 99i32;
    while li >= 0 && hn < cnt * 0.2 {
        let u = li as usize;
        ha += LAB_A[u];
        hb += LAB_B[u];
        hn += LAB_N[u];
        li -= 1;
    }
    let wa = ha / fmax(hn, 1.0);
    let wb = hb / fmax(hn, 1.0);
    wrf(out, 2, wa);
    wrf(out, 3, wb);
    wrf(out, 4, sqrt(wa * wa + wb * wb));
    wrf(out, 14, ma);
    wrf(out, 15, mbb);
    wrf(out, 5, colorful);
    wrf(out, 6, uciqe);
    wrf(out, 7, clipped * inv);
    wrf(out, 8, ms);
    wrf(out, 9, std_c);
    wrf(out, 10, hi - lo);
    wrf(out, 11, mr * inv / 255.0);
    wrf(out, 12, mg * inv / 255.0);
    wrf(out, 13, mb * inv / 255.0);
}

/// Exposed so the page can check it was built for the same layout.
#[no_mangle]
pub extern "C" fn layout_version() -> u32 {
    (NPARAMS * 1000 + METRICS_LEN) as u32
}

#[cfg(all(not(test), not(minicore)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    #[cfg(target_arch = "wasm32")]
    core::arch::wasm32::unreachable();
    #[cfg(not(target_arch = "wasm32"))]
    loop {}
}

#[cfg(test)]
mod tests;
