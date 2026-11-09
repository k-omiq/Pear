//! Photoshop's noise gradients (Gradient Type: Noise): a ramp of random
//! colours, the same for the same seed.
//!
//! Ours: PhotoCraft has none, and no Adobe text gives the generator, so this
//! is designed from how Photoshop's dialog behaves (`docs/LAYER_STYLES_PLAN.md`,
//! "Noise gradient design"):
//!
//! - Each channel of the colour model (RGB, HSB or LAB), and alpha with Add
//!   Transparency, is a random walk between its Limits. The walk sets
//!   `3 + round(61 r^2)` knots evenly along the ramp for Roughness `r`, each
//!   a random step from the last of up to `(0.35 + 0.65 r)` of the channel's
//!   range, folded back at the limits. A full hue range wraps instead.
//! - Between knots the channel eases with a smoothstep squeezed into
//!   `1 / (1 + 15 r^2)` of the gap: Roughness 0 is three knots eased over the
//!   whole ramp (smooth), 100 % is 64 knots with near hard steps.
//! - The random numbers are SplitMix64, one stream per channel, seeded from
//!   the gradient's seed. Only integer maths, IEEE adds and multiplies, and
//!   a log and an exp written here from the same, so the ramp is the same
//!   bit for bit in wasm and natively.
//! - Restrict Colors keeps the colours printable: the chroma (largest less
//!   smallest channel) is capped at 0.8, pulled in about the mid value, which
//!   keeps the hue.
//! - The ramp is baked once, [`SAMPLES`] colours, and read with a linear
//!   step between them.

use crate::paint::budget;
use crate::Error;

/// The colour model the channels walk in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Model {
    #[default]
    Rgb,
    Hsb,
    Lab,
}

impl Model {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0 => Model::Rgb,
            1 => Model::Hsb,
            2 => Model::Lab,
            _ => return None,
        })
    }
}

/// A noise gradient as Photoshop's dialog states one.
#[derive(Clone, Debug, PartialEq)]
pub struct Noise {
    pub seed: u32,
    /// Roughness, 0 to 1.
    pub roughness: f32,
    pub model: Model,
    /// Each channel's Limits, 0 to 1 of its range, `min[i] <= max[i]`: R G B,
    /// H S B, or L a b.
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// Restrict Colors.
    pub restrict: bool,
    /// Add Transparency: a walk in alpha too.
    pub transparency: bool,
}

/// How many colours a ramp is baked to.
pub const SAMPLES: usize = 1024;

/// The highest chroma Restrict Colors keeps.
pub const RESTRICT_CHROMA: f32 = 0.8;

/// A noise gradient baked to its colours.
#[derive(Clone, Debug, PartialEq)]
pub struct Ramp {
    pub noise: Noise,
    /// Straight RGB and alpha, 0 to 1.
    table: Vec<[f32; 4]>,
}

impl Ramp {
    pub fn new(noise: Noise) -> Self {
        let mut table = Vec::with_capacity(SAMPLES);
        bake(&noise, &mut table);
        Ramp { noise, table }
    }

    /// [`Ramp::new`] for a decoded record: its table is charged to the
    /// painter's budget for the paint, as the record's other vectors are,
    /// and the walks it is baked from are checked against it first.
    pub fn charged(noise: Noise) -> Result<Self, Error> {
        budget::ensure(4 * SAMPLES * core::mem::size_of::<f32>())?;
        let mut table = Vec::new();
        budget::reserve_raw(&mut table, SAMPLES)?;
        bake(&noise, &mut table);
        Ok(Ramp { noise, table })
    }

    /// The colour at `t`, 0 to 1: straight RGB and alpha.
    pub fn sample(&self, t: f32) -> [f32; 4] {
        let n = self.table.len();
        let t = if t.is_finite() {
            t.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let p = t * (n - 1) as f32;
        let i = (p as usize).min(n - 2);
        let k = p - i as f32;
        let (a, b) = (self.table[i], self.table[i + 1]);
        core::array::from_fn(|c| a[c] + (b[c] - a[c]) * k)
    }

    /// The baked colours.
    pub fn table(&self) -> &[[f32; 4]] {
        &self.table
    }
}

/// SplitMix64: integer only, so the same on every target.
struct Rng(u64);

impl Rng {
    fn new(seed: u32, stream: u64) -> Self {
        Rng((u64::from(seed) << 8 | stream).wrapping_mul(0x9e37_79b9_7f4a_7c15) ^ 0x2545_f491)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// 0 up to, not including, 1, exactly a multiple of 2^-24.
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u32 << 24) as f32
    }
}

fn clean(v: f32, lo: f32, hi: f32, or: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        or
    }
}

