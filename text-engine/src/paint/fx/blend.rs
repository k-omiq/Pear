//! Photoshop's blend modes, and laying one picture over another with one.
//!
//! A mode says what colour a layer leaves where it covers what is under it.
//! The arithmetic is per pixel on straight (not premultiplied) colour from 0
//! to 1, in the values as stored: Photoshop blends in the document's gamma,
//! not in linear light, and so does this.
//!
//! The shared modes follow the W3C compositing spec. The ones Photoshop has
//! and the spec does not (Linear Burn, Darker Color, Linear Dodge, Lighter
//! Color, Vivid Light, Linear Light, Pin Light, Hard Mix, Subtract, Divide,
//! Dissolve) and Photoshop's own Soft Light are from Adobe's descriptions of
//! them. Soft Light and the luma of the four colour modes are not stated by
//! Adobe in numbers; a Photoshop golden checks them (LAYER_STYLES_PLAN.md,
//! G4).

use super::super::blur::Surface;
use super::super::geom::IBox;
use super::noise;

/// Every mode, in the order Photoshop's menu lists them. The number is the
/// wire's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Blend {
    #[default]
    Normal,
    Dissolve,
    Darken,
    Multiply,
    ColorBurn,
    LinearBurn,
    DarkerColor,
    Lighten,
    Screen,
    ColorDodge,
    LinearDodge,
    LighterColor,
    Overlay,
    SoftLight,
    HardLight,
    VividLight,
    LinearLight,
    PinLight,
    HardMix,
    Difference,
    Exclusion,
    Subtract,
    Divide,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

/// How many modes there are.
pub const BLEND_COUNT: u32 = 27;

impl Blend {
    /// The mode with wire number `n`, or `None` for a number past the last.
    pub fn from_u32(n: u32) -> Option<Self> {
        use Blend::*;
        const ALL: [Blend; BLEND_COUNT as usize] = [
            Normal,
            Dissolve,
            Darken,
            Multiply,
            ColorBurn,
            LinearBurn,
            DarkerColor,
            Lighten,
            Screen,
            ColorDodge,
            LinearDodge,
            LighterColor,
            Overlay,
            SoftLight,
            HardLight,
            VividLight,
            LinearLight,
            PinLight,
            HardMix,
            Difference,
            Exclusion,
            Subtract,
            Divide,
            Hue,
            Saturation,
            Color,
            Luminosity,
        ];
        ALL.get(n as usize).copied()
    }

    /// Whether the mode works on each channel alone.
    fn separable(self) -> bool {
        !matches!(
            self,
            Blend::DarkerColor
                | Blend::LighterColor
                | Blend::Hue
                | Blend::Saturation
                | Blend::Color
                | Blend::Luminosity
        )
    }

    /// The colour the mode makes of a source `s` over a backdrop `b`, both
    /// straight and opaque. Normal and Dissolve give the source: Dissolve's
    /// difference is in its coverage, not its colour.
    pub fn mix(self, b: [f32; 3], s: [f32; 3]) -> [f32; 3] {
        if self.separable() {
            let f = |b: f32, s: f32| self.channel(b, s).clamp(0.0, 1.0);
            return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
        }
        match self {
            Blend::DarkerColor => {
                if sum(s) < sum(b) {
                    s
                } else {
                    b
                }
            }
            Blend::LighterColor => {
                if sum(s) > sum(b) {
                    s
                } else {
                    b
                }
            }
            Blend::Hue => set_lum(set_sat(s, sat(b)), lum(b)),
            Blend::Saturation => set_lum(set_sat(b, sat(s)), lum(b)),
            Blend::Color => set_lum(s, lum(b)),
            Blend::Luminosity => set_lum(b, lum(s)),
            _ => s,
        }
    }

    /// Photoshop's "special eight": the modes for which a layer's Fill is
    /// not just less coverage. Ported from PhotoCraft,
    /// `crates/compose/src/psblend.rs` `fill_is_special`, Copyright (c) 2026
    /// ArtCraft Team and the PhotoCraft contributors, MIT licence (see
    /// `THIRD_PARTY.md`).
    pub fn fill_is_special(self) -> bool {
        matches!(
            self,
            Blend::ColorBurn
                | Blend::LinearBurn
                | Blend::ColorDodge
                | Blend::LinearDodge
                | Blend::VividLight
                | Blend::LinearLight
                | Blend::HardMix
                | Blend::Difference
        )
    }

