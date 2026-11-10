//! Photoshop's effect gradients: the five styles (Linear, Radial, Angle,
//! Reflected, Diamond) laid over a frame, with Angle, Scale, Reverse and an
//! offset, and colour and opacity stops sampled apart; Shape Burst, run by
//! the distance from the shape's edge ([`Gradient::burst`]); and a noise
//! gradient's colours in place of the stops ([`super::noise_gradient`]).
//!
//! Ported from PhotoCraft, `crates/compose/src/effects/paint.rs`
//! (`gradient_units`, `gradient_t`, `PreparedGradient`, `sample_stops`,
//! `glow_gradient_gain`), Copyright (c) 2026 ArtCraft Team and the PhotoCraft
//! contributors, MIT licence (see `THIRD_PARTY.md`). PhotoCraft fitted the
//! lengths on psd-tools' cached Photoshop renders; the notes are kept.
//! Changed: the frame is in the box's own units, so a turned or mirrored box
//! turns its gradient with it, and the whole-pixel snap of PhotoCraft's
//! `fill_layout` is left out (it is a device-pixel grid; up to about 1 px
//! along the gradient, and Reflected tilts on odd frames).
//!
//! Midpoints, separate opacity stops and Dither: PhotoCraft's
//! `crates/compose/src/gradient_fill.rs` (`Ramp::sample`, `sample_color`,
//! `sample_opacity`, `dither`) and `crates/color/src/lib.rs`
//! (`dither_noise`). Changed: opacity stops take midpoints too (Photoshop's
//! Gradient Editor has them; PhotoCraft folds them into its bake), and the
//! stops are found by halving, not walked. Smoothness and the Method are
//! [`super::gradient_bake`]'s.

use super::gradient_bake::{self, Method};
use super::noise_gradient::Ramp;
use crate::Error;

/// The gradient's shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Style {
    #[default]
    Linear,
    Radial,
    Angle,
    Reflected,
    Diamond,
    /// From the painted shape's edge (0) in to its deepest point (1). The
    /// effect that lays it measures the depth; without a shape it is Linear.
    ShapeBurst,
}

impl Style {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0 => Style::Linear,
            1 => Style::Radial,
            2 => Style::Angle,
            3 => Style::Reflected,
            4 => Style::Diamond,
            5 => Style::ShapeBurst,
            _ => return None,
        })
    }
}

/// An effect's gradient.
#[derive(Clone, Debug, PartialEq)]
pub struct Gradient {
    /// Colour stops: position 0 to 1, straight RGB 0 to 1, in order.
    pub stops: Vec<(f32, [f32; 3])>,
    /// Opacity stops: position, opacity. None is opaque.
    pub opacity: Vec<(f32, f32)>,
    /// The midpoint of each segment between colour stops, 0.05 to 0.95 (0.5
    /// is even); missing ones are even.
    pub mids: Vec<f32>,
    /// The same between opacity stops.
    pub opacity_mids: Vec<f32>,
    /// Photoshop's Dither: a fraction of a level of noise per pixel, so a
    /// long, gentle ramp does not band.
    pub dither: bool,
    pub style: Style,
    /// Degrees, counter-clockwise from the +x axis with y up (Photoshop's).
    pub angle: f32,
    /// 1 is 100 %.
    pub scale: f32,
    pub reverse: bool,
    /// The centre moved by a share of the frame.
    pub offset: (f32, f32),
    /// Photoshop's Align with Layer (PhotoCraft's `Gradient::align`): on,
    /// the gradient is laid over the letters' frame in the box's own units;
    /// off, over the page the box sits on, in the page's (the effects'
    /// `Place::page`), so it neither turns with the box nor moves with it.
    /// A glow's gradient runs along the glow and a Shape Burst by depth:
    /// neither reads it.
    pub align: bool,
    /// Gradient Type Noise: these colours in place of the stops.
    pub noise: Option<Ramp>,
}

/// A frame: `[x0, y0, x1, y1]`, any units.
pub type Frame = [f32; 4];

