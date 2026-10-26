//! Backscatter removal: finds the small bright specks that particles lit by a
//! strobe or the sun leave in underwater photos, and paints them out.
//!
//! Runs on the colour-corrected image, where the specks stand out.
//!
//! Detection works on a half-resolution brightness image (and a quarter
//! resolution one for larger, softer discs):
//!   1. white top-hat: brightness minus its grey opening (erode then dilate
//!      with a square, van Herk / Gil-Werman, a fixed cost per pixel whatever
//!      the size) keeps only bright features smaller than the square;
//!   2. a pixel is a candidate when its top-hat beats a threshold that rises
//!      with the local top-hat level, so textured sea floor needs far more
//!      contrast than open water;
//!   3. candidates are grouped into blobs; a blob is kept when it is small,
//!      compact, and the thin ring around it is flat compared with its own
//!      contrast (rejects sand, coral, fish patterns and fin rays).
//!
//! Filling works at full resolution: the half-resolution mask is widened a
//! little to cover each speck's soft edge, every speck is filled from its
//! surroundings with a pull-push pyramid, and the result is only ever allowed
//! to darken a pixel (backscatter only adds light), so a wrong detection can
//! not create a bright artefact.
//!
//! Like the rest of the engine nothing here allocates: the page passes
//! scratch memory (see `bs_detect_scratch` / `bs_fill_scratch`).

use super::{rd8, wr8};

#[inline(always)]
unsafe fn ld32(p: *const u8, i: usize) -> u32 {
    *((p as usize + i * 4) as *const u32)
}
#[inline(always)]
unsafe fn st32(p: *mut u8, i: usize, v: u32) {
    *((p as usize + i * 4) as *mut u32) = v;
}
#[inline(always)]
unsafe fn ldf(p: *const u8, i: usize) -> f32 {
    *((p as usize + i * 4) as *const f32)
}
#[inline(always)]
unsafe fn stf(p: *mut u8, i: usize, v: f32) {
    *((p as usize + i * 4) as *mut f32) = v;
}
#[inline(always)]
fn umin(a: usize, b: usize) -> usize {
    if a < b { a } else { b }
}
#[inline(always)]
fn umax(a: usize, b: usize) -> usize {
    if a > b { a } else { b }
}
#[inline(always)]
fn bmin(a: u8, b: u8) -> u8 {
    if a < b { a } else { b }
}
#[inline(always)]
fn bmax(a: u8, b: u8) -> u8 {
    if a > b { a } else { b }
}
#[inline(always)]
fn roundf(x: f32) -> usize {
    if x <= 0.0 { 0 } else { (x + 0.5) as usize }
}
#[inline(always)]
unsafe fn add(p: *mut u8, bytes: usize) -> *mut u8 {
    (p as usize + bytes) as *mut u8
}

/// Radius of the square used at half resolution, from the image's long side.
fn radius_half(maxdim: f32) -> usize {
    umax(2, roundf(maxdim * 0.00065))
}
/// Radius at quarter resolution (larger, softer discs).
fn radius_quarter(maxdim: f32) -> usize {
    umax(3, roundf(maxdim * 0.0051 / 4.0))
}

/// Rows of margin a band of the full image needs around it so every speck
/// that touches the band is filled the same way as in one piece.
#[no_mangle]
pub extern "C" fn bs_margin(maxdim: f32) -> u32 {
    ((2 * radius_quarter(maxdim) + 3) * 4 + 12) as u32
}

// ------------------------------------------------------------ brightness ----

#[inline(always)]
unsafe fn luma_at(src: *const u8, k: usize) -> u32 {
    (77 * rd8(src, k) as u32 + 150 * rd8(src, k + 1) as u32 + 29 * rd8(src, k + 2) as u32 + 128) >> 8
}

/// Brightness of `w`×`rows` RGBA pixels at half resolution (2×2 averages),
/// written as ceil(w/2) × ceil(rows/2) bytes.
#[no_mangle]
pub unsafe extern "C" fn bs_luma_half(src: *const u8, w: u32, rows: u32, dst: *mut u8) {
    let (w, h) = (w as usize, rows as usize);
    let (w2, h2) = ((w + 1) / 2, (h + 1) / 2);
    let mut y2 = 0;
    while y2 < h2 {
        let ya = y2 * 2;
        let yb = umin(ya + 1, h - 1);
        let mut x2 = 0;
        while x2 < w2 {
            let xa = x2 * 2;
            let xb = umin(xa + 1, w - 1);
            let s = luma_at(src, (ya * w + xa) * 4) + luma_at(src, (ya * w + xb) * 4)
                + luma_at(src, (yb * w + xa) * 4) + luma_at(src, (yb * w + xb) * 4);
            wr8(dst, y2 * w2 + x2, ((s + 2) >> 2) as u8);
            x2 += 1;
        }
        y2 += 1;
    }
}

