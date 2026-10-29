//! Deinterlacing for interlaced video (1080i from camcorders, AVCHD).
//!
//! An interlaced frame holds two fields taken half a frame apart: even lines
//! and odd lines. Shown together, anything that moved has a comb along its
//! edges. `deinterlace` keeps one field and rebuilds the other field's lines
//! only where they don't fit: a line of the other field keeps its pixel
//! where it lies between the pixels above and below it (a still part of the
//! picture keeps its full detail), and takes their average where it sticks
//! out from both (motion). Run once per field, it turns 25 interlaced
//! frames per second into 50 full frames, as the camera saw them.
//! The WebGL renderer runs the same test (web/gpu.js).

use super::{rd8, wr8};

#[inline(always)]
unsafe fn luma(p: *const u8, k: usize) -> i32 {
    (77 * rd8(p, k) as i32 + 150 * rd8(p, k + 1) as i32 + 29 * rd8(p, k + 2) as i32) >> 8
}

/// Keep field `field` (0 = even lines, 1 = odd lines) of the `w`×`h` RGBA
/// frame in `buf` and rebuild the other field's lines in place where they
/// comb. `t` is the brightness step (0..255) that counts as a comb.
#[no_mangle]
pub unsafe extern "C" fn deinterlace(buf: *mut u8, w: u32, h: u32, field: u32, t: u32) {
    let (w, h) = (w as usize, h as usize);
    if h < 3 {
        return;
    }
    let tt = (t * t) as i32;
    let mut y = if field == 0 { 1 } else { 0 };
    while y < h {
        // the lines above and below belong to the kept field
        let ya = if y > 0 { y - 1 } else { y + 1 };
        let yc = if y + 1 < h { y + 1 } else { y - 1 };
        let (ra, rb, rc) = (ya * w * 4, y * w * 4, yc * w * 4);
        let mut x = 0;
        while x < w {
            let (ka, kb, kc) = (ra + x * 4, rb + x * 4, rc + x * 4);
            let (la, lb, lc) = (luma(buf, ka), luma(buf, kb), luma(buf, kc));
            if (lb - la) * (lb - lc) > tt {
                let mut c = 0;
                while c < 3 {
                    let v = (rd8(buf, ka + c) as u32 + rd8(buf, kc + c) as u32 + 1) >> 1;
                    wr8(buf, kb + c, v as u8);
                    c += 1;
                }
            }
            x += 1;
        }
        y += 2;
    }
}

/// Share of pixels that comb (0..1) in a `w`×`h` RGBA frame: high for
/// interlaced video with motion, near zero for progressive video.
#[no_mangle]
pub unsafe extern "C" fn comb_score(buf: *const u8, w: u32, h: u32, t: u32) -> f32 {
    let (w, h) = (w as usize, h as usize);
    let ti = t as i32;
    let mut n = 0u32;
    let mut combed = 0u32;
    let mut y = 1;
    while y + 1 < h {
        let mut x = 0;
        while x < w {
            let (la, lb, lc) = (luma(buf, ((y - 1) * w + x) * 4), luma(buf, (y * w + x) * 4), luma(buf, ((y + 1) * w + x) * 4));
            let d = la - lc;
            if (lb - la) * (lb - lc) > ti * ti && d < ti && d > -ti {
                combed += 1;
            }
            n += 1;
            x += 1;
        }
        y += 2;
    }
    if n == 0 { 0.0 } else { combed as f32 / n as f32 }
}
