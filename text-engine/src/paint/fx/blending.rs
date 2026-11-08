//! Photoshop's Advanced Blending options, the parts a box paints.
//!
//! Blend Interior Effects as Group decides whether Fill Opacity fades the
//! interior effects with the fill; how far a shadow shows through the
//! letters that knock it out depends on the fill and the mode. Channels and
//! Blend If (phase 6b) work on the finished box at its blend onto the page:
//! a channel left out keeps the page's, and Blend If hides the box by its
//! own colour (This Layer) and by the page's (Underlying Layer). Knockout is
//! stored, not painted (`docs/LAYER_STYLES_PLAN.md`, phase 6).
//!
//! `shadow_see_through`, `Range` (PhotoCraft's `BlendRange`),
//! `BlendIf::weight` (`blend_if_weight`), `level` (`blend_if_level`) and
//! `gray` (`blend_if_gray`) are ported from PhotoCraft,
//! `crates/compose/src/effects/composite.rs`, `crates/doc/src/blend_if.rs`
//! and `crates/compose/src/composite.rs`, Copyright (c) 2026 ArtCraft Team
//! and the PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).

use super::super::blur::Surface;
use super::super::geom::IBox;
use super::blend::Blend;

/// The Advanced Blending options of a box.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Blending {
    /// Blend Interior Effects as Group (Photoshop's default is off): Fill
    /// Opacity fades the fill and the overlays, the satin and the inner
    /// glows on it together. Off, Fill fades the fill alone.
    pub interior: bool,
    /// The channels left out (Channels unticked): bit 0 R, 1 G, 2 B. Where
    /// the box is, a left-out channel shows the page's.
    pub channels_out: u8,
    /// Blend If.
    pub blend_if: BlendIf,
}

impl Blending {
    /// The wire's flags: 1 Blend Interior Effects as Group.
    pub fn from_flags(flags: u32) -> Option<Self> {
        if flags > 1 {
            return None;
        }
        Some(Self {
            interior: flags & 1 != 0,
            ..Self::default()
        })
    }

    /// Whether Channels or Blend If change the box's blend onto the page.
    /// Both work only where there is a page: on a PSD layer (no page)
    /// Photoshop applies them from the layer's own fields.
    pub fn restricts(&self) -> bool {
        self.channels_out != 0 || !self.blend_if.is_full()
    }
}

/// One Blend If slider: its black point and its white point, each split
/// into a low and a high half (Alt-drag in Photoshop), on 0 to 255. A value
/// below the black low half or above the white high half is hidden; across
/// a split point it fades. Ported from PhotoCraft,
/// `crates/doc/src/blend_if.rs` `BlendRange`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub black: [u8; 2],
    pub white: [u8; 2],
}

impl Default for Range {
    fn default() -> Self {
        Self::FULL
    }
}

impl Range {
    /// Every value shows (the sliders at the ends).
    pub const FULL: Range = Range {
        black: [0, 0],
        white: [255, 255],
    };

    pub fn is_full(&self) -> bool {
        *self == Self::FULL
    }

    /// From PSD's byte order, black low, black high, white low, white high;
    /// `None` out of that order (the black point past the white one).
    pub fn from_bytes(b: [u8; 4]) -> Option<Self> {
        if b[0] > b[1] || b[1] > b[2] || b[2] > b[3] {
            return None;
        }
        Some(Range {
            black: [b[0], b[1]],
            white: [b[2], b[3]],
        })
    }

    /// How much of a pixel of value `v` (0 to 255) shows: 0 below the black
    /// point or above the white point, 1 between, a straight ramp across a
    /// split point. An unsplit black point at `b` shows `v >= b`, an unsplit
    /// white point at `w` shows `v <= w`.
    pub fn weight(&self, v: f32) -> f32 {
        let ramp = |lo: u8, hi: u8, x: f32| -> f32 {
            // 0 at or below `lo`, 1 at or above `hi`.
            let (lo, hi) = (f32::from(lo), f32::from(hi));
            if hi <= lo {
                if x >= lo {
                    1.0
                } else {
                    0.0
                }
            } else {
                ((x - lo) / (hi - lo)).clamp(0.0, 1.0)
            }
        };
        let lo = ramp(self.black[0], self.black[1], v);
        // The white point mirrored: 1 at or below its low half, 0 above its
        // high half.
        let hi = ramp(255 - self.white[1], 255 - self.white[0], 255.0 - v);
        lo * hi
    }
}