/// Brightness of `n` RGBA pixels, one byte each (for a preview that is
/// already at half resolution).
#[no_mangle]
pub unsafe extern "C" fn bs_luma(src: *const u8, n: u32, dst: *mut u8) {
    let mut i = 0;
    while i < n as usize {
        wr8(dst, i, luma_at(src, i * 4) as u8);
        i += 1;
    }
}

// ------------------------------------------------------------ morphology ----

/// One horizontal van Herk pass (min or max over 2r+1 pixels) per row.
/// `g` and `hb` are row buffers of `w` bytes.
unsafe fn pass_h(src: *const u8, dst: *mut u8, w: usize, h: usize, r: usize, is_min: bool, g: *mut u8, hb: *mut u8) {
    let k = 2 * r + 1;
    let mut y = 0;
    while y < h {
        let row = y * w;
        let mut s = 0;
        while s < w {
            let e = umin(s + k, w);
            let mut m = rd8(src, row + s);
            wr8(g, s, m);
            let mut i = s + 1;
            while i < e {
                let v = rd8(src, row + i);
                m = if is_min { bmin(m, v) } else { bmax(m, v) };
                wr8(g, i, m);
                i += 1;
            }
            m = rd8(src, row + e - 1);
            wr8(hb, e - 1, m);
            let mut i = e - 1;
            while i > s {
                i -= 1;
                let v = rd8(src, row + i);
                m = if is_min { bmin(m, v) } else { bmax(m, v) };
                wr8(hb, i, m);
            }
            s = e;
        }
        let mut x = 0;
        while x < w {
            let lo = if x >= r { x - r } else { 0 };
            let hi = umin(x + r, w - 1);
            let a = rd8(hb, lo);
            let b = rd8(g, hi);
            wr8(dst, row + x, if is_min { bmin(a, b) } else { bmax(a, b) });
            x += 1;
        }
        y += 1;
    }
}

/// One vertical van Herk pass, whole rows at a time so memory is read in
/// order. `g` and `hb` are full-size buffers.
unsafe fn pass_v(src: *const u8, dst: *mut u8, w: usize, h: usize, r: usize, is_min: bool, g: *mut u8, hb: *mut u8) {
    let k = 2 * r + 1;
    let mut s = 0;
    while s < h {
        let e = umin(s + k, h);
        let mut x = 0;
        while x < w {
            wr8(g, s * w + x, rd8(src, s * w + x));
            x += 1;
        }
        let mut y = s + 1;
        while y < e {
            let (p, q) = ((y - 1) * w, y * w);
            let mut x = 0;
            while x < w {
                let a = rd8(g, p + x);
                let b = rd8(src, q + x);
                wr8(g, q + x, if is_min { bmin(a, b) } else { bmax(a, b) });
                x += 1;
            }
            y += 1;
        }
        let mut x = 0;
        while x < w {
            wr8(hb, (e - 1) * w + x, rd8(src, (e - 1) * w + x));
            x += 1;
        }
        let mut y = e - 1;
        while y > s {
            y -= 1;
            let (p, q) = ((y + 1) * w, y * w);
            let mut x = 0;
            while x < w {
                let a = rd8(hb, p + x);
                let b = rd8(src, q + x);
                wr8(hb, q + x, if is_min { bmin(a, b) } else { bmax(a, b) });
                x += 1;
            }
        }
        s = e;
    }
    let mut y = 0;
    while y < h {
        let lo = (if y >= r { y - r } else { 0 }) * w;
        let hi = umin(y + r, h - 1) * w;
        let q = y * w;
        let mut x = 0;
        while x < w {
            let a = rd8(hb, lo + x);
            let b = rd8(g, hi + x);
            wr8(dst, q + x, if is_min { bmin(a, b) } else { bmax(a, b) });
            x += 1;
        }
        y += 1;
    }
}

