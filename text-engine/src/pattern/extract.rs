use super::fft::{Complex, Plan};
use crate::paint::budget::{self, Buffer};
use crate::Error;

pub const MAX_SIDE: usize = 1024;

/// One lattice cell, with opaque, straight RGBA pixels. The caller keeps the
/// crop centre as the origin; no phase is discarded while averaging the cell.
#[derive(Debug)]
pub struct Tile {
    pub pixels: Vec<u8>,
    pub side: usize,
    pub periodic: bool,
    pub confidence: f64,
    pub a: [f64; 2],
    pub b: [f64; 2],
}

impl Tile {
    /// The ABI's fixed nine-slot report. Angles are in degrees, in the same
    /// downward-y coordinate system as the input raster.
    pub fn info(&self) -> [f64; 9] {
        [
            if self.periodic { 1.0 } else { 0.0 },
            self.confidence,
            length(self.a),
            self.a[1].atan2(self.a[0]).to_degrees(),
            self.a[0],
            self.a[1],
            self.b[0],
            self.b[1],
            self.side as f64,
        ]
    }
}

type Point = [f64; 2];
fn dot(a: Point, b: Point) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn cross(a: Point, b: Point) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn length(a: Point) -> f64 {
    dot(a, a).sqrt()
}
fn scale(a: Point, s: f64) -> Point {
    [a[0] * s, a[1] * s]
}
fn add(a: Point, b: Point) -> Point {
    [a[0] + b[0], a[1] + b[1]]
}

struct Correlation {
    data: Buffer<Complex>,
    stride: usize,
    range: i32,
    // The principal gradient direction identifies a line screen. Its second
    // eigenvalue is small because movement along the lines changes no colour.
    normal: Point,
    line: bool,
}

impl Correlation {
    fn at(&self, x: i32, y: i32) -> f64 {
        let n = self.stride as i32;
        self.data[y.rem_euclid(n) as usize * self.stride + x.rem_euclid(n) as usize].re
    }

    fn sample(&self, p: Point) -> f64 {
        let x = p[0].floor() as i32;
        let y = p[1].floor() as i32;
        let u = p[0] - x as f64;
        let v = p[1] - y as f64;
        (self.at(x, y) * (1.0 - u) + self.at(x + 1, y) * u) * (1.0 - v)
            + (self.at(x, y + 1) * (1.0 - u) + self.at(x + 1, y + 1) * u) * v
    }

    /// Least-squares quadratic on the nine neighbours, including its mixed
    /// derivative. At a line ridge the Hessian is singular: only move in the
    /// normal direction, leaving the unconstrained tangent where it was.
    fn parabola(&self, x: i32, y: i32, normal: Option<Point>) -> Point {
        let mut gx = 0.0;
        let mut gy = 0.0;
        let mut xx = 0.0;
        let mut yy = 0.0;
        for i in -1..=1 {
            gx += (self.at(x + 1, y + i) - self.at(x - 1, y + i)) / 6.0;
            gy += (self.at(x + i, y + 1) - self.at(x + i, y - 1)) / 6.0;
            xx += (self.at(x - 1, y + i) - 2.0 * self.at(x, y + i) + self.at(x + 1, y + i)) / 3.0;
            yy += (self.at(x + i, y - 1) - 2.0 * self.at(x + i, y) + self.at(x + i, y + 1)) / 3.0;
        }
        let xy = (self.at(x + 1, y + 1) - self.at(x - 1, y + 1) - self.at(x + 1, y - 1)
            + self.at(x - 1, y - 1))
            / 4.0;
        let offset = if let Some(n) = normal {
            let curvature = xx * n[0] * n[0] + 2.0 * xy * n[0] * n[1] + yy * n[1] * n[1];
            if curvature >= -1e-9 {
                return [x as f64, y as f64];
            }
            scale(n, -(gx * n[0] + gy * n[1]) / curvature)
        } else {
            let det = xx * yy - xy * xy;
            if xx >= 0.0 || yy >= 0.0 || det <= 1e-9 {
                return [x as f64, y as f64];
            }
            [(xy * gy - yy * gx) / det, (xy * gx - xx * gy) / det]
        };
        if offset.iter().any(|v| !v.is_finite() || v.abs() > 1.0) {
            return [x as f64, y as f64];
        }
        [x as f64 + offset[0], y as f64 + offset[1]]
    }

