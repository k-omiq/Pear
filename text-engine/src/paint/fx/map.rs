//! An effect's matte as floats, and the maps the glows, the inner shadow and
//! the satin are built from.
//!
//! A map is `w * h` coverages from 0 to 1, row by row, over the same pixels
//! as the surface it is laid on. The letters' shape goes in; what comes out
//! is how much of the effect's colour each pixel takes.
//!
//! Ported from PhotoCraft, `crates/compose/src/effects.rs` (`Map`),
//! `effects/paint.rs` (`shadow_map`, `glow_map`, `noise`, `ranged_lut`),
//! `effects/bevel.rs` (`satin_map`) and
//! `effects/distance.rs` (`dt1`, `edt_nearest`, `dist_outside`,
//! `dist_inside`, the chamfer `dist_*_by`, `local_coverage`,
//! `STROKE_CHAMFER_MAX`), Copyright (c) 2026 ArtCraft Team and the PhotoCraft
//! contributors, MIT licence (see `THIRD_PARTY.md`). PhotoCraft measured each
//! against Photoshop's renders; the measurements are kept in the comments.
//! Changed: one thread, a seed per effect, contours as 256-entry tables.

use super::super::budget::{self, Buffer};
use super::contour::Lut;
use super::{distance, noise, tent};
use crate::Error;

/// A pixel with less coverage than this is outside the shape.
pub(crate) const INSIDE_EPS: f32 = 0.5 / 255.0;

// How many inside distances this thread has worked out, for the tests that
// a paint works each out once.
#[cfg(test)]
thread_local! {
    pub(crate) static INSIDE_DISTANCES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(test)]
fn count_inside_distance() {
    INSIDE_DISTANCES.with(|c| c.set(c.get() + 1));
}
#[cfg(not(test))]
fn count_inside_distance() {}

/// Its values are charged to the painter's budget while it lives, so an
/// effect over a frame the budget cannot hold is refused, not run.
pub(crate) struct Map {
    pub w: usize,
    pub h: usize,
    pub v: Buffer<f32>,
}

impl Map {
    /// `w * h` values of `fill`.
    pub(crate) fn filled(w: usize, h: usize, fill: f32) -> Result<Self, Error> {
        let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
        Ok(Map {
            w,
            h,
            v: budget::filled(n, fill)?,
        })
    }

    #[cfg(test)]
    pub(crate) fn new(w: usize, h: usize, fill: f32) -> Self {
        Self::filled(w, h, fill).unwrap()
    }

    /// A map of the `w * h` values `v`, row by row.
    pub(crate) fn collect(
        w: usize,
        h: usize,
        v: impl IntoIterator<Item = f32>,
    ) -> Result<Self, Error> {
        let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
        Ok(Map {
            w,
            h,
            v: budget::exact(n, v)?,
        })
    }

    /// A copy, charged as its own.
    pub(crate) fn try_clone(&self) -> Result<Self, Error> {
        Self::collect(self.w, self.h, self.v.iter().copied())
    }

