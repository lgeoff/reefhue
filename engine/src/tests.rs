//! Host-side tests (`cargo test`). They check that a synthetic "underwater"
//! version of a neutral grey ramp comes back close to neutral.

use super::*;
use std::sync::{Mutex, MutexGuard};

/// The engine keeps its buffers in statics (it runs single-threaded in
/// WebAssembly), so tests that call it must not run concurrently.
static ENGINE: Mutex<()> = Mutex::new(());
fn engine_lock() -> MutexGuard<'static, ()> {
    ENGINE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Beer–Lambert-style attenuation + backscatter veil, roughly 10 m of blue water.
fn underwater(r: f32, g: f32, b: f32) -> [f32; 3] {
    let t = [0.12f32, 0.55, 0.75]; // transmission per channel
    let veil = [0.02f32, 0.20, 0.32]; // backscatter
    [r * t[0] + veil[0] * (1.0 - t[0]), g * t[1] + veil[1] * (1.0 - t[1]), b * t[2] + veil[2] * (1.0 - t[2])]
}

fn make_scene(w: usize, h: usize) -> (Vec<u8>, Vec<[f32; 3]>) {
    let mut px = Vec::with_capacity(w * h * 4);
    let mut truth = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            // neutral ramp on top half, a few colour patches below
            let c = if y < h / 2 {
                let v = 0.05 + 0.9 * x as f32 / (w - 1) as f32;
                [v, v, v]
            } else {
                match (x * 6 / w) % 6 {
                    0 => [0.75, 0.25, 0.2],
                    1 => [0.9, 0.6, 0.2],
                    2 => [0.3, 0.6, 0.3],
                    3 => [0.25, 0.35, 0.7],
                    4 => [0.85, 0.85, 0.8],
                    _ => [0.6, 0.45, 0.35],
                }
            };
            let u = underwater(c[0], c[1], c[2]);
            for v in u {
                px.push((v * 255.0).round() as u8);
            }
            px.push(255);
            truth.push(c);
        }
    }
    (px, truth)
}

#[test]
fn restores_grey_ramp_towards_neutral() {
    let _engine = engine_lock();
    let (w, h) = (120, 80);
    let (src, _truth) = make_scene(w, h);
    let mut s = [0.0f32; NPARAMS];
    unsafe {
        analyze(src.as_ptr(), w as u32, h as u32, 1.0, 1.0, s.as_mut_ptr());
    }
    s[S_STRENGTH] = 1.0;
    s[S_DEHAZE] = 1.0;
    let mut dst = vec![0u8; src.len()];
    unsafe {
        prepare(s.as_ptr());
        process(src.as_ptr(), dst.as_mut_ptr(), w as u32, h as u32);
    }
    // mid grey from the ramp: channel spread should be small after correction
    let y = h / 4;
    let mut worst_in = 0i32;
    let mut worst_out = 0i32;
    for x in (w / 5)..(4 * w / 5) {
        let k = (y * w + x) * 4;
        let spread = |p: &[u8]| {
            let (r, g, b) = (p[k] as i32, p[k + 1] as i32, p[k + 2] as i32);
            r.max(g).max(b) - r.min(g).min(b)
        };
        worst_in = worst_in.max(spread(&src));
        worst_out = worst_out.max(spread(&dst));
    }
    assert!(worst_in > 60, "scene should start strongly tinted ({worst_in})");
    assert!(worst_out < 40, "grey ramp should be close to neutral, spread {worst_out}");
}

#[test]
fn strength_zero_is_identity() {
    let _engine = engine_lock();
    let (w, h) = (32, 16);
    let (src, _) = make_scene(w, h);
    let mut s = [0.0f32; NPARAMS];
    unsafe { analyze(src.as_ptr(), w as u32, h as u32, 1.0, 1.0, s.as_mut_ptr()) };
    s[S_STRENGTH] = 0.0;
    s[S_DEHAZE] = 1.0;
    s[S_CLARITY] = 0.5;
    let mut dst = vec![0u8; src.len()];
    unsafe {
        prepare(s.as_ptr());
        process(src.as_ptr(), dst.as_mut_ptr(), w as u32, h as u32);
    }
    assert_eq!(src, dst);
}

#[test]
fn thumbnail_grid_matches_full_grid() {
    let _engine = engine_lock();
    // clarity computed from a downscaled grid should be close to the full one
    let (w, h) = (160, 96);
    let (src, _) = make_scene(w, h);
    let mut s = [0.0f32; NPARAMS];
    unsafe { analyze(src.as_ptr(), w as u32, h as u32, 1.0, 1.0, s.as_mut_ptr()) };
    s[S_STRENGTH] = 1.0;
    s[S_DEHAZE] = 1.0;
    s[S_CLARITY] = 0.6;
    // 2x box-downscaled thumbnail
    let (tw, th) = (w / 2, h / 2);
    let mut thumb = vec![0u8; tw * th * 4];
    for y in 0..th {
        for x in 0..tw {
            for c in 0..4 {
                let mut acc = 0u32;
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    acc += src[((2 * y + dy) * w + 2 * x + dx) * 4 + c] as u32;
                }
                thumb[(y * tw + x) * 4 + c] = (acc / 4) as u8;
            }
        }
    }
    let mut full = vec![0u8; src.len()];
    let mut viathumb = vec![0u8; src.len()];
    unsafe {
        prepare(s.as_ptr());
        process(src.as_ptr(), full.as_mut_ptr(), w as u32, h as u32);
        prepare(s.as_ptr());
        build_grid(thumb.as_ptr(), tw as u32, th as u32);
        process(src.as_ptr(), viathumb.as_mut_ptr(), w as u32, h as u32);
    }
    let worst = full.iter().zip(&viathumb).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap();
    assert!(worst <= 6, "thumbnail grid differs by {worst}");
}

