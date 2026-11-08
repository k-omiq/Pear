//! A stored brush stroke as the stamps that make it up: `strokeStamps` in
//! `src/lib/brush.js`, function for function.
//!
//! The JS twin stays: the brush board and the browser engine stamp with it,
//! and `tests/ink.rs` holds the two together on a fixture the JS writes
//! (`parity/ink-stamps.mjs`). So the arithmetic here is the JS's own, in its
//! order: the same additions in the same sequence, `Math.hypot` as V8 sums
//! it, `Math.round` rounding halves up, and the seeds' streams added as
//! doubles and then cut to 32 bits as `>>> 0` cuts them.

use super::{Flip, Stroke, Taper, TipOrder, PT_F, PT_O, PT_W};

/// One impression of the tip.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stamp {
    pub x: f64,
    pub y: f64,
    /// The tip's size here, page px: the dab's diameter.
    pub size: f64,
    /// Degrees.
    pub angle: f64,
    /// The stroke's opacity, faded by the opacity dynamics at this point.
    pub alpha: f64,
    /// A ribbon's slice: the arc length it sits at and how much of the path
    /// it covers.
    pub ribbon: Option<(f64, f64)>,
    /// Which tip of the cycle, when the stroke has one.
    pub tip: Option<usize>,
    /// The flips, 1 or -1.
    pub fx: f64,
    pub fy: f64,
    /// The flatness when the thickness dynamics squashed it here; `None`
    /// takes the stroke's own.
    pub flat: Option<f64>,
}