/// White top-hat of `l` into `top`: l minus its opening. Uses t, g, hb.
unsafe fn tophat(l: *const u8, top: *mut u8, w: usize, h: usize, r: usize, t: *mut u8, g: *mut u8, hb: *mut u8) {
    pass_h(l, t, w, h, r, true, g, hb);
    pass_v(t, top, w, h, r, true, g, hb);
    pass_h(top, t, w, h, r, false, g, hb);
    pass_v(t, top, w, h, r, false, g, hb);
    let n = w * h;
    let mut i = 0;
    while i < n {
        let a = rd8(l, i);
        let b = rd8(top, i);
        wr8(top, i, if a > b { a - b } else { 0 });
        i += 1;
    }
}

// -------------------------------------------------------------- detection ----

const BLOCK: usize = 8;
const QCAP: usize = 1 << 18; // ring queue entries for flood fill
const PCAP: usize = 4096; // pixels kept per blob (bigger blobs are rejected anyway)

struct Pass {
    l: *const u8,     // brightness
    top: *const u8,   // top-hat
    marks: *mut u8,   // 0 none, 1 candidate, 2 kept, 3 visited and rejected
    w: usize,
    h: usize,
    r: usize,
    a: f32,           // threshold = a + b * local level
    b: f32,
    ring_k: f32,      // ring flatness: k * ring deviation must stay below the contrast
    lvl: *mut u8,     // f32 per block (two arrays)
    queue: *mut u8,   // u32 ring buffer
    pix: *mut u8,     // u32 pixel list
}

/// Local top-hat level per block, smoothed over 5×5 blocks.
unsafe fn level(p: &Pass) -> (usize, usize) {
    let (nbx, nby) = ((p.w + BLOCK - 1) / BLOCK, (p.h + BLOCK - 1) / BLOCK);
    let nb = nbx * nby;
    let sums = p.lvl;
    let out = add(p.lvl, nb * 4);
    let mut i = 0;
    while i < nb {
        stf(sums, i, 0.0);
        i += 1;
    }
    let mut y = 0;
    while y < p.h {
        let by = y / BLOCK;
        let mut x = 0;
        while x < p.w {
            let k = by * nbx + x / BLOCK;
            stf(sums, k, ldf(sums, k) + rd8(p.top, y * p.w + x) as f32);
            x += 1;
        }
        y += 1;
    }
    let mut by = 0;
    while by < nby {
        let mut bx = 0;
        while bx < nbx {
            let (mut s, mut c) = (0.0f32, 0.0f32);
            let y0 = if by >= 2 { by - 2 } else { 0 };
            let x0 = if bx >= 2 { bx - 2 } else { 0 };
            let mut yy = y0;
            while yy < umin(by + 3, nby) {
                let mut xx = x0;
                while xx < umin(bx + 3, nbx) {
                    s += ldf(sums, yy * nbx + xx);
                    // pixels in that block (edge blocks are partial)
                    let bw = umin(BLOCK, p.w - xx * BLOCK);
                    let bh = umin(BLOCK, p.h - yy * BLOCK);
                    c += (bw * bh) as f32;
                    xx += 1;
                }
                yy += 1;
            }
            stf(out, by * nbx + bx, s / c);
            bx += 1;
        }
        by += 1;
    }
    (nbx, nby)
}