#[test]
fn strips_match_whole_image() {
    let _engine = engine_lock();
    let (w, h) = (96, 70);
    let (src, _) = make_scene(w, h);
    let mut s = [0.0f32; NPARAMS];
    unsafe { analyze(src.as_ptr(), w as u32, h as u32, 1.0, 1.0, s.as_mut_ptr()) };
    s[S_STRENGTH] = 1.0;
    s[S_DEHAZE] = 1.0;
    s[S_CLARITY] = 0.7;
    let mut whole = vec![0u8; src.len()];
    let mut strips = vec![0u8; src.len()];
    unsafe {
        prepare(s.as_ptr());
        build_grid(src.as_ptr(), w as u32, h as u32);
        process(src.as_ptr(), whole.as_mut_ptr(), w as u32, h as u32);
        let mut y = 0;
        while y < h {
            let rows = (h - y).min(17);
            let off = y * w * 4;
            process_rows(src.as_ptr().add(off), strips.as_mut_ptr().add(off), w as u32, rows as u32, y as u32, h as u32);
            y += rows;
        }
    }
    assert_eq!(whole, strips);
}

#[test]
fn metrics_detect_cast() {
    let _engine = engine_lock();
    let (w, h) = (64, 32);
    let (src, _) = make_scene(w, h);
    let mut m = vec![0.0f32; METRICS_LEN];
    unsafe { metrics(src.as_ptr(), w as u32, h as u32, 1, m.as_mut_ptr()) };
    assert!(m[3] < -10.0, "blue water has strongly negative b*: {}", m[3]);
    let hist_total: f32 = m[16..16 + 256].iter().sum();
    assert_eq!(hist_total as usize, w * h);
}


/// Backscatter removal on a real photo: `BS_IN=photo.rgba BS_W=.. BS_H=.. cargo test --release bs_photo -- --ignored --nocapture`
/// (raw RGBA in, `<BS_IN>.out` written). Prints timings per stage.
#[test]
#[ignore]
fn bs_photo() {
    use crate::despeck::*;
    use std::time::Instant;
    let path = std::env::var("BS_IN").unwrap();
    let w: usize = std::env::var("BS_W").unwrap().parse().unwrap();
    let h: usize = std::env::var("BS_H").unwrap().parse().unwrap();
    let sens: f32 = std::env::var("BS_SENS").ok().map(|s| s.parse().unwrap()).unwrap_or(0.6);
    let mut img = std::fs::read(&path).unwrap();
    assert_eq!(img.len(), w * h * 4);
    let maxdim = w.max(h) as f32;
    let (w2, h2) = ((w + 1) / 2, (h + 1) / 2);
    let t0 = Instant::now();
    let mut l2 = vec![0u8; w2 * h2];
    unsafe { bs_luma_half(img.as_ptr(), w as u32, h as u32, l2.as_mut_ptr()) };
    let t_luma = t0.elapsed();
    let t = Instant::now();
    let mut mask2 = vec![0u8; w2 * h2];
    let mut scratch = vec![0u32; bs_detect_scratch(w2 as u32, h2 as u32) as usize / 4 + 1];
    let mut blobs = vec![0f32; 3 * 20000];
    let n = unsafe { bs_detect(l2.as_ptr(), w2 as u32, h2 as u32, maxdim, sens, mask2.as_mut_ptr(), scratch.as_mut_ptr() as *mut u8, blobs.as_mut_ptr(), 20000) };
    let t_detect = t.elapsed();
    // fill in bands with a margin, like the workers do
    let t = Instant::now();
    let margin = bs_margin(maxdim) as usize;
    let band = 512usize;
    let mut fs = vec![0u32; bs_fill_scratch() as usize / 4 + 1];
    let src = img.clone();
    let mut masked = 0usize;
    let mut y = 0;
    while y < h {
        let core = band.min(h - y);
        let a = y.saturating_sub(margin) & !1; // even, so it lines up with the half-res mask
        let b = (y + core + margin).min(h);
        let rows = b - a;
        let mut buf = src[a * w * 4..b * w * 4].to_vec();
        let mut m = vec![0u8; w * rows];
        let (ya2, yb2) = (a / 2, (b + 1) / 2);
        unsafe {
            bs_expand(mask2[ya2 * w2..yb2 * w2].as_ptr(), w2 as u32, (yb2 - ya2) as u32, ya2 as u32, m.as_mut_ptr(), w as u32, rows as u32, a as u32, 2.0);
            bs_fill(buf.as_mut_ptr(), w as u32, rows as u32, m.as_mut_ptr(), (y - a) as u32, (y - a + core) as u32, fs.as_mut_ptr() as *mut u8);
        }
        masked += m[(y - a) * w..(y - a + core) * w].iter().filter(|&&v| v != 0).count();
        img[y * w * 4..(y + core) * w * 4].copy_from_slice(&buf[(y - a) * w * 4..(y - a + core) * w * 4]);
        y += core;
    }
    let t_fill = t.elapsed();
    std::fs::write(format!("{path}.out"), &img).unwrap();
    println!("{w}x{h}: {n} specks, {:.3}% of pixels changed | luma {t_luma:?} detect {t_detect:?} fill {t_fill:?} total {:?}", masked as f64 * 100.0 / (w * h) as f64, t0.elapsed());
}