    fn peak_near(&self, p: Point) -> Option<Point> {
        let x = p[0].round() as i32;
        let y = p[1].round() as i32;
        let mut best = (x, y);
        for dy in -1..=1 {
            for dx in -1..=1 {
                if self.at(x + dx, y + dy) > self.at(best.0, best.1) {
                    best = (x + dx, y + dy);
                }
            }
        }
        let q = self.parabola(best.0, best.1, None);
        (length(add(q, scale(p, -1.0))) < 1.75 && self.sample(q) > 0.25).then_some(q)
    }
}

/// All allocations that scale with the crop are fallible and charged to the
/// same scope. The dimensions are bounded before any multiplication or read.
pub fn extract(width: usize, height: usize, rgba: &[u8]) -> Result<Tile, Error> {
    let _scope = budget::Scope::new();
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || rgba.len() != width * height * 4
    {
        return Err(Error::BadSpec);
    }
    let short = width.min(height);
    if short >= 16 {
        let s = (1usize << short.ilog2()).min(512);
        let ac = autocorrelation(width, height, rgba, s)?;
        let basis = if ac.line {
            line_basis(&ac)
        } else {
            lattice(&ac)?
        };
        if let Some((a, b)) = basis.filter(|&(a, b)| {
            let aa = dot(a, a);
            let bb = dot(b, b);
            aa.is_finite()
                && bb.is_finite()
                && aa >= 4.0
                && bb >= 4.0
                && cross(a, b).abs() > 0.3 * (aa * bb).sqrt()
        }) {
            let (a, b) = reduce(a, b);
            let confidence = [a, b, add(a, b), add(a, scale(b, -1.0))]
                .iter()
                .map(|&p| ac.sample(p))
                .sum::<f64>()
                / 4.0;
            let confidence = confidence.clamp(0.0, 1.0);
            // The projection of a rectangle on a vector is its extent in that
            // direction. Check the original crop as well as the analysis lag.
            let repeats = |p: Point| {
                let extent = (width as f64 * p[0].abs() + height as f64 * p[1].abs()) / length(p);
                3.0 * length(p) <= extent
            };
            if confidence >= 0.35 && repeats(a) && repeats(b) {
                drop(ac);
                let side = (length(a).max(length(b)) * 4.0).ceil().clamp(16.0, 256.0) as usize;
                let pixels = average_cell(width, height, rgba, a, b, side)?;
                return Ok(Tile {
                    pixels,
                    side,
                    periodic: true,
                    confidence,
                    a,
                    b,
                });
            }
        }
    }
    fallback(width, height, rgba)
}