/// Mark candidates, group them, keep the speck-like blobs (their pixels are
/// marked 2, and painted into `paint` when it is given) and append their
/// position and size to `blobs`. Returns the number of blobs kept.
unsafe fn find(p: &Pass, blobs: *mut u8, nblob0: usize, max_blobs: usize, scale: f32, paint: *mut u8, pw: usize, ph: usize) -> usize {
    let (nbx, _) = level(p);
    let nb = ((p.w + BLOCK - 1) / BLOCK) * ((p.h + BLOCK - 1) / BLOCK);
    let lvl = add(p.lvl, nb * 4);
    let n = p.w * p.h;
    // candidates
    let mut y = 0;
    while y < p.h {
        let by = y / BLOCK;
        let mut x = 0;
        while x < p.w {
            let i = y * p.w + x;
            let thr = p.a + p.b * ldf(lvl, by * nbx + x / BLOCK);
            wr8(p.marks, i, if rd8(p.top, i) as f32 > thr { 1 } else { 0 });
            x += 1;
        }
        y += 1;
    }
    let max_side = 2 * p.r + 2;
    let mut kept = 0;
    let mut i0 = 0;
    while i0 < n {
        if rd8(p.marks, i0) != 1 {
            i0 += 1;
            continue;
        }
        // flood fill (8-connected) with a ring queue; visited = 3 for now
        let (mut qh, mut qt) = (0usize, 1usize);
        st32(p.queue, 0, i0 as u32);
        wr8(p.marks, i0, 3);
        let (mut x0, mut y0, mut x1, mut y1) = (p.w, p.h, 0usize, 0usize);
        let mut area = 0usize;
        let mut npix = 0usize;
        let mut peak = 0u32;
        let mut ptop = 0u32;
        while qh != qt {
            let q = ld32(p.queue, qh % QCAP) as usize;
            qh += 1;
            let (x, y) = (q % p.w, q / p.w);
            area += 1;
            if npix < PCAP {
                st32(p.pix, npix, q as u32);
                npix += 1;
            }
            x0 = umin(x0, x);
            y0 = umin(y0, y);
            x1 = umax(x1, x);
            y1 = umax(y1, y);
            let v = rd8(p.l, q) as u32;
            if v > peak {
                peak = v;
            }
            let tv = rd8(p.top, q) as u32;
            if tv > ptop {
                ptop = tv;
            }
            let ya = if y > 0 { y - 1 } else { 0 };
            let yb = umin(y + 1, p.h - 1);
            let xa = if x > 0 { x - 1 } else { 0 };
            let xb = umin(x + 1, p.w - 1);
            let mut yy = ya;
            while yy <= yb {
                let mut xx = xa;
                while xx <= xb {
                    let j = yy * p.w + xx;
                    if rd8(p.marks, j) == 1 && qt - qh < QCAP {
                        wr8(p.marks, j, 3);
                        st32(p.queue, qt % QCAP, j as u32);
                        qt += 1;
                    }
                    xx += 1;
                }
                yy += 1;
            }
        }
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let mut ok = area >= 2 && npix == area && umax(bw, bh) <= max_side && (area as f32) >= 0.35 * (bw * bh) as f32;
        if ok {
            // the ring: 2 pixels around the box, candidates excluded
            let ra = if y0 >= 2 { y0 - 2 } else { 0 };
            let rb = umin(y1 + 2, p.h - 1);
            let ca = if x0 >= 2 { x0 - 2 } else { 0 };
            let cb = umin(x1 + 2, p.w - 1);
            let (mut s, mut c) = (0.0f32, 0.0f32);
            let mut yy = ra;
            while yy <= rb {
                let mut xx = ca;
                while xx <= cb {
                    let j = yy * p.w + xx;
                    if rd8(p.marks, j) == 0 {
                        s += rd8(p.l, j) as f32;
                        c += 1.0;
                    }
                    xx += 1;
                }
                yy += 1;
            }
            if c < 4.0 {
                ok = false;
            } else {
                let mean = s / c;
                let mut dev = 0.0f32;
                let mut yy = ra;
                while yy <= rb {
                    let mut xx = ca;
                    while xx <= cb {
                        let j = yy * p.w + xx;
                        if rd8(p.marks, j) == 0 {
                            let d = rd8(p.l, j) as f32 - mean;
                            dev += if d < 0.0 { -d } else { d };
                        }
                        xx += 1;
                    }
                    yy += 1;
                }
                dev /= c;
                let contrast = peak as f32 - mean;
                ok = contrast > p.a && p.ring_k * dev < contrast;
            }
        }
        if ok {
            let mut k = 0;
            while k < npix {
                let q = ld32(p.pix, k) as usize;
                wr8(p.marks, q, 2);
                if paint as usize != 0 {
                    paint_quarter(paint, pw, ph, q % p.w, q / p.w);
                }
                k += 1;
            }
            // and its soft edge: grow into nearby pixels that still stand out
            // (a quarter of the peak, capped so a very bright speck takes its
            // whole glow with it)
            let e = umax(1, umax(bw, bh) / 2 + 1);
            let q = ptop / 4;
            let gthr = if q < 3 { 3 } else if q > 9 { 9 } else { q };
            let ga = if y0 >= e { y0 - e } else { 0 };
            let gb = umin(y1 + e, p.h - 1);
            let gc = if x0 >= e { x0 - e } else { 0 };
            let gd = umin(x1 + e, p.w - 1);
            let mut yy = ga;
            while yy <= gb {
                let mut xx = gc;
                while xx <= gd {
                    let j = yy * p.w + xx;
                    if rd8(p.marks, j) != 2 && rd8(p.top, j) as u32 >= gthr {
                        wr8(p.marks, j, 2);
                        if paint as usize != 0 {
                            paint_quarter(paint, pw, ph, xx, yy);
                        }
                    }
                    xx += 1;
                }
                yy += 1;
            }
            let at = nblob0 + kept;
            if at < max_blobs {
                stf(blobs, at * 3, (x0 + x1 + 1) as f32 * 0.5 * scale);
                stf(blobs, at * 3 + 1, (y0 + y1 + 1) as f32 * 0.5 * scale);
                stf(blobs, at * 3 + 2, umax(bw, bh) as f32 * 0.5 * scale);
            }
            kept += 1;
        }
        i0 += 1;
    }
    kept
}

