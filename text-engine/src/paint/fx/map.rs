//! An effect's matte as floats, and the maps the glows and the inner shadow
//! are built from.
//!
//! A map is `w * h` coverages from 0 to 1, row by row, over the same pixels
//! as the surface it is laid on. The letters' shape goes in; what comes out
//! is how much of the effect's colour each pixel takes.
//!
//! Ported from PhotoCraft, `crates/compose/src/effects.rs` (`Map`),
//! `effects/paint.rs` (`shadow_map`, `glow_map`, `noise`, `ranged_lut`) and
//! `effects/distance.rs` (`dt1`, `edt_nearest`, `dist_outside`,
//! `dist_inside`, the chamfer `dist_*_by`, `local_coverage`,
//! `STROKE_CHAMFER_MAX`), Copyright (c) 2026 ArtCraft Team and the PhotoCraft
//! contributors, MIT licence (see `THIRD_PARTY.md`). PhotoCraft measured each
//! against Photoshop's renders; the measurements are kept in the comments.
//! Changed: one thread, a seed per effect, contours as 256-entry tables.

use super::contour::Lut;
use super::{distance, noise, spread_split, tent};

/// A pixel with less coverage than this is outside the shape.
pub(crate) const INSIDE_EPS: f32 = 0.5 / 255.0;

pub(crate) struct Map {
    pub w: usize,
    pub h: usize,
    pub v: Vec<f32>,
}

impl Map {
    pub(crate) fn new(w: usize, h: usize, fill: f32) -> Self {
        Map {
            w,
            h,
            v: vec![fill; w * h],
        }
    }

    /// Every value through `f`.
    pub(crate) fn map(mut self, f: impl Fn(f32) -> f32) -> Self {
        for v in &mut self.v {
            *v = f(*v);
        }
        self
    }

    /// A copy moved by `(dx, dy)` (bilinear); what comes in from outside the
    /// map reads `outside`.
    pub(crate) fn shifted(&self, dx: f32, dy: f32, outside: f32) -> Map {
        let mut out = Map::new(self.w, self.h, 0.0);
        let reach = |d: f32| {
            if d.is_finite() {
                d.clamp(-1.0e9, 1.0e9)
            } else {
                0.0
            }
        };
        let (dx, dy) = (reach(dx), reach(dy));
        let (fx, fy) = (dx.floor(), dy.floor());
        let (ax, ay) = (dx - fx, dy - fy);
        let (w, h) = (self.w as i64, self.h as i64);
        let s = |x: i64, y: i64| {
            if x < 0 || y < 0 || x >= w || y >= h {
                outside
            } else {
                self.v[y as usize * self.w + x as usize]
            }
        };
        for y in 0..h {
            for x in 0..w {
                let (sx, sy) = (x - fx as i64, y - fy as i64);
                let top = s(sx, sy) * (1.0 - ax) + s(sx - 1, sy) * ax;
                let bot = s(sx, sy - 1) * (1.0 - ax) + s(sx - 1, sy - 1) * ax;
                out.v[y as usize * self.w + x as usize] = top * (1.0 - ay) + bot * ay;
            }
        }
        out
    }
}

/// Spread or Choke: the map grown by `r` pixels with the 5 x 5 chamfer,
/// keeping its soft edge (as [`distance::dilate`]).
pub(crate) fn dilate(m: &Map, r: f32) -> Map {
    if r.is_nan() || r <= 0.0 {
        return Map {
            w: m.w,
            h: m.h,
            v: m.v.clone(),
        };
    }
    let mut d: Vec<f32> =
        m.v.iter()
            .map(|&a| {
                if a > INSIDE_EPS {
                    1.0 - a.min(1.0)
                } else {
                    distance::FAR
                }
            })
            .collect();
    distance::chamfer(&mut d, m.w, m.h);
    let v =
        m.v.iter()
            .zip(d)
            .map(|(&a, d)| {
                if a > INSIDE_EPS {
                    (a + r).min(1.0)
                } else {
                    a.max((r + 0.5 - (d - 0.5)).clamp(0.0, 1.0))
                }
            })
            .collect();
    Map { w: m.w, h: m.h, v }
}