/// `Math.hypot` of two numbers as V8 computes it: both over the larger,
/// summed with Kahan's compensation, the root times the larger.
pub(crate) fn hypot(a: f64, b: f64) -> f64 {
    let (a, b) = (a.abs(), b.abs());
    if a == f64::INFINITY || b == f64::INFINITY {
        return f64::INFINITY;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    let max = if b > a { b } else { a };
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    let mut compensation = 0.0f64;
    for v in [a, b] {
        let n = v / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.round`: the nearest whole number, a half up.
pub(crate) fn js_round(v: f64) -> f64 {
    let f = v.floor();
    if v - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `v >>> 0`.
pub(crate) fn to_uint32(v: f64) -> u32 {
    if !v.is_finite() {
        return 0;
    }
    v.trunc().rem_euclid(4_294_967_296.0) as u32
}

/// Tommy Ettinger's mulberry32, as `mulberry32` in brush.js.
pub(crate) struct Mulberry32(u32);

impl Mulberry32 {
    pub(crate) fn new(seed: f64) -> Self {
        Self(to_uint32(seed))
    }

    pub(crate) fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

type Point = [f64; 5];

/// `mixPoint`: the point a share `f` of the way from `p` to `q`.
fn mix_point(p: &Point, q: &Point, f: f64) -> Point {
    let mut out = [0.0; 5];
    out[0] = p[0] + (q[0] - p[0]) * f;
    out[1] = p[1] + (q[1] - p[1]) * f;
    for k in 2..5 {
        let a = p[k];
        out[k] = a + (q[k] - a) * f;
    }
    out
}

/// `resamplePath`: the path walked at even arc length.
fn resample_path(pts: &[Point], step: f64) -> Vec<Point> {
    if pts.is_empty() {
        return Vec::new();
    }
    if pts.len() == 1 {
        return vec![pts[0]];
    }
    let d = step.max(0.01);
    let mut out = vec![pts[0]];
    let mut carry = 0.0;
    for i in 1..pts.len() {
        let (p, q) = (&pts[i - 1], &pts[i]);
        let seg = hypot(q[0] - p[0], q[1] - p[1]);
        if seg == 0.0 {
            continue;
        }
        let mut t = d - carry;
        while t <= seg {
            out.push(mix_point(p, q, t / seg));
            t += d;
        }
        carry = seg - (t - d);
    }
    out
}

/// `taperPx`.
pub(crate) fn taper_px(taper: &Taper, size: f64) -> f64 {
    let len = taper.len.max(0.0);
    if taper.pct {
        (size * len) / 100.0
    } else {
        len
    }
}

/// `taperFactor`.
fn taper_factor(taper: &Taper, dist: f64, total: f64, size: f64) -> f64 {
    if !taper.on {
        return 1.0;
    }
    let len = taper_px(taper, size).min(total / 2.0);
    if len <= 0.0 || dist >= len {
        return 1.0;
    }
    let f = dist / len;
    f.powf(1.0 + (taper.ratio / 100.0) * 2.0)
}

/// `ribbonStep`.
fn ribbon_step(size: f64) -> f64 {
    (size / 12.0).max(1.0)
}

/// `flipSign`.
fn flip_sign(mode: Flip, rnd: &mut Mulberry32) -> f64 {
    match mode {
        Flip::On => -1.0,
        Flip::Random => {
            if rnd.next() < 0.5 {
                -1.0
            } else {
                1.0
            }
        }
        Flip::Off => 1.0,
    }
}

/// `tipIndex`.
fn tip_index(order: TipOrder, i: usize, n: usize, rnd: &mut Mulberry32) -> usize {
    if n <= 1 {
        return 0;
    }
    match order {
        TipOrder::Reverse => {
            let period = 2 * (n - 1);
            let k = i % period;
            if k < n {
                k
            } else {
                period - k
            }
        }
        TipOrder::Once => i.min(n - 1),
        TipOrder::Random => (n - 1).min((rnd.next() * n as f64).floor() as usize),
        TipOrder::Repeat => i % n,
    }
}

fn degrees(rad: f64) -> f64 {
    (rad * 180.0) / core::f64::consts::PI
}

/// `headings`: the direction at each point, degrees.
fn headings(path: &[Point]) -> Vec<f64> {
    let n = path.len();
    let mut out = vec![0.0; n];
    if n < 2 {
        return out;
    }
    for (i, h) in out.iter_mut().enumerate() {
        let a = &path[i.saturating_sub(1)];
        let b = &path[(i + 1).min(n - 1)];
        *h = degrees((b[1] - a[1]).atan2(b[0] - a[0]));
    }
    out
}

/// `strokeStamps`: a stored stroke as the impressions that make it up.
pub fn stroke_stamps(stroke: &Stroke) -> Vec<Stamp> {
    if stroke.pts.is_empty() {
        return Vec::new();
    }
    let ribbon = stroke.ribbon;
    let step = if ribbon {
        ribbon_step(stroke.size)
    } else {
        ((stroke.size * stroke.spacing) / 100.0).max(0.5)
    };
    let path = resample_path(&stroke.pts, step);
    let mut dist = Vec::with_capacity(path.len());
    dist.push(0.0);
    for i in 1..path.len() {
        dist.push(dist[i - 1] + hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    }
    let total = dist[dist.len() - 1];
    let follow = ribbon || stroke.follow_dir;
    let head = follow.then(|| headings(&path));
    let mut rnd = Mulberry32::new(stroke.seed);
    let tips = stroke.cycle.len();
    let mut tip_rnd = Mulberry32::new(stroke.seed + 2_654_435_769.0);
    let flips = stroke.flip_x != Flip::Off || stroke.flip_y != Flip::Off;
    let mut flip_rnd = Mulberry32::new(stroke.seed + 2_135_587_861.0);
    let mut out = Vec::new();
    for i in 0..path.len() {
        let [x, y, w, ..] = path[i];
        let t = taper_factor(&stroke.taper_in, dist[i], total, stroke.size)
            * taper_factor(&stroke.taper_out, total - dist[i], total, stroke.size);
        let size = stroke.size * w * t;
        let alpha = stroke.opacity * path[i][PT_O];
        let f = path[i][PT_F];
        let flat = (f != 1.0).then_some(stroke.flatness * f);
        let jit = (rnd.next() * 2.0 - 1.0) * (stroke.angle_jitter / 100.0) * 180.0;
        let fx = if flips {
            flip_sign(stroke.flip_x, &mut flip_rnd)
        } else {
            1.0
        };
        let fy = if flips {
            flip_sign(stroke.flip_y, &mut flip_rnd)
        } else {
            1.0
        };
        if size < 0.25 {
            continue;
        }
        let angle = stroke.angle + jit + head.as_ref().map_or(0.0, |h| h[i]);
        let mut st = Stamp {
            x,
            y,
            size,
            angle,
            alpha,
            ribbon: None,
            tip: None,
            fx,
            fy,
            flat,
        };
        if ribbon {
            let back = if i > 0 {
                (dist[i] - dist[i - 1]) / 2.0
            } else {
                0.0
            };
            let fwd = if i + 1 < path.len() {
                (dist[i + 1] - dist[i]) / 2.0
            } else {
                0.0
            };
            st.angle = angle - 90.0;
            st.ribbon = Some((dist[i], (back + fwd).max(0.5)));
        } else if tips > 1 {
            st.tip = Some(tip_index(stroke.tip_order, out.len(), tips, &mut tip_rnd));
        }
        out.push(st);
    }
    if !ribbon && stroke.corners > 0.0 {
        mitre_stamps(stroke, step, follow, &mut out);
    }
    out
}

/// How far a pointed corner may reach past the vertex, in radii.
const MITRE_LIMIT: f64 = 4.0;
/// How far along the path a turn is measured over, page px.
const CORNER_REACH: f64 = 6.0;

/// `arcLengths`.
fn arc_lengths(pts: &[Point]) -> Vec<f64> {
    let mut arc = Vec::with_capacity(pts.len());
    arc.push(0.0);
    for i in 1..pts.len() {
        arc.push(arc[i - 1] + hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    arc
}

struct Legs {
    ux: f64,
    uy: f64,
    vx: f64,
    vy: f64,
    u: f64,
    v: f64,
}

/// `legs`.
fn legs(pts: &[Point], arc: &[f64], i: usize, last: usize) -> Option<Legs> {
    let mut a = i - 1;
    while a > 0 && arc[i] - arc[a] < CORNER_REACH {
        a -= 1;
    }
    let mut b = i + 1;
    while b < last && arc[b] - arc[i] < CORNER_REACH {
        b += 1;
    }
    let ux = pts[i][0] - pts[a][0];
    let uy = pts[i][1] - pts[a][1];
    let vx = pts[b][0] - pts[i][0];
    let vy = pts[b][1] - pts[i][1];
    let u = hypot(ux, uy);
    let v = hypot(vx, vy);
    if u < CORNER_REACH / 2.0 || v < CORNER_REACH / 2.0 {
        return None;
    }
    Some(Legs {
        ux,
        uy,
        vx,
        vy,
        u,
        v,
    })
}

/// `sharpCorners`: the vertices a turn of at least `deg` pins, in order.
pub(crate) fn sharp_corners(pts: &[Point], deg: f64) -> Vec<usize> {
    let guard = if deg.is_nan() { 0.0 } else { deg };
    if guard <= 0.0 || pts.len() < 3 {
        return Vec::new();
    }
    let arc = arc_lengths(pts);
    let last = pts.len() - 1;
    let mut found: Vec<(usize, f64)> = Vec::new();
    for i in 1..last {
        let Some(leg) = legs(pts, &arc, i, last) else {
            continue;
        };
        let dot = (leg.ux * leg.vx + leg.uy * leg.vy) / (leg.u * leg.v);
        let turn = degrees(dot.clamp(-1.0, 1.0).acos());
        if turn >= guard {
            found.push((i, turn));
        }
    }
    let mut out = Vec::new();
    for n in 0..found.len() {
        let (i, turn) = found[n];
        let mut best = true;
        let mut m = n;
        while best && m > 0 && arc[i] - arc[found[m - 1].0] <= CORNER_REACH {
            if found[m - 1].1 >= turn {
                best = false;
            }
            m -= 1;
        }
        let mut m = n + 1;
        while best && m < found.len() && arc[found[m].0] - arc[i] <= CORNER_REACH {
            if found[m].1 > turn {
                best = false;
            }
            m += 1;
        }
        if best {
            out.push(i);
        }
    }
    out
}

/// `mitreStamps`: the pointed corners, as dabs inscribed in each wedge.
fn mitre_stamps(stroke: &Stroke, step: f64, follow: bool, out: &mut Vec<Stamp>) {
    let pts = &stroke.pts;
    let pins = sharp_corners(pts, stroke.corners);
    if pins.is_empty() {
        return;
    }
    let arc = arc_lengths(pts);
    let total = arc[arc.len() - 1];
    let last = pts.len() - 1;
    for i in pins {
        let Some(leg) = legs(pts, &arc, i, last) else {
            continue;
        };
        let dot = (leg.ux * leg.vx + leg.uy * leg.vy) / (leg.u * leg.v);
        let turn = dot.clamp(-1.0, 1.0).acos();
        let phi = (core::f64::consts::PI - turn) / 2.0;
        // `!(phi > 0.01) || !(turn > 0.01)`, NaN included.
        if phi.is_nan() || phi <= 0.01 || turn.is_nan() || turn <= 0.01 {
            continue;
        }
        let mut wx = leg.ux / leg.u - leg.vx / leg.v;
        let mut wy = leg.uy / leg.u - leg.vy / leg.v;
        let wl = hypot(wx, wy);
        if wl.is_nan() || wl <= 0.0 {
            continue;
        }
        wx /= wl;
        wy /= wl;
        let w = pts[i][PT_W];
        let t = taper_factor(&stroke.taper_in, arc[i], total, stroke.size)
            * taper_factor(&stroke.taper_out, total - arc[i], total, stroke.size);
        let r = (stroke.size * w * t) / 2.0;
        let alpha = stroke.opacity * pts[i][PT_O];
        let f = pts[i][PT_F];
        let flat = (f != 1.0).then_some(stroke.flatness * f);
        if r.is_nan() || r <= 0.125 {
            continue;
        }
        let tip = r / phi.sin();
        let limit = tip.min(r * MITRE_LIMIT);
        let (vx, vy) = (pts[i][0], pts[i][1]);
        let angle = stroke.angle
            + if follow {
                degrees(leg.vy.atan2(leg.vx))
            } else {
                0.0
            };
        let dab = |d: f64, size: f64| Stamp {
            x: vx + wx * d,
            y: vy + wy * d,
            size,
            angle,
            alpha,
            ribbon: None,
            tip: None,
            fx: 1.0,
            fy: 1.0,
            flat,
        };
        let mut d = step;
        while d <= limit {
            let size = 2.0 * (tip - d) * phi.sin();
            if size < 0.25 {
                break;
            }
            out.push(dab(d, size));
            d += step;
        }
        if tip <= limit {
            let d = tip - 0.125 / phi.sin();
            out.push(dab(d, 0.25));
        }
    }
}

/// `strokeBounds`: the box-local rectangle the stroke's ink reaches,
/// `(min x, min y, max x, max y)`, or `None` when it paints nothing.
pub fn stroke_bounds(stroke: &Stroke, stamps: &[Stamp]) -> Option<(f64, f64, f64, f64)> {
    if stamps.is_empty() {
        return None;
    }
    let reach = if stroke.tip.is_some() {
        core::f64::consts::FRAC_1_SQRT_2
    } else {
        0.5
    };
    let rim = if stroke.water_edge {
        stroke.water_edge_width.max(0.0) + stroke.water_edge_blur.max(0.0)
    } else {
        0.0
    };
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for s in stamps {
        let r = s.size * reach + rim;
        x0 = x0.min(s.x - r);
        y0 = y0.min(s.y - r);
        x1 = x1.max(s.x + r);
        y1 = y1.max(s.y + r);
    }
    Some((x0, y0, x1, y1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry32_is_the_js_stream() {
        // mulberry32(1) in node: the first three draws.
        let mut r = Mulberry32::new(1.0);
        let a = [r.next(), r.next(), r.next()];
        assert_eq!(
            a,
            [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]
        );
    }

    #[test]
    fn the_cut_to_32_bits_is_the_js_one() {
        assert_eq!(to_uint32(1.0 + 2_654_435_769.0), 2_654_435_770);
        assert_eq!(to_uint32(4_294_967_296.0 + 5.0), 5);
        assert_eq!(to_uint32(-1.0), u32::MAX);
        assert_eq!(to_uint32(f64::NAN), 0);
    }

    #[test]
    fn hypot_and_round_are_the_js_ones() {
        assert_eq!(hypot(3.0, 4.0), 5.0);
        assert_eq!(hypot(0.0, -0.0), 0.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
    }
}