/// A box's Blend If: `ranges[0]` is Gray, then R, G, B, each as `[this
/// layer, underlying layer]`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlendIf {
    pub ranges: [[Range; 2]; 4],
}

impl BlendIf {
    /// Whether no range hides anything (Photoshop's default).
    pub fn is_full(&self) -> bool {
        self.ranges.iter().flatten().all(Range::is_full)
    }

    /// Whether the This Layer sliders hide nothing.
    pub fn this_is_full(&self) -> bool {
        self.ranges.iter().all(|p| p[0].is_full())
    }

    /// How much of a pixel shows, given the box's own colour there (`this`,
    /// `None` where the box has no letters of its own) and the page's
    /// (`under`), both straight RGB on 0 to 1. Every range multiplies in;
    /// each side tests Gray, then R, G, B. Ported from PhotoCraft,
    /// `crates/compose/src/composite.rs` `blend_if_weight`.
    pub fn weight(&self, this: Option<[f32; 3]>, under: Option<[f32; 3]>) -> f32 {
        let mut k = 1.0;
        for (side, px) in [this, under].into_iter().enumerate() {
            let Some(p) = px else { continue };
            let v = p.map(level);
            k *= self.ranges[0][side].weight(gray(v[0], v[1], v[2]));
            for (c, &v) in v.iter().enumerate() {
                k *= self.ranges[c + 1][side].weight(v);
            }
            if k <= 0.0 {
                return 0.0;
            }
        }
        k
    }
}

/// A channel value on Blend If's 0 to 255 scale. Photoshop compares at its
/// 16-bit precision (0 to 32768): a value on the step of a whole level is
/// that level, which also absorbs the drift of un-premultiplying. Ported
/// from PhotoCraft, `crates/compose/src/composite.rs` `blend_if_level`.
pub fn level(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    let v = x * 255.0;
    let level = v.round();
    if (x * 32768.0).round() == (level * 32768.0 / 255.0).round() {
        level
    } else {
        v
    }
}

/// Blend If's Gray from channel levels: Photoshop's (30 R + 59 G + 11 B) /
/// 100, rounded half down on whole levels (measured by PhotoCraft in
/// Photoshop 2025: pure red passes a black point at 20 from 66, not 65).
/// Ported from PhotoCraft, `crates/compose/src/composite.rs`
/// `blend_if_gray`.
pub fn gray(r: f32, g: f32, b: f32) -> f32 {
    let sum = 30.0 * r + 59.0 * g + 11.0 * b;
    if [r, g, b].iter().all(|c| c.fract() == 0.0) {
        ((sum + 49.0) / 100.0).floor()
    } else {
        sum / 100.0
    }
}

/// Channels, then Blend If, on the finished box `s` within `bx`, as
/// PhotoCraft applies them to a composited layer (`composite_layer`:
/// `restore_channels`, then `apply_blend_if`).
///
/// `s` is in its over-the-page form (`blend::lay`): laid source-over on the
/// page it shows the box blended. So a channel left out is the page's
/// channel times the pixel's alpha, which shows the page's there, and
/// mixing the box back toward the page by `k` is scaling the premultiplied
/// pixel by `k`. `page` is the page under the surface, straight RGBA8 read
/// as opaque, one pixel to each of `s`'s. `this` is the box's own letters
/// on a clear surface (their colour is This Layer's), or `None` when no
/// This Layer slider hides anything.
pub(crate) fn restrict(
    s: &mut Surface,
    bx: IBox,
    blending: &Blending,
    page: &[u8],
    this: Option<&Surface>,
) {
    let w = s.width;
    let bx = bx.intersect(&IBox {
        x0: 0,
        y0: 0,
        x1: w as i32,
        y1: s.height as i32,
    });
    if bx.is_empty() || page.len() < s.data.len() {
        return;
    }
    let out = blending.channels_out & 7;
    let blend_if = &blending.blend_if;
    let gated = !blend_if.is_full();
    for y in bx.y0..bx.y1 {
        for x in bx.x0..bx.x1 {
            let i = y as usize * w + x as usize;
            let p = &mut s.data[i * 4..i * 4 + 4];
            let a = u32::from(p[3]);
            if a == 0 {
                continue;
            }
            let pg = &page[i * 4..i * 4 + 3];
            for c in 0..3 {
                if out & (1 << c) != 0 {
                    p[c] = ((u32::from(pg[c]) * a + 127) / 255) as u8;
                }
            }
            if !gated {
                continue;
            }
            let own = this.and_then(|t| {
                let q = &t.data[i * 4..i * 4 + 4];
                let qa = f32::from(q[3]);
                (q[3] > 0).then(|| {
                    [
                        f32::from(q[0]) / qa,
                        f32::from(q[1]) / qa,
                        f32::from(q[2]) / qa,
                    ]
                })
            });
            let under = [
                f32::from(pg[0]) / 255.0,
                f32::from(pg[1]) / 255.0,
                f32::from(pg[2]) / 255.0,
            ];
            let k = blend_if.weight(own, Some(under));
            if k >= 1.0 {
                continue;
            }
            for v in p.iter_mut() {
                *v = (f32::from(*v) * k + 0.5) as u8;
            }
        }
    }
}