/// The knots a walk of Roughness `r` sets.
pub fn knots(r: f32) -> usize {
    3 + (61.0 * r * r).round() as usize
}

/// `x` folded back into `lo..=hi` at its ends.
fn fold(x: f32, lo: f32, hi: f32) -> f32 {
    let span = hi - lo;
    if span <= 0.0 {
        return lo;
    }
    let y = (x - lo).rem_euclid(2.0 * span);
    lo + if y > span { 2.0 * span - y } else { y }
}

/// One channel's walk from `lo` to `hi` over `n` samples. A wrapping
/// channel (a full hue range) is not folded; the caller wraps it.
fn walk(rng: &mut Rng, lo: f32, hi: f32, r: f32, wrap: bool, n: usize) -> Vec<f32> {
    let k = knots(r);
    let span = hi - lo;
    let amp = span * (0.35 + 0.65 * r);
    let mut v = Vec::with_capacity(k);
    let mut x = lo + rng.unit() * span;
    v.push(x);
    for _ in 1..k {
        x += (rng.unit() * 2.0 - 1.0) * amp;
        if !wrap {
            x = fold(x, lo, hi);
        }
        v.push(x);
    }
    let squeeze = 1.0 + 15.0 * r * r;
    (0..n)
        .map(|i| {
            let p = i as f32 / (n - 1) as f32 * (k - 1) as f32;
            let j = (p as usize).min(k - 2);
            let f = ((p - j as f32 - 0.5) * squeeze + 0.5).clamp(0.0, 1.0);
            let f = f * f * (3.0 - 2.0 * f);
            v[j] + (v[j + 1] - v[j]) * f
        })
        .collect()
}

fn hsb_rgb(h: f32, s: f32, b: f32) -> [f32; 3] {
    let h = h.rem_euclid(1.0) * 6.0;
    let i = (h as usize).min(5);
    let f = h - i as f32;
    let (p, q, t) = (b * (1.0 - s), b * (1.0 - s * f), b * (1.0 - s * (1.0 - f)));
    match i {
        0 => [b, t, p],
        1 => [q, b, p],
        2 => [p, b, t],
        3 => [p, q, b],
        4 => [t, p, b],
        _ => [b, p, q],
    }
}

/// The natural log, from adds and multiplies only (`x > 0`).
fn ln(x: f64) -> f64 {
    let bits = x.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    // ln m = 2 atanh((m - 1) / (m + 1)), m in [1, 2).
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let mut term = s;
    let mut sum = 0.0;
    for k in 0..24 {
        sum += term / f64::from(2 * k + 1);
        term *= s2;
    }
    2.0 * sum + e as f64 * core::f64::consts::LN_2
}

/// `e^y`, from adds and multiplies only, for `y` from -745 to 0.
fn exp(y: f64) -> f64 {
    if y < -700.0 {
        return 0.0;
    }
    let k = (y / core::f64::consts::LN_2).round();
    let r = y - k * core::f64::consts::LN_2;
    let mut term = 1.0;
    let mut sum = 1.0;
    for i in 1..24 {
        term *= r / f64::from(i);
        sum += term;
    }
    sum * f64::from_bits(((k as i64 + 1023) as u64) << 52)
}

/// Linear light to an sRGB value, 0 to 1.
fn encode(v: f64) -> f32 {
    let v = v.clamp(0.0, 1.0);
    (if v <= 0.003_130_8 {
        12.92 * v
    } else if v >= 1.0 {
        1.0
    } else {
        1.055 * exp(ln(v) / 2.4) - 0.055
    }) as f32
}

/// CIE L*a*b* (D50, as Photoshop's Lab) to sRGB.
fn lab_rgb(l: f32, a: f32, b: f32) -> [f32; 3] {
    let (l, a, b) = (f64::from(l), f64::from(a), f64::from(b));
    let fy = (l + 16.0) / 116.0;
    let fx = fy + a / 500.0;
    let fz = fy - b / 200.0;
    let inv = |f: f64| {
        let f3 = f * f * f;
        if f3 > 216.0 / 24389.0 {
            f3
        } else {
            (116.0 * f - 16.0) * 27.0 / 24389.0
        }
    };
    let (x, y, z) = (0.964_22 * inv(fx), inv(fy), 0.825_21 * inv(fz));
    // XYZ (D50) to linear sRGB, Bradford adapted.
    [
        3.134_136 * x - 1.617_386 * y - 0.490_662 * z,
        -0.978_795 * x + 1.916_254 * y + 0.033_443 * z,
        0.071_955 * x - 0.228_977 * y + 1.405_386 * z,
    ]
    .map(encode)
}