/// The lengths a 100 % gradient at `angle` spans in a `w` by `h` frame: the
/// chord (Linear and Reflected) and the ellipse-norm length (Radial, Angle,
/// Diamond; its half is the radius).
pub fn units(angle: f32, w: f32, h: f32) -> (f32, f32) {
    let (s, c) = angle.to_radians().sin_cos();
    // The frame's extent along the angle as an ellipse norm (a unit gradient
    // scaled to the frame), fitted on psd-tools' gradient-styles.psd.
    let len = ((c * w).powi(2) + (s * h).powi(2)).sqrt().max(1e-3);
    // Linear and Reflected span the chord of the frame through its centre
    // along the angle: min(w / |cos|, h / |sin|). A 45 degree gradient on a
    // 29 px square runs 41 px (psd-tools shape-fx2).
    let chord = (w / c.abs().max(1e-6)).min(h / s.abs().max(1e-6)).max(1e-3);
    (chord, len)
}

/// A gradient laid over one frame at one pixel size: the centre, the angle's
/// sine and cosine and the lengths it spans ([`Gradient::run`]).
#[derive(Clone, Copy, Debug)]
pub struct Run {
    cx: f32,
    cy: f32,
    s: f32,
    c: f32,
    chord: f32,
    half_chord: f32,
    half_len: f32,
    corner: f32,
    /// The angle, radians.
    turn: f32,
}

impl Gradient {
    /// Where point `(x, y)` (the frame's units, y down) lies on the gradient,
    /// 0 to 1. `px` is one device pixel in those units: Linear and Reflected
    /// sample half a pixel before the centre, as Photoshop does.
    pub fn t(&self, frame: Frame, px: f32, x: f32, y: f32) -> f32 {
        self.t_along(&self.run(frame, px), x, y)
    }

    /// What [`t`](Self::t) works out from the frame and the pixel alone, once
    /// for every point asked over them.
    pub fn run(&self, frame: Frame, px: f32) -> Run {
        let w = (frame[2] - frame[0]).max(1e-3);
        let h = (frame[3] - frame[1]).max(1e-3);
        let cx = frame[0] + w / 2.0 + self.offset.0 * w;
        let cy = frame[1] + h / 2.0 + self.offset.1 * h;
        let angle = if self.angle.is_finite() {
            self.angle
        } else {
            0.0
        };
        let (s, c) = angle.to_radians().sin_cos();
        let scale = if self.scale.is_finite() {
            self.scale.max(1e-3)
        } else {
            1.0
        };
        let (chord, len) = units(angle, w, h);
        let (chord, len) = (chord * scale, len * scale);
        Run {
            cx,
            cy,
            s,
            c,
            chord,
            half_chord: chord / 2.0,
            half_len: len / 2.0,
            corner: 0.5 * px * (c - s),
            turn: angle.to_radians(),
        }
    }

    /// [`t`](Self::t) at `(x, y)` over the frame and pixel `run` was made
    /// for.
    pub fn t_along(&self, run: &Run, x: f32, y: f32) -> f32 {
        let (s, c) = (run.s, run.c);
        let (dx, dy) = (x - run.cx, y - run.cy);
        let along = dx * c - dy * s;
        let across = dx * s + dy * c;
        let t = match self.style {
            Style::Linear | Style::ShapeBurst => (along - run.corner) / run.chord + 0.5,
            Style::Reflected => ((along - run.corner) / run.half_chord).abs(),
            Style::Radial => (dx * dx + dy * dy).sqrt() / run.half_len,
            Style::Diamond => (along.abs() + across.abs()) / run.half_len,
            // A clockwise sweep from the gradient's angle.
            Style::Angle => ((run.turn - (-dy).atan2(dx)) / core::f32::consts::TAU).rem_euclid(1.0),
        };
        self.finish(t)
    }

    /// Shape Burst at `depth`: 0 on the painted shape's edge, 1 at its
    /// deepest point. Scale shortens the run (at 50 % it is done halfway
    /// in); Angle and the offset do not move it.
    pub fn burst(&self, depth: f32) -> f32 {
        let scale = if self.scale.is_finite() {
            self.scale.max(1e-3)
        } else {
            1.0
        };
        self.finish(depth / scale)
    }

    fn finish(&self, t: f32) -> f32 {
        let t = if t.is_nan() { 0.0 } else { t.clamp(0.0, 1.0) };
        if self.reverse {
            1.0 - t
        } else {
            t
        }
    }

    /// The colour and opacity at `t`: straight RGB and alpha, 0 to 1.
    pub fn sample(&self, t: f32) -> [f32; 4] {
        if let Some(r) = &self.noise {
            return r.sample(t);
        }
        let c = sample_stops(&self.stops, &self.mids, t);
        let a = if self.opacity.is_empty() {
            1.0
        } else {
            sample_stops1(&self.opacity, &self.opacity_mids, t)
        };
        [c[0], c[1], c[2], a]
    }