/// Mark the 2×2 half-resolution pixels under quarter-resolution pixel (x, y).
unsafe fn paint_quarter(paint: *mut u8, pw: usize, ph: usize, x: usize, y: usize) {
    let (qx, qy) = (x * 2, y * 2);
    let mut dy = 0;
    while dy < 2 {
        let mut dx = 0;
        while dx < 2 {
            if qx + dx < pw && qy + dy < ph {
                wr8(paint, (qy + dy) * pw + qx + dx, 2);
            }
            dx += 1;
        }
        dy += 1;
    }
}

/// Scratch bytes `bs_detect` needs for a `w2`×`h2` half-resolution image.
#[no_mangle]
pub extern "C" fn bs_detect_scratch(w2: u32, h2: u32) -> u32 {
    let (w2, h2) = (w2 as usize, h2 as usize);
    let n2 = w2 * h2;
    let n4 = ((w2 + 1) / 2) * ((h2 + 1) / 2);
    let nb = ((w2 + BLOCK - 1) / BLOCK) * ((h2 + BLOCK - 1) / BLOCK);
    (4 * n2 + n4 + 8 * nb + 4 * QCAP + 4 * PCAP + 64) as u32
}

/// Find specks in the half-resolution brightness image `l2` (`w2`×`h2`) of
/// a photo whose long side is `maxdim` pixels. `sens` is 0..1.
/// Writes `mask` (w2×h2 bytes, 2 = speck) and up to `max_blobs` (x, y,
/// radius) triples in half-resolution pixels to `blobs`. Returns the number
/// of specks found.
#[no_mangle]
pub unsafe extern "C" fn bs_detect(l2: *const u8, w2: u32, h2: u32, maxdim: f32, sens: f32, mask: *mut u8, scratch: *mut u8, blobs: *mut f32, max_blobs: u32) -> u32 {
    let (w2, h2) = (w2 as usize, h2 as usize);
    let n2 = w2 * h2;
    let s = if sens < 0.0 { 0.0 } else if sens > 1.0 { 1.0 } else { sens };
    let a = 11.0 - 6.0 * s;
    let b = 7.0 - 3.0 * s;
    let ring_k = 2.6 - 1.0 * s;
    let nb = ((w2 + BLOCK - 1) / BLOCK) * ((h2 + BLOCK - 1) / BLOCK);
    // layout
    let top = scratch;
    let t = add(top, n2);
    let g = add(t, n2);
    let hb = add(g, n2);
    let l4 = add(hb, n2);
    let w4 = (w2 + 1) / 2;
    let h4 = (h2 + 1) / 2;
    let n4 = w4 * h4;
    let lvl = add(l4, (n4 + 3) / 4 * 4);
    let queue = add(lvl, 8 * nb);
    let pix = add(queue, 4 * QCAP);
    let blobs = blobs as *mut u8;
    let max_blobs = max_blobs as usize;

    // half resolution: small specks
    let rh = radius_half(maxdim);
    tophat(l2, top, w2, h2, rh, t, g, hb);
    let half = Pass { l: l2, top, marks: mask, w: w2, h: h2, r: rh, a, b, ring_k, lvl, queue, pix };
    let mut count = find(&half, blobs, 0, max_blobs, 2.0, 0 as *mut u8, 0, 0);
    let mut i = 0;
    while i < n2 {
        if rd8(mask, i) != 2 {
            wr8(mask, i, 0);
        }
        i += 1;
    }

    // quarter resolution: larger, softer discs
    let mut y = 0;
    while y < h4 {
        let ya = y * 2;
        let yb = umin(ya + 1, h2 - 1);
        let mut x = 0;
        while x < w4 {
            let xa = x * 2;
            let xb = umin(xa + 1, w2 - 1);
            let v = rd8(l2, ya * w2 + xa) as u32 + rd8(l2, ya * w2 + xb) as u32 + rd8(l2, yb * w2 + xa) as u32 + rd8(l2, yb * w2 + xb) as u32;
            wr8(l4, y * w4 + x, ((v + 2) >> 2) as u8);
            x += 1;
        }
        y += 1;
    }
    let rq = radius_quarter(maxdim);
    tophat(l4, top, w4, h4, rq, t, g, hb);
    let marks4 = g; // free again after the top-hat
    let quarter = Pass { l: l4, top, marks: marks4, w: w4, h: h4, r: rq, a: a * 0.6, b, ring_k, lvl, queue, pix };
    count += find(&quarter, blobs, count, max_blobs, 4.0, mask, w2, h2);
    count as u32
}