/// The chroma capped at [`RESTRICT_CHROMA`] about the mid value.
fn restrict(c: [f32; 3]) -> [f32; 3] {
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    let chroma = mx - mn;
    if chroma <= RESTRICT_CHROMA {
        return c;
    }
    let mid = (mx + mn) / 2.0;
    c.map(|v| mid + (v - mid) * (RESTRICT_CHROMA / chroma))
}

/// The ramp's [`SAMPLES`] colours, onto `out`.
fn bake(n: &Noise, out: &mut Vec<[f32; 4]>) {
    let r = clean(n.roughness, 0.0, 1.0, 0.5);
    let lim = |i: usize| {
        let lo = clean(n.min[i], 0.0, 1.0, 0.0);
        let hi = clean(n.max[i], 0.0, 1.0, 1.0);
        (lo.min(hi), lo.max(hi))
    };
    let ch: [Vec<f32>; 3] = core::array::from_fn(|i| {
        let (lo, hi) = lim(i);
        let wrap = n.model == Model::Hsb && i == 0 && lo <= 0.0 && hi >= 1.0;
        let mut rng = Rng::new(n.seed, i as u64 + 1);
        walk(&mut rng, lo, hi, r, wrap, SAMPLES)
    });
    let alpha = n.transparency.then(|| {
        let mut rng = Rng::new(n.seed, 4);
        walk(&mut rng, 0.0, 1.0, r, false, SAMPLES)
    });
    out.extend((0..SAMPLES).map(|i| {
        let (a, b, c) = (ch[0][i], ch[1][i], ch[2][i]);
        let rgb = match n.model {
            Model::Rgb => [a, b, c],
            Model::Hsb => hsb_rgb(a, b, c),
            Model::Lab => lab_rgb(a * 100.0, a_b(b), a_b(c)),
        }
        .map(|v| v.clamp(0.0, 1.0));
        let rgb = if n.restrict { restrict(rgb) } else { rgb };
        let al = alpha.as_ref().map_or(1.0, |al| al[i].clamp(0.0, 1.0));
        [rgb[0], rgb[1], rgb[2], al]
    }));
}