    /// [`Gradient::sample`] at device pixel `(x, y)`: with Dither on, the
    /// colour moves by under half a level, by the pixel's own noise.
    pub fn sample_at(&self, t: f32, x: i32, y: i32) -> [f32; 4] {
        let mut c = self.sample(t);
        if self.dither {
            dither(&mut c, x, y);
        }
        c
    }

    /// Photoshop's Smoothness (0 to 1) and interpolation `method`, baked
    /// into the stops: dense ones the painter runs between in a straight
    /// line, the midpoints folded in. Classic at 0 % is how the stops are
    /// sampled anyway and leaves them; so does Smooth at 0 % for the
    /// opacity, which keeps Classic's curve ([`gradient_bake`]).
    pub fn interpolate(&mut self, method: Method, smoothness: f32) -> Result<(), Error> {
        let plain = smoothness.is_nan() || smoothness <= 0.0;
        if !(plain && method == Method::Classic) && self.stops.len() >= 2 {
            self.stops = gradient_bake::bake(&self.stops, &self.mids, smoothness, method)?;
            self.mids.clear();
        }
        let shaped = !(plain && matches!(method, Method::Classic | Method::Smooth));
        if shaped && self.opacity.len() >= 2 {
            self.opacity =
                gradient_bake::bake_opacity(&self.opacity, &self.opacity_mids, smoothness, method)?;
            self.opacity_mids.clear();
        }
        Ok(())
    }
}

/// Per-pixel dither noise, 0 up to 1, from a hash of the pixel: PhotoCraft's
/// `dither_noise` (`crates/color/src/lib.rs`), which its Gradient tool,
/// Gradient Fill layers and Gradient Overlay share.
pub fn dither_noise(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    f32::from((h & 0xFFFF) as u16) / 65535.0
}

/// One level's worth of the pixel's dither noise, centred, added to a
/// colour's RGB (PhotoCraft's `gradient_fill::dither`).
pub fn dither(c: &mut [f32; 4], x: i32, y: i32) {
    let n = (dither_noise(x, y) - 0.5) / 255.0;
    for ch in &mut c[..3] {
        *ch = (*ch + n).clamp(0.0, 1.0);
    }
}

/// The segment `t` falls in: the index of its first stop, and how far
/// across it `t` is. Before the first stop or past the last, `None` (the end
/// stop's own value stands).
fn locate<T>(stops: &[(f32, T)], t: f32) -> Option<(usize, f32)> {
    // The first stop at or past `t`; a hard edge's two stops share a
    // position and `t` on it takes the first segment that ends there.
    let j = stops.partition_point(|s| s.0 < t);
    if j == 0 || j >= stops.len() {
        return None;
    }
    let (a, b) = (stops[j - 1].0, stops[j].0);
    let k = if b > a { (t - a) / (b - a) } else { 0.0 };
    Some((j - 1, k))
}

fn sample_stops(stops: &[(f32, [f32; 3])], mids: &[f32], t: f32) -> [f32; 3] {
    match stops {
        [] => [t; 3],
        [s] => s.1,
        _ => match locate(stops, t) {
            None if t <= stops[0].0 => stops[0].1,
            None => stops[stops.len() - 1].1,
            Some((i, k)) => {
                let k = gradient_bake::midpoint_remap(k, mids.get(i).copied().unwrap_or(0.5));
                let (a, b) = (stops[i].1, stops[i + 1].1);
                core::array::from_fn(|c| a[c] + (b[c] - a[c]) * k)
            }
        },
    }
}

fn sample_stops1(stops: &[(f32, f32)], mids: &[f32], t: f32) -> f32 {
    match stops {
        [] => 1.0,
        [s] => s.1,
        _ => match locate(stops, t) {
            None if t <= stops[0].0 => stops[0].1,
            None => stops[stops.len() - 1].1,
            Some((i, k)) => {
                let k = gradient_bake::midpoint_remap(k, mids.get(i).copied().unwrap_or(0.5));
                stops[i].1 + (stops[i + 1].1 - stops[i].1) * k
            }
        },
    }
}

/// The opacity gain of a gradient glow: it is opaque from strength `range^2`
/// on. A glow's gradient runs along the glow, not across the frame: where its
/// strength is `v` it takes the gradient at `1 - v`, so the first stop hugs
/// the edge (photoshop corpus outer-glow-gradient.psd: 1.4/255 mean).
pub fn glow_gain(range: f32) -> f32 {
    let r = if range.is_finite() {
        range.clamp(0.01, 1.0)
    } else {
        1.0
    };
    1.0 / (r * r)
}

