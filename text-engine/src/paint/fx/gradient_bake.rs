//! Photoshop's gradient interpolation: Smoothness (0 to 100 %) and, since
//! the 2022 releases, the Method (Classic, Perceptual, Linear, Smooth),
//! baked into dense stops that the painter then runs between in a straight
//! line ([`super::gradient::Gradient::interpolate`]).
//!
//! Ported from PhotoCraft, `crates/io/src/gradient_bake.rs` (`Method`,
//! `lin`, `enc`, `to_oklab`, `from_oklab`, `SMOOTH_EASE`, `smooth_ease`,
//! `eval`, `bake`, `OPACITY_RESPONSE`, `bake_opacity` and their tests),
//! Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors, MIT
//! licence (see `THIRD_PARTY.md`). PhotoCraft fitted the model on
//! Photoshop's own composites: Smoothness blends the straight line with a
//! Catmull-Rom spline through the stop colours (end tangents at half the
//! chord slope); Perceptual runs in Oklab, Linear in linear light, Classic
//! in sRGB; Smooth runs straight across Oklab with its own measured easing.
//! Midpoints remap each segment piecewise-linearly.
//!
//! Changed: the stops are straight sRGB triples (no colour modes, so no Lab
//! documents); a dense run keeps every stop's own position and both sides
//! of a hard edge (PhotoCraft samples 97 even steps, which smears a hard
//! edge over a step); the run is charged to the painter's budget.

use crate::paint::budget;
use crate::Error;

/// Photoshop's gradient interpolation methods, by the number the wire
/// carries.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Method {
    /// sRGB, as gradients were before Photoshop 2022 (and as old files are).
    #[default]
    Classic,
    Perceptual,
    Linear,
    Smooth,
}

impl Method {
    pub fn from_u32(v: u32) -> Option<Self> {
        Some(match v {
            0 => Method::Classic,
            1 => Method::Perceptual,
            2 => Method::Linear,
            3 => Method::Smooth,
            _ => return None,
        })
    }
}

/// Even steps a whole 0 to 1 run is cut into (PhotoCraft's `N`).
const STEPS: usize = 96;