/// The soft edge of Size `w`: two box passes each way ([`tent`]).
pub(crate) fn blur(m: &mut Map, w: f32) {
    if tent::reach(f64::from(w)) == 0 || m.v.is_empty() {
        return;
    }
    let (mw, mh) = (m.w, m.h);
    let mut mid = Vec::new();
    let mut src = vec![0f64; mw.max(mh)];
    let mut dst = vec![0f64; mw.max(mh)];
    for y in 0..mh {
        for x in 0..mw {
            src[x] = f64::from(m.v[y * mw + x]);
        }
        tent::line(&src[..mw], &mut dst[..mw], f64::from(w), &mut mid);
        for x in 0..mw {
            m.v[y * mw + x] = dst[x] as f32;
        }
    }
    for x in 0..mw {
        for y in 0..mh {
            src[y] = f64::from(m.v[y * mw + x]);
        }
        tent::line(&src[..mh], &mut dst[..mh], f64::from(w), &mut mid);
        for y in 0..mh {
            m.v[y * mw + x] = dst[y] as f32;
        }
    }
}

/// Photoshop's Noise over a map: each covered pixel keeps `1 + (n - 0.5) * 2
/// * amount` of itself, so the speckle fades with the effect.
pub(crate) fn speckle(m: &mut Map, amount: f32, seed: u32) {
    if amount.is_nan() || amount <= 0.0 {
        return;
    }
    let amount = amount.min(1.0);
    for y in 0..m.h {
        for x in 0..m.w {
            let v = &mut m.v[y * m.w + x];
            if *v <= 0.0 {
                continue;
            }
            let n = noise::unit(x as i32, y as i32, seed);
            *v = (*v * (1.0 + (n - 0.5) * 2.0 * amount)).clamp(0.0, 1.0);
        }
    }
}

/// A contour read over a Range: `contour(min(v / range, 1))`. Photoshop's
/// default Range of 50 % doubles a blurred edge's 0.5 to full strength.
/// `contour` `None` is Linear.
pub(crate) fn ranged(m: Map, contour: Option<&Lut>, range: f32) -> Map {
    let range = if range.is_finite() {
        range.clamp(0.01, 1.0)
    } else {
        1.0
    };
    if range >= 0.999 && contour.is_none() {
        return m;
    }
    m.map(|v| {
        let v = if range >= 0.999 {
            v
        } else {
            (v / range).min(1.0)
        };
        contour.map_or(v, |l| l.at(v))
    })
}

// ---- distances ----

/// The 1-D squared distance transform (Felzenszwalb and Huttenlocher), with
/// the index each sample is nearest to.
fn dt1(f: &[f32], out: &mut [f32], v: &mut [usize], z: &mut [f32], near: &mut [usize]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0usize;
    v[0] = 0;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in 1..n {
        loop {
            let p = v[k];
            let s = ((f[q] + (q * q) as f32) - (f[p] + (p * p) as f32))
                / (2.0 * q as f32 - 2.0 * p as f32);
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                v[0] = q;
                z[0] = f32::NEG_INFINITY;
                z[1] = f32::INFINITY;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = f32::INFINITY;
            break;
        }
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let p = v[k];
        let d = q as f32 - p as f32;
        *o = d * d + f[p];
        near[q] = p;
    }
}

/// The exact Euclidean distance from every pixel to the nearest one where
/// `inside` holds, and that pixel's index.
fn edt_nearest(inside: &[bool], w: usize, h: usize) -> (Vec<f32>, Vec<usize>) {
    const INF: f32 = 1e20;
    let n = w.max(h);
    let mut f = vec![0f32; n];
    let mut o = vec![0f32; n];
    let mut v = vec![0usize; n];
    let mut z = vec![0f32; n + 1];
    let mut near = vec![0usize; n];
    // Columns first, kept column by column.
    let mut gc = vec![0f32; w * h];
    let mut nc = vec![0usize; w * h];
    for x in 0..w {
        for y in 0..h {
            f[y] = if inside[y * w + x] { 0.0 } else { INF };
        }
        dt1(&f[..h], &mut o[..h], &mut v, &mut z, &mut near[..h]);
        gc[x * h..x * h + h].copy_from_slice(&o[..h]);
        nc[x * h..x * h + h].copy_from_slice(&near[..h]);
    }
    let mut g = vec![0f32; w * h];
    let mut nearest = vec![0usize; w * h];
    for y in 0..h {
        for x in 0..w {
            f[x] = gc[x * h + y];
        }
        dt1(&f[..w], &mut o[..w], &mut v, &mut z, &mut near[..w]);
        for x in 0..w {
            g[y * w + x] = o[x].sqrt();
            let px = near[x];
            nearest[y * w + x] = nc[px * h + y] * w + px;
        }
    }
    (g, nearest)
}