fn autocorrelation(w: usize, h: usize, rgba: &[u8], s: usize) -> Result<Correlation, Error> {
    // A summed-area table removes a wide box blur without a radius-dependent
    // cost. The whole crop supplies the blur even outside the analysis square.
    let iw = w + 1;
    let mut integral = budget::filled(iw * (h + 1), 0.0)?;
    for y in 0..h {
        let mut sum = 0.0;
        for x in 0..w {
            let i = (y * w + x) * 4;
            sum +=
                0.2126 * rgba[i] as f64 + 0.7152 * rgba[i + 1] as f64 + 0.0722 * rgba[i + 2] as f64;
            integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1] + sum;
        }
    }
    let radius = (w.min(h) / 10).max(8);
    let n = s * 2;
    let mut data = budget::filled(n * n, Complex::default())?;
    let mut window = budget::filled(s, 0.0)?;
    for (i, v) in window.iter_mut().enumerate() {
        *v = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / (s - 1) as f64).cos();
    }
    let x0 = (w - s) / 2;
    let y0 = (h - s) / 2;
    for y in 0..s {
        for x in 0..s {
            let px = x + x0;
            let py = y + y0;
            let l = px.saturating_sub(radius);
            let r = (px + radius + 1).min(w);
            let t = py.saturating_sub(radius);
            let b = (py + radius + 1).min(h);
            let mean = (integral[b * iw + r] - integral[t * iw + r] - integral[b * iw + l]
                + integral[t * iw + l])
                / ((r - l) * (b - t)) as f64;
            let i = (py * w + px) * 4;
            data[y * n + x].re = (0.2126 * rgba[i] as f64
                + 0.7152 * rgba[i + 1] as f64
                + 0.0722 * rgba[i + 2] as f64
                - mean)
                * window[x]
                * window[y];
        }
    }
    drop(integral);
    let (mut xx, mut xy, mut yy) = (0.0, 0.0, 0.0);
    for y in 1..s - 1 {
        for x in 1..s - 1 {
            let gx = data[y * n + x + 1].re - data[y * n + x - 1].re;
            let gy = data[(y + 1) * n + x].re - data[(y - 1) * n + x].re;
            xx += gx * gx;
            xy += gx * gy;
            yy += gy * gy;
        }
    }
    let angle = 0.5 * (2.0 * xy).atan2(xx - yy);
    let normal = [angle.cos(), angle.sin()];
    let anisotropy = ((xx - yy).powi(2) + 4.0 * xy * xy).sqrt() / (xx + yy).max(1e-12);
    let plan = Plan::new(n)?;
    plan.square(&mut data, false);
    for v in data.iter_mut() {
        v.re = v.re * v.re + v.im * v.im;
        v.im = 0.0;
    }
    plan.square(&mut data, true);
    // With a Hann window, the overlap count is the sum of the products of
    // window weights, rather than the unwindowed number of pixel pairs. It
    // factors into two one-dimensional counts; this prevents a long true lag
    // from appearing weaker just because fewer window weights overlap.
    let range = (s / 3) as i32;
    let mut overlap = budget::filled(s, 0.0)?;
    for lag in 0..s {
        overlap[lag] = (0..s - lag).map(|i| window[i] * window[i + lag]).sum();
    }
    let zero = data[0].re / (overlap[0] * overlap[0]);
    // The four confidence probes include a+b and a-b. Normalize their lags
    // too, even when the sum is outside the radius used to discover peaks.
    let report_range = 2 * range + 2;
    for y in -report_range..=report_range {
        for x in -report_range..=report_range {
            let i = y.rem_euclid(n as i32) as usize * n + x.rem_euclid(n as i32) as usize;
            data[i].re = if zero > 1e-9 {
                data[i].re
                    / (overlap[x.unsigned_abs() as usize]
                        * overlap[y.unsigned_abs() as usize]
                        * zero)
            } else {
                0.0
            };
        }
    }
    Ok(Correlation {
        data,
        stride: n,
        range,
        normal,
        line: anisotropy > 0.92,
    })
}