#[cfg(test)]
mod tests {
    use super::super::noise_gradient::{Model, Noise};
    use super::*;

    fn bw() -> Gradient {
        Gradient {
            stops: vec![(0.0, [0.0; 3]), (1.0, [1.0; 3])],
            opacity: Vec::new(),
            style: Style::Linear,
            angle: 0.0,
            scale: 1.0,
            reverse: false,
            offset: (0.0, 0.0),
            noise: None,
            mids: Vec::new(),
            opacity_mids: Vec::new(),
            align: true,
            dither: false,
        }
    }

    #[test]
    fn a_linear_gradient_at_zero_runs_left_to_right_over_the_frame() {
        let g = bw();
        let f = [0.0, 0.0, 100.0, 20.0];
        assert!(g.t(f, 1.0, 0.0, 10.0) < 0.01);
        assert!((g.t(f, 1.0, 50.5, 10.0) - 0.5).abs() < 0.01);
        assert!(g.t(f, 1.0, 100.0, 10.0) > 0.99);
        let r = Gradient {
            reverse: true,
            ..bw()
        };
        assert!(r.t(f, 1.0, 0.0, 10.0) > 0.99);
    }

    #[test]
    fn ninety_degrees_runs_bottom_to_top() {
        let g = Gradient {
            angle: 90.0,
            ..bw()
        };
        let f = [0.0, 0.0, 20.0, 100.0];
        assert!(g.t(f, 1.0, 10.0, 100.0) < 0.02);
        assert!(g.t(f, 1.0, 10.0, 0.0) > 0.98);
    }

    #[test]
    fn radial_reflected_and_diamond_are_zero_at_the_centre() {
        let f = [0.0, 0.0, 40.0, 40.0];
        for style in [Style::Radial, Style::Diamond] {
            let g = Gradient { style, ..bw() };
            assert!(g.t(f, 1.0, 20.0, 20.0) < 0.01, "{style:?}");
            assert!(g.t(f, 1.0, 40.0, 20.0) > 0.6, "{style:?}");
        }
        let g = Gradient {
            style: Style::Reflected,
            ..bw()
        };
        assert!((g.t(f, 1.0, 0.5, 20.0) - g.t(f, 1.0, 40.5, 20.0)).abs() < 0.06);
    }

    #[test]
    fn opacity_stops_sample_apart_from_the_colours() {
        let g = Gradient {
            opacity: vec![(0.0, 1.0), (1.0, 0.0)],
            ..bw()
        };
        let p = g.sample(0.25);
        assert!((p[0] - 0.25).abs() < 1e-6 && (p[3] - 0.75).abs() < 1e-6);
        assert_eq!(glow_gain(0.5), 4.0);
    }

    #[test]
    fn shape_burst_runs_from_the_edge_in_and_reverses() {
        let g = Gradient {
            style: Style::ShapeBurst,
            ..bw()
        };
        assert_eq!(
            (g.burst(0.0), g.burst(0.25), g.burst(1.0)),
            (0.0, 0.25, 1.0)
        );
        let r = Gradient {
            reverse: true,
            ..g.clone()
        };
        assert_eq!((r.burst(0.0), r.burst(1.0)), (1.0, 0.0));
        let half = Gradient { scale: 0.5, ..g };
        assert_eq!((half.burst(0.25), half.burst(0.75)), (0.5, 1.0));
        assert_eq!(Style::from_u32(5), Some(Style::ShapeBurst));
        assert_eq!(Style::from_u32(6), None);
    }

    #[test]
    fn a_noise_gradient_samples_its_ramp_not_its_stops() {
        let n = Noise {
            seed: 1,
            roughness: 0.5,
            model: Model::Rgb,
            min: [0.0; 3],
            max: [1.0; 3],
            restrict: false,
            transparency: false,
        };
        let ramp = Ramp::new(n);
        let g = Gradient {
            noise: Some(ramp.clone()),
            ..bw()
        };
        for t in [0.0, 0.3, 1.0] {
            assert_eq!(g.sample(t), ramp.sample(t));
        }
    }