/// The distance from each pixel outside the shape to its edge, which lies
/// inside the nearest covered pixel by that pixel's coverage, as Photoshop
/// places it. Pixels inside read -0.5.
pub(crate) fn dist_outside(s: &Map) -> Vec<f32> {
    let inside: Vec<bool> = s.v.iter().map(|&a| a > INSIDE_EPS).collect();
    let (d, near) = edt_nearest(&inside, s.w, s.h);
    (0..s.v.len())
        .map(|i| {
            if inside[i] {
                -0.5
            } else {
                d[i] - 0.5 + (1.0 - s.v[near[i]].min(1.0))
            }
        })
        .collect()
}

/// The distance from each pixel inside the shape to its edge; -0.5 outside.
pub(crate) fn dist_inside(s: &Map) -> Vec<f32> {
    let outside: Vec<bool> = s.v.iter().map(|&a| a <= INSIDE_EPS).collect();
    let (d, _) = edt_nearest(&outside, s.w, s.h);
    (0..s.v.len())
        .map(|i| if outside[i] { -0.5 } else { d[i] - 0.5 })
        .collect()
}

/// Outside width from which a stroke's outer edge takes the exact Euclidean
/// distance instead of the 5 x 5 chamfer. The chamfer's level sets are
/// octagons, up to `0.027 r` past the true radius: half a pixel at r = 19.
/// Narrower, Photoshop matches the chamfer's sub-pixel edge seeding.
pub(crate) const STROKE_CHAMFER_MAX: f32 = 20.0;

/// The chamfer distance outside the shape, its seeds starting at their
/// sub-pixel edge (1 - coverage). Inside reads -0.5.
pub(crate) fn chamfer_outside(s: &Map) -> Vec<f32> {
    let mut d: Vec<f32> =
        s.v.iter()
            .map(|&a| {
                if a > INSIDE_EPS {
                    1.0 - a.min(1.0)
                } else {
                    distance::FAR
                }
            })
            .collect();
    distance::chamfer(&mut d, s.w, s.h);
    d.iter()
        .zip(&s.v)
        .map(|(d, &a)| if a > INSIDE_EPS { -0.5 } else { d - 0.5 })
        .collect()
}

/// Alpha relative to its 3 x 3 neighbourhood's highest: an edge's coverage
/// apart from the fill's own opacity.
fn local_coverage(s: &Map) -> Map {
    let mut out = Map::new(s.w, s.h, 0.0);
    let (w, h) = (s.w as i64, s.h as i64);
    let get = |x: i64, y: i64| {
        if x < 0 || y < 0 || x >= w || y >= h {
            0.0
        } else {
            s.v[y as usize * s.w + x as usize]
        }
    };
    for y in 0..h {
        for x in 0..w {
            let a = get(x, y);
            if a <= INSIDE_EPS {
                continue;
            }
            let mut mx = a;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    mx = mx.max(get(x + dx, y + dy));
                }
            }
            out.v[y as usize * s.w + x as usize] = (a / mx).min(1.0);
        }
    }
    out
}