// ------------------------------------------------------------------- fill ----

/// Turn the half-resolution speck mask into a mask for an output buffer:
/// `out` is `ow`×`oh`, its row 0 is row `oy` of an image `sp` times the
/// size of the mask's image. `mask2` holds rows `y2` .. `y2 + h2` of the
/// half-resolution mask (`w2` wide). Out values: 2 = speck, 1 = soft edge.
#[no_mangle]
pub unsafe extern "C" fn bs_expand(mask2: *const u8, w2: u32, h2: u32, y2: u32, out: *mut u8, ow: u32, oh: u32, oy: u32, sp: f32) {
    let (w2, h2, y2, ow, oh, oy) = (w2 as usize, h2 as usize, y2 as usize, ow as usize, oh as usize, oy as usize);
    let mut i = 0;
    while i < ow * oh {
        wr8(out, i, 0);
        i += 1;
    }
    let mut yy = 0;
    while yy < h2 {
        let mut xx = 0;
        while xx < w2 {
            if rd8(mask2, yy * w2 + xx) == 2 {
                let (fx, fy) = (xx as f32, (y2 + yy) as f32);
                // soft edge: one half-res pixel around; speck: half a pixel around
                paint(out, ow, oh, oy, (fx - 1.0) * sp, (fy - 1.0) * sp, (fx + 2.0) * sp, (fy + 2.0) * sp, 1);
                paint(out, ow, oh, oy, (fx - 0.5) * sp, (fy - 0.5) * sp, (fx + 1.5) * sp, (fy + 1.5) * sp, 2);
            }
            xx += 1;
        }
        yy += 1;
    }
}

unsafe fn paint(out: *mut u8, ow: usize, oh: usize, oy: usize, xa: f32, ya: f32, xb: f32, yb: f32, v: u8) {
    let x0 = if xa <= 0.0 { 0 } else { xa as usize };
    let y0 = if ya <= 0.0 { 0 } else { ya as usize };
    let x1 = umin(ow, if xb <= 0.0 { 0 } else { (xb + 0.999) as usize });
    let y1 = if yb <= 0.0 { 0 } else { (yb + 0.999) as usize };
    let ys = umax(y0, oy);
    let ye = umin(y1, oy + oh);
    let mut y = ys;
    while y < ye {
        let mut x = x0;
        while x < x1 {
            let k = (y - oy) * ow + x;
            if rd8(out, k) < v {
                wr8(out, k, v);
            }
            x += 1;
        }
        y += 1;
    }
}

const TMAX: usize = 320 * 320; // largest fill tile

/// Scratch bytes `bs_fill` needs.
#[no_mangle]
pub extern "C" fn bs_fill_scratch() -> u32 {
    (4 * 4 * TMAX * 2 + 4 * QCAP + 64) as u32
}