    /// The value at `(x, y)`, 0 off the map (PhotoCraft `Map::get`).
    pub(crate) fn get(&self, x: i64, y: i64) -> f32 {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            0.0
        } else {
            self.v[y as usize * self.w + x as usize]
        }
    }

    /// Every value through `f`.
    pub(crate) fn map(mut self, f: impl Fn(f32) -> f32) -> Self {
        for v in self.v.iter_mut() {
            *v = f(*v);
        }
        self
    }

    /// A copy moved by `(dx, dy)` (bilinear); what comes in from outside the
    /// map reads `outside`.
    pub(crate) fn shifted(&self, dx: f32, dy: f32, outside: f32) -> Result<Map, Error> {
        let mut out = Map::filled(self.w, self.h, 0.0)?;
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
        let (mx, my) = (fx as i64, fy as i64);
        // Zero or more, and finite: what a share is. Such a value times one
        // is itself, and times nothing is plain zero.
        let share = |v: &f32| v.to_bits() < 0x7f80_0000;
        if ax == 0.0 && ay == 0.0 && share(&outside) && self.v.iter().all(share) {
            // A move by whole pixels reads one pixel for each it writes: the
            // other three weigh nothing, and add nothing.
            let x0 = mx.clamp(0, w) as usize;
            let x1 = (w + mx).clamp(0, w) as usize;
            for y in 0..h {
                let row = &mut out.v[y as usize * self.w..][..self.w];
                let from = y - my;
                if from < 0 || from >= h || x0 >= x1 {
                    row.fill(outside);
                    continue;
                }
                row[..x0].fill(outside);
                row[x1..].fill(outside);
                let first = from as usize * self.w + (x0 as i64 - mx) as usize;
                row[x0..x1].copy_from_slice(&self.v[first..first + (x1 - x0)]);
            }
            return Ok(out);
        }
        let s = |x: i64, y: i64| {
            if x < 0 || y < 0 || x >= w || y >= h {
                outside
            } else {
                self.v[y as usize * self.w + x as usize]
            }
        };
        let cell = |x: i64, y: i64| {
            let (sx, sy) = (x - mx, y - my);
            let top = s(sx, sy) * (1.0 - ax) + s(sx - 1, sy) * ax;
            let bot = s(sx, sy - 1) * (1.0 - ax) + s(sx - 1, sy - 1) * ax;
            top * (1.0 - ay) + bot * ay
        };
        // The columns whose four reads are all in the map, in a row whose
        // two source rows are: read there side by side, with no asking.
        let xa = (mx + 1).clamp(0, w);
        let xb = (w + mx).clamp(xa, w);
        for y in 0..h {
            let row = &mut out.v[y as usize * self.w..][..self.w];
            let sy = y - my;
            if sy < 1 || sy >= h || xa >= xb {
                for x in 0..w {
                    row[x as usize] = cell(x, y);
                }
                continue;
            }
            for x in (0..xa).chain(xb..w) {
                row[x as usize] = cell(x, y);
            }
            let first = (xa - mx - 1) as usize;
            let n = (xb - xa) as usize;
            let top = &self.v[sy as usize * self.w + first..][..n + 1];
            let bot = &self.v[(sy as usize - 1) * self.w + first..][..n + 1];
            let cells = row[xa as usize..xb as usize]
                .iter_mut()
                .zip(top.windows(2))
                .zip(bot.windows(2));
            for ((o, t), b) in cells {
                let top = t[1] * (1.0 - ax) + t[0] * ax;
                let bot = b[1] * (1.0 - ax) + b[0] * ax;
                *o = top * (1.0 - ay) + bot * ay;
            }
        }
        Ok(out)
    }

    /// The move as it was first written: four asked-for reads to the pixel.
    #[cfg(test)]
    fn shifted_as_first_written(&self, dx: f32, dy: f32, outside: f32) -> Map {
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
pub(crate) fn dilate(m: &Map, r: f32) -> Result<Map, Error> {
    if r.is_nan() || r <= 0.0 {
        return m.try_clone();
    }
    let mut d = budget::exact(
        m.v.len(),
        m.v.iter().map(|&a| {
            if a > INSIDE_EPS {
                1.0 - a.min(1.0)
            } else {
                distance::FAR
            }
        }),
    )?;
    distance::chamfer(&mut d, m.w, m.h);
    Map::collect(
        m.w,
        m.h,
        m.v.iter().zip(d.iter()).map(|(&a, &d)| {
            if a > INSIDE_EPS {
                (a + r).min(1.0)
            } else {
                a.max((r + 0.5 - (d - 0.5)).clamp(0.0, 1.0))
            }
        }),
    )
}

/// The soft edge of Size `w`: two box passes each way ([`tent`]).
pub(crate) fn blur(m: &mut Map, w: f32) -> Result<(), Error> {
    if tent::reach(f64::from(w)) == 0 || m.v.is_empty() {
        return Ok(());
    }
    let (mw, mh) = (m.w, m.h);
    tent::grid(&mut m.v, mw, mh, f64::from(w))?;
    Ok(())
}

/// Photoshop's Noise over a map whose corner is device pixel `origin`: each
/// covered pixel keeps `1 + (n - 0.5) * 2 * amount` of itself, so the
/// speckle fades with the effect. `n` is hashed from the device pixel, as
/// PhotoCraft's `noise` adds the map's origin: the map's own corner moves
/// with the room the box's other effects ask for, and an Outside Stroke's
/// size (or an Inner Shadow's) once re-rolled a glow's grain (review F22).
pub(crate) fn speckle(m: &mut Map, amount: f32, seed: u32, origin: (i32, i32)) {
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
            let n = noise::unit(
                origin.0.wrapping_add(x as i32),
                origin.1.wrapping_add(y as i32),
                seed,
            );
            *v = (*v * (1.0 + (n - 0.5) * 2.0 * amount)).clamp(0.0, 1.0);
        }
    }
}