/// The chamfer distance inside the shape: partly covered edge pixels are
/// seeds starting at their coverage, so a 25 % edge column puts the edge a
/// quarter pixel in. Outside reads -0.5.
pub(crate) fn chamfer_inside(s: &Map) -> Vec<f32> {
    let cov = local_coverage(s);
    let mut d: Vec<f32> =
        s.v.iter()
            .zip(&cov.v)
            .map(|(&a, &c)| {
                if a <= INSIDE_EPS {
                    0.0
                } else if c < 1.0 - INSIDE_EPS {
                    c
                } else {
                    distance::FAR
                }
            })
            .collect();
    distance::chamfer(&mut d, s.w, s.h);
    d.iter()
        .zip(&s.v)
        .map(|(d, &a)| if a <= INSIDE_EPS { -0.5 } else { d - 0.5 })
        .collect()
}

// ---- the effects' maps ----

/// What one glow or inner shadow asks of its map.
pub(crate) struct Soft {
    /// Size, device pixels.
    pub size: f32,
    /// Spread or Choke, 0 to 1.
    pub spread: f32,
    pub contour: Option<Lut>,
    /// Range, 0 to 1 (a glow's; a shadow has none, 1).
    pub range: f32,
    /// Noise, 0 to 1.
    pub noise: f32,
    pub seed: u32,
}

/// An Inner Shadow's map over `shape`: the outside of the shape moved by
/// `(dx, dy)` into it, choked and softened like a drop shadow, through its
/// contour and noise, and kept to the shape.
pub(crate) fn inner_shadow(shape: &Map, dx: f32, dy: f32, s: &Soft) -> Map {
    let src = Map {
        w: shape.w,
        h: shape.h,
        v: shape.v.iter().map(|a| 1.0 - a).collect(),
    };
    let mut m = src.shifted(dx, dy, 1.0);
    let (r, bw) = spread_split(f64::from(s.size), f64::from(s.spread));
    m = dilate(&m, r as f32);
    blur(&mut m, bw as f32);
    let mut m = match &s.contour {
        Some(l) => m.map(|v| l.at(v)),
        None => m,
    };
    speckle(&mut m, s.noise, s.seed);
    for (v, a) in m.v.iter_mut().zip(&shape.v) {
        *v *= a;
    }
    m
}

/// Softer or Precise.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Technique {
    Softer,
    Precise,
}

/// A glow's map over `shape`. An outer glow spreads out from the shape; an
/// inner one is built from the edge inward, or, from the Center, is the
/// inverse of that, taken after the contour and Range (Photoshop 27.11,
/// measured by PhotoCraft: a centre glow is exactly 1 minus the edge glow).
pub(crate) fn glow(shape: &Map, technique: Technique, inner: bool, center: bool, s: &Soft) -> Map {
    let src = if inner {
        Map {
            w: shape.w,
            h: shape.h,
            v: shape.v.iter().map(|a| 1.0 - a).collect(),
        }
    } else {
        Map {
            w: shape.w,
            h: shape.h,
            v: shape.v.clone(),
        }
    };
    let mut m = match technique {
        // Coverage falls linearly from 0.5 at the edge to 0 at `size + 1`
        // pixels, solid within the spread or choke: after the default 50 %
        // Range that is Photoshop's `1 - D / (size + 1)` past the solid part
        // (measured outside and inside, sizes 10 and 20, spread 0 and 40 %,
        // choke 0 and 30 %: within one level).
        Technique::Precise => {
            let d = if inner {
                dist_inside(shape)
            } else {
                dist_outside(&src)
            };
            let solid = s.size * s.spread;
            let soft = (s.size + 1.0 - solid).max(1e-3);
            let v = d
                .into_iter()
                .map(|d| {
                    let d = d + 0.5;
                    if d <= solid {
                        1.0
                    } else {
                        0.5 * (1.0 - (d - solid) / soft).clamp(0.0, 1.0)
                    }
                })
                .collect();
            Map {
                w: shape.w,
                h: shape.h,
                v,
            }
        }
        Technique::Softer => {
            let (r, bw) = spread_split(f64::from(s.size), f64::from(s.spread));
            let mut m = dilate(&src, r as f32);
            blur(&mut m, bw as f32);
            m
        }
    };
    m = ranged(m, s.contour.as_ref(), s.range);
    if inner && center {
        m = m.map(|v| 1.0 - v);
    }
    speckle(&mut m, s.noise, s.seed);
    if inner {
        for (v, a) in m.v.iter_mut().zip(&shape.v) {
            *v *= a;
        }
    }
    m
}