    /// [`mix`](Self::mix) for a layer at Fill `fill` (0 to 1). Below 100 %
    /// the special eight blend, at full strength, a source pulled toward the
    /// mode's neutral colour (the one that leaves the backdrop as it is):
    /// white for the two burns, mid grey for Vivid and Linear Light, black
    /// for the dodges and Difference; Hard Mix has its own formula. Every
    /// other mode, or a whole fill, is plain `mix`. Ported from PhotoCraft,
    /// `crates/compose/src/psblend.rs` `blend_rgb_fill` (measured on
    /// Photoshop 27.11, Fill 50 %, eight modes, within a level), MIT licence.
    pub fn mix_fill(self, b: [f32; 3], s: [f32; 3], fill: f32) -> [f32; 3] {
        let f = fill.clamp(0.0, 1.0);
        if f >= 1.0 || !self.fill_is_special() {
            return self.mix(b, s);
        }
        let toward =
            |neutral: f32| -> [f32; 3] { core::array::from_fn(|i| neutral + (s[i] - neutral) * f) };
        match self {
            // At Fill f: (b - f (1 - s)) / (1 - f), clamped. At f = 1 it is
            // the hard threshold (b + s >= 1), at f = 0 the backdrop.
            Blend::HardMix => {
                core::array::from_fn(|i| ((b[i] - f * (1.0 - s[i])) / (1.0 - f)).clamp(0.0, 1.0))
            }
            Blend::ColorBurn | Blend::LinearBurn => self.mix(b, toward(1.0)),
            Blend::VividLight | Blend::LinearLight => self.mix(b, toward(0.5)),
            _ => self.mix(b, toward(0.0)),
        }
    }

    fn channel(self, b: f32, s: f32) -> f32 {
        match self {
            Blend::Normal | Blend::Dissolve => s,
            Blend::Darken => b.min(s),
            Blend::Multiply => b * s,
            Blend::ColorBurn => color_burn(b, s),
            Blend::LinearBurn => b + s - 1.0,
            Blend::Lighten => b.max(s),
            Blend::Screen => screen(b, s),
            Blend::ColorDodge => color_dodge(b, s),
            Blend::LinearDodge => b + s,
            Blend::Overlay => hard_light(s, b),
            Blend::SoftLight => {
                // Photoshop's Soft Light, which is not the W3C one: the dark
                // half darkens by a square; the light half lightens towards
                // the square root, by W3C's polynomial in the darkest
                // quarter (PhotoCraft's `soft_light_ps`).
                if s <= 0.5 {
                    2.0 * b * s + b * b * (1.0 - 2.0 * s)
                } else {
                    let c = b.max(0.0);
                    let d = if c <= 0.25 {
                        ((16.0 * c - 12.0) * c + 4.0) * c
                    } else {
                        c.sqrt()
                    };
                    2.0 * b * (1.0 - s) + d * (2.0 * s - 1.0)
                }
            }
            Blend::HardLight => hard_light(b, s),
            Blend::VividLight => vivid_light_ps(b, s),
            Blend::LinearLight => b + 2.0 * s - 1.0,
            Blend::PinLight => {
                if s <= 0.5 {
                    b.min(2.0 * s)
                } else {
                    b.max(2.0 * s - 1.0)
                }
            }
            // The generic Vivid Light thresholded: `b + s >= 1` inside, and
            // the backdrop's extremes win at the ends, as Photoshop's do.
            Blend::HardMix => {
                if vivid_light(b, s) >= 0.5 - 1e-6 {
                    1.0
                } else {
                    0.0
                }
            }
            Blend::Difference => (b - s).abs(),
            Blend::Exclusion => b + s - 2.0 * b * s,
            Blend::Subtract => b - s,
            Blend::Divide => {
                if s <= 0.0 {
                    if b <= 0.0 {
                        0.0
                    } else {
                        1.0
                    }
                } else {
                    b / s
                }
            }
            // Not separable: answered by `mix`.
            _ => s,
        }
    }
}

fn screen(b: f32, s: f32) -> f32 {
    b + s - b * s
}

