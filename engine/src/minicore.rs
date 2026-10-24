//! Offline build shim — NOT used by a normal `cargo build`.
//!
//! The precompiled `core` library for `wasm32-unknown-unknown` normally comes
//! from `rustup target add wasm32-unknown-unknown`. When that download is not
//! possible (air-gapped machine, locked-down CI), `build-offline.sh` compiles
//! the crate with `--cfg minicore`, which swaps `core` for this file: the few
//! language items the engine actually relies on (operators on primitive types,
//! `Copy`, panic entry points). It mirrors the `minicore` the Rust compiler's
//! own test-suite uses for cross-target tests.
//!
//! Only enabled with `RUSTC_BOOTSTRAP=1 rustc --cfg minicore ...`.

#![allow(internal_features, dead_code, clippy::all)]

#[lang = "pointee_sized"]
pub trait PointeeSized {}
#[lang = "meta_sized"]
pub trait MetaSized: PointeeSized {}
#[lang = "sized"]
pub trait Sized: MetaSized {}

#[lang = "copy"]
pub trait Copy {}

#[lang = "legacy_receiver"]
pub trait LegacyReceiver {}
impl<T: ?Sized> LegacyReceiver for &T {}
impl<T: ?Sized> LegacyReceiver for &mut T {}

macro_rules! copy_impls { ($($t:ty)*) => { $(impl Copy for $t {})* } }
copy_impls!(bool u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64);
impl<T: ?Sized> Copy for *const T {}
impl<T: ?Sized> Copy for *mut T {}
impl<T: ?Sized> Copy for &T {}
impl<T: Copy, const N: usize> Copy for [T; N] {}

#[lang = "index"]
pub trait Index<Idx> {
    type Output: ?Sized;
    fn index(&self, index: Idx) -> &Self::Output;
}
#[lang = "index_mut"]
pub trait IndexMut<Idx>: Index<Idx> {
    fn index_mut(&mut self, index: Idx) -> &mut Self::Output;
}
impl<T, const N: usize> Index<usize> for [T; N] {
    type Output = T;
    #[inline(always)]
    fn index(&self, i: usize) -> &T {
        &self[i]
    }
}
impl<T, const N: usize> IndexMut<usize> for [T; N] {
    #[inline(always)]
    fn index_mut(&mut self, i: usize) -> &mut T {
        &mut self[i]
    }
}