fn lattice(ac: &Correlation) -> Result<Option<(Point, Point)>, Error> {
    let mut peaks = Buffer::new();
    for y in -ac.range..=ac.range {
        for x in 0..=ac.range {
            let len = (x * x + y * y) as f64;
            if (x == 0 && y <= 0)
                || len < 4.0
                || len > (ac.range * ac.range) as f64
                || ac.at(x, y) <= 0.25
            {
                continue;
            }
            if (-1..=1).all(|dy| {
                (-1..=1).all(|dx| (dx == 0 && dy == 0) || ac.at(x, y) >= ac.at(x + dx, y + dy))
            }) {
                budget::push(&mut peaks, ac.parabola(x, y, None))?;
            }
        }
    }
    // Unstable sort is in-place: even the peak list's ordering cannot hide
    // an infallible scratch allocation outside the painter's budget.
    peaks.sort_unstable_by(|a, b| dot(*a, *a).total_cmp(&dot(*b, *b)));
    let Some(&a) = peaks.first() else {
        return Ok(None);
    };
    let Some(&b) = peaks
        .iter()
        .find(|&&b| cross(a, b).abs() > 0.3 * length(a) * length(b))
    else {
        return Ok(None);
    };
    let (mut a, mut b) = (a, b);
    for _ in 0..4 {
        let (mut mm, mut mn, mut nn) = (0.0, 0.0, 0.0);
        let (mut mp, mut np) = ([0.0; 2], [0.0; 2]);
        for m in -4..=4 {
            for n in -4..=4 {
                let p = add(scale(a, m as f64), scale(b, n as f64));
                if (m == 0 && n == 0) || length(p) > ac.range as f64 {
                    continue;
                }
                if let Some(q) = ac.peak_near(p) {
                    let (m, n) = (m as f64, n as f64);
                    mm += m * m;
                    mn += m * n;
                    nn += n * n;
                    mp = add(mp, scale(q, m));
                    np = add(np, scale(q, n));
                }
            }
        }
        let det = mm * nn - mn * mn;
        if det <= 0.0 {
            return Ok(None);
        }
        a = scale(add(scale(mp, nn), scale(np, -mn)), 1.0 / det);
        b = scale(add(scale(np, mm), scale(mp, -mn)), 1.0 / det);
    }
    Ok(Some((a, b)))
}

/// A line screen has no unique second period. Return a square cell: one
/// vector crosses one line period and the other runs along the lines for the
/// same distance. Ridges constrain only the normal frequency, so fit that
/// frequency to many displaced ridges, rather than inventing 2D maxima.
fn line_basis(ac: &Correlation) -> Option<(Point, Point)> {
    let mut period = None;
    for r in 2..ac.range {
        let p = scale(ac.normal, r as f64);
        let v = ac.sample(p);
        if v > 0.25
            && v >= ac.sample(scale(ac.normal, r as f64 - 1.0))
            && v > ac.sample(scale(ac.normal, r as f64 + 1.0))
        {
            period = Some(r as f64);
            break;
        }
    }
    let mut q = scale(ac.normal, 1.0 / period?);
    for _ in 0..6 {
        let p = 1.0 / length(q);
        let normal = scale(q, p);
        let tangent = [-normal[1], normal[0]];
        let (mut xx, mut xy, mut yy, mut xm, mut ym) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for m in -4..=4 {
            for n in -4..=4 {
                if m == 0 && n == 0 {
                    continue;
                }
                let at = add(scale(normal, p * m as f64), scale(tangent, p * n as f64));
                if length(at) > ac.range as f64 {
                    continue;
                }
                let peak = ac.parabola(at[0].round() as i32, at[1].round() as i32, Some(normal));
                if ac.sample(peak) < 0.25 {
                    continue;
                }
                xx += peak[0] * peak[0];
                xy += peak[0] * peak[1];
                yy += peak[1] * peak[1];
                xm += peak[0] * m as f64;
                ym += peak[1] * m as f64;
            }
        }
        let det = xx * yy - xy * xy;
        if det <= 1e-9 {
            return None;
        }
        q = [(yy * xm - xy * ym) / det, (xx * ym - xy * xm) / det];
    }
    let a = scale(q, 1.0 / dot(q, q));
    Some((a, [-a[1], a[0]]))
}

fn reduce(mut a: Point, mut b: Point) -> (Point, Point) {
    for _ in 0..32 {
        if dot(b, b) < dot(a, a) {
            std::mem::swap(&mut a, &mut b);
        }
        let m = (dot(a, b) / dot(a, a)).round();
        if m == 0.0 {
            break;
        }
        b = add(b, scale(a, -m));
    }
    if a[0] < 0.0 || (a[0] == 0.0 && a[1] < 0.0) {
        a = scale(a, -1.0);
    }
    if cross(a, b) < 0.0 {
        b = scale(b, -1.0);
    }
    (a, b)
}