fn hard_light(b: f32, s: f32) -> f32 {
    if s <= 0.5 {
        b * 2.0 * s
    } else {
        screen(b, 2.0 * s - 1.0)
    }
}

// What follows of Color Burn, Color Dodge, Vivid Light and Hard Mix is
// PhotoCraft's (`crates/compose/src/psblend.rs`), measured on Photoshop's
// composites of psd-tools `blend-modes/*.psd`. Copyright (c) 2026 ArtCraft
// Team and the PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).

/// A backdrop within this of 0 or 1 counts as exactly that where the result
/// jumps there: a value that should be 1 can arrive a rounding step under.
const EDGE: f32 = 1e-4;

/// Photoshop's Vivid Light: the source's extremes win, so a black source
/// gives black even over white, and a white one white even over black.
fn vivid_light_ps(b: f32, s: f32) -> f32 {
    if s <= 0.5 {
        if s <= 0.0 {
            0.0
        } else {
            1.0 - ((1.0 - b) / (2.0 * s)).min(1.0)
        }
    } else if s >= 1.0 {
        1.0
    } else {
        (b / (2.0 * (1.0 - s))).min(1.0)
    }
}

/// Vivid Light as Color Burn and Color Dodge give it, the backdrop's
/// extremes winning: what Hard Mix thresholds.
fn vivid_light(b: f32, s: f32) -> f32 {
    if s <= 0.5 {
        color_burn(b, 2.0 * s)
    } else {
        color_dodge(b, 2.0 * s - 1.0)
    }
}

fn color_dodge(b: f32, s: f32) -> f32 {
    if b <= EDGE {
        0.0
    } else if s >= 1.0 {
        1.0
    } else {
        (b / (1.0 - s)).min(1.0)
    }
}

fn color_burn(b: f32, s: f32) -> f32 {
    if b >= 1.0 - EDGE {
        1.0
    } else if s <= 0.0 {
        0.0
    } else {
        1.0 - ((1.0 - b) / s).min(1.0)
    }
}

fn sum(c: [f32; 3]) -> f32 {
    c[0] + c[1] + c[2]
}

/// Luma with the weights Photoshop's colour modes are known to use.
fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut out = c;
    if n < 0.0 {
        for v in &mut out {
            *v = l + (*v - l) * l / (l - n);
        }
    }
    if x > 1.0 {
        for v in &mut out {
            *v = l + (*v - l) * (1.0 - l) / (x - l);
        }
    }
    out
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let (mut hi, mut mid, mut lo) = (0usize, 1usize, 2usize);
    if c[lo] > c[mid] {
        core::mem::swap(&mut lo, &mut mid);
    }
    if c[mid] > c[hi] {
        core::mem::swap(&mut mid, &mut hi);
    }
    if c[lo] > c[mid] {
        core::mem::swap(&mut lo, &mut mid);
    }
    let mut out = [0.0; 3];
    if c[hi] > c[lo] {
        out[mid] = (c[mid] - c[lo]) * s / (c[hi] - c[lo]);
        out[hi] = s;
    }
    out
}

/// The page under a box: straight RGBA8, the size of the surface, read as
/// opaque. What a mode blends with where the box's own layers leave the
/// surface clear.
pub struct Backdrop<'a> {
    pub pixels: &'a [u8],
}

impl Backdrop<'_> {
    fn at(&self, i: usize) -> [f32; 3] {
        let p = &self.pixels[i * 4..i * 4 + 3];
        [
            f32::from(p[0]) / 255.0,
            f32::from(p[1]) / 255.0,
            f32::from(p[2]) / 255.0,
        ]
    }
}

/// Lays `src` over `dst` within `bx`, at `opacity`, in `mode`.
///
/// Both are premultiplied surfaces of one size. Where the mode needs to know
/// what is under the box and a `backdrop` is given, what is under is `dst`
/// over the backdrop, and `dst` is left holding what, laid source-over on the
/// backdrop, shows the blend: the box stays a layer of its own that the page
/// is drawn under. With no backdrop, what is under is `dst` alone, and the
/// mode blends with nothing where `dst` is clear (the W3C rule).
///
/// `seed` decides Dissolve's pattern.
pub(crate) fn lay(
    dst: &mut Surface,
    src: &Surface,
    bx: IBox,
    opacity: f32,
    mode: Blend,
    backdrop: Option<&Backdrop<'_>>,
    seed: u32,
) {
    lay_at_fill(dst, src, bx, opacity, mode, backdrop, seed, 1.0);
}