macro_rules! binop {
    ($lang:literal $tr:ident $m:ident $op:tt, $alang:literal $atr:ident $am:ident; $($t:ty)*) => {
        #[lang = $lang] pub trait $tr<Rhs = Self> { type Output; fn $m(self, rhs: Rhs) -> Self::Output; }
        #[lang = $alang] pub trait $atr<Rhs = Self> { fn $am(&mut self, rhs: Rhs); }
        $(
            impl $tr for $t { type Output = $t; #[inline(always)] fn $m(self, rhs: $t) -> $t { self $op rhs } }
            impl $atr for $t { #[inline(always)] fn $am(&mut self, rhs: $t) { *self = *self $op rhs; } }
        )*
    };
}
binop!("add" Add add +, "add_assign" AddAssign add_assign; u8 u32 u64 usize i32 i64 f32 f64);
binop!("sub" Sub sub -, "sub_assign" SubAssign sub_assign; u8 u32 u64 usize i32 i64 f32 f64);
binop!("mul" Mul mul *, "mul_assign" MulAssign mul_assign; u8 u32 u64 usize i32 i64 f32 f64);
binop!("div" Div div /, "div_assign" DivAssign div_assign; u8 u32 u64 usize i32 i64 f32 f64);
binop!("rem" Rem rem %, "rem_assign" RemAssign rem_assign; u8 u32 u64 usize i32 i64 f32 f64);
binop!("bitand" BitAnd bitand &, "bitand_assign" BitAndAssign bitand_assign; bool u8 u32 u64 usize i32);
binop!("bitor" BitOr bitor |, "bitor_assign" BitOrAssign bitor_assign; bool u8 u32 u64 usize i32);
binop!("bitxor" BitXor bitxor ^, "bitxor_assign" BitXorAssign bitxor_assign; bool u8 u32 u64 usize i32);

macro_rules! shift {
    ($($t:ty)*) => {$(
        impl Shl<u32> for $t { type Output = $t; #[inline(always)] fn shl(self, rhs: u32) -> $t { self << rhs } }
        impl Shr<u32> for $t { type Output = $t; #[inline(always)] fn shr(self, rhs: u32) -> $t { self >> rhs } }
        impl Shl<i32> for $t { type Output = $t; #[inline(always)] fn shl(self, rhs: i32) -> $t { self << rhs } }
        impl Shr<i32> for $t { type Output = $t; #[inline(always)] fn shr(self, rhs: i32) -> $t { self >> rhs } }
    )*};
}
#[lang = "shl"]
pub trait Shl<Rhs = Self> {
    type Output;
    fn shl(self, rhs: Rhs) -> Self::Output;
}
#[lang = "shr"]
pub trait Shr<Rhs = Self> {
    type Output;
    fn shr(self, rhs: Rhs) -> Self::Output;
}
shift!(u8 u32 u64 usize i32);

#[lang = "neg"]
pub trait Neg {
    type Output;
    fn neg(self) -> Self::Output;
}
macro_rules! neg { ($($t:ty)*) => {$( impl Neg for $t { type Output = $t; #[inline(always)] fn neg(self) -> $t { -self } } )*} }
neg!(i32 i64 isize f32 f64);

#[lang = "not"]
pub trait Not {
    type Output;
    fn not(self) -> Self::Output;
}
impl Not for bool {
    type Output = bool;
    #[inline(always)]
    fn not(self) -> bool {
        !self
    }
}

#[lang = "eq"]
pub trait PartialEq<Rhs: ?Sized = Self> {
    fn eq(&self, other: &Rhs) -> bool;
    fn ne(&self, other: &Rhs) -> bool {
        !self.eq(other)
    }
}
#[lang = "partial_ord"]
pub trait PartialOrd<Rhs: ?Sized = Self>: PartialEq<Rhs> {
    fn lt(&self, other: &Rhs) -> bool;
    fn le(&self, other: &Rhs) -> bool;
    fn gt(&self, other: &Rhs) -> bool;
    fn ge(&self, other: &Rhs) -> bool;
}
macro_rules! cmp {
    ($($t:ty)*) => {$(
        impl PartialEq for $t {
            #[inline(always)] fn eq(&self, o: &$t) -> bool { *self == *o }
            #[inline(always)] fn ne(&self, o: &$t) -> bool { *self != *o }
        }
        impl PartialOrd for $t {
            #[inline(always)] fn lt(&self, o: &$t) -> bool { *self < *o }
            #[inline(always)] fn le(&self, o: &$t) -> bool { *self <= *o }
            #[inline(always)] fn gt(&self, o: &$t) -> bool { *self > *o }
            #[inline(always)] fn ge(&self, o: &$t) -> bool { *self >= *o }
        }
    )*};
}
cmp!(bool u8 u32 u64 usize i32 i64 f32 f64);

// ---- panic entry points: trap (wasm `unreachable`) ----

#[rustc_intrinsic]
pub fn abort() -> !;

#[lang = "panic_bounds_check"]
fn panic_bounds_check(_index: usize, _len: usize) -> ! {
    abort()
}
#[lang = "panic"]
fn panic(_msg: &str) -> ! {
    abort()
}
#[lang = "panic_const_div_by_zero"]
fn panic_div_zero() -> ! {
    abort()
}
#[lang = "panic_const_rem_by_zero"]
fn panic_rem_zero() -> ! {
    abort()
}
#[lang = "panic_const_div_overflow"]
fn panic_div_overflow() -> ! {
    abort()
}
#[lang = "panic_const_rem_overflow"]
fn panic_rem_overflow() -> ! {
    abort()
}

#[lang = "freeze"]
pub unsafe auto trait Freeze {}

#[lang = "drop_glue"]
#[allow(unconditional_recursion)]
pub unsafe fn drop_glue<T: ?Sized>(to_drop: *mut T) {
    // body is replaced by compiler-generated drop glue; nothing here needs dropping
    unsafe { drop_glue(to_drop) }
}

#[lang = "panic_location"]
pub struct Location<'a> {
    file: &'a str,
    line: u32,
    col: u32,
}
