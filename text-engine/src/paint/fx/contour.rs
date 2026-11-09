//! Contours: the curve an effect's matte is passed through.
//!
//! A shadow, a glow or a bevel makes a soft matte from the letters, 0 at its
//! far edge and 1 against them. A contour maps that 0..1 to another 0..1, so
//! the same blur can fall off in a ring, a cone or steps. Photoshop stores a
//! contour as points from 0 to 255, each smooth or a corner; this bakes it
//! into a 256-entry table that is read once a pixel.
//!
//! The twelve presets are Photoshop's own curves as PhotoCraft measured them
//! in Photoshop 27.11 (a Satin of each preset against a Linear one, read
//! back and thinned to within 1 %), straight segments between the points.
//! PhotoCraft does not use a contour's Anti-aliased box when it renders, and
//! matches Photoshop's renders without it; neither does this. The flag is
//! only carried, for the PSD.
//!
//! The preset points and the reading of a curve are PhotoCraft's
//! (`crates/engine/src/layer_style.rs` `CONTOURS`, `crates/compose/src/
//! adjust/tone.rs` `contour_curve_lut`), Copyright (c) 2026 ArtCraft Team
//! and the PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).

use crate::paint::budget;
use crate::Error;

/// A contour as the style states it.
#[derive(Clone, Debug, PartialEq)]
pub enum Curve {
    /// One of the twelve built-in curves, by its number (`PRESETS`).
    Preset(u32),
    /// Points from 0 to 255 in both directions, in order of `x`. A corner
    /// point breaks the curve there; between corners it is one smooth curve.
    Points(Vec<Point>),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub corner: bool,
}

