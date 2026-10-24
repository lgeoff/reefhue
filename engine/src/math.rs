//! Small, dependency-free float math.
//!
//! `core` has no `powf`, `exp`, `ln` or `sqrt` without `std`/`libm`, so the few
//! transcendental functions the engine needs are implemented here. They are
//! only used to build lookup tables and in the (subsampled) metrics pass, so
//! accuracy (~1e-6 relative) matters more than raw speed.

#[repr(C)]
union Bits {
    f: f32,
    u: u32,
}

#[inline(always)]
pub fn to_bits(f: f32) -> u32 {
    unsafe { Bits { f: f }.u }
}

#[inline(always)]
pub fn from_bits(u: u32) -> f32 {
    unsafe { Bits { u: u }.f }
}

#[inline(always)]
pub fn fmin(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[inline(always)]
pub fn fmax(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[inline(always)]
pub fn clamp(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}

#[inline(always)]
pub fn fabs(x: f32) -> f32 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

#[inline(always)]
pub fn floor(x: f32) -> f32 {
    let i = x as i32;
    let fi = i as f32;
    if fi > x {
        fi - 1.0
    } else {
        fi
    }
}

/// log2(x) for x > 0. Returns -126 for x <= 0.
pub fn log2(x: f32) -> f32 {
    if x <= 0.0 {
        return -126.0;
    }
    let b = to_bits(x);
    let e = ((b >> 23) & 255) as i32 - 127;
    let m = from_bits((b & 0x007F_FFFF) | 0x3F80_0000); // mantissa in [1, 2)
    // ln(m) = 2 * atanh(t), t = (m - 1) / (m + 1), |t| <= 1/3
    let t = (m - 1.0) / (m + 1.0);
    let t2 = t * t;
    let ln = 2.0 * t * (1.0 + t2 * (1.0 / 3.0 + t2 * (0.2 + t2 * (1.0 / 7.0 + t2 * (1.0 / 9.0)))));
    e as f32 + ln * core_consts::LOG2_E
}

/// 2^x
pub fn exp2(x: f32) -> f32 {
    let x = clamp(x, -126.0, 127.0);
    let fl = floor(x);
    let f = x - fl; // [0, 1)
    let y = f * core_consts::LN_2;
    // e^y, |y| < 0.7, Taylor to degree 7
    let p = 1.0
        + y * (1.0
            + y * (0.5
                + y * (1.0 / 6.0
                    + y * (1.0 / 24.0 + y * (1.0 / 120.0 + y * (1.0 / 720.0 + y * (1.0 / 5040.0)))))));
    let e = (fl as i32 + 127) as u32;
    p * from_bits(e << 23)
}

/// x^y for x > 0 (0 otherwise).
pub fn pow(x: f32, y: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    exp2(y * log2(x))
}

pub fn sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    // initial guess from exponent halving, then Newton
    let mut g = from_bits((to_bits(x) >> 1) + 0x1FC0_0000);
    g = 0.5 * (g + x / g);
    g = 0.5 * (g + x / g);
    g = 0.5 * (g + x / g);
    g
}

pub fn cbrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut g = pow(x, 1.0 / 3.0);
    g = g - (g * g * g - x) / (3.0 * g * g);
    g
}

/// sin(x) for |x| <= pi (Taylor to x^11, error < 1e-6 on [-pi/2, pi/2]).
pub fn sin(x: f32) -> f32 {
    let pi = 3.141_592_7f32;
    // reduce to [-pi/2, pi/2]
    let x = if x > pi * 0.5 { pi - x } else if x < -pi * 0.5 { -pi - x } else { x };
    let x2 = x * x;
    x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0 * (1.0 - x2 / 72.0 * (1.0 - x2 / 110.0)))))
}

pub fn cos(x: f32) -> f32 {
    sin(x + 1.570_796_3)
}

mod core_consts {
    pub const LOG2_E: f32 = 1.442_695_04;
    pub const LN_2: f32 = 0.693_147_18;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accuracy() {
        let mut x = 0.001f32;
        while x < 50.0 {
            assert!((log2(x) - x.log2()).abs() < 2e-5, "log2 {x}");
            assert!((pow(x, 0.4545) / x.powf(0.4545) - 1.0).abs() < 2e-5, "pow {x}");
            assert!((sqrt(x) / x.sqrt() - 1.0).abs() < 1e-5, "sqrt {x}");
            assert!((cbrt(x) / x.cbrt() - 1.0).abs() < 1e-5, "cbrt {x}");
            x *= 1.37;
        }
        let mut a = -3.0f32;
        while a < 3.0 {
            assert!((sin(a) - a.sin()).abs() < 2e-5, "sin {a}");
            assert!((cos(a * 0.5) - (a * 0.5).cos()).abs() < 2e-5, "cos {a}");
            a += 0.137;
        }
        let mut y = -10.0f32;
        while y < 10.0 {
            assert!((exp2(y) / y.exp2() - 1.0).abs() < 2e-6, "exp2 {y}");
            y += 0.173;
        }
    }
}