/// How far the letters let a knocked-out drop shadow show under them (Layer
/// Knocks Out Drop Shadow): 0 covered, 1 knocked out wholly. In Normal (and
/// Dissolve) an opaque fill covers the shadow anyway, so only the
/// see-through share of the fill knocks it out, and the anti-aliased edges
/// are not cut twice. In any other mode the letters blend with what is under
/// them, shadow and all, and Photoshop keeps the shadow out from under them
/// wholly. `blends` is whether the letters do blend in `mode` (over a page,
/// or Dissolve); `no_fill` is a fill of nothing. Ported from PhotoCraft,
/// `crates/compose/src/effects/composite.rs` `shadow_see_through`.
pub fn shadow_see_through(mode: Blend, blends: bool, fill_opacity: f64, no_fill: bool) -> f32 {
    if no_fill {
        return 1.0;
    }
    if blends && !matches!(mode, Blend::Normal | Blend::Dissolve) {
        return 1.0;
    }
    (1.0 - fill_opacity.clamp(0.0, 1.0)) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flags_are_the_options_and_nothing_else() {
        assert_eq!(Blending::from_flags(0), Some(Blending::default()));
        assert_eq!(
            Blending::from_flags(1),
            Some(Blending {
                interior: true,
                ..Blending::default()
            })
        );
        assert_eq!(Blending::from_flags(2), None);
    }

    /// After PhotoCraft's `shadow_knockout_needs_see_through_fill` and
    /// `shadow_knockout_beneath_a_layer_in_a_blending_mode`
    /// (`crates/compose/src/tests.rs`): an opaque Normal layer knocks out
    /// nothing, a half fill half, a blending layer all of it.
    #[test]
    fn a_shadow_shows_through_what_the_fill_leaves() {
        assert_eq!(shadow_see_through(Blend::Normal, false, 1.0, false), 0.0);
        assert_eq!(shadow_see_through(Blend::Normal, false, 0.5, false), 0.5);
        assert_eq!(shadow_see_through(Blend::Normal, false, 0.0, false), 1.0);
        assert_eq!(shadow_see_through(Blend::Dissolve, true, 0.25, false), 0.75);
        assert_eq!(shadow_see_through(Blend::Multiply, true, 1.0, false), 1.0);
        // A mode with no page to blend with paints Normal.
        assert_eq!(shadow_see_through(Blend::Multiply, false, 1.0, false), 0.0);
        assert_eq!(shadow_see_through(Blend::Normal, false, 1.0, true), 1.0);
    }

    fn range(black: [u8; 2], white: [u8; 2]) -> Range {
        Range { black, white }
    }

    /// PhotoCraft's `full_range_shows_everything`,
    /// `unsplit_points_are_hard_thresholds` and `split_points_ramp_linearly`
    /// (`crates/doc/src/blend_if.rs`).
    #[test]
    fn a_range_shows_between_its_points_and_fades_across_a_split() {
        for v in [0.0, 0.5, 127.0, 254.9, 255.0] {
            assert_eq!(Range::FULL.weight(v), 1.0);
        }
        let hard = range([50, 50], [200, 200]);
        assert_eq!(hard.weight(49.9), 0.0);
        assert_eq!(hard.weight(50.0), 1.0);
        assert_eq!(hard.weight(200.0), 1.0);
        assert_eq!(hard.weight(200.1), 0.0);
        let split = range([0, 100], [155, 255]);
        assert_eq!(split.weight(0.0), 0.0);
        assert!((split.weight(50.0) - 0.5).abs() < 1e-6);
        assert_eq!(split.weight(100.0), 1.0);
        assert!((split.weight(205.0) - 0.5).abs() < 1e-6);
        assert_eq!(split.weight(255.0), 0.0);
    }

    #[test]
    fn a_range_out_of_order_is_refused() {
        assert_eq!(Range::from_bytes([0, 0, 255, 255]), Some(Range::FULL));
        assert_eq!(
            Range::from_bytes([10, 20, 230, 240]),
            Some(range([10, 20], [230, 240]))
        );
        assert_eq!(Range::from_bytes([20, 10, 230, 240]), None);
        assert_eq!(Range::from_bytes([10, 20, 240, 230]), None);
        assert_eq!(Range::from_bytes([10, 200, 100, 240]), None);
        // Black and white may meet.
        assert!(Range::from_bytes([128, 128, 128, 128]).is_some());
    }

    /// PhotoCraft's `blend_if_gray_follows_photoshops_weights_and_rounding`
    /// (`crates/compose/src/tests.rs`), on the weight alone.
    #[test]
    fn gray_is_photoshops_and_rounds_half_down() {
        let shown = |rgb: [u8; 3], black: u8, white: u8| {
            let mut b = BlendIf::default();
            b.ranges[0][1] = range([black, black], [white, white]);
            b.weight(None, Some(rgb.map(|v| f32::from(v) / 255.0))) > 0.999
        };
        for (cut, below, at) in [
            (20, [65, 0, 0], [66, 0, 0]),
            (25, [81, 0, 0], [82, 0, 0]),
            (20, [0, 33, 0], [0, 34, 0]),
            (20, [0, 0, 177], [0, 0, 178]),
            (28, [0, 0, 250], [0, 0, 251]),
        ] {
            assert!(!shown(below, cut, 255), "{below:?} hidden by black {cut}");
            assert!(shown(at, cut, 255), "{at:?} shown by black {cut}");
        }
        assert!(shown([123, 126, 151], 128, 255), "127.85 is 128");
        assert!(shown([120, 129, 149], 0, 128), "128.5 is 128");
        assert!(!shown([121, 129, 149], 0, 128), "128.8 is 129");
    }

    /// PhotoCraft's `blend_if_hard_point_includes_its_own_level`: a level
    /// passes a hard black point at itself.
    #[test]
    fn a_hard_point_takes_in_its_own_level() {
        for k in 0..=255u8 {
            let mut b = BlendIf::default();
            b.ranges[1][1] = range([k, k], [255, 255]);
            let v = f32::from(k) / 255.0;
            assert_eq!(b.weight(None, Some([v, 0.0, 0.0])), 1.0, "level {k}");
            // A few millionths of a level under it, as un-premultiplying
            // leaves it (PhotoCraft's 19.999998 for 20).
            let drift = (f32::from(k) - 2e-6) / 255.0;
            assert_eq!(b.weight(None, Some([drift, 0.0, 0.0])), 1.0, "level {k}");
        }
    }

    /// PhotoCraft's `blend_if_per_channel_ranges`: each side and channel
    /// counts on its own.
    #[test]
    fn this_layer_and_underlying_each_take_their_own_colour() {
        let mut b = BlendIf::default();
        // Blue, This Layer: hide a blue above 100.
        b.ranges[3][0] = range([0, 0], [100, 100]);
        assert_eq!(b.weight(Some([1.0, 0.0, 0.0]), Some([1.0; 3])), 1.0);
        assert_eq!(b.weight(Some([0.0, 0.0, 1.0]), Some([1.0; 3])), 0.0);
        // No letters of its own there: This Layer is not asked.
        assert_eq!(b.weight(None, Some([0.0, 0.0, 1.0])), 1.0);
        assert!(!b.this_is_full() && !b.is_full());
        // Red, Underlying: a page red above 254 hides everything.
        let mut u = BlendIf::default();
        u.ranges[1][1] = range([0, 0], [254, 254]);
        assert_eq!(u.weight(Some([1.0, 0.0, 0.0]), Some([1.0; 3])), 0.0);
        assert!(u.this_is_full());
    }

    #[test]
    fn only_channels_or_blend_if_restrict_the_blend() {
        assert!(!Blending::default().restricts());
        let mut b = Blending {
            interior: true,
            ..Blending::default()
        };
        assert!(!b.restricts());
        b.channels_out = 4;
        assert!(b.restricts());
        b.channels_out = 0;
        b.blend_if.ranges[2][1] = range([1, 1], [255, 255]);
        assert!(b.restricts());
    }
}