/// [`lay`] for a layer whose Fill Opacity is `fill`, its `src` drawn at the
/// whole fill. Over a page the special eight ([`Blend::fill_is_special`])
/// take Fill into the blend ([`Blend::mix_fill`]) and leave coverage to
/// `opacity`; with no page, or in any other mode, Fill is coverage, as
/// `opacity` is. Ported from PhotoCraft, `crates/compose/src/psblend.rs`
/// `composite_fill`, with the backdrop opaque (the page is), MIT licence.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lay_fill(
    dst: &mut Surface,
    src: &Surface,
    bx: IBox,
    opacity: f32,
    mode: Blend,
    backdrop: Option<&Backdrop<'_>>,
    seed: u32,
    fill: f32,
) {
    let fill = fill.clamp(0.0, 1.0);
    if fill >= 1.0 || !mode.fill_is_special() || backdrop.is_none() {
        return lay_at_fill(dst, src, bx, opacity * fill, mode, backdrop, seed, 1.0);
    }
    lay_at_fill(dst, src, bx, opacity, mode, backdrop, seed, fill);
}

#[allow(clippy::too_many_arguments)]
fn lay_at_fill(
    dst: &mut Surface,
    src: &Surface,
    bx: IBox,
    opacity: f32,
    mode: Blend,
    backdrop: Option<&Backdrop<'_>>,
    seed: u32,
    fill: f32,
) {
    let w = dst.width;
    let bx = bx.intersect(&IBox {
        x0: 0,
        y0: 0,
        x1: w as i32,
        y1: dst.height as i32,
    });
    if bx.is_empty() || opacity <= 0.0 {
        return;
    }
    let opacity = opacity.min(1.0);
    for y in bx.y0..bx.y1 {
        for x in bx.x0..bx.x1 {
            let i = y as usize * w + x as usize;
            let sp = &src.data[i * 4..i * 4 + 4];
            let mut sa = f32::from(sp[3]) / 255.0 * opacity;
            if sa <= 0.0 {
                continue;
            }
            let s_col = unpremul(sp);
            if mode == Blend::Dissolve {
                // Each pixel is all or nothing, with the alpha as its odds.
                sa = if noise::unit(x, y, seed) < sa {
                    1.0
                } else {
                    0.0
                };
                if sa <= 0.0 {
                    continue;
                }
            }
            let dp = &mut dst.data[i * 4..i * 4 + 4];
            let da = f32::from(dp[3]) / 255.0;
            let d_col = unpremul(dp);
            let (col, alpha) = match backdrop {
                Some(page) if mode != Blend::Normal && mode != Blend::Dissolve => {
                    let p = page.at(i);
                    // What is under the layer: the box so far over the page.
                    let under = [
                        d_col[0] * da + p[0] * (1.0 - da),
                        d_col[1] * da + p[1] * (1.0 - da),
                        d_col[2] * da + p[2] * (1.0 - da),
                    ];
                    let mixed = mode.mix_fill(under, s_col, fill);
                    let alpha = sa + da * (1.0 - sa);
                    // What shows: the blend over what was under.
                    let shown = [
                        mixed[0] * sa + under[0] * (1.0 - sa),
                        mixed[1] * sa + under[1] * (1.0 - sa),
                        mixed[2] * sa + under[2] * (1.0 - sa),
                    ];
                    // The colour that, laid at `alpha` over the page, shows
                    // that.
                    let c = |k: usize| ((shown[k] - p[k] * (1.0 - alpha)) / alpha).clamp(0.0, 1.0);
                    ([c(0), c(1), c(2)], alpha)
                }
                _ => {
                    // The W3C rule: where the box is clear the source is its
                    // own colour.
                    let mixed = mode.mix(d_col, s_col);
                    let cs = |k: usize| (1.0 - da) * s_col[k] + da * mixed[k];
                    let alpha = sa + da * (1.0 - sa);
                    let c = |k: usize| (sa * cs(k) + (1.0 - sa) * da * d_col[k]) / alpha;
                    ([c(0), c(1), c(2)], alpha)
                }
            };
            for k in 0..3 {
                dp[k] = super::super::blur::to_u8(col[k] * alpha * 255.0);
            }
            dp[3] = super::super::blur::to_u8(alpha * 255.0);
        }
    }
}