/// The presets, in wire order (Photoshop's picker order): a name and the
/// curve's points, input to output, both 0 to 1, and whether each is a
/// corner.
pub const PRESETS: [(&str, &[(f64, f64, bool)]); 12] = [
    ("Linear", &[(0.0, 0.0, false), (1.0, 1.0, false)]),
    (
        "Cone",
        &[
            (0.0, 0.0, false),
            (0.172, 0.477, true),
            (0.195, 0.555, true),
            (0.266, 0.711, true),
            (0.383, 0.922, true),
            (0.43, 0.969, true),
            (0.477, 0.992, true),
            (0.523, 0.992, true),
            (0.57, 0.969, true),
            (0.664, 0.859, true),
            (0.703, 0.789, true),
            (0.742, 0.711, true),
            (0.836, 0.477, true),
            (0.859, 0.398, true),
            (0.914, 0.266, true),
            (0.945, 0.156, true),
            (0.977, 0.078, true),
            (1.0, 0.0, false),
        ],
    ),
    (
        "Cone - Inverted",
        &[
            (0.0, 1.0, false),
            (0.031, 0.922, true),
            (0.07, 0.789, true),
            (0.172, 0.523, true),
            (0.195, 0.445, true),
            (0.266, 0.289, true),
            (0.383, 0.078, true),
            (0.43, 0.031, true),
            (0.477, 0.008, true),
            (0.523, 0.008, true),
            (0.57, 0.031, true),
            (0.664, 0.141, true),
            (0.703, 0.211, true),
            (0.742, 0.289, true),
            (0.836, 0.523, true),
            (0.859, 0.602, true),
            (0.914, 0.734, true),
            (0.945, 0.844, true),
            (0.977, 0.922, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Cove - Deep",
        &[
            (0.0, 0.258, false),
            (0.344, 0.289, true),
            (0.383, 0.297, true),
            (0.477, 0.352, true),
            (0.57, 0.43, true),
            (0.617, 0.484, true),
            (0.664, 0.57, true),
            (0.703, 0.711, true),
            (0.742, 0.906, true),
            (0.773, 1.0, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Cove - Shallow",
        &[
            (0.0, 0.0, false),
            (0.008, 0.164, true),
            (0.016, 0.477, true),
            (0.039, 0.508, true),
            (0.172, 0.57, true),
            (0.305, 0.688, true),
            (0.344, 0.734, true),
            (0.477, 0.945, true),
            (0.523, 1.0, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Gaussian",
        &[
            (0.0, 0.0, false),
            (0.117, 0.023, true),
            (0.172, 0.055, true),
            (0.234, 0.117, true),
            (0.305, 0.234, true),
            (0.383, 0.414, true),
            (0.523, 0.688, true),
            (0.617, 0.812, true),
            (0.703, 0.891, true),
            (0.805, 0.953, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Half Round",
        &[
            (0.0, 0.0, false),
            (0.07, 0.18, true),
            (0.195, 0.445, true),
            (0.266, 0.555, true),
            (0.383, 0.703, true),
            (0.523, 0.828, true),
            (0.617, 0.883, true),
            (0.773, 0.945, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Ring",
        &[
            (0.0, 0.0, false),
            (0.031, 0.078, true),
            (0.039, 0.117, true),
            (0.117, 0.383, true),
            (0.172, 0.609, true),
            (0.195, 0.734, true),
            (0.266, 0.953, true),
            (0.305, 1.0, true),
            (0.344, 0.992, true),
            (0.383, 0.922, true),
            (0.43, 0.805, true),
            (0.477, 0.641, true),
            (0.57, 0.281, true),
            (0.617, 0.141, true),
            (0.664, 0.055, true),
            (0.703, 0.016, true),
            (0.742, 0.016, true),
            (0.773, 0.062, true),
            (0.836, 0.234, true),
            (0.859, 0.344, true),
            (0.891, 0.445, true),
            (0.914, 0.547, true),
            (0.945, 0.734, true),
            (0.977, 0.875, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Ring - Double",
        &[
            (0.0, 0.0, false),
            (0.055, 0.086, true),
            (0.094, 0.172, true),
            (0.117, 0.242, true),
            (0.172, 0.477, true),
            (0.195, 0.625, true),
            (0.266, 0.891, true),
            (0.305, 0.945, true),
            (0.344, 0.891, true),
            (0.383, 0.695, true),
            (0.43, 0.367, true),
            (0.477, 0.07, true),
            (0.523, 0.047, true),
            (0.57, 0.32, true),
            (0.617, 0.648, true),
            (0.664, 0.867, true),
            (0.703, 0.93, true),
            (0.742, 0.852, true),
            (0.773, 0.641, true),
            (0.805, 0.375, true),
            (0.836, 0.156, true),
            (0.859, 0.031, true),
            (0.891, 0.023, true),
            (0.914, 0.109, true),
            (0.977, 0.703, true),
            (0.984, 0.82, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Rolling Slope - Descending",
        &[
            (0.0, 1.0, false),
            (0.008, 1.0, true),
            (0.031, 0.93, true),
            (0.039, 0.883, true),
            (0.07, 0.758, true),
            (0.141, 0.539, true),
            (0.195, 0.406, true),
            (0.266, 0.352, true),
            (0.305, 0.352, true),
            (0.523, 0.57, true),
            (0.57, 0.602, true),
            (0.617, 0.617, true),
            (0.703, 0.602, true),
            (0.742, 0.562, true),
            (0.836, 0.391, true),
            (0.914, 0.211, true),
            (0.945, 0.109, true),
            (0.977, 0.039, true),
            (0.984, 0.008, true),
            (1.0, 0.0, false),
        ],
    ),
    (
        "Rounded Steps",
        &[
            (0.0, 0.234, false),
            (0.031, 0.305, true),
            (0.039, 0.336, true),
            (0.094, 0.43, true),
            (0.141, 0.477, true),
            (0.234, 0.492, true),
            (0.266, 0.516, true),
            (0.305, 0.602, true),
            (0.344, 0.664, true),
            (0.383, 0.711, true),
            (0.477, 0.734, true),
            (0.523, 0.797, true),
            (0.57, 0.898, true),
            (0.617, 0.953, true),
            (0.664, 0.984, true),
            (0.773, 0.984, true),
            (0.836, 0.906, true),
            (0.891, 0.891, true),
            (0.914, 0.898, true),
            (1.0, 1.0, false),
        ],
    ),
    (
        "Sawtooth 1",
        &[
            (0.0, 0.0, false),
            (0.031, 0.047, true),
            (0.195, 0.375, true),
            (0.266, 0.492, true),
            (0.477, 0.047, true),
            (0.523, 0.055, true),
            (0.742, 0.469, true),
            (0.773, 0.445, true),
            (0.914, 0.18, true),
            (0.945, 0.102, true),
            (1.0, 0.0, false),
        ],
    ),
];

/// The presets' names, in wire order.
pub fn preset_name(n: u32) -> Option<&'static str> {
    PRESETS.get(n as usize).map(|p| p.0)
}

/// Most points a custom curve may have. Photoshop's curve editor stops at 16.
pub const MAX_POINTS: usize = 64;

/// A contour baked to a table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lut(pub [u8; 256]);

impl Lut {
    /// The table that changes nothing.
    pub fn identity() -> Self {
        let mut t = [0u8; 256];
        for (i, v) in t.iter_mut().enumerate() {
            *v = i as u8;
        }
        Lut(t)
    }

    /// `curve` baked.
    pub fn new(curve: &Curve) -> Self {
        let pts = points(curve);
        let mut out = [0u8; 256];
        for (i, v) in out.iter_mut().enumerate() {
            let y = through(&pts, i as f64 / 255.0).clamp(0.0, 1.0);
            *v = (y * 255.0).round() as u8;
        }
        Lut(out)
    }

    /// Whether the table changes nothing.
    pub fn is_identity(&self) -> bool {
        self.0.iter().enumerate().all(|(i, v)| *v as usize == i)
    }

    /// Satin's table: the contour read from its far end, `|c(1 - v) - c(1)|`.
    /// Measured by PhotoCraft in Photoshop 27.11: Cone and Cone - Inverted
    /// Satins are identical, and a Gaussian Satin runs under the diagonal
    /// (0.36 at 0.5) while the same Gaussian on a glow runs over it (0.65).
    /// Linear stays Linear. Ported from PhotoCraft
    /// `crates/compose/src/effects/paint.rs` `satin_lut`.
    pub fn satin(&self) -> Self {
        let end = i16::from(self.0[255]);
        let mut out = [0u8; 256];
        for (i, v) in out.iter_mut().enumerate() {
            *v = (i16::from(self.0[255 - i]) - end).unsigned_abs() as u8;
        }
        Lut(out)
    }

    pub fn apply(&self, v: u8) -> u8 {
        self.0[v as usize]
    }

    /// The table at `v` from 0 to 1, read between its entries.
    pub fn at(&self, v: f32) -> f32 {
        let x = v.clamp(0.0, 1.0) * 255.0;
        let i = x.floor() as usize;
        let j = (i + 1).min(255);
        let (a, b) = (f32::from(self.0[i]), f32::from(self.0[j]));
        (a + (b - a) * (x - i as f32)) / 255.0
    }

    /// [`Lut::at`] with the edge hidden, for the effects that spread out
    /// past the letters (an Outer Glow, a Drop Shadow): a contour that does
    /// not start at 0 (Cone - Inverted, Cove - Deep) lifts the ground to its
    /// value at 0, which would fill the whole rectangle the effect is worked
    /// out over. That floor is taken away near 0, along a ramp on the input
    /// ([`edge_hide`]), so where the matte is 0 the effect is too. A contour
    /// that starts at 0 (Linear, Cone, Gaussian) is left exactly as it is.
    /// The plan's B4 rule, after the behaviour Krita's layer styles have
    /// with `edgeHidden` on for these two effects.
    pub fn at_hidden(&self, v: f32) -> f32 {
        let out = self.at(v);
        if self.0[0] == 0 {
            return out;
        }
        (out - self.at(0.0) * (1.0 - edge_hide(v))).max(0.0)
    }

    /// [`Lut::apply`] with the edge hidden, as [`Lut::at_hidden`].
    pub fn apply_hidden(&self, v: u8) -> u8 {
        let out = self.apply(v);
        if self.0[0] == 0 {
            return out;
        }
        let floor = f32::from(self.0[0]) * (1.0 - edge_hide(f32::from(v) / 255.0));
        ((f32::from(out) - floor).max(0.0) + 0.5) as u8
    }
}

/// How far up a matte, 0 to 1, the edge-hide ramp runs: 8 levels.
pub const EDGE_HIDE: f32 = 8.0 / 255.0;

/// The edge-hide ramp at matte `v`: 0 at 0, rising straight to 1 at
/// [`EDGE_HIDE`]. Ours: a fixed ramp near 0, as the plan's B4 asks; its
/// length is not measured against Photoshop.
pub fn edge_hide(v: f32) -> f32 {
    if v.is_nan() {
        return 0.0;
    }
    (v / EDGE_HIDE).clamp(0.0, 1.0)
}

/// A curve's points from 0 to 255, a preset's read from its table.
fn points(curve: &Curve) -> std::borrow::Cow<'_, [Point]> {
    match curve {
        Curve::Preset(n) => {
            let p = PRESETS.get(*n as usize).unwrap_or(&PRESETS[0]).1;
            p.iter()
                .map(|&(x, y, corner)| Point {
                    x: x * 255.0,
                    y: y * 255.0,
                    corner,
                })
                .collect::<Vec<_>>()
                .into()
        }
        Curve::Points(pts) => {
            // A smooth point that shares its x with another has no curve
            // through it: the spline would floor the gap and run to 0 or 255
            // (review F13). At a repeated x the corners stay (two are a
            // vertical step) and the smooth points go, whether before or
            // after them; with no corner there, the first smooth point stays.
            // As PhotoCraft's `contour_curve_lut` dedups before its fit, and
            // as the app's `normalizeContour` does.
            let keep = |i: usize| {
                let x = pts[i].x;
                let (mut lo, mut hi) = (i, i);
                while lo > 0 && pts[lo - 1].x == x {
                    lo -= 1;
                }
                while hi + 1 < pts.len() && pts[hi + 1].x == x {
                    hi += 1;
                }
                if pts[lo..=hi].iter().any(|p| p.corner) {
                    pts[i].corner
                } else {
                    i == lo
                }
            };
            if (0..pts.len()).all(keep) {
                pts.as_slice().into()
            } else {
                (0..pts.len())
                    .filter(|&i| keep(i))
                    .map(|i| pts[i])
                    .collect::<Vec<_>>()
                    .into()
            }
        }
    }
}

/// A contour baked to [`Table::LEN`] floats from 0 to 1, read between its
/// entries: the bevel's Contour (on the height map) and its Gloss Contour
/// (on the shading). Not the 8-bit [`Lut`]: the bevel's shading is the
/// slope of the height map times `depth * size`, and a height in steps of
/// 1/255 shades as a staircase of noise. PhotoCraft's table is 4096 floats
/// too (`crates/compose/src/effects/paint.rs` `bevel_contour_lut`, `lut_at`;
/// `crates/compose/src/adjust/tone.rs` `contour_curve_lut`), Copyright (c)
/// 2026 ArtCraft Team and the PhotoCraft contributors, MIT licence.
#[derive(Clone, Debug, PartialEq)]
pub struct Table(Vec<f32>);

impl Table {
    pub const LEN: usize = 4096;

    /// `curve` baked, or `None` when it changes nothing (Linear).
    pub fn new(curve: &Curve) -> Option<Self> {
        let mut v = Vec::with_capacity(Self::LEN);
        Self::bake(curve, &mut v);
        Self::unless_linear(v)
    }

    /// [`Table::new`] for a decoded record: the table is charged to the
    /// painter's budget for the paint, as the record's other vectors are.
    pub fn charged(curve: &Curve) -> Result<Option<Self>, Error> {
        let mut v = Vec::new();
        budget::reserve_raw(&mut v, Self::LEN)?;
        Self::bake(curve, &mut v);
        Ok(Self::unless_linear(v))
    }

    /// [`Table::charged`] for a ticked bevel Contour: Linear too is a
    /// table, so the height still goes through it and is clamped to 0 to 1
    /// (a chisel's outer ramp tops out past 1). PhotoCraft's
    /// `bevel_contour_lut` bakes the identity for Linear and reads every
    /// height through it (`lut_at` clamps).
    pub fn charged_on(curve: &Curve) -> Result<Self, Error> {
        let mut v = Vec::new();
        budget::reserve_raw(&mut v, Self::LEN)?;
        Self::bake(curve, &mut v);
        Ok(Table(v))
    }

    fn bake(curve: &Curve, out: &mut Vec<f32>) {
        let pts = points(curve);
        let n = Self::LEN - 1;
        out.extend((0..=n).map(|k| through(&pts, k as f64 / n as f64).clamp(0.0, 1.0) as f32));
    }

    fn unless_linear(v: Vec<f32>) -> Option<Self> {
        let n = Self::LEN - 1;
        let linear = v
            .iter()
            .enumerate()
            .all(|(k, y)| (y - k as f32 / n as f32).abs() < 1e-5);
        (!linear).then_some(Table(v))
    }

    /// The table at `v`, clamped to 0 to 1, read between its entries
    /// (PhotoCraft `lut_at`).
    pub fn at(&self, v: f32) -> f32 {
        let l = &self.0;
        let x = if v.is_nan() { 0.0 } else { v.clamp(0.0, 1.0) } * (l.len() - 1) as f32;
        let i = x.floor() as usize;
        let j = (i + 1).min(l.len() - 1);
        l[i] + (l[j] - l[i]) * (x - i as f32)
    }
}

/// Photoshop's Range on a byte, as a stretch of the curve's input. Nothing in
/// the paint calls it: the glows apply their Range in [`super::map::ranged`],
/// and the bevel's contour carries one that PhotoCraft found no `v / range`
/// stretch matching Photoshop for, so the bevel applies none. Only the tests
/// here use it. The curve is laid over the inner `range` percent of the
/// matte, so a smaller range pulls the whole curve towards the far edge.
pub fn range(v: u8, range: f64) -> u8 {
    if range >= 100.0 {
        return v;
    }
    let r = range.max(1.0);
    (f64::from(v) * 100.0 / r).min(255.0) as u8
}

/// A curve through `pts` (0..255) at `t` (0..1): straight before the first
/// point and after the last, and a natural cubic spline through each run of
/// points between corners.
fn through(pts: &[Point], t: f64) -> f64 {
    let x = t * 255.0;
    let Some(first) = pts.first() else {
        return t;
    };
    let last = pts[pts.len() - 1];
    if pts.len() == 1 || x <= first.x {
        return first.y / 255.0;
    }
    if x >= last.x {
        return last.y / 255.0;
    }
    // The run of points between corners that holds `x`.
    let seg = pts
        .windows(2)
        .position(|w| x >= w[0].x && x <= w[1].x)
        .unwrap_or(0);
    let mut lo = seg;
    while lo > 0 && !pts[lo].corner {
        lo -= 1;
    }
    let mut hi = seg + 1;
    while hi < pts.len() - 1 && !pts[hi].corner {
        hi += 1;
    }
    spline(&pts[lo..=hi], x) / 255.0
}

/// A natural cubic spline through `pts` at `x`, which is within them.
fn spline(pts: &[Point], x: f64) -> f64 {
    let n = pts.len();
    if n == 2 {
        let (a, b) = (pts[0], pts[1]);
        let w = b.x - a.x;
        return if w > 0.0 {
            a.y + (b.y - a.y) * (x - a.x) / w
        } else {
            b.y
        };
    }
    // Second derivatives by the tridiagonal system, zero at both ends.
    let mut m = vec![0.0f64; n];
    let mut c = vec![0.0f64; n];
    let mut d = vec![0.0f64; n];
    for i in 1..n - 1 {
        let h0 = (pts[i].x - pts[i - 1].x).max(1e-9);
        let h1 = (pts[i + 1].x - pts[i].x).max(1e-9);
        let rhs = 6.0 * ((pts[i + 1].y - pts[i].y) / h1 - (pts[i].y - pts[i - 1].y) / h0);
        let diag = 2.0 * (h0 + h1) - h0 * c[i - 1];
        c[i] = h1 / diag;
        d[i] = (rhs - h0 * d[i - 1]) / diag;
    }
    for i in (1..n - 1).rev() {
        m[i] = d[i] - c[i] * m[i + 1];
    }
    let i = pts.windows(2).position(|w| x <= w[1].x).unwrap_or(n - 2);
    let (a, b) = (pts[i], pts[i + 1]);
    let h = (b.x - a.x).max(1e-9);
    let u = (b.x - x) / h;
    let v = (x - a.x) / h;
    u * a.y + v * b.y + ((u * u * u - u) * m[i] + (v * v * v - v) * m[i + 1]) * h * h / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_is_identity() {
        assert!(Lut::new(&Curve::Preset(0)).is_identity());
        assert!(Lut::identity().is_identity());
    }

    #[test]
    fn every_preset_runs_from_0_to_1_and_stays_in_range() {
        for (name, pts) in PRESETS {
            assert!(pts.len() >= 2, "{name}");
            assert_eq!(pts[0].0, 0.0, "{name}");
            assert_eq!(pts[pts.len() - 1].0, 1.0, "{name}");
            assert!(pts.windows(2).all(|w| w[0].0 < w[1].0), "{name}");
            assert!(pts.iter().all(|p| (0.0..=1.0).contains(&p.1)), "{name}");
        }
        assert_eq!(preset_name(2), Some("Cone - Inverted"));
        assert_eq!(preset_name(12), None);
    }

    #[test]
    fn presets_read_as_their_points() {
        // Cone peaks in the middle and is 0 at both ends; Cone - Inverted the
        // reverse.
        let cone = Lut::new(&Curve::Preset(1));
        assert_eq!(cone.apply(0), 0);
        assert!(cone.apply(128) > 250);
        assert_eq!(cone.apply(255), 0);
        let inverted = Lut::new(&Curve::Preset(2));
        assert_eq!(inverted.apply(0), 255);
        assert!(inverted.apply(128) < 5);
        // Between two points, straight.
        let half = Lut::new(&Curve::Preset(6));
        let (a, b) = (PRESETS[6].1[1], PRESETS[6].1[2]);
        let mid = (a.0 + b.0) / 2.0;
        let want = (a.1 + b.1) / 2.0 * 255.0;
        assert!((f64::from(half.apply((mid * 255.0).round() as u8)) - want).abs() <= 2.0);
    }

    #[test]
    fn points_pass_through_and_corners_break() {
        let p = |x: f64, y: f64, corner: bool| Point { x, y, corner };
        let smooth = vec![
            p(0.0, 0.0, false),
            p(128.0, 200.0, false),
            p(255.0, 255.0, false),
        ];
        let l = Lut::new(&Curve::Points(smooth));
        assert_eq!(l.apply(0), 0);
        assert!((i32::from(l.apply(128)) - 200).abs() <= 1);
        assert_eq!(l.apply(255), 255);
        // A corner in the middle is two straight runs.
        let cone = vec![
            p(0.0, 0.0, false),
            p(128.0, 255.0, true),
            p(255.0, 0.0, false),
        ];
        let l = Lut::new(&Curve::Points(cone));
        assert!((i32::from(l.apply(64)) - 128).abs() <= 1);
    }

    /// Review F13: two smooth points at x 128 (the report's curve) once ran
    /// the spline to 0 and 255 ([0, 255, 255, ..., 0, 0, 0, 60, 255]). The
    /// second is dropped; the curve runs through the rest.
    #[test]
    fn a_smooth_point_at_a_repeated_x_is_dropped() {
        let p = |x: f64, y: f64, corner: bool| Point { x, y, corner };
        let pts = vec![
            p(0.0, 0.0, false),
            p(100.0, 50.0, false),
            p(128.0, 60.0, false),
            p(128.0, 200.0, false),
            p(255.0, 255.0, false),
        ];
        let l = Lut::new(&Curve::Points(pts.clone()));
        let want = Lut::new(&Curve::Points(vec![
            p(0.0, 0.0, false),
            p(100.0, 50.0, false),
            p(128.0, 60.0, false),
            p(255.0, 255.0, false),
        ]));
        assert_eq!(l, want);
        assert_eq!(l.apply(0), 0);
        assert!(
            (i32::from(l.apply(100)) - 50).abs() <= 1,
            "{}",
            l.apply(100)
        );
        assert!(
            (i32::from(l.apply(128)) - 60).abs() <= 1,
            "{}",
            l.apply(128)
        );
        assert_eq!(l.apply(255), 255);
        // No run to the ends anywhere along it.
        assert!(l.0[1..250].iter().all(|&v| v > 0 && v < 255), "{:?}", l.0);
        // The float table alike.
        let t = Table::new(&Curve::Points(pts)).unwrap();
        assert!((t.at(128.0 / 255.0) - 60.0 / 255.0).abs() < 1e-3);
        assert!((0..=64).all(|k| {
            let v = t.at(k as f32 / 64.0);
            k == 0 || k == 64 || (v > 0.0 && v < 1.0)
        }));
        // A corner pair at one x stays: a vertical step from 60 to 200.
        let step = Lut::new(&Curve::Points(vec![
            p(0.0, 0.0, false),
            p(128.0, 60.0, true),
            p(128.0, 200.0, true),
            p(255.0, 255.0, false),
        ]));
        assert!(
            (i32::from(step.apply(127)) - 60).abs() <= 1,
            "{}",
            step.apply(127)
        );
        assert!(
            (i32::from(step.apply(129)) - 200).abs() <= 1,
            "{}",
            step.apply(129)
        );
        // A smooth point and a corner at one x, either way round: the
        // corner stays, the smooth one goes, and the curve below 128 does
        // not collapse to 0.
        for pair in [
            [p(128.0, 60.0, false), p(128.0, 200.0, true)],
            [p(128.0, 200.0, true), p(128.0, 60.0, false)],
        ] {
            let mut pts = vec![p(0.0, 0.0, false), p(100.0, 50.0, false)];
            pts.extend(pair);
            pts.push(p(255.0, 255.0, false));
            let l = Lut::new(&Curve::Points(pts));
            let want = Lut::new(&Curve::Points(vec![
                p(0.0, 0.0, false),
                p(100.0, 50.0, false),
                p(128.0, 200.0, true),
                p(255.0, 255.0, false),
            ]));
            assert_eq!(l, want);
            assert!(
                (i32::from(l.apply(100)) - 50).abs() <= 1,
                "{}",
                l.apply(100)
            );
            // The run from 100 up to the corner climbs from 50, not 0.
            assert!(l.0[100..128].iter().all(|&v| v >= 49), "{:?}", &l.0[..128]);
        }
    }

    /// Review F7: the edge-hide ramp keeps 0 at 0 whatever the curve.
    #[test]
    fn the_hidden_edge_is_nothing_at_nothing() {
        let inverted = Lut::new(&Curve::Preset(2));
        let deep = Lut::new(&Curve::Preset(3));
        assert_eq!((inverted.apply(0), deep.apply(0)), (255, 66));
        assert_eq!((inverted.apply_hidden(0), deep.apply_hidden(0)), (0, 0));
        assert_eq!((inverted.at_hidden(0.0), deep.at_hidden(0.0)), (0.0, 0.0));
        // Past the ramp, the curve as it is.
        for v in [8u8, 64, 200, 255] {
            assert_eq!(inverted.apply_hidden(v), inverted.apply(v));
            assert_eq!(deep.apply_hidden(v), deep.apply(v));
        }
        // Half way up it, half the floor taken away.
        let half = (f32::from(inverted.apply(4)) - 127.5).max(0.0);
        assert_eq!(inverted.apply_hidden(4), (half + 0.5) as u8);
    }

    /// Review F7 follow-up: a contour that starts at 0 keeps every level,
    /// the faint ones near 0 too (Cone's 3 at 1 and 11 at 4 were once
    /// damped to 0 and 6).
    #[test]
    fn a_contour_from_0_is_not_touched_by_the_hidden_edge() {
        let cone = Lut::new(&Curve::Preset(1));
        assert_eq!((cone.apply(1), cone.apply(4)), (3, 11));
        for n in 0..PRESETS.len() as u32 {
            let l = Lut::new(&Curve::Preset(n));
            if l.apply(0) != 0 {
                continue;
            }
            for v in 0..=255u8 {
                assert_eq!(l.apply_hidden(v), l.apply(v), "{n} at {v}");
                let f = f32::from(v) / 255.0;
                assert_eq!(l.at_hidden(f), l.at(f), "{n} at {v}");
            }
        }
        assert_eq!(Lut::identity().apply_hidden(3), 3);
    }

    #[test]
    fn satin_reads_the_contour_from_its_far_end() {
        // Linear stays Linear.
        assert!(Lut::identity().satin().is_identity());
        // Photoshop draws Cone and Cone - Inverted Satins alike (the
        // measured curves agree to within their 1 % thinning).
        let cone = Lut::new(&Curve::Preset(1)).satin();
        let inverted = Lut::new(&Curve::Preset(2)).satin();
        for i in 0..256 {
            let d = (i32::from(cone.0[i]) - i32::from(inverted.0[i])).abs();
            assert!(d <= 6, "{i}: {} vs {}", cone.0[i], inverted.0[i]);
        }
        // A Gaussian Satin runs under the diagonal at the middle.
        assert!(Lut::new(&Curve::Preset(5)).satin().apply(128) < 128);
    }

    #[test]
    fn the_float_table_is_the_curve_and_linear_is_none() {
        assert!(Table::new(&Curve::Preset(0)).is_none());
        let p = |x: f64, y: f64| Point {
            x,
            y,
            corner: false,
        };
        assert!(Table::new(&Curve::Points(vec![p(0.0, 0.0), p(255.0, 255.0)])).is_none());
        for n in 1..PRESETS.len() as u32 {
            let c = Curve::Preset(n);
            let t = Table::new(&c).expect("not linear");
            let pts = points(&c);
            for k in 0..=64 {
                let v = k as f64 / 64.0;
                let want = through(&pts, v).clamp(0.0, 1.0);
                assert!(
                    (f64::from(t.at(v as f32)) - want).abs() < 1e-3,
                    "{n} at {v}"
                );
            }
            // Clamped at both ends.
            assert_eq!(t.at(-1.0), t.at(0.0));
            assert_eq!(t.at(2.0), t.at(1.0));
        }
        // Finer than the 8-bit table: a gentle curve keeps steps far below
        // 1/255.
        let t = Table::new(&Curve::Points(vec![
            p(0.0, 0.0),
            p(128.0, 100.0),
            p(255.0, 255.0),
        ]))
        .unwrap();
        let step = (t.at(0.5 + 1.0 / 4095.0) - t.at(0.5)).abs();
        assert!(step < 1.0 / 1000.0, "{step}");
    }

    #[test]
    fn range_pulls_the_curve_out() {
        assert_eq!(range(100, 100.0), 100);
        assert_eq!(range(100, 50.0), 200);
        assert_eq!(range(200, 50.0), 255);
    }

    #[test]
    fn a_decoded_table_is_charged_to_the_budget() {
        use crate::paint::budget;
        let cone = Curve::Preset(1);
        {
            let _scope = budget::Scope::new();
            assert_eq!(Table::charged(&cone).unwrap(), Table::new(&cone));
            assert_eq!(budget::peak_for_test(), Table::LEN * 4);
        }
        budget::limit_next_scope_for_test(Table::LEN * 4 - 1);
        let _scope = budget::Scope::new();
        assert_eq!(Table::charged(&cone), Err(Error::BadSpec));
    }
}