/// Fill the specks marked in `mask` (from `bs_expand`, modified) in the RGBA
/// buffer `buf` (`w`×`h`). Only rows `y_lo` .. `y_hi` are written; the rows
/// around them are read so specks crossing the edge are filled the same way
/// by both neighbours.
#[no_mangle]
pub unsafe extern "C" fn bs_fill(buf: *mut u8, w: u32, h: u32, mask: *mut u8, y_lo: u32, y_hi: u32, scratch: *mut u8) {
    let (w, h, y_lo, y_hi) = (w as usize, h as usize, y_lo as usize, umin(y_hi as usize, h as usize));
    let queue = scratch;
    let pyr = add(scratch, 4 * QCAP);
    let mut y = y_lo;
    while y < y_hi {
        let mut x = 0;
        while x < w {
            let i0 = y * w + x;
            let m = rd8(mask, i0);
            if m == 0 || m >= 0x40 {
                x += 1;
                continue;
            }
            // this speck: flood fill over the whole buffer, tagging 0x40
            let (mut qh, mut qt) = (0usize, 1usize);
            st32(queue, 0, i0 as u32);
            wr8(mask, i0, m | 0x40);
            let (mut x0, mut y0, mut x1, mut y1) = (x, y, x, y);
            while qh != qt {
                let q = ld32(queue, qh % QCAP) as usize;
                qh += 1;
                let (qx, qy) = (q % w, q / w);
                x0 = umin(x0, qx);
                y0 = umin(y0, qy);
                x1 = umax(x1, qx);
                y1 = umax(y1, qy);
                let ya = if qy > 0 { qy - 1 } else { 0 };
                let yb = umin(qy + 1, h - 1);
                let xa = if qx > 0 { qx - 1 } else { 0 };
                let xb = umin(qx + 1, w - 1);
                let mut yy = ya;
                while yy <= yb {
                    let mut xx = xa;
                    while xx <= xb {
                        let j = yy * w + xx;
                        let v = rd8(mask, j);
                        if v != 0 && v < 0x40 && qt - qh < QCAP {
                            wr8(mask, j, v | 0x40);
                            st32(queue, qt % QCAP, j as u32);
                            qt += 1;
                        }
                        xx += 1;
                    }
                    yy += 1;
                }
            }
            // tile around it
            let size = umax(x1 - x0 + 1, y1 - y0 + 1);
            let pad = umax(3, size / 2);
            let tx0 = if x0 >= pad { x0 - pad } else { 0 };
            let ty0 = if y0 >= pad { y0 - pad } else { 0 };
            let tx1 = umin(x1 + pad + 1, w);
            let ty1 = umin(y1 + pad + 1, h);
            let (tw, th) = (tx1 - tx0, ty1 - ty0);
            if tw * th <= TMAX {
                fill_tile(buf, w, mask, tx0, ty0, tw, th, y_lo, y_hi, pyr);
            }
            // done: tag 0x80 so it isn't visited again
            let mut yy = y0;
            while yy <= y1 {
                let mut xx = x0;
                while xx <= x1 {
                    let j = yy * w + xx;
                    let v = rd8(mask, j);
                    if v >= 0x40 && v < 0x80 {
                        wr8(mask, j, (v & 3) | 0x80);
                    }
                    xx += 1;
                }
                yy += 1;
            }
            x += 1;
        }
        y += 1;
    }
}