#[cfg(test)]
#[inline]
fn sample_rgb(w: usize, rgba: &[u8], p: Point) -> [f64; 3] {
    sample::<false>(w, rgba, p)
}

#[inline]
fn sample<const GRAY: bool>(w: usize, rgba: &[u8], p: Point) -> [f64; 3] {
    let x = p[0] - 0.5;
    let y = p[1] - 0.5;
    let ix = x as usize;
    let iy = y as usize;
    let u = x - ix as f64;
    let v = y - iy as f64;
    let i = (iy * w + ix) * 4;
    let mut out = [0.0; 3];
    for c in 0..if GRAY { 1 } else { 3 } {
        out[c] = (rgba[i + c] as f64 * (1.0 - u) + rgba[i + 4 + c] as f64 * u) * (1.0 - v)
            + (rgba[i + w * 4 + c] as f64 * (1.0 - u) + rgba[i + w * 4 + 4 + c] as f64 * u) * v;
    }
    out
}

// Intersect the integer translations of one lattice row with a crop axis.
// This avoids visiting the empty corners of a rotated cell's bounding box,
// and leaves the hot sampling loop with no per-point crop rejection.
fn clip_translations(base: f64, step: f64, extent: usize, low: &mut f64, high: &mut f64) {
    // A point exactly on the one-pixel margin must not lose its contribution
    // because a different grouping of the affine additions moved it by a few
    // floating-point ulps. This is far smaller than a sampling pixel.
    let epsilon = 1e-9;
    if step.abs() < 1e-12 {
        if base < 1.0 - epsilon || base > extent as f64 - 1.0 + epsilon {
            *high = *low - 1.0;
        }
    } else {
        let a = (1.0 - epsilon - base) / step;
        let b = (extent as f64 - 1.0 + epsilon - base) / step;
        *low = low.max(a.min(b));
        *high = high.min(a.max(b));
    }
}

fn average_cell(
    w: usize,
    h: usize,
    rgba: &[u8],
    a: Point,
    b: Point,
    side: usize,
) -> Result<Vec<u8>, Error> {
    // Manga crops are commonly grey. Checking once lets the inner loop read
    // and interpolate one colour instead of doing the same work three times.
    // This is exact even when the crop has arbitrary, ignored alpha values.
    if rgba.chunks_exact(4).all(|p| p[0] == p[1] && p[1] == p[2]) {
        average_cell_with::<true>(w, h, rgba, a, b, side)
    } else {
        average_cell_with::<false>(w, h, rgba, a, b, side)
    }
}

