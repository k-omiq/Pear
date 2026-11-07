//! Contours: the curve an effect's matte is passed through.
//!
//! A shadow, a glow or a bevel makes a soft matte from the letters, 0 at its
//! far edge and 1 against them. A contour maps that 0..1 to another 0..1, so
//! the same blur can fall off in a ring, a cone or steps. Photoshop stores a
//! contour as points from 0 to 255, each smooth or a corner; this bakes it
//! into a 256-entry table that is read once a pixel.
//!
//! The twelve presets are drawn from their shapes in Photoshop's picker, not
//! from Adobe's own point lists, which are not published. A Photoshop golden
//! fixes each (LAYER_STYLES_PLAN.md, G3).

/// A contour as the style states it.
#[derive(Clone, Debug, PartialEq)]
pub enum Curve {
    /// One of the twelve built-in curves, by its number (`PRESET_NAMES`).
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

/// The presets' names, in wire order: Photoshop's picker order.
pub const PRESET_NAMES: [&str; 12] = [
    "Linear",
    "Cone",
    "Cone - Inverted",
    "Cove - Deep",
    "Cove - Shallow",
    "Gaussian",
    "Half Round",
    "Ring",
    "Ring - Double",
    "Rolling Slope - Descending",
    "Rounded Steps",
    "Sawtooth 1",
];

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
    ///
    /// `aa` is Photoshop's Anti-aliased box: off, the curve is read at a
    /// hundred steps only, so a curve that turns sharply shows bands as
    /// Photoshop's does; on, at every level. `edge_hidden` is for an effect
    /// that lies outside the letters (a drop shadow, an outer glow): the
    /// curve is faded to nothing over the last tenth of the matte, so a curve
    /// that is high at 0 does not flood the whole surface.
    pub fn new(curve: &Curve, aa: bool, edge_hidden: bool) -> Self {
        let f = |t: f64| -> f64 {
            match curve {
                Curve::Preset(n) => preset(*n, t),
                Curve::Points(pts) => through(pts, t),
            }
        };
        let mut out = [0u8; 256];
        for (i, v) in out.iter_mut().enumerate() {
            let at = if aa {
                i as f64
            } else {
                // A hundred steps across 0..255.
                ((i as f64 / 2.55).floor() * 2.55).round()
            };
            let mut y = f(at / 255.0).clamp(0.0, 1.0);
            if edge_hidden {
                y *= (i as f64 / EDGE_RAMP).min(1.0);
            }
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
}

/// How many matte levels the edge fade of an outer effect spans.
const EDGE_RAMP: f64 = 23.0;

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

fn smoothstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Preset number `n` at `t`, both 0..1. Past the last preset, Linear.
fn preset(n: u32, t: f64) -> f64 {
    use core::f64::consts::PI;
    match n {
        // Cone: up to full at the middle, down again, a sharp peak.
        1 => 1.0 - (2.0 * t - 1.0).abs(),
        2 => (2.0 * t - 1.0).abs(),
        // Coves: hollow, the deep one far more.
        3 => t.powf(3.0),
        4 => t.powf(1.6),
        // An S: slow at both ends.
        5 => smoothstep(smoothstep(t)),
        // A quarter circle, bulging up.
        6 => (1.0 - (1.0 - t) * (1.0 - t)).max(0.0).sqrt(),
        // A rounded hump, and two.
        7 => (PI * t).sin().powi(2),
        8 => (2.0 * PI * t).sin().powi(2),
        // Falls from full to none in two rolls.
        9 => {
            let base = 1.0 - t;
            (base + 0.12 * (3.0 * PI * t).sin()).clamp(0.0, 1.0)
        }
        // Four flat levels joined by smooth steps.
        10 => {
            let k = t * 4.0;
            if k >= 4.0 {
                return 1.0;
            }
            let step = k.floor();
            (step + smoothstep((k - step - 0.75) / 0.25)) / 4.0
        }
        // Two teeth: up, drop, up.
        11 => {
            let k = (t * 2.0).min(1.999_999);
            k - k.floor()
        }
        _ => t,
    }
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
    fn linear_with_aa_is_identity() {
        assert!(Lut::new(&Curve::Preset(0), true, false).is_identity());
        assert!(Lut::identity().is_identity());
    }

    #[test]
    fn linear_without_aa_steps() {
        let l = Lut::new(&Curve::Preset(0), false, false);
        assert!(!l.is_identity());
        // A hundred levels at most.
        let mut levels: Vec<u8> = l.0.to_vec();
        levels.dedup();
        assert!(levels.len() <= 101, "{}", levels.len());
    }

    #[test]
    fn every_preset_starts_and_ends_in_range() {
        for n in 0..PRESET_NAMES.len() as u32 {
            for i in 0..=100 {
                let y = preset(n, f64::from(i) / 100.0);
                assert!((0.0..=1.0 + 1e-9).contains(&y), "preset {n} at {i}: {y}");
            }
        }
        assert!((preset(1, 0.5) - 1.0).abs() < 1e-9);
        assert!(preset(2, 0.5).abs() < 1e-9);
        assert!((preset(6, 1.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn edge_hidden_fades_the_far_edge() {
        let inv = Lut::new(&Curve::Preset(2), true, true);
        assert_eq!(inv.apply(0), 0);
        assert!(inv.apply(10) < 128);
        assert_eq!(inv.apply(255), 255);
    }

    #[test]
    fn points_pass_through_and_corners_break() {
        let p = |x: f64, y: f64, corner: bool| Point { x, y, corner };
        let smooth = vec![
            p(0.0, 0.0, false),
            p(128.0, 200.0, false),
            p(255.0, 255.0, false),
        ];
        let l = Lut::new(&Curve::Points(smooth), true, false);
        assert_eq!(l.apply(0), 0);
        assert!((i32::from(l.apply(128)) - 200).abs() <= 1);
        assert_eq!(l.apply(255), 255);
        // A corner in the middle is two straight runs.
        let cone = vec![
            p(0.0, 0.0, false),
            p(128.0, 255.0, true),
            p(255.0, 0.0, false),
        ];
        let l = Lut::new(&Curve::Points(cone), true, false);
        assert!((i32::from(l.apply(64)) - 128).abs() <= 1);
    }

    #[test]
    fn range_pulls_the_curve_out() {
        assert_eq!(range(100, 100.0), 100);
        assert_eq!(range(100, 50.0), 200);
        assert_eq!(range(200, 50.0), 255);
    }
}