/// A Lab a or b channel: 0 to 1 of its range to -128 to 127.
fn a_b(v: f32) -> f32 {
    v * 255.0 - 128.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(seed: u32, roughness: f32) -> Noise {
        Noise {
            seed,
            roughness,
            model: Model::Rgb,
            min: [0.0; 3],
            max: [1.0; 3],
            restrict: false,
            transparency: false,
        }
    }

    fn max_step(t: &[[f32; 4]]) -> f32 {
        t.windows(2)
            .map(|w| {
                (0..4)
                    .map(|c| (w[1][c] - w[0][c]).abs())
                    .fold(0.0, f32::max)
            })
            .fold(0.0, f32::max)
    }

    #[test]
    fn the_same_seed_gives_the_same_ramp_and_another_seed_another() {
        let a = Ramp::new(noise(7, 0.5));
        assert_eq!(a, Ramp::new(noise(7, 0.5)));
        assert_ne!(a.table(), Ramp::new(noise(8, 0.5)).table());
        // Bit for bit: pinned so a change to the generator is seen.
        let p = a.sample(0.0);
        let q = a.sample(0.5);
        assert_eq!(
            [p, q].map(|c| c.map(|v| (v * 255.0).round() as u8)),
            PINNED_SEED_7
        );
    }

    #[test]
    fn the_ends_match_what_the_wasm_engine_paints() {
        // src/lib/text-engine/rust-painter.engine.test.js paints these two
        // ramps' ends through the wasm build and expects the same colours.
        let lab = Noise {
            model: Model::Lab,
            restrict: true,
            ..noise(7, 0.5)
        };
        let ends = [noise(7, 0.5), lab].map(|n| {
            let r = Ramp::new(n);
            [r.sample(0.0), r.sample(1.0)].map(|c| c.map(|v| (v * 255.0).round() as u8))
        });
        assert_eq!(ends, PINNED_ENDS);
    }

    const PINNED_ENDS: [[[u8; 4]; 2]; 2] = [
        [[6, 198, 142, 255], [89, 84, 44, 255]],
        [[79, 0, 0, 255], [8, 104, 212, 255]],
    ];

    // `Ramp::new(noise(7, 0.5))` at 0 and 0.5, times 255.
    const PINNED_SEED_7: [[u8; 4]; 2] = [[6, 198, 142, 255], [68, 167, 169, 255]];

    #[test]
    fn roughness_zero_is_smooth_and_roughness_one_steps() {
        for seed in 0..8 {
            let smooth = Ramp::new(noise(seed, 0.0));
            assert!(max_step(smooth.table()) < 0.01, "seed {seed}");
            let rough = Ramp::new(noise(seed, 1.0));
            assert!(max_step(rough.table()) > 0.05, "seed {seed}");
        }
        assert_eq!((knots(0.0), knots(0.5), knots(1.0)), (3, 18, 64));
    }

    #[test]
    fn every_channel_keeps_within_its_limits() {
        let n = Noise {
            min: [0.2, 0.0, 0.5],
            max: [0.4, 0.1, 0.5],
            ..noise(3, 1.0)
        };
        for c in Ramp::new(n).table() {
            assert!((0.2..=0.4).contains(&c[0]), "{c:?}");
            assert!((0.0..=0.1).contains(&c[1]), "{c:?}");
            assert_eq!(c[2], 0.5);
            assert_eq!(c[3], 1.0);
        }
        // In HSB, brightness 0 is black whatever the hue does.
        let dark = Noise {
            model: Model::Hsb,
            min: [0.0, 0.0, 0.0],
            max: [1.0, 1.0, 0.0],
            ..noise(3, 0.7)
        };
        for c in Ramp::new(dark).table() {
            assert_eq!(&c[..3], &[0.0; 3]);
        }
    }

    #[test]
    fn add_transparency_walks_the_alpha_too() {
        let t = Ramp::new(Noise {
            transparency: true,
            ..noise(5, 0.6)
        });
        let lo = t.table().iter().map(|c| c[3]).fold(1.0, f32::min);
        let hi = t.table().iter().map(|c| c[3]).fold(0.0, f32::max);
        assert!(lo < 0.5 && hi > 0.5, "{lo} {hi}");
        let solid = Ramp::new(noise(5, 0.6));
        assert!(solid.table().iter().all(|c| c[3] == 1.0));
        // The colours do not change with the alpha.
        assert!(t
            .table()
            .iter()
            .zip(solid.table())
            .all(|(a, b)| a[..3] == b[..3]));
    }

    #[test]
    fn restrict_colors_caps_the_chroma() {
        for model in [Model::Rgb, Model::Hsb, Model::Lab] {
            let t = Ramp::new(Noise {
                model,
                restrict: true,
                ..noise(9, 0.8)
            });
            for c in t.table() {
                let mx = c[0].max(c[1]).max(c[2]);
                let mn = c[0].min(c[1]).min(c[2]);
                assert!(mx - mn <= RESTRICT_CHROMA + 1e-5, "{model:?} {c:?}");
            }
        }
        let c = restrict([1.0, 0.0, 0.5]);
        assert!((c[0] - 0.9).abs() < 1e-6 && (c[1] - 0.1).abs() < 1e-6 && c[2] == 0.5);
    }

    #[test]
    fn lab_and_the_maths_under_it_hold() {
        // L 100 is white, L 0 black, a grey has no colour.
        let w = lab_rgb(100.0, 0.0, 0.0);
        assert!(w.iter().all(|v| (v - 1.0).abs() < 2e-3), "{w:?}");
        assert_eq!(lab_rgb(0.0, 0.0, 0.0), [0.0; 3]);
        let g = lab_rgb(50.0, 0.0, 0.0);
        assert!((g[0] - g[1]).abs() < 2e-3 && (g[1] - g[2]).abs() < 2e-3);
        for x in [1e-6, 0.01, 0.2, 0.5, 0.999] {
            assert!((ln(x) - x.ln()).abs() < 1e-12, "ln {x}");
            assert!((exp(-x * 9.0) - (-x * 9.0).exp()).abs() < 1e-12, "exp {x}");
        }
    }

    #[test]
    fn a_full_hue_range_wraps_and_a_part_one_folds() {
        assert!((fold(1.2, 0.0, 1.0) - 0.8).abs() < 1e-6);
        assert_eq!(fold(-0.25, 0.0, 1.0), 0.25);
        assert_eq!(fold(5.0, 0.3, 0.3), 0.3);
        let t = Ramp::new(Noise {
            model: Model::Hsb,
            ..noise(11, 0.4)
        });
        assert!(t
            .table()
            .iter()
            .all(|c| c.iter().all(|v| (0.0..=1.0).contains(v))));
    }

    #[test]
    fn a_decoded_ramp_is_charged_to_the_budget() {
        {
            let _scope = budget::Scope::new();
            assert_eq!(
                Ramp::charged(noise(7, 0.5)).unwrap(),
                Ramp::new(noise(7, 0.5))
            );
            assert_eq!(budget::peak_for_test(), SAMPLES * 16);
        }
        budget::limit_next_scope_for_test(SAMPLES * 16 - 1);
        let _scope = budget::Scope::new();
        assert_eq!(Ramp::charged(noise(7, 0.5)), Err(Error::BadSpec));
    }
}