fn average_cell_with<const GRAY: bool>(
    w: usize,
    h: usize,
    rgba: &[u8],
    a: Point,
    b: Point,
    side: usize,
) -> Result<Vec<u8>, Error> {
    let mut pixels = budget::filled(side * side * 4, 255u8)?;
    let origin = [w as f64 / 2.0, h as f64 / 2.0];
    let det = cross(a, b);
    if !det.is_finite() || det <= 1e-6 {
        return Err(Error::BadSpec);
    }
    let inverse = |p: Point| [cross(p, b) / det, cross(a, p) / det];
    let mut low = [f64::INFINITY; 2];
    let mut high = [f64::NEG_INFINITY; 2];
    for y in [1.0, h as f64 - 1.0] {
        for x in [1.0, w as f64 - 1.0] {
            let p = inverse([x - origin[0], y - origin[1]]);
            for c in 0..2 {
                low[c] = low[c].min(p[c]);
                high[c] = high[c].max(p[c]);
            }
        }
    }
    let channels = if GRAY { 1 } else { 3 };
    let mut sums = budget::filled(side * side * channels, 0.0)?;
    // At most one million crop pixels contribute translations to a texel,
    // so a 32-bit counter suffices even for the shortest accepted basis.
    let mut counts = budget::filled(side * side, 0u32)?;
    let step = scale(a, 1.0 / side as f64);
    let cell_min = [a[0].min(0.0) + b[0].min(0.0), a[1].min(0.0) + b[1].min(0.0)];
    let cell_max = [a[0].max(0.0) + b[0].max(0.0), a[1].max(0.0) + b[1].max(0.0)];
    // Visit neighbouring texels of each crop cell together. The definition is
    // unchanged, including the order of translations in each texel's sum,
    // but source pixels now stay in cache instead of rescanning the full crop
    // for every single texel. The small sums and counts stay hot as well.
    for l in low[1].floor() as i32..=high[1].ceil() as i32 {
        for k in low[0].floor() as i32..=high[0].ceil() as i32 {
            let cell = add(origin, add(scale(a, k as f64), scale(b, l as f64)));
            if cell[0] + cell_max[0] < 1.0
                || cell[0] + cell_min[0] > w as f64 - 1.0
                || cell[1] + cell_max[1] < 1.0
                || cell[1] + cell_min[1] > h as f64 - 1.0
            {
                continue;
            }
            for j in 0..side {
                let v = (j as f64 + 0.5) / side as f64;
                let base = add(cell, add(scale(a, 0.5 / side as f64), scale(b, v)));
                let mut first = 0.0;
                let mut last = (side - 1) as f64;
                clip_translations(base[0], step[0], w, &mut first, &mut last);
                clip_translations(base[1], step[1], h, &mut first, &mut last);
                let first = first.ceil() as usize;
                let last = last.floor();
                if last < first as f64 {
                    continue;
                }
                let mut p = add(base, scale(step, first as f64));
                for i in first..=last as usize {
                    let at = j * side + i;
                    let rgb = sample::<GRAY>(w, rgba, p);
                    for c in 0..channels {
                        sums[at * channels + c] += rgb[c];
                    }
                    counts[at] += 1;
                    p = add(p, step);
                }
            }
        }
    }
    for at in 0..side * side {
        if counts[at] == 0 {
            return Err(Error::BadSpec);
        }
        for c in 0..3 {
            pixels[at * 4 + c] =
                (sums[at * channels + if GRAY { 0 } else { c }] / counts[at] as f64).round() as u8;
        }
    }
    Ok(pixels.into_vec())
}

fn fallback(w: usize, h: usize, rgba: &[u8]) -> Result<Tile, Error> {
    let side = w.min(h);
    let x0 = (w - side) / 2;
    let y0 = (h - side) / 2;
    let mut pixels = budget::filled(side * side * 4, 255u8)?;
    let mut weights = budget::filled(side, 0.0)?;
    if side > 1 {
        for (i, v) in weights.iter_mut().enumerate() {
            *v = (std::f64::consts::PI * i as f64 / (side - 1) as f64)
                .sin()
                .powi(2);
        }
    }
    // Offset and blend: at the outer edges only the wrapped, half-shifted
    // copy remains. Both sides of a join consequently meet at neighbouring
    // pixels from the original centre, with a smooth falloff of the original.
    for y in 0..side {
        for x in 0..side {
            let weight = weights[x] * weights[y];
            let original = ((y0 + y) * w + x0 + x) * 4;
            let shifted = ((y0 + (y + side / 2) % side) * w + x0 + (x + side / 2) % side) * 4;
            for c in 0..3 {
                pixels[(y * side + x) * 4 + c] = (rgba[original + c] as f64 * weight
                    + rgba[shifted + c] as f64 * (1.0 - weight))
                    .round() as u8;
            }
        }
    }
    Ok(Tile {
        pixels: pixels.into_vec(),
        side,
        periodic: false,
        confidence: 0.0,
        a: [side as f64, 0.0],
        b: [0.0, side as f64],
    })
}

#[cfg(test)]
mod tests;
