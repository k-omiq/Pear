//! Photoshop's effect gradients: the five styles (Linear, Radial, Angle,
//! Reflected, Diamond) laid over a frame, with Angle, Scale, Reverse and an
//! offset, and colour and opacity stops sampled apart.
//!
//! Ported from PhotoCraft, `crates/compose/src/effects/paint.rs`
//! (`gradient_units`, `gradient_t`, `PreparedGradient`, `sample_stops`,
//! `glow_gradient_gain`), Copyright (c) 2026 ArtCraft Team and the PhotoCraft
//! contributors, MIT licence (see `THIRD_PARTY.md`). PhotoCraft fitted the
//! lengths on psd-tools' cached Photoshop renders; the notes are kept.
//! Changed: the frame is in the box's own units, so a turned or mirrored box
//! turns its gradient with it, and the whole-pixel snap of PhotoCraft's
//! `fill_layout` is left out (it is a device-pixel grid; at most half a
//! device pixel along the gradient).

/// The gradient's shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Style {
    #[default]
    Linear,
    Radial,
    Angle,
    Reflected,
    Diamond,
}

impl Style {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0 => Style::Linear,
            1 => Style::Radial,
            2 => Style::Angle,
            3 => Style::Reflected,
            4 => Style::Diamond,
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
    pub style: Style,
    /// Degrees, counter-clockwise from the +x axis with y up (Photoshop's).
    pub angle: f32,
    /// 1 is 100 %.
    pub scale: f32,
    pub reverse: bool,
    /// The centre moved by a share of the frame.
    pub offset: (f32, f32),
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

impl Gradient {
    /// Where point `(x, y)` (the frame's units, y down) lies on the gradient,
    /// 0 to 1. `px` is one device pixel in those units: Linear and Reflected
    /// sample half a pixel before the centre, as Photoshop does.
    pub fn t(&self, frame: Frame, px: f32, x: f32, y: f32) -> f32 {
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
        let (dx, dy) = (x - cx, y - cy);
        let along = dx * c - dy * s;
        let across = dx * s + dy * c;
        let scale = if self.scale.is_finite() {
            self.scale.max(1e-3)
        } else {
            1.0
        };
        let (chord, len) = units(angle, w, h);
        let (chord, len) = (chord * scale, len * scale);
        let corner = 0.5 * px * (c - s);
        let t = match self.style {
            Style::Linear => (along - corner) / chord + 0.5,
            Style::Reflected => ((along - corner) / (chord / 2.0)).abs(),
            Style::Radial => (dx * dx + dy * dy).sqrt() / (len / 2.0),
            Style::Diamond => (along.abs() + across.abs()) / (len / 2.0),
            // A clockwise sweep from the gradient's angle.
            Style::Angle => {
                ((angle.to_radians() - (-dy).atan2(dx)) / core::f32::consts::TAU).rem_euclid(1.0)
            }
        };
        let t = if t.is_nan() { 0.0 } else { t.clamp(0.0, 1.0) };
        if self.reverse {
            1.0 - t
        } else {
            t
        }
    }

    /// The colour and opacity at `t`: straight RGB and alpha, 0 to 1.
    pub fn sample(&self, t: f32) -> [f32; 4] {
        let c = sample_stops(&self.stops, t);
        let a = if self.opacity.is_empty() {
            1.0
        } else {
            sample_stops1(&self.opacity, t)
        };
        [c[0], c[1], c[2], a]
    }
}

fn sample_stops(stops: &[(f32, [f32; 3])], t: f32) -> [f32; 3] {
    match stops {
        [] => [t; 3],
        [s] => s.1,
        _ => {
            if t <= stops[0].0 {
                return stops[0].1;
            }
            for w in stops.windows(2) {
                if t <= w[1].0 {
                    let k = if w[1].0 > w[0].0 {
                        (t - w[0].0) / (w[1].0 - w[0].0)
                    } else {
                        0.0
                    };
                    return core::array::from_fn(|i| w[0].1[i] + (w[1].1[i] - w[0].1[i]) * k);
                }
            }
            stops[stops.len() - 1].1
        }
    }
}

fn sample_stops1(stops: &[(f32, f32)], t: f32) -> f32 {
    match stops {
        [] => 1.0,
        [s] => s.1,
        _ => {
            if t <= stops[0].0 {
                return stops[0].1;
            }
            for w in stops.windows(2) {
                if t <= w[1].0 {
                    let k = if w[1].0 > w[0].0 {
                        (t - w[0].0) / (w[1].0 - w[0].0)
                    } else {
                        0.0
                    };
                    return w[0].1 + (w[1].1 - w[0].1) * k;
                }
            }
            stops[stops.len() - 1].1
        }
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
}