/// Pull-push fill of one tile: known pixels are those with no mask; every
/// pixel of the current speck (tag 0x40) gets min(itself, fill), fully for
/// the speck and half way on its soft edge.
unsafe fn fill_tile(buf: *mut u8, w: usize, mask: *mut u8, tx0: usize, ty0: usize, tw: usize, th: usize, y_lo: usize, y_hi: usize, pyr: *mut u8) {
    // level 0: r, g, b (normalised colour) and weight, as f32
    let mut lw = tw;
    let mut lh = th;
    let mut base = 0usize; // f32 index of the current level
    let mut y = 0;
    while y < th {
        let mut x = 0;
        while x < tw {
            let j = (ty0 + y) * w + tx0 + x;
            let k = (base + y * tw + x) * 4;
            if rd8(mask, j) == 0 {
                stf(pyr, k, rd8(buf, j * 4) as f32);
                stf(pyr, k + 1, rd8(buf, j * 4 + 1) as f32);
                stf(pyr, k + 2, rd8(buf, j * 4 + 2) as f32);
                stf(pyr, k + 3, 1.0);
            } else {
                stf(pyr, k, 0.0);
                stf(pyr, k + 1, 0.0);
                stf(pyr, k + 2, 0.0);
                stf(pyr, k + 3, 0.0);
            }
            x += 1;
        }
        y += 1;
    }
    // pull: coarser levels average the known pixels below them
    let mut bases = [0usize; 12];
    let mut ws = [0usize; 12];
    let mut hs = [0usize; 12];
    bases[0] = 0;
    ws[0] = tw;
    hs[0] = th;
    let mut nl = 1;
    while (lw > 1 || lh > 1) && nl < 12 {
        let (cw, ch) = ((lw + 1) / 2, (lh + 1) / 2);
        let cb = base + lw * lh;
        let mut cy = 0;
        while cy < ch {
            let mut cx = 0;
            while cx < cw {
                let (mut r, mut g, mut b, mut wt) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                let mut dy = 0;
                while dy < 2 {
                    let mut dx = 0;
                    while dx < 2 {
                        let (fx, fy) = (cx * 2 + dx, cy * 2 + dy);
                        if fx < lw && fy < lh {
                            let k = (base + fy * lw + fx) * 4;
                            let ww = ldf(pyr, k + 3);
                            r += ldf(pyr, k) * ww;
                            g += ldf(pyr, k + 1) * ww;
                            b += ldf(pyr, k + 2) * ww;
                            wt += ww;
                        }
                        dx += 1;
                    }
                    dy += 1;
                }
                let k = (cb + cy * cw + cx) * 4;
                if wt > 0.0 {
                    stf(pyr, k, r / wt);
                    stf(pyr, k + 1, g / wt);
                    stf(pyr, k + 2, b / wt);
                } else {
                    stf(pyr, k, 0.0);
                    stf(pyr, k + 1, 0.0);
                    stf(pyr, k + 2, 0.0);
                }
                stf(pyr, k + 3, if wt > 1.0 { 1.0 } else { wt });
                cx += 1;
            }
            cy += 1;
        }
        base = cb;
        lw = cw;
        lh = ch;
        bases[nl] = base;
        ws[nl] = lw;
        hs[nl] = lh;
        nl += 1;
    }
    // push: fill each level's gaps from the (bilinear) level above
    let mut lv = nl - 1;
    while lv > 0 {
        lv -= 1;
        let (fb, fw, fh) = (bases[lv], ws[lv], hs[lv]);
        let (cb, cw, ch) = (bases[lv + 1], ws[lv + 1], hs[lv + 1]);
        let mut fy = 0;
        while fy < fh {
            let mut fx = 0;
            while fx < fw {
                let k = (fb + fy * fw + fx) * 4;
                let wt = ldf(pyr, k + 3);
                if wt < 1.0 {
                    // bilinear sample of the coarse level
                    let sx = (fx as f32 + 0.5) * 0.5 - 0.5;
                    let sy = (fy as f32 + 0.5) * 0.5 - 0.5;
                    let sx = if sx < 0.0 { 0.0 } else { sx };
                    let sy = if sy < 0.0 { 0.0 } else { sy };
                    let x0 = umin(sx as usize, cw - 1);
                    let y0 = umin(sy as usize, ch - 1);
                    let x1 = umin(x0 + 1, cw - 1);
                    let y1 = umin(y0 + 1, ch - 1);
                    let ax = sx - x0 as f32;
                    let ay = sy - y0 as f32;
                    let ax = if ax > 1.0 { 1.0 } else { ax };
                    let ay = if ay > 1.0 { 1.0 } else { ay };
                    let mut c = 0;
                    while c < 3 {
                        let v00 = ldf(pyr, (cb + y0 * cw + x0) * 4 + c);
                        let v01 = ldf(pyr, (cb + y0 * cw + x1) * 4 + c);
                        let v10 = ldf(pyr, (cb + y1 * cw + x0) * 4 + c);
                        let v11 = ldf(pyr, (cb + y1 * cw + x1) * 4 + c);
                        let up = (v00 * (1.0 - ax) + v01 * ax) * (1.0 - ay) + (v10 * (1.0 - ax) + v11 * ax) * ay;
                        stf(pyr, k + c, ldf(pyr, k + c) * wt + up * (1.0 - wt));
                        c += 1;
                    }
                    stf(pyr, k + 3, 1.0);
                }
                fx += 1;
            }
            fy += 1;
        }
    }
    // write the speck: never brighter than it was
    let mut y = 0;
    while y < th {
        let ay = ty0 + y;
        if ay >= y_lo && ay < y_hi {
            let mut x = 0;
            while x < tw {
                let j = ay * w + tx0 + x;
                let m = rd8(mask, j);
                if m >= 0x40 && m < 0x80 {
                    let alpha = if (m & 3) == 2 { 1.0f32 } else { 0.5f32 };
                    let k = (y * tw + x) * 4;
                    let mut c = 0;
                    while c < 3 {
                        let v = rd8(buf, j * 4 + c) as f32;
                        let f = ldf(pyr, k + c);
                        let lo = if f < v { f } else { v };
                        let o = v + (lo - v) * alpha;
                        wr8(buf, j * 4 + c, (o + 0.5) as u8);
                        c += 1;
                    }
                }
                x += 1;
            }
        }
        y += 1;
    }
}