/// A contour read over a Range: `contour(min(v / range, 1))`. Photoshop's
/// default Range of 50 % doubles a blurred edge's 0.5 to full strength.
/// `contour` `None` is Linear. `hide_edge`: an effect that spreads out past
/// the letters (an Outer Glow) reads its contour with the edge hidden
/// ([`Lut::at_hidden`]), so where the matte is 0 it is too: a contour that
/// does not start at 0 once filled the whole region the glow is worked out
/// over, whose edge moves with the zoom (review F7).
pub(crate) fn ranged(m: Map, contour: Option<&Lut>, range: f32, hide_edge: bool) -> Map {
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
        match contour {
            Some(l) if hide_edge => l.at_hidden(v),
            Some(l) => l.at(v),
            None => v,
        }
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

/// [`edt_nearest`] into `g` and `nearest`, with `gc` and `nc` (`w * h`
/// each) as scratch.
fn edt_into(
    inside: &[bool],
    (w, h): (usize, usize),
    (gc, nc): (&mut [f32], &mut [usize]),
    g: &mut [f32],
    nearest: &mut [usize],
) {
    const INF: f32 = 1e20;
    let n = w.max(h);
    let mut f = vec![0f32; n];
    let mut o = vec![0f32; n];
    let mut v = vec![0usize; n];
    let mut z = vec![0f32; n + 1];
    let mut near = vec![0usize; n];
    // Columns first, kept column by column.
    for x in 0..w {
        for y in 0..h {
            f[y] = if inside[y * w + x] { 0.0 } else { INF };
        }
        dt1(&f[..h], &mut o[..h], &mut v, &mut z, &mut near[..h]);
        gc[x * h..x * h + h].copy_from_slice(&o[..h]);
        nc[x * h..x * h + h].copy_from_slice(&near[..h]);
    }
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
}

/// The exact Euclidean distance from every pixel to the nearest one where
/// `inside` holds, and that pixel's index. Not charged to the budget: its
/// caller (a bevel's, `effects::bevel_maps`) checks the budget holds it.
pub(crate) fn edt_nearest(inside: &[bool], w: usize, h: usize) -> (Vec<f32>, Vec<usize>) {
    let n = w * h;
    let (mut gc, mut nc) = (vec![0f32; n], vec![0usize; n]);
    let (mut g, mut nearest) = (vec![0f32; n], vec![0usize; n]);
    edt_into(inside, (w, h), (&mut gc, &mut nc), &mut g, &mut nearest);
    (g, nearest)
}

/// [`edt_nearest`], charged to the budget.
fn edt(inside: &[bool], w: usize, h: usize) -> Result<(Buffer<f32>, Buffer<usize>), Error> {
    let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
    let mut g = budget::filled(n, 0f32)?;
    let mut nearest = budget::filled(n, 0usize)?;
    let mut gc = budget::filled(n, 0f32)?;
    let mut nc = budget::filled(n, 0usize)?;
    edt_into(inside, (w, h), (&mut gc, &mut nc), &mut g, &mut nearest);
    Ok((g, nearest))
}

/// The distance from each pixel outside the shape to its edge, which lies
/// inside the nearest covered pixel by that pixel's coverage, as Photoshop
/// places it. Pixels inside read -0.5.
pub(crate) fn dist_outside(s: &Map) -> Result<Buffer<f32>, Error> {
    let inside = budget::exact(s.v.len(), s.v.iter().map(|&a| a > INSIDE_EPS))?;
    let (mut d, near) = edt(&inside, s.w, s.h)?;
    for (i, d) in d.iter_mut().enumerate() {
        *d = if inside[i] {
            -0.5
        } else {
            *d - 0.5 + (1.0 - s.v[near[i]].min(1.0))
        };
    }
    Ok(d)
}

/// The distance from each pixel inside the shape to its edge; -0.5 outside.
pub(crate) fn dist_inside(s: &Map) -> Result<Buffer<f32>, Error> {
    count_inside_distance();
    let outside = budget::exact(s.v.len(), s.v.iter().map(|&a| a <= INSIDE_EPS))?;
    let (mut d, near) = edt(&outside, s.w, s.h)?;
    drop(near);
    for (d, &out) in d.iter_mut().zip(outside.iter()) {
        *d = if out { -0.5 } else { *d - 0.5 };
    }
    Ok(d)
}

/// Outside width from which a stroke's outer edge takes the exact Euclidean
/// distance instead of the 5 x 5 chamfer. The chamfer's level sets are
/// octagons, up to `0.027 r` past the true radius: half a pixel at r = 19.
/// Narrower, Photoshop matches the chamfer's sub-pixel edge seeding.
pub(crate) const STROKE_CHAMFER_MAX: f32 = 20.0;

/// The chamfer distance outside the shape, its seeds starting at their
/// sub-pixel edge (1 - coverage). Inside reads -0.5.
pub(crate) fn chamfer_outside(s: &Map) -> Result<Buffer<f32>, Error> {
    let mut d = budget::exact(
        s.v.len(),
        s.v.iter().map(|&a| {
            if a > INSIDE_EPS {
                1.0 - a.min(1.0)
            } else {
                distance::FAR
            }
        }),
    )?;
    distance::chamfer(&mut d, s.w, s.h);
    for (d, &a) in d.iter_mut().zip(s.v.iter()) {
        *d = if a > INSIDE_EPS { -0.5 } else { *d - 0.5 };
    }
    Ok(d)
}

/// Alpha relative to its 3 x 3 neighbourhood's highest: an edge's coverage
/// apart from the fill's own opacity.
fn local_coverage(s: &Map) -> Result<Map, Error> {
    let mut out = Map::filled(s.w, s.h, 0.0)?;
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
    Ok(out)
}

/// The chamfer distance inside the shape: partly covered edge pixels are
/// seeds starting at their coverage, so a 25 % edge column puts the edge a
/// quarter pixel in. Outside reads -0.5.
pub(crate) fn chamfer_inside(s: &Map) -> Result<Buffer<f32>, Error> {
    count_inside_distance();
    let cov = local_coverage(s)?;
    let mut d = budget::exact(
        s.v.len(),
        s.v.iter().zip(cov.v.iter()).map(|(&a, &c)| {
            if a <= INSIDE_EPS {
                0.0
            } else if c < 1.0 - INSIDE_EPS {
                c
            } else {
                distance::FAR
            }
        }),
    )?;
    drop(cov);
    distance::chamfer(&mut d, s.w, s.h);
    for (d, &a) in d.iter_mut().zip(s.v.iter()) {
        *d = if a <= INSIDE_EPS { -0.5 } else { *d - 0.5 };
    }
    Ok(d)
}

// ---- the effects' maps ----

/// What one glow or inner shadow asks of its map.
pub(crate) struct Soft {
    /// Size, device pixels.
    pub size: f32,
    /// Spread or Choke, 0 to 1.
    pub spread: f32,
    /// The Size split by the Spread or Choke (`fx::spread_split`) into what
    /// grows the matte and what blurs it, device pixels. Split in job units
    /// and then scaled, so the grow's whole pixels are whole job units and
    /// the effect looks the same at every zoom (review F24).
    pub grow: f32,
    pub blur: f32,
    pub contour: Option<Lut>,
    /// Range, 0 to 1 (a glow's; a shadow has none, 1).
    pub range: f32,
    /// Noise, 0 to 1.
    pub noise: f32,
    pub seed: u32,
    /// The map's corner in device pixels: where the Noise is hashed from.
    pub origin: (i32, i32),
}

/// The inverse of `shape`'s coverage: what lies outside it.
fn inverse(shape: &Map) -> Result<Map, Error> {
    Map::collect(shape.w, shape.h, shape.v.iter().map(|a| 1.0 - a))
}

/// Each value of `m` times `shape`'s coverage: the map kept to the shape.
fn keep_to(m: &mut Map, shape: &Map) {
    for (v, a) in m.v.iter_mut().zip(shape.v.iter()) {
        *v *= a;
    }
}

/// An Inner Shadow's map over `shape`: the outside of the shape moved by
/// `(dx, dy)` into it, choked and softened like a drop shadow, through its
/// contour and noise, and kept to the shape.
pub(crate) fn inner_shadow(shape: &Map, dx: f32, dy: f32, s: &Soft) -> Result<Map, Error> {
    let mut m = inverse(shape)?.shifted(dx, dy, 1.0)?;
    m = dilate(&m, s.grow)?;
    blur(&mut m, s.blur)?;
    let mut m = match &s.contour {
        Some(l) => m.map(|v| l.at(v)),
        None => m,
    };
    speckle(&mut m, s.noise, s.seed, s.origin);
    keep_to(&mut m, shape);
    Ok(m)
}

/// Satin's map over `shape`: two copies of the shape moved `(dx, dy)` and
/// `(-dx, -dy)` device pixels, each softened by `size`, and how far apart
/// they are, `|a - b|`; inverted when `invert`, then through the contour's
/// Satin table (`Lut::satin`), then kept to the shape. The order matters:
/// the contour runs on the inverted value. `contour` `None` is Linear. The
/// offsets come in whole and at least a pixel long (see
/// [`effects::satin_throw`](super::effects::satin_throw)).
/// Ported from PhotoCraft `crates/compose/src/effects/bevel.rs`
/// `satin_map`; the two box passes are fitted there to 0.2 % mean error on
/// psd-tools' layer_effects.
pub(crate) fn satin(
    shape: &Map,
    dx: f32,
    dy: f32,
    size: f32,
    invert: bool,
    contour: Option<&Lut>,
) -> Result<Map, Error> {
    let mut a = shape.shifted(dx, dy, 0.0)?;
    blur(&mut a, size)?;
    let mut b = shape.shifted(-dx, -dy, 0.0)?;
    blur(&mut b, size)?;
    // The gap, into `a`.
    for (x, y) in a.v.iter_mut().zip(b.v.iter()) {
        *x = (*x - y).abs();
    }
    drop(b);
    let mut m = a;
    if invert {
        m = m.map(|v| 1.0 - v);
    }
    if let Some(l) = contour.map(Lut::satin).filter(|l| !l.is_identity()) {
        m = m.map(|v| l.at(v));
    }
    keep_to(&mut m, shape);
    Ok(m)
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
pub(crate) fn glow(
    shape: &Map,
    technique: Technique,
    inner: bool,
    center: bool,
    s: &Soft,
) -> Result<Map, Error> {
    let mut m = match technique {
        // Coverage falls linearly from 0.5 at the edge to 0 at `size + 1`
        // pixels, solid within the spread or choke: after the default 50 %
        // Range that is Photoshop's `1 - D / (size + 1)` past the solid part
        // (measured outside and inside, sizes 10 and 20, spread 0 and 40 %,
        // choke 0 and 30 %: within one level).
        Technique::Precise => {
            let mut d = if inner {
                dist_inside(shape)?
            } else {
                dist_outside(shape)?
            };
            let solid = s.size * s.spread;
            let soft = (s.size + 1.0 - solid).max(1e-3);
            for d in d.iter_mut() {
                let e = *d + 0.5;
                *d = if e <= solid {
                    1.0
                } else {
                    0.5 * (1.0 - (e - solid) / soft).clamp(0.0, 1.0)
                };
            }
            Map {
                w: shape.w,
                h: shape.h,
                v: d,
            }
        }
        Technique::Softer => {
            let mut m = if inner {
                dilate(&inverse(shape)?, s.grow)?
            } else {
                dilate(shape, s.grow)?
            };
            blur(&mut m, s.blur)?;
            m
        }
    };
    m = ranged(m, s.contour.as_ref(), s.range, !inner);
    if inner && center {
        m = m.map(|v| 1.0 - v);
    }
    speckle(&mut m, s.noise, s.seed, s.origin);
    if inner {
        keep_to(&mut m, shape);
    }
    Ok(m)
}

/// A map read as a share of the shape's own coverage: what an interior effect
/// lays inside a half-covered edge pixel before that pixel's alpha applies.
pub(crate) fn relative_to(m: &Map, shape: &Map) -> Result<Map, Error> {
    Map::collect(
        m.w,
        m.h,
        m.v.iter().zip(shape.v.iter()).map(|(m, a)| {
            // Nothing is a share of nothing, with no divide; `min(1.0)`,
            // said as the one compare it is.
            if *a > INSIDE_EPS && m.to_bits() != 0 {
                let q = m / a;
                if q < 1.0 {
                    q
                } else {
                    1.0
                }
            } else {
                0.0
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn next(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    /// A value of a map: mostly a share, now and then one that is not.
    fn value(seed: &mut u64, odd: bool) -> f32 {
        let r = next(seed);
        let v = (r % 1001) as f32 / 1000.0;
        match (r >> 12) % 23 {
            0..=6 => 0.0,
            7..=9 => 1.0,
            10 if odd => -0.0,
            11 if odd => -v,
            12 if odd => f32::NAN,
            13 if odd => f32::INFINITY,
            14 if odd => v * 1.0e30,
            _ => v,
        }
    }

    #[test]
    fn a_move_is_what_it_was_to_the_bit() {
        let mut seed = 7u64;
        let moves = [
            0.0, -0.0, 1.0, -1.0, 3.0, -4.0, 0.5, -0.5, 2.25, -3.75, 40.0, -40.0, 1.0e12,
            f32::NAN, f32::INFINITY, 1.0e-30, -1.0e-30,
        ];
        let outsides = [0.0, 1.0, 0.25, -0.0, -1.0, f32::NAN, f32::INFINITY];
        for round in 0..600 {
            let (w, h) = (next(&mut seed) as usize % 9, next(&mut seed) as usize % 9);
            let odd = round % 3 == 0;
            let mut m = Map::new(w, h, 0.0);
            for v in m.v.iter_mut() {
                *v = value(&mut seed, odd);
            }
            let dx = moves[next(&mut seed) as usize % moves.len()];
            let dy = moves[next(&mut seed) as usize % moves.len()];
            let outside = outsides[next(&mut seed) as usize % if odd { outsides.len() } else { 3 }];
            let now = m.shifted(dx, dy, outside).unwrap();
            let then = m.shifted_as_first_written(dx, dy, outside);
            let bits = |m: &Map| m.v.iter().map(|v| v.to_bits()).collect::<Vec<_>>();
            assert_eq!(bits(&now), bits(&then), "{w}x{h} by {dx},{dy} past {outside}");
        }
    }

    #[test]
    fn a_share_of_the_shape_is_what_it_was_to_the_bit() {
        let mut seed = 11u64;
        for _ in 0..200 {
            let (w, h) = (1 + next(&mut seed) as usize % 9, 1 + next(&mut seed) as usize % 9);
            let (mut m, mut shape) = (Map::new(w, h, 0.0), Map::new(w, h, 0.0));
            for v in m.v.iter_mut().chain(shape.v.iter_mut()) {
                *v = value(&mut seed, true);
            }
            let now = relative_to(&m, &shape).unwrap();
            for ((now, m), a) in now.v.iter().zip(m.v.iter()).zip(shape.v.iter()) {
                // As first written.
                let then = if *a > INSIDE_EPS {
                    (m / a).min(1.0)
                } else {
                    0.0
                };
                assert_eq!(now.to_bits(), then.to_bits(), "{m} of {a}");
            }
        }
    }

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
            grow: 0.0,
            blur: size,
            contour: None,
            range: 0.5,
            noise: 0.0,
            seed: 1,
            origin: (0, 0),
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
        let g = glow(&shape, Technique::Softer, false, false, &soft(8.0)).unwrap();
        // Full against the shape (the default Range doubles the edge's half).
        assert!(g.v[30 * 60 + 30] > 0.99);
        // Nothing past the size and the edge.
        assert_eq!(g.v[30 * 60 + 30 + 10 + 10], 0.0);
        assert!(g.v[30 * 60 + 30 + 10 + 3] > 0.0);
    }

    /// Review F7: an Outer Glow through Cone - Inverted (contour(0) = 1) or
    /// Cove - Deep (66) once filled every pixel of its map. With the edge
    /// hidden, nothing lies past its Size; the band against the letters
    /// still takes the curve.
    #[test]
    fn an_outer_glow_through_a_lifted_contour_stops_at_its_size() {
        use super::super::contour::{Curve, Lut};
        let shape = disc(60, 60, 30.0, 30.0, 10.0);
        for (preset, ground) in [(2, 255), (3, 66)] {
            let lut = Lut::new(&Curve::Preset(preset));
            assert_eq!(lut.apply(0), ground);
            for technique in [Technique::Softer, Technique::Precise] {
                let mut s = soft(8.0);
                s.contour = Some(lut);
                let g = glow(&shape, technique, false, false, &s).unwrap();
                // The map's corners and far edge: nothing.
                for i in [0, 59, 60 * 59, 60 * 60 - 1, 30 * 60 + 1, 30 * 60 + 58] {
                    assert_eq!(g.v[i], 0.0, "preset {preset} {technique:?} at {i}");
                }
                // Past Size + 1 from the edge, nothing anywhere (bar the
                // blur's float residue on a Softer glow's square reach).
                for y in 0..60 {
                    for x in 0..60 {
                        let d = ((x as f32 - 30.0).powi(2) + (y as f32 - 30.0).powi(2)).sqrt();
                        let v = g.v[y * 60 + x];
                        if d > 10.0 + 8.0 + 3.0 {
                            assert!(v < 1e-3, "{preset} {technique:?} ({x}, {y}): {v}");
                        }
                    }
                }
                // Against the letters the glow is full (the curve's 1 there).
                assert!(g.v[30 * 60 + 30] > 0.99);
            }
        }
        // An inner glow keeps its curve's ground: it is kept to the shape.
        let mut s = soft(4.0);
        s.contour = Some(Lut::new(&Curve::Preset(3)));
        let g = glow(&shape, Technique::Softer, true, false, &s).unwrap();
        assert!(
            (g.v[30 * 60 + 30] - 66.0 / 255.0).abs() < 0.01,
            "{}",
            g.v[30 * 60 + 30]
        );
        // A contour that starts at 0 (Cone) is read as it always was: the
        // Linear glow's map through the curve, its faint tail included.
        let cone = Lut::new(&Curve::Preset(1));
        for technique in [Technique::Softer, Technique::Precise] {
            let mut s = soft(8.0);
            s.range = 1.0;
            let plain = glow(&shape, technique, false, false, &s).unwrap();
            s.contour = Some(cone);
            let curved = glow(&shape, technique, false, false, &s).unwrap();
            for (c, p) in curved.v.iter().zip(plain.v.iter()) {
                assert_eq!(*c, cone.at(*p));
            }
        }
    }

    /// Review F22: the grain is hashed from device pixels, so the same
    /// glow over maps with different corners has the same grain where they
    /// meet.
    #[test]
    fn noise_grain_stays_with_the_device_pixel() {
        let mut s = soft(6.0);
        s.noise = 0.8;
        s.seed = 9;
        // The disc at device (40, 40): one map from device (10, 10), one
        // from (0, 0) and wider.
        let small = disc(60, 60, 30.0, 30.0, 8.0);
        let big = disc(80, 80, 40.0, 40.0, 8.0);
        s.origin = (10, 10);
        let a = glow(&small, Technique::Softer, false, false, &s).unwrap();
        s.origin = (0, 0);
        let b = glow(&big, Technique::Softer, false, false, &s).unwrap();
        let mut grained = 0;
        for y in 0..60 {
            for x in 0..60 {
                let (va, vb) = (a.v[y * 60 + x], b.v[(y + 10) * 80 + x + 10]);
                assert!((va - vb).abs() < 1e-5, "({x}, {y}): {va} vs {vb}");
                grained += usize::from(va > 0.0 && va < 0.99);
            }
        }
        assert!(grained > 100, "{grained}");
        // And the inner shadow's.
        let (sa, sb) = (
            inner_shadow(
                &small,
                2.0,
                2.0,
                &Soft {
                    origin: (10, 10),
                    ..soft_noise()
                },
            )
            .unwrap(),
            inner_shadow(
                &big,
                2.0,
                2.0,
                &Soft {
                    origin: (0, 0),
                    ..soft_noise()
                },
            )
            .unwrap(),
        );
        for y in 0..60 {
            for x in 0..60 {
                let (va, vb) = (sa.v[y * 60 + x], sb.v[(y + 10) * 80 + x + 10]);
                assert!(
                    (va - vb).abs() < 1e-5,
                    "inner shadow ({x}, {y}): {va} vs {vb}"
                );
            }
        }
    }

    fn soft_noise() -> Soft {
        let mut s = soft(3.0);
        s.noise = 0.8;
        s.seed = 4;
        s
    }

    #[test]
    fn a_precise_glow_is_photoshops_line() {
        let shape = disc(80, 80, 40.0, 40.0, 12.0);
        let mut s = soft(10.0);
        s.range = 1.0;
        let g = glow(&shape, Technique::Precise, false, false, &s).unwrap();
        // Half at the edge, falling straight to nothing at size + 1.
        let at = |dx: usize| g.v[40 * 80 + 40 + 12 + dx];
        assert!(at(1) > at(4) && at(4) > at(8));
        assert_eq!(at(13), 0.0);
    }

    #[test]
    fn an_inner_glow_stays_inside_and_the_centre_one_is_its_inverse() {
        let shape = disc(60, 60, 30.0, 30.0, 15.0);
        let edge = glow(&shape, Technique::Softer, true, false, &soft(6.0)).unwrap();
        let centre = glow(&shape, Technique::Softer, true, true, &soft(6.0)).unwrap();
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

    /// A square of `n` with a 5 px empty border (PhotoCraft's `square_shape`).
    fn square(n: usize) -> Map {
        let mut m = Map::new(n, n, 0.0);
        for y in 5..n - 5 {
            for x in 5..n - 5 {
                m.v[y * n + x] = 1.0;
            }
        }
        m
    }

    #[test]
    fn a_satin_at_distance_zero_matches_photoshop() {
        // PhotoCraft's `satin_at_distance_zero_matches_photoshop`
        // (`crates/compose/src/effects/tests.rs`): Photoshop 27.11, Satin
        // black 100 %, angle 90, Linear, distance 0 (drawn as 1 px), size 5
        // over a #808080 square: the rows from the top edge read 82, 102,
        // 123, 128. At 90 degrees the 1 px throw is (0, 1).
        let m = satin(&square(60), 0.0, 1.0, 5.0, false, None).unwrap();
        for (row, gray) in [(5, 82.0), (7, 102.0), (9, 123.0), (11, 128.0), (30, 128.0)] {
            let want = 1.0 - gray / 128.0;
            let got = m.v[row * 60 + 30];
            assert!((got - want).abs() < 0.02, "row {row}: {got} vs {want}");
        }
    }

    #[test]
    fn a_satin_is_kept_to_the_shape_and_inverts() {
        let shape = square(60);
        let m = satin(&shape, 3.0, 2.0, 4.0, false, None).unwrap();
        let inv = satin(&shape, 3.0, 2.0, 4.0, true, None).unwrap();
        for (i, a) in shape.v.iter().enumerate() {
            if *a == 0.0 {
                assert_eq!(m.v[i], 0.0);
                assert_eq!(inv.v[i], 0.0);
            } else {
                assert!((m.v[i] + inv.v[i] - 1.0).abs() < 1e-5);
            }
        }
        // The two copies cancel in the middle.
        assert!(m.v[30 * 60 + 30] < 1e-5);
    }

    #[test]
    fn an_inner_shadow_falls_on_the_side_away_from_the_light() {
        let shape = disc(60, 60, 30.0, 30.0, 15.0);
        let m = inner_shadow(&shape, 5.0, 5.0, &soft(0.0)).unwrap();
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