fn lin(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn enc(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn to_oklab(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb.map(lin);
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn from_oklab(p: [f32; 3]) -> [f32; 3] {
    let l = (p[0] + 0.396_337_78 * p[1] + 0.215_803_76 * p[2]).powi(3);
    let m = (p[0] - 0.105_561_346 * p[1] - 0.063_854_17 * p[2]).powi(3);
    let s = (p[0] - 0.089_484_18 * p[1] - 1.291_485_5 * p[2]).powi(3);
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
    .map(enc)
}

fn into_space(m: Method, rgb: [f32; 3]) -> [f32; 3] {
    match m {
        Method::Classic => rgb,
        Method::Linear => rgb.map(lin),
        Method::Perceptual | Method::Smooth => to_oklab(rgb),
    }
}

fn out_of_space(m: Method, p: [f32; 3]) -> [f32; 3] {
    match m {
        Method::Classic => p.map(|v| v.clamp(0.0, 1.0)),
        Method::Linear => p.map(enc),
        Method::Perceptual | Method::Smooth => from_oklab(p),
    }
}

/// Smooth's progress across a segment at u = 0, 1/16, ..., 1 (Photoshop
/// 27.11, measured by PhotoCraft as the position along the Oklab line
/// between the two stop colours).
const SMOOTH_EASE: [f32; 17] = [
    0.0, 0.0438, 0.099, 0.1644, 0.2303, 0.2988, 0.3667, 0.433, 0.4974, 0.5642, 0.6302, 0.6985,
    0.7656, 0.8333, 0.8945, 0.9517, 1.0,
];

fn smooth_ease(u: f32) -> f32 {
    let x = u.clamp(0.0, 1.0) * 16.0;
    let i = (x.floor() as usize).min(15);
    let (a, b) = (SMOOTH_EASE[i], SMOOTH_EASE[i + 1]);
    a + (b - a) * (x - i as f32)
}

/// Where a segment's relative position `u` lands once its midpoint is `m`
/// (0.5 leaves it): the blend is half-way at `m`, straight on either side.
/// Photoshop's midpoints run 5 to 95 %.
///
/// From PhotoCraft, `crates/compose/src/gradient_fill.rs` `midpoint_remap`.
pub fn midpoint_remap(u: f32, m: f32) -> f32 {
    let m = if m.is_finite() {
        m.clamp(0.05, 0.95)
    } else {
        0.5
    };
    if (m - 0.5).abs() < 1e-6 {
        u
    } else if u <= m {
        0.5 * u / m
    } else {
        0.5 + 0.5 * (u - m) / (1.0 - m)
    }
}

/// The colour `u` (0 to 1) across segment `i` of sorted `stops` (in `m`'s
/// space), with midpoint `mids[i]` and Smoothness `smooth` (PhotoCraft's
/// `eval`, from the segment on).
fn segment(
    stops: &[(f32, [f32; 3])],
    mids: &[f32],
    smooth: f32,
    i: usize,
    u: f32,
    m: Method,
) -> [f32; 3] {
    let n = stops.len();
    let (t0, t1) = (stops[i].0, stops[i + 1].0);
    let h = (t1 - t0).max(1e-6);
    let u = midpoint_remap(u, mids.get(i).copied().unwrap_or(0.5));
    let (p0, p1) = (stops[i].1, stops[i + 1].1);
    if m == Method::Smooth {
        let e = smooth_ease(u);
        return core::array::from_fn(|c| p0[c] + (p1[c] - p0[c]) * e);
    }
    // Catmull-Rom tangents per unit t; the ends use half the chord slope.
    let tangent = |k: usize| -> [f32; 3] {
        let (a, b) = match k {
            0 => (0, 1),
            k if k == n - 1 => (n - 2, n - 1),
            k => (k - 1, k + 1),
        };
        let d = (stops[b].0 - stops[a].0).max(1e-6);
        let half = if k == 0 || k == n - 1 { 0.5 } else { 1.0 };
        core::array::from_fn(|c| (stops[b].1[c] - stops[a].1[c]) / d * half)
    };
    let (m0, m1) = (tangent(i), tangent(i + 1));
    let (u2, u3) = (u * u, u * u * u);
    let (h00, h10, h01, h11) = (
        2.0 * u3 - 3.0 * u2 + 1.0,
        u3 - 2.0 * u2 + u,
        -2.0 * u3 + 3.0 * u2,
        u3 - u2,
    );
    core::array::from_fn(|c| {
        let linear = p0[c] + (p1[c] - p0[c]) * u;
        let spline = h00 * p0[c] + h10 * h * m0[c] + h01 * p1[c] + h11 * h * m1[c];
        let value = linear + (spline - linear) * smooth;
        // Catmull-Rom tangents can overshoot neighbouring stops, turning even
        // a flat segment into a dip: Smoothness bends the ramp without making
        // colours outside the segment.
        let (lo, hi) = (p0[c].min(p1[c]), p0[c].max(p1[c]));
        if lo.is_finite() && hi.is_finite() {
            value.clamp(lo, hi)
        } else {
            value
        }
    })
}

/// The dense run of sorted `stops` with `f` mapping each segment `i` and
/// position `u` to a value: every stop's own position (both sides of a hard
/// edge) and the even steps between, charged to the budget.
fn run<T: Copy>(
    stops: &[(f32, [f32; 3])],
    f: impl Fn(usize, f32) -> T,
) -> Result<Vec<(f32, T)>, Error> {
    let spans = stops
        .windows(2)
        .filter(|w| w[1].0 > w[0].0)
        .map(|w| ((w[1].0 - w[0].0) * STEPS as f32).ceil() as usize + 1)
        .sum::<usize>();
    let mut out = Vec::new();
    budget::reserve_raw(&mut out, spans)?;
    for (i, w) in stops.windows(2).enumerate() {
        let (t0, t1) = (w[0].0, w[1].0);
        if t1 <= t0 {
            continue;
        }
        let steps = ((t1 - t0) * STEPS as f32).ceil() as usize;
        for k in 0..=steps {
            let u = k as f32 / steps as f32;
            out.push((t0 + (t1 - t0) * u, f(i, u)));
        }
    }
    Ok(out)
}

/// Dense straight-line colour stops that draw sorted `stops` (positions 0
/// to 1, straight sRGB) as Photoshop does with `midpoints` (one per
/// segment, missing ones even), Smoothness `smoothness` (0 to 1) and method
/// `m`. Fewer than two stops come back as they are.
pub fn bake(
    stops: &[(f32, [f32; 3])],
    midpoints: &[f32],
    smoothness: f32,
    m: Method,
) -> Result<Vec<(f32, [f32; 3])>, Error> {
    if stops.len() < 2 {
        return budget::collect(stops.iter().map(|s| Ok(*s)));
    }
    let smooth = if smoothness.is_finite() {
        smoothness.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let pts: Vec<(f32, [f32; 3])> = stops.iter().map(|(t, c)| (*t, into_space(m, *c))).collect();
    run(&pts, |i, u| {
        out_of_space(m, segment(&pts, midpoints, smooth, i, u, m))
    })
}

/// Exponent of Photoshop's opacity response for Perceptual and Linear
/// gradients: the opacity stops enter the method's space as if they were
/// sRGB grey levels (Linear: linear light; Perceptual: Oklab L), and the
/// blended linear-light value `y` comes out as opacity `y^0.65`. PhotoCraft
/// fitted it on Photoshop (scripted Gradient Overlays, within 0.015 of
/// every 8-bit sample; a flat 60 % draws as 47 %).
const OPACITY_RESPONSE: f32 = 0.65;

/// Dense straight-line opacity stops that draw sorted `stops` (position,
/// opacity) as Photoshop does with their midpoints, Smoothness and method.
/// Smooth keeps Classic's opacity curve (PhotoCraft did not measure it).
pub fn bake_opacity(
    stops: &[(f32, f32)],
    midpoints: &[f32],
    smoothness: f32,
    m: Method,
) -> Result<Vec<(f32, f32)>, Error> {
    if stops.len() < 2 {
        return budget::collect(stops.iter().map(|s| Ok(*s)));
    }
    let m = if m == Method::Smooth {
        Method::Classic
    } else {
        m
    };
    let smooth = if smoothness.is_finite() {
        smoothness.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let into = |o: f32| -> f32 {
        let o = if o.is_finite() { o.clamp(0.0, 1.0) } else { 1.0 };
        match m {
            Method::Linear => lin(o),
            Method::Perceptual => lin(o).cbrt(),
            Method::Classic | Method::Smooth => o,
        }
    };
    let out = |v: f32| -> f32 {
        let v = if v.is_finite() { v } else { 1.0 };
        let y = match m {
            Method::Linear => v,
            Method::Perceptual => v.max(0.0).powi(3),
            Method::Classic | Method::Smooth => return v.clamp(0.0, 1.0),
        };
        y.clamp(0.0, 1.0).powf(OPACITY_RESPONSE)
    };
    let pts: Vec<(f32, [f32; 3])> = stops.iter().map(|(t, o)| (*t, [into(*o); 3])).collect();
    // Smoothness and midpoints shape the curve as for Classic colours, in
    // the method's space.
    run(&pts, |i, u| {
        out(segment(&pts, midpoints, smooth, i, u, Method::Classic)[0])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opacity_at(stops: &[(f32, f32)], t: f32) -> f32 {
        let i = stops
            .windows(2)
            .position(|w| t >= w[0].0 && t <= w[1].0)
            .unwrap();
        let (a, b) = (stops[i], stops[i + 1]);
        a.1 + (b.1 - a.1) * (t - a.0) / (b.0 - a.0).max(1e-9)
    }

    fn at(stops: &[(f32, [f32; 3])], t: f32) -> [f32; 3] {
        let i = stops
            .windows(2)
            .position(|w| t >= w[0].0 && t <= w[1].0 && w[1].0 > w[0].0)
            .unwrap();
        let (a, b) = (&stops[i], &stops[i + 1]);
        let u = (t - a.0) / (b.0 - a.0);
        core::array::from_fn(|c| a.1[c] + (b.1[c] - a.1[c]) * u)
    }

    const BLACK: [f32; 3] = [0.0; 3];
    const WHITE: [f32; 3] = [1.0; 3];

    /// PhotoCraft's Photoshop Gradient Overlay samples (black, Normal, over
    /// white; a 256 px linear gradient, pixel `x` at t = (x + 0.5) / 256).
    #[test]
    fn opacity_matches_photoshop_samples() {
        type Case = (
            &'static [(f32, f32)],
            &'static [f32],
            f32,
            Method,
            &'static [(f32, f32)],
        );
        let ramp: &[(f32, f32)] = &[(0.0, 1.0), (1.0, 0.0)];
        let three: &[(f32, f32)] = &[(0.0, 1.0), (0.25, 0.2), (1.0, 0.9)];
        let cases: [Case; 9] = [
            (ramp, &[0.5], 0.0, Method::Linear, &[(64.0, 0.827), (128.0, 0.631), (192.0, 0.400)]),
            (ramp, &[0.5], 0.0, Method::Perceptual, &[(64.0, 0.565), (128.0, 0.255), (192.0, 0.063)]),
            (ramp, &[0.25], 1.0, Method::Classic, &[(32.0, 0.796), (64.0, 0.502), (128.0, 0.298), (192.0, 0.122)]),
            (ramp, &[0.25], 1.0, Method::Linear, &[(32.0, 0.859), (64.0, 0.631), (128.0, 0.447), (192.0, 0.247)]),
            (ramp, &[0.25], 1.0, Method::Perceptual, &[(32.0, 0.639), (64.0, 0.255), (128.0, 0.090), (192.0, 0.016)]),
            (ramp, &[0.5], 1.0, Method::Classic, &[(64.0, 0.796), (128.0, 0.502), (192.0, 0.204)]),
            (three, &[0.5, 0.5], 1.0, Method::Classic, &[(32.0, 0.557), (64.0, 0.200), (160.0, 0.502)]),
            (three, &[0.5, 0.5], 1.0, Method::Perceptual, &[(32.0, 0.392), (64.0, 0.106), (160.0, 0.341)]),
            (three, &[0.5, 0.5], 0.0, Method::Linear, &[(32.0, 0.647), (64.0, 0.106), (160.0, 0.557)]),
        ];
        for (stops, mids, smooth, m, samples) in cases {
            let baked = bake_opacity(stops, mids, smooth, m).unwrap();
            for (x, want) in samples {
                let got = opacity_at(&baked, (x + 0.5) / 256.0);
                assert!(
                    (got - want).abs() < 0.015,
                    "{m:?} smooth {smooth} mids {mids:?} x {x}: {got} vs Photoshop {want}"
                );
            }
        }
        // A flat 60 % draws as 47 % in Linear and Perceptual.
        for m in [Method::Linear, Method::Perceptual] {
            let baked = bake_opacity(&[(0.0, 0.6), (1.0, 0.6)], &[0.5], 0.0, m).unwrap();
            assert!(baked.iter().all(|o| (o.1 - 0.471).abs() < 0.01), "{m:?}");
        }
    }

    #[test]
    fn opacity_bake_survives_hostile_values() {
        for m in [Method::Classic, Method::Perceptual, Method::Linear, Method::Smooth] {
            let baked = bake_opacity(
                &[(0.0, f32::INFINITY), (0.5, -3.0), (1.0, f32::NAN)],
                &[f32::NAN, 2.0],
                f32::NAN,
                m,
            )
            .unwrap();
            assert!(baked.iter().all(|o| (0.0..=1.0).contains(&o.1)), "{m:?}");
        }
    }

    #[test]
    fn smoothness_eases_between_two_stops() {
        // Two stops, 100 %: t + (smoothstep(t) - t) / 2 (Catmull-Rom with
        // half-slope ends).
        let s = bake(&[(0.0, BLACK), (1.0, WHITE)], &[0.5], 1.0, Method::Classic).unwrap();
        for t in [0.1f32, 0.25, 0.5, 0.75, 0.9] {
            let ss = t * t * (3.0 - 2.0 * t);
            let want = t + 0.5 * (ss - t);
            assert!((at(&s, t)[0] - want).abs() < 2e-3, "{t}: {} vs {want}", at(&s, t)[0]);
        }
    }

    #[test]
    fn smoothness_does_not_overshoot_a_flat_stop_segment() {
        let gray = |v: f32| [v; 3];
        let dark = 28.0 / 255.0;
        let stops = [
            (0.0, gray(202.0 / 255.0)),
            (0.27, gray(dark)),
            (0.53, gray(dark)),
            (0.72, gray(148.0 / 255.0)),
        ];
        let baked = bake(&stops, &[0.5, 0.5, 0.5], 1.0, Method::Classic).unwrap();
        let sample = at(&baked, 0.4);
        assert!(sample.iter().all(|v| (*v - dark).abs() < 1e-4), "{sample:?}");
    }

    #[test]
    fn perceptual_matches_photoshop_sample() {
        // PhotoCraft's measure of Photoshop's composite: orange to blue,
        // Perceptual, 100 % Smoothness.
        let s = bake(
            &[(0.0, [0.882, 0.602, 0.201]), (1.0, [0.164, 0.568, 0.851])],
            &[0.5],
            1.0,
            Method::Perceptual,
        )
        .unwrap();
        for (t, want, tol) in [
            (0.491, [0.592f32, 0.612, 0.596], 0.01),
            (0.113, [0.839, 0.608, 0.290], 0.012),
        ] {
            let p = at(&s, t);
            for (got, want) in p.iter().zip(want) {
                assert!((got - want).abs() < tol, "{t}: {p:?}");
            }
        }
    }

    #[test]
    fn smooth_matches_photoshop() {
        // Photoshop 27.11, Method Smooth, dither off, 256 px, every 32 px.
        type Row = (&'static str, [f32; 3], [f32; 3], [[u8; 3]; 8]);
        let measured: [Row; 2] = [
            ("black to white", [0.0; 3], [1.0; 3], [[0; 3], [4; 3], [29; 3], [63; 3], [99; 3], [137; 3], [179; 3], [221; 3]]),
            (
                "red to blue",
                [1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0],
                [[255, 0, 0], [232, 51, 67], [202, 71, 105], [171, 81, 136], [140, 83, 162], [109, 80, 188], [76, 69, 213], [41, 49, 236]],
            ),
        ];
        for (name, a, b, want) in measured {
            let s = bake(&[(0.0, a), (1.0, b)], &[0.5], 1.0, Method::Smooth).unwrap();
            for (k, w) in want.iter().enumerate() {
                let x = k * 32;
                let got = at(&s, (x as f32 + 0.5) / 256.0).map(|v| (v * 255.0).round() as i32);
                for c in 0..3 {
                    assert!((got[c] - i32::from(w[c])).abs() <= 2, "{name} x {x}: {got:?} vs {w:?}");
                }
            }
        }
    }

    #[test]
    fn linear_blends_in_linear_light() {
        // Half-way from black to white in linear light is 50 % light: sRGB
        // 0.735 (188/255), where Classic gives 0.5.
        let s = bake(&[(0.0, BLACK), (1.0, WHITE)], &[0.5], 0.0, Method::Linear).unwrap();
        assert!((at(&s, 0.5)[0] - 0.7354).abs() < 2e-3, "{:?}", at(&s, 0.5));
        let c = bake(&[(0.0, BLACK), (1.0, WHITE)], &[0.5], 0.0, Method::Classic).unwrap();
        assert!((at(&c, 0.5)[0] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn midpoint_shifts_the_half_way_colour() {
        let s = bake(&[(0.0, BLACK), (1.0, WHITE)], &[0.25], 0.0, Method::Classic).unwrap();
        assert!((at(&s, 0.25)[0] - 0.5).abs() < 0.01);
        assert_eq!(midpoint_remap(0.3, 0.5), 0.3);
        assert!((midpoint_remap(0.25, 0.25) - 0.5).abs() < 1e-6);
        // Photoshop's range is 5 to 95 %.
        assert_eq!(midpoint_remap(0.05, 0.0), 0.5);
    }

    #[test]
    fn a_hard_edge_stays_one_and_every_stop_keeps_its_place() {
        let red = [1.0, 0.0, 0.0];
        let s = bake(
            &[(0.0, BLACK), (0.3, WHITE), (0.3, red), (1.0, BLACK)],
            &[0.5, 0.5, 0.5],
            1.0,
            Method::Perceptual,
        )
        .unwrap();
        let edge: Vec<_> = s.iter().filter(|p| (p.0 - 0.3).abs() < 1e-6).collect();
        assert_eq!(edge.len(), 2);
        assert!(edge[0].1.iter().all(|v| (v - 1.0).abs() < 1e-3), "{edge:?}");
        assert!((edge[1].1[0] - 1.0).abs() < 1e-3 && edge[1].1[1] < 1e-3, "{edge:?}");
        assert!(s.windows(2).all(|w| w[0].0 <= w[1].0));
        assert_eq!((s[0].0, s[s.len() - 1].0), (0.0, 1.0));
    }

    #[test]
    fn a_lone_stop_is_kept() {
        assert_eq!(bake(&[(0.4, WHITE)], &[], 1.0, Method::Smooth).unwrap(), vec![(0.4, WHITE)]);
        assert_eq!(bake_opacity(&[(0.5, 0.3)], &[], 1.0, Method::Linear).unwrap(), vec![(0.5, 0.3)]);
        assert_eq!(Method::from_u32(3), Some(Method::Smooth));
        assert_eq!(Method::from_u32(4), None);
    }
}