fn unpremul(p: &[u8]) -> [f32; 3] {
    let a = f32::from(p[3]);
    if a <= 0.0 {
        return [0.0; 3];
    }
    [
        (f32::from(p[0]) / a).min(1.0),
        (f32::from(p[1]) / a).min(1.0),
        (f32::from(p[2]) / a).min(1.0),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: [f32; 3] = [0.25, 0.5, 0.75];
    const S: [f32; 3] = [0.6, 0.2, 0.9];

    fn close(a: [f32; 3], b: [f32; 3]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
    }

    #[test]
    fn every_number_names_a_mode_and_back() {
        for n in 0..BLEND_COUNT {
            assert!(Blend::from_u32(n).is_some(), "mode {n}");
        }
        assert_eq!(Blend::from_u32(BLEND_COUNT), None);
        assert_eq!(Blend::from_u32(3), Some(Blend::Multiply));
        assert_eq!(Blend::from_u32(26), Some(Blend::Luminosity));
    }

    #[test]
    fn separable_modes_match_their_formulas() {
        assert!(close(Blend::Multiply.mix(B, S), [0.15, 0.1, 0.675]));
        assert!(close(Blend::Screen.mix(B, S), [0.7, 0.6, 0.975]));
        assert!(close(Blend::Darken.mix(B, S), [0.25, 0.2, 0.75]));
        assert!(close(Blend::Lighten.mix(B, S), [0.6, 0.5, 0.9]));
        assert!(close(Blend::Difference.mix(B, S), [0.35, 0.3, 0.15]));
        assert!(close(Blend::LinearDodge.mix(B, S), [0.85, 0.7, 1.0]));
        assert!(close(Blend::LinearBurn.mix(B, S), [0.0, 0.0, 0.65]));
        assert!(close(Blend::Subtract.mix(B, S), [0.0, 0.3, 0.0]));
        assert!(close(Blend::Exclusion.mix(B, S), [0.55, 0.5, 0.3]));
        // Overlay is Hard Light with the two swapped.
        assert!(close(Blend::Overlay.mix(B, S), Blend::HardLight.mix(S, B)));
        assert!(close(Blend::HardMix.mix(B, S), [0.0, 0.0, 1.0]));
    }

    #[test]
    fn dodge_and_burn_hold_their_ends() {
        assert_eq!(color_dodge(0.0, 1.0), 0.0);
        assert_eq!(color_dodge(0.5, 1.0), 1.0);
        assert_eq!(color_burn(1.0, 0.0), 1.0);
        assert_eq!(color_burn(0.5, 0.0), 0.0);
        assert_eq!(Blend::Divide.mix([0.0; 3], [0.0; 3]), [0.0; 3]);
        assert_eq!(Blend::Divide.mix([0.5; 3], [0.0; 3]), [1.0; 3]);
    }

    #[test]
    fn soft_light_is_photoshops_and_mid_grey_is_neutral() {
        for b in [0.0f32, 0.2, 0.5, 0.9, 1.0] {
            assert!((Blend::SoftLight.mix([b; 3], [0.5; 3])[0] - b).abs() < 1e-6);
        }
        // The light half heads to the square root: 0.25 under white is 0.5.
        assert!((Blend::SoftLight.mix([0.25; 3], [1.0; 3])[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn colour_modes_keep_the_luma_they_promise() {
        assert!((lum(Blend::Color.mix(B, S)) - lum(B)).abs() < 1e-5);
        assert!((lum(Blend::Luminosity.mix(B, S)) - lum(S)).abs() < 1e-5);
        assert!((lum(Blend::Hue.mix(B, S)) - lum(B)).abs() < 1e-5);
        // A grey has no hue or saturation to give.
        let grey = [0.4; 3];
        assert!(close(Blend::Saturation.mix(B, grey), [lum(B); 3]));
    }

    #[test]
    fn darker_and_lighter_colour_pick_a_whole_colour() {
        assert_eq!(Blend::DarkerColor.mix(B, S), B);
        assert_eq!(Blend::LighterColor.mix(B, S), S);
    }

    fn surface(px: [u8; 4]) -> Surface {
        let mut s = Surface::new(1, 1).unwrap();
        s.data.copy_from_slice(&px);
        s
    }

    const ONE: IBox = IBox {
        x0: 0,
        y0: 0,
        x1: 1,
        y1: 1,
    };

    #[test]
    fn normal_lay_is_source_over() {
        let mut d = surface([0, 0, 255, 255]);
        let s = surface([128, 0, 0, 128]);
        lay(&mut d, &s, ONE, 1.0, Blend::Normal, None, 0);
        assert_eq!(&d.data[..], &[128, 0, 127, 255]);
    }

    #[test]
    fn multiply_over_a_page_shows_the_product_when_laid_on_it() {
        // A half-covering grey multiplied over a page of mid red.
        let mut d = Surface::new(1, 1).unwrap();
        let s = surface([64, 64, 64, 128]);
        let page = [200u8, 100, 50, 255];
        let back = Backdrop { pixels: &page };
        lay(&mut d, &s, ONE, 1.0, Blend::Multiply, Some(&back), 0);
        // Laid source-over on the page, the box shows page * (1 - a) +
        // page * grey * a.
        let a = f32::from(d.data[3]) / 255.0;
        for (k, &pg) in page.iter().take(3).enumerate() {
            let p = f32::from(pg) / 255.0;
            let shown = f32::from(d.data[k]) / 255.0 + p * (1.0 - a);
            // The grey is 64 / 128 = 0.5 straight, at alpha 128 / 255.
            let expect = p * (1.0 - 128.0 / 255.0) + p * 0.5 * (128.0 / 255.0);
            assert!(
                (shown - expect).abs() < 2.0 / 255.0,
                "channel {k}: {shown} vs {expect}"
            );
        }
    }

    #[test]
    fn black_multiply_is_black_normal() {
        let page = [180u8, 90, 40, 255];
        let back = Backdrop { pixels: &page };
        let s = surface([0, 0, 0, 191]);
        let mut a = Surface::new(1, 1).unwrap();
        let mut b = Surface::new(1, 1).unwrap();
        lay(&mut a, &s, ONE, 1.0, Blend::Multiply, Some(&back), 0);
        lay(&mut b, &s, ONE, 1.0, Blend::Normal, Some(&back), 0);
        assert_eq!(&a.data[..], &b.data[..]);
    }

    /// What an opaque layer of `layer` at Fill `fill` in `mode` shows over a
    /// page of `page`, through `lay_fill`, as 0 to 255 per channel.
    fn shown_at_fill(mode: Blend, page: [u8; 3], layer: [u8; 3], fill: f32) -> [f32; 3] {
        let pg = [page[0], page[1], page[2], 255];
        let back = Backdrop { pixels: &pg };
        let s = surface([layer[0], layer[1], layer[2], 255]);
        let mut d = Surface::new(1, 1).unwrap();
        lay_fill(&mut d, &s, ONE, 1.0, mode, Some(&back), 0, fill);
        let a = f32::from(d.data[3]) / 255.0;
        core::array::from_fn(|k| f32::from(d.data[k]) + f32::from(page[k]) * (1.0 - a))
    }

    /// PhotoCraft's `special_eight_fill_matches_photoshop`
    /// (`crates/compose/src/psblend.rs`, MIT licence): Photoshop 27.11's own
    /// composites of a layer at Fill 25, 50 and 75 % in each of the eight.
    #[test]
    fn special_eight_fill_matches_photoshop() {
        let measured: [(Blend, [u8; 3]); 8] = [
            (Blend::ColorBurn, [176, 132, 88]),
            (Blend::LinearBurn, [122, 112, 82]),
            (Blend::ColorDodge, [249, 232, 176]),
            (Blend::LinearDodge, [250, 240, 210]),
            (Blend::VividLight, [193, 188, 157]),
            (Blend::LinearLight, [171, 202, 192]),
            (Blend::HardMix, [245, 225, 165]),
            (Blend::Difference, [150, 60, 10]),
        ];
        let (b, t) = ([200, 150, 100], [100, 180, 220]);
        for (mode, want) in measured {
            assert!(mode.fill_is_special());
            let got = shown_at_fill(mode, b, t, 128.0 / 255.0);
            for i in 0..3 {
                assert!(
                    (got[i] - f32::from(want[i])).abs() <= 2.0,
                    "{mode:?} channel {i}: {} vs Photoshop {}",
                    got[i],
                    want[i]
                );
            }
            // At Fill 0 the page, as it was.
            let none = shown_at_fill(mode, b, t, 0.0);
            assert!(
                (0..3).all(|i| (none[i] - f32::from(b[i])).abs() <= 1.0),
                "{mode:?} {none:?}"
            );
        }
        let confirm: [(Blend, [u8; 3], [u8; 3]); 8] = [
            (Blend::ColorBurn, [51, 94, 159], [30, 0, 33]),
            (Blend::LinearBurn, [49, 79, 124], [26, 0, 11]),
            (Blend::ColorDodge, [76, 132, 186], [156, 163, 197]),
            (Blend::LinearDodge, [113, 143, 188], [217, 187, 202]),
            (Blend::VividLight, [71, 109, 162], [117, 81, 80]),
            (Blend::LinearLight, [100, 100, 130], [183, 63, 33]),
            (Blend::HardMix, [65, 105, 166], [102, 0, 47]),
            (Blend::Difference, [7, 97, 172], [97, 53, 158]),
        ];
        let (b2, t2) = ([60, 120, 180], [210, 90, 30]);
        for (mode, q, tq) in confirm {
            for (fill, want) in [(64.0 / 255.0, q), (191.0 / 255.0, tq)] {
                let got = shown_at_fill(mode, b2, t2, fill);
                // Hard Mix at 75 % divides by 1 - f = 0.25, which magnifies
                // Photoshop's 8-bit rounding.
                let tol = if mode == Blend::HardMix { 4.0 } else { 2.0 };
                for i in 0..3 {
                    assert!(
                        (got[i] - f32::from(want[i])).abs() <= tol,
                        "{mode:?} fill {fill} channel {i}: {} vs Photoshop {}",
                        got[i],
                        want[i]
                    );
                }
            }
        }
    }

    #[test]
    fn fill_is_coverage_off_the_special_eight_and_off_the_page() {
        let page = [200u8, 150, 100, 255];
        let back = Backdrop { pixels: &page };
        let s = surface([100, 180, 220, 255]);
        // Multiply at Fill 50 % is Multiply at half the coverage.
        let mut a = Surface::new(1, 1).unwrap();
        let mut b = Surface::new(1, 1).unwrap();
        lay_fill(&mut a, &s, ONE, 0.8, Blend::Multiply, Some(&back), 0, 0.5);
        lay(&mut b, &s, ONE, 0.4, Blend::Multiply, Some(&back), 0);
        assert_eq!(a.data, b.data);
        // With no page, a special mode's Fill is coverage too.
        let mut a = Surface::new(1, 1).unwrap();
        lay_fill(&mut a, &s, ONE, 1.0, Blend::LinearDodge, None, 0, 0.5);
        assert!(a.data[3].abs_diff(128) <= 1, "{:?}", a.data);
        // A whole fill is the plain blend.
        let mut a = Surface::new(1, 1).unwrap();
        let mut b = Surface::new(1, 1).unwrap();
        lay_fill(&mut a, &s, ONE, 1.0, Blend::ColorDodge, Some(&back), 0, 1.0);
        lay(&mut b, &s, ONE, 1.0, Blend::ColorDodge, Some(&back), 0);
        assert_eq!(a.data, b.data);
        assert!(!Blend::Multiply.fill_is_special() && !Blend::Overlay.fill_is_special());
    }

    #[test]
    fn dissolve_is_all_or_nothing() {
        let s = surface([255, 0, 0, 128]);
        let mut hit = 0;
        for seed in 0..200 {
            let mut d = Surface::new(1, 1).unwrap();
            lay(&mut d, &s, ONE, 1.0, Blend::Dissolve, None, seed);
            assert!(d.data[3] == 0 || d.data[3] == 255);
            hit += usize::from(d.data[3] == 255);
        }
        assert!((60..140).contains(&hit), "{hit} of 200");
    }
}
