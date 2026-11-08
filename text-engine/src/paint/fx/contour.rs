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
        let preset;
        let pts: &[Point] = match curve {
            Curve::Preset(n) => {
                let p = PRESETS.get(*n as usize).unwrap_or(&PRESETS[0]).1;
                preset = p
                    .iter()
                    .map(|&(x, y, corner)| Point {
                        x: x * 255.0,
                        y: y * 255.0,
                        corner,
                    })
                    .collect::<Vec<_>>();
                &preset
            }
            Curve::Points(pts) => pts,
        };
        let mut out = [0u8; 256];
        for (i, v) in out.iter_mut().enumerate() {
            let y = through(pts, i as f64 / 255.0).clamp(0.0, 1.0);
            *v = (y * 255.0).round() as u8;
        }
        Lut(out)
    }

    /// Whether the table changes nothing.
    pub fn is_identity(&self) -> bool {
        self.0.iter().enumerate().all(|(i, v)| *v as usize == i)
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
}

/// Photoshop's Range (glows and the bevel's contour): the curve is laid over
/// the inner `range` percent of the matte, so a smaller range pulls the whole
/// curve towards the far edge.
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

    #[test]
    fn range_pulls_the_curve_out() {
        assert_eq!(range(100, 100.0), 100);
        assert_eq!(range(100, 50.0), 200);
        assert_eq!(range(200, 50.0), 255);
    }
}