    #[test]
    fn midpoints_move_the_half_way_point_of_each_kind_of_stop() {
        // PhotoCraft's `ramp_midpoints_and_opacity`, with the opacity's own
        // midpoint too.
        let g = Gradient {
            mids: vec![0.25],
            opacity: vec![(0.0, 1.0), (1.0, 0.0)],
            opacity_mids: vec![0.75],
            align: true,
            ..bw()
        };
        let p = g.sample(0.25);
        assert!((p[0] - 0.5).abs() < 1e-5, "{p:?}");
        assert!((g.sample(0.75)[3] - 0.5).abs() < 1e-5);
        // Either side of a midpoint is a straight line.
        assert!((g.sample(0.125)[0] - 0.25).abs() < 1e-5);
        assert!((g.sample(0.625)[0] - 0.75).abs() < 1e-5);
        assert_eq!(g.sample(1.0), [1.0, 1.0, 1.0, 0.0]);
        // Out of Photoshop's 5 to 95 %, a midpoint is held to it.
        let far = Gradient {
            mids: vec![0.0],
            ..bw()
        };
        assert!((far.sample(0.05)[0] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn three_stops_take_one_midpoint_per_segment_and_a_hard_edge_holds() {
        let g = Gradient {
            stops: vec![(0.0, [0.0; 3]), (0.5, [1.0; 3]), (0.5, [0.0; 3]), (1.0, [1.0; 3])],
            mids: vec![0.5, 0.5, 0.2],
            ..bw()
        };
        assert!((g.sample(0.25)[0] - 0.5).abs() < 1e-5);
        assert_eq!(g.sample(0.5)[0], 1.0);
        assert!(g.sample(0.5001)[0] < 0.01);
        assert!((g.sample(0.6)[0] - 0.5).abs() < 1e-4);
    }

    #[test]
    fn dither_moves_a_colour_by_under_half_a_level_and_keeps_its_mean() {
        // PhotoCraft's dither check (`native_cmyk_ramp_interpolates...`):
        // the noise is the pixel's own, alpha untouched.
        let g = Gradient {
            dither: true,
            ..bw()
        };
        let plain = Gradient { ..bw() };
        let mut sum = 0.0f64;
        let mut moved = 0;
        for y in 0..32 {
            for x in 0..32 {
                let c = g.sample_at(0.3, x, y);
                let n = (dither_noise(x, y) - 0.5) / 255.0;
                assert!((c[0] - 0.3 - n).abs() < 1e-6 && c[3] == 1.0);
                assert!((c[0] - 0.3).abs() <= 0.5 / 255.0 + 1e-7);
                sum += f64::from(c[0]);
                let level = |v: f32| (v * 255.0 + 0.5) as u8;
                if level(c[0]) != level(0.3) {
                    moved += 1;
                }
            }
        }
        assert!((sum / 1024.0 - 0.3).abs() < 1e-3);
        // 0.3 is 76.5 levels: dithered, about half the pixels round each way.
        assert!((300..700).contains(&moved), "{moved}");
        assert_eq!(plain.sample_at(0.3, 5, 7), plain.sample(0.3));
        assert_eq!(dither_noise(3, 7), dither_noise(3, 7));
    }

    #[test]
    fn interpolate_bakes_the_method_and_smoothness_and_folds_the_midpoints() {
        let mut g = Gradient {
            mids: vec![0.25],
            opacity: vec![(0.0, 1.0), (1.0, 0.0)],
            opacity_mids: vec![0.5],
            align: true,
            ..bw()
        };
        let before = g.clone();
        g.interpolate(Method::Classic, 0.0).unwrap();
        assert_eq!(g, before, "Classic at 0 % samples the stops as they are");
        g.interpolate(Method::Linear, 0.0).unwrap();
        assert!(g.mids.is_empty() && g.opacity_mids.is_empty());
        assert!(g.stops.len() > 2 && g.opacity.len() > 2);
        // The midpoint still puts the half-way blend at 25 %, in linear
        // light: sRGB 0.735.
        assert!((g.sample(0.25)[0] - 0.7354).abs() < 3e-3, "{:?}", g.sample(0.25));
        // Linear opacity: PhotoCraft's Photoshop sample, 63 % at x 128 of 256.
        assert!((g.sample(128.5 / 256.0)[3] - 0.631).abs() < 0.015);
        // Smooth at 0 % leaves the opacity on Classic's curve.
        let mut s = Gradient {
            opacity: vec![(0.0, 1.0), (1.0, 0.0)],
            opacity_mids: vec![0.25],
            align: true,
            ..bw()
        };
        s.interpolate(Method::Smooth, 0.0).unwrap();
        assert_eq!(s.opacity_mids, vec![0.25]);
        assert!((s.sample(0.25)[3] - 0.5).abs() < 1e-5);
    }
}