/// A map read as a share of the shape's own coverage: what an interior effect
/// lays inside a half-covered edge pixel before that pixel's alpha applies.
pub(crate) fn relative_to(m: &Map, shape: &Map) -> Map {
    let v =
        m.v.iter()
            .zip(&shape.v)
            .map(|(m, a)| {
                if *a > INSIDE_EPS {
                    (m / a).min(1.0)
                } else {
                    0.0
                }
            })
            .collect();
    Map { w: m.w, h: m.h, v }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc(w: usize, h: usize, cx: f32, cy: f32, r: f32) -> Map {
        let mut m = Map::new(w, h, 0.0);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt();
                m.v[y * w + x] = (r + 0.5 - d).clamp(0.0, 1.0);
            }
        }
        m
    }

    fn soft(size: f32) -> Soft {
        Soft {
            size,
            spread: 0.0,
            contour: None,
            range: 0.5,
            noise: 0.0,
            seed: 1,
        }
    }

    #[test]
    fn the_exact_distance_is_euclidean() {
        let mut inside = vec![false; 25];
        inside[12] = true;
        let (d, near) = edt_nearest(&inside, 5, 5);
        assert_eq!(d[12], 0.0);
        assert!((d[0] - 8f32.sqrt()).abs() < 1e-6);
        assert_eq!(near[0], 12);
    }

    #[test]
    fn an_outer_glow_reaches_its_size_and_never_inside() {
        let shape = disc(60, 60, 30.0, 30.0, 10.0);
        let g = glow(&shape, Technique::Softer, false, false, &soft(8.0));
        // Full against the shape (the default Range doubles the edge's half).
        assert!(g.v[30 * 60 + 30] > 0.99);
        // Nothing past the size and the edge.
        assert_eq!(g.v[30 * 60 + 30 + 10 + 10], 0.0);
        assert!(g.v[30 * 60 + 30 + 10 + 3] > 0.0);
    }

    #[test]
    fn a_precise_glow_is_photoshops_line() {
        let shape = disc(80, 80, 40.0, 40.0, 12.0);
        let mut s = soft(10.0);
        s.range = 1.0;
        let g = glow(&shape, Technique::Precise, false, false, &s);
        // Half at the edge, falling straight to nothing at size + 1.
        let at = |dx: usize| g.v[40 * 80 + 40 + 12 + dx];
        assert!(at(1) > at(4) && at(4) > at(8));
        assert_eq!(at(13), 0.0);
    }

    #[test]
    fn an_inner_glow_stays_inside_and_the_centre_one_is_its_inverse() {
        let shape = disc(60, 60, 30.0, 30.0, 15.0);
        let edge = glow(&shape, Technique::Softer, true, false, &soft(6.0));
        let centre = glow(&shape, Technique::Softer, true, true, &soft(6.0));
        for (i, a) in shape.v.iter().enumerate() {
            if *a == 0.0 {
                assert_eq!(edge.v[i], 0.0);
                assert_eq!(centre.v[i], 0.0);
            }
            if *a >= 1.0 {
                assert!((edge.v[i] + centre.v[i] - 1.0).abs() < 1e-5);
            }
        }
        // Strong at the edge, nothing at the middle.
        assert!(edge.v[30 * 60 + 30 - 14] > 0.6);
        assert!(edge.v[30 * 60 + 30] < 0.01);
    }

    #[test]
    fn an_inner_shadow_falls_on_the_side_away_from_the_light() {
        let shape = disc(60, 60, 30.0, 30.0, 15.0);
        let m = inner_shadow(&shape, 5.0, 5.0, &soft(0.0));
        // Thrown down and right: the top-left inside edge is dark, the
        // bottom-right is not.
        assert!(m.v[(30 - 13) * 60 + 30 - 2] > 0.9);
        assert!(m.v[(30 + 13) * 60 + 30 + 2] < 0.1);
        // Never outside the shape.
        for (v, a) in m.v.iter().zip(&shape.v) {
            assert!(*v <= *a + 1e-6);
        }
    }
}
