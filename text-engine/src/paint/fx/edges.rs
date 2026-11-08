//! The distances a chiselled bevel is cut from: to the letters' edge as
//! their anti-aliased pixels place it, at any angle.
//!
//! The plain distance to the nearest empty pixel follows the pixel
//! staircase of an oblique edge, and a chisel facet made from it shades in
//! stripes. Here each sharp, anti-aliased edge pixel puts the straight edge
//! through it where its coverage says, along a normal fitted to its
//! neighbours, and the pixels near the edge measure to that line.
//!
//! Ported from PhotoCraft, `crates/compose/src/effects/distance.rs`
//! (`edge_offset`, `SharpEdge`, `EdgePixel`, `SharpEdges`, `sharp_edges`,
//! `refine_edge_normals`, `edge_distance`, `bevel_dist_inside`,
//! `bevel_dist_outside`, `bevel_dists`, `covered`, and their constants),
//! Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors, MIT
//! licence (see `THIRD_PARTY.md`). Changed: one thread (PhotoCraft's
//! `par_units` / `par_fill` are plain loops), nearest indices as `usize`.

use super::map::{edt_nearest, Map, INSIDE_EPS};

/// Signed distance from the centre of a pixel of coverage `a` to the
/// straight edge crossing it, positive when the centre is inside the shape.
/// `n` is the edge's unit normal (its signs don't matter).
///
/// A unit pixel cut by a straight edge at distance `r` from its centre (on
/// the side that holds at most half of the pixel) is covered `1/2 - r/u`
/// while the edge crosses two opposite sides, and `((u + v)/2 - r)^2 /
/// (2uv)` once it only cuts off a corner, with `u >= v` the larger and
/// smaller component of the normal. Inverting that places the edge by its
/// coverage at any angle. For an axis-aligned edge (`v = 0`) it is the
/// `a - 1/2` that `dist_outside` assumes.
pub(crate) fn edge_offset(n: [f32; 2], a: f32) -> f32 {
    if !a.is_finite() {
        return 0.0;
    }
    let (u, v) = (n[0].abs().max(n[1].abs()), n[0].abs().min(n[1].abs()));
    let (c, inside) = if a > 0.5 { (1.0 - a, true) } else { (a, false) };
    let c = c.clamp(0.0, 0.5);
    // The coverage below which the edge only cuts off a corner.
    let corner = if u > 0.0 { v / (2.0 * u) } else { 0.0 };
    let r = if c >= corner {
        (0.5 - c) * u
    } else {
        0.5 * (u + v) - (2.0 * u * v * c).sqrt()
    };
    if inside {
        r
    } else {
        -r
    }
}

/// A sharp, anti-aliased edge pixel: where it puts the straight edge
/// crossing it.
#[derive(Clone, Copy)]
pub(crate) struct SharpEdge {
    /// Signed distance from the pixel's centre to the edge, positive inside
    /// ([`edge_offset`]).
    pub offset: f32,
    /// The edge's unit normal pointing into the shape (`[0, 0]` when the
    /// coverage gives no direction).
    pub normal: [f32; 2],
}

/// Half the spacing of the edge pixels along an edge (at most sqrt 2 / 2,
/// along a diagonal): a pixel within it of the foot of the perpendicular
/// sees the edge as a line, one further out as its end.
const EDGE_REACH: f32 = 0.75;

impl SharpEdge {
    /// Distance to the edge from the pixel `(dx, dy)` away from this one,
    /// positive on the shape's side (`inside`) or on the empty side. It is
    /// the distance to the edge's line where the perpendicular lands within
    /// [`EDGE_REACH`] of this pixel, and to the end of that stretch beyond,
    /// so the distance to a straight edge is exact and does not follow the
    /// pixel staircase. `None` when the edge has no direction or `(dx, dy)`
    /// is on the wrong side of it.
    fn distance(&self, dx: f32, dy: f32, inside: bool) -> Option<f32> {
        let [nx, ny] = self.normal;
        if nx == 0.0 && ny == 0.0 {
            return None;
        }
        let signed = self.offset + dx * nx + dy * ny;
        let across = if inside { signed } else { -signed };
        let along = (dx * -ny + dy * nx).abs();
        (across > 0.0).then(|| across.hypot((along - EDGE_REACH).max(0.0)))
    }
}

/// A sharp edge pixel and where it sits.
#[derive(Clone, Copy)]
struct EdgePixel {
    /// Index of the pixel in the map.
    at: usize,
    /// The pixel's coverage (`local_coverage` of it).
    cov: f32,
    edge: SharpEdge,
}

/// The sharp edge pixels of a map: a short list, and for every pixel a 4
/// byte slot (0 = no edge, k = the k-th of the list). Maps are big and edge
/// pixels few.
pub(crate) struct SharpEdges {
    w: usize,
    h: usize,
    slot: Vec<u32>,
    pixels: Vec<EdgePixel>,
}

impl SharpEdges {
    fn empty(w: usize, h: usize) -> Self {
        SharpEdges {
            w,
            h,
            slot: Vec::new(),
            pixels: Vec::new(),
        }
    }

    /// The edge of pixel `i`, if it is a sharp edge pixel.
    fn get(&self, i: usize) -> Option<SharpEdge> {
        let k = (*self.slot.get(i)? as usize).checked_sub(1)?;
        self.pixels.get(k).map(|p| p.edge)
    }

    /// The edge of pixel `(x, y)`, if it is a sharp edge pixel (`None` off
    /// the map).
    fn at(&self, x: usize, y: usize) -> Option<SharpEdge> {
        if x >= self.w || y >= self.h {
            None
        } else {
            self.get(y * self.w + x)
        }
    }

    fn has(&self, x: usize, y: usize) -> bool {
        self.at(x, y).is_some()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pixels.is_empty()
    }

    /// Every sharp edge pixel, as (index in the map, its edge), in pixel
    /// order.
    #[cfg(test)]
    pub(crate) fn iter(&self) -> impl Iterator<Item = (usize, SharpEdge)> + '_ {
        self.pixels.iter().map(|p| (p.at, p.edge))
    }
}

/// Where the sharp, anti-aliased edge pixels of `s` put the edge
/// ([`edge_offset`], along the normal the coverage gradient gives). Sharp
/// pixels are partly covered and touch both an empty and a full pixel; hard
/// edges and soft ramps have none and keep the `alpha - 1/2` of
/// `dist_outside`.
pub(crate) fn sharp_edges(s: &Map) -> SharpEdges {
    let (w, h) = (s.w, s.h);
    if w == 0 || h == 0 || s.v.len() != w * h || s.v.len() >= u32::MAX as usize {
        return SharpEdges::empty(w, h);
    }
    let (wi, hi) = (w as i64, h as i64);
    // `local_coverage` of the pixel at (x, y), on the map.
    let cov_at = |x: i64, y: i64| -> f32 {
        let a = s.v[y as usize * w + x as usize];
        if a <= INSIDE_EPS {
            return a;
        }
        let mut mx = a;
        for dy in -1..=1 {
            for dx in -1..=1 {
                mx = mx.max(s.get(x + dx, y + dy));
            }
        }
        (a / mx).min(1.0)
    };
    // The coverage with the map's border repeated, for the gradient.
    let cov_clamped = |x: i64, y: i64| cov_at(x.clamp(0, wi - 1), y.clamp(0, hi - 1));
    // Whether a pixel is not empty. Off the map counts as covered: only a
    // neighbour on the map can be empty.
    let solid = |x: i64, y: i64| -> bool {
        if x < 0 || y < 0 || x >= wi || y >= hi {
            return true;
        }
        let a = s.v[y as usize * w + x as usize];
        a.is_nan() || a > INSIDE_EPS
    };
    let mut pixels: Vec<EdgePixel> = Vec::new();
    for y in 0..hi {
        for x in 0..wi {
            if !solid(x, y) || (-1..=1).all(|dy| (-1..=1).all(|dx| solid(x + dx, y + dy))) {
                continue;
            }
            let i = (y * wi + x) as usize;
            let c = cov_at(x, y);
            if s.v[i] <= INSIDE_EPS || c >= 1.0 - INSIDE_EPS {
                continue;
            }
            let (mut empty, mut full) = (false, false);
            for (dx, dy) in (-1..=1).flat_map(|dy| (-1..=1).map(move |dx| (dx, dy))) {
                let (nx, ny) = (x + dx, y + dy);
                if (dx, dy) == (0, 0) || nx < 0 || ny < 0 || nx >= wi || ny >= hi {
                    continue;
                }
                empty |= s.get(nx, ny) <= INSIDE_EPS;
                full |= cov_at(nx, ny) >= 1.0 - INSIDE_EPS;
            }
            if !(empty && full) {
                continue;
            }
            let at = &cov_clamped;
            let gx = (at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2.0 * at(x - 1, y) + at(x - 1, y + 1));
            let gy = (at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2.0 * at(x, y - 1) + at(x + 1, y - 1));
            let len = gx.hypot(gy);
            let (normal, n) = if len.is_finite() && len > 1e-6 {
                ([gx / len, gy / len], [gx / len, gy / len])
            } else {
                ([0.0, 0.0], [1.0, 0.0])
            };
            pixels.push(EdgePixel {
                at: i,
                cov: c,
                edge: SharpEdge {
                    offset: edge_offset(n, c),
                    normal,
                },
            });
        }
    }
    let mut slot = vec![0u32; w * h];
    for (k, p) in pixels.iter().enumerate() {
        if let Some(s) = slot.get_mut(p.at) {
            *s = k as u32 + 1;
        }
    }
    refine_edge_normals(&mut pixels, &slot, w, h);
    SharpEdges { w, h, slot, pixels }
}

/// How far (in pixels) around an edge pixel [`refine_edge_normals`] looks
/// for its neighbours.
const NORMAL_RADIUS: i64 = 3;

/// The edge points around a pixel must spread at least this far (px,
/// standard deviation) along their line to give it a direction, and stay
/// within [`EDGE_LINE_MAX_OFF`] of it.
const EDGE_LINE_MIN_SPREAD: f32 = 0.7;

const EDGE_LINE_MAX_OFF: f32 = 0.1;

/// The 3 x 3 gradient of the coverage gives an edge's direction to 1-2
/// degrees, and its error is systematic, so it tilts the distance of every
/// pixel the same way and shows as a faint ripple. The edge points of a
/// straight edge's pixels (each pixel's centre moved to its edge) lie on one
/// line, and the line through the points of the pixels around one gives the
/// direction to a fraction of a degree. Where those points are not on a line
/// (corners, tight curves) the gradient's normal stays.
fn refine_edge_normals(pixels: &mut [EdgePixel], slot: &[u32], w: usize, h: usize) {
    let (wi, hi) = (w as i64, h as i64);
    let points: Vec<[f32; 2]> = pixels
        .iter()
        .map(|p| {
            [
                (p.at as i64 % wi) as f32 - p.edge.offset * p.edge.normal[0],
                (p.at as i64 / wi) as f32 - p.edge.offset * p.edge.normal[1],
            ]
        })
        .collect();
    let before: Vec<SharpEdge> = pixels.iter().map(|p| p.edge).collect();
    // Every pixel reads the unrefined edges around it and writes its own.
    let mut near: Vec<[f32; 2]> = Vec::new();
    for (pixel, &e) in pixels.iter_mut().zip(&before) {
        let (x, y) = (pixel.at as i64 % wi, pixel.at as i64 / wi);
        let (mut n, mut sum) = (0.0f32, [0.0f32; 2]);
        near.clear();
        for (dx, dy) in (-NORMAL_RADIUS..=NORMAL_RADIUS)
            .flat_map(|dy| (-NORMAL_RADIUS..=NORMAL_RADIUS).map(move |dx| (dx, dy)))
        {
            let (nx, ny) = (x + dx, y + dy);
            if dx * dx + dy * dy > NORMAL_RADIUS * NORMAL_RADIUS
                || nx < 0
                || ny < 0
                || nx >= wi
                || ny >= hi
            {
                continue;
            }
            let Some(j) = slot
                .get((ny * wi + nx) as usize)
                .and_then(|&s| (s as usize).checked_sub(1))
            else {
                continue;
            };
            let (Some(o), Some(&p)) = (before.get(j), points.get(j)) else {
                continue;
            };
            if o.normal[0] * e.normal[0] + o.normal[1] * e.normal[1] > 0.9 {
                near.push(p);
                sum = [sum[0] + p[0], sum[1] + p[1]];
                n += 1.0;
            }
        }
        if near.len() < 3 {
            continue;
        }
        let mean = [sum[0] / n, sum[1] / n];
        let (mut sxx, mut sxy, mut syy) = (0.0f32, 0.0f32, 0.0f32);
        for p in &near {
            let (dx, dy) = (p[0] - mean[0], p[1] - mean[1]);
            sxx += dx * dx;
            sxy += dx * dy;
            syy += dy * dy;
        }
        // Spread along and across the best line through the points.
        let half = 0.5 * (sxx + syy);
        let root = (0.25 * (sxx - syy) * (sxx - syy) + sxy * sxy).sqrt();
        let (along, across) = (
            ((half + root) / n).max(0.0).sqrt(),
            ((half - root) / n).max(0.0).sqrt(),
        );
        if !(along > EDGE_LINE_MIN_SPREAD && across < EDGE_LINE_MAX_OFF) {
            continue;
        }
        let angle = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        let mut normal = [-angle.sin(), angle.cos()];
        if normal[0] * e.normal[0] + normal[1] * e.normal[1] < 0.0 {
            normal = [-normal[0], -normal[1]];
        }
        pixel.edge.normal = normal;
        pixel.edge.offset = edge_offset(normal, pixel.cov);
    }
}

/// How far from the foot of the perpendicular (in pixels) [`edge_distance`]
/// looks for edge pixels.
const FOOT_RADIUS: i64 = 2;

/// The distance from pixel `p` to the sharp edge whose pixel `q` is nearest
/// to it, or `None` when `q` gives no usable distance. The nearest pixel by
/// its centre is not the best one: it can sit a few pixels along the edge
/// from the foot of the perpendicular and deeper than the edge, and the
/// further `p` is from the edge the further, so its distance ripples along
/// the edge. So this takes the smallest distance of the edge pixels around
/// that foot, which is exact for a straight edge.
fn edge_distance(sharp: &SharpEdges, p: [usize; 2], q: [usize; 2], inside: bool) -> Option<f32> {
    let (px, py) = (p[0] as f32, p[1] as f32);
    let e = sharp.at(q[0], q[1])?;
    let mut best = e.distance(px - q[0] as f32, py - q[1] as f32, inside)?;
    // Where p's perpendicular meets q's line.
    let signed = e.offset + (px - q[0] as f32) * e.normal[0] + (py - q[1] as f32) * e.normal[1];
    let (fx, fy) = (
        (px - signed * e.normal[0]).round() as i64,
        (py - signed * e.normal[1]).round() as i64,
    );
    for sy in (fy - FOOT_RADIUS).max(0)..=(fy + FOOT_RADIUS).min(sharp.h as i64 - 1) {
        for sx in (fx - FOOT_RADIUS).max(0)..=(fx + FOOT_RADIUS).min(sharp.w as i64 - 1) {
            if let Some(d) = sharp
                .at(sx as usize, sy as usize)
                .and_then(|near| near.distance(px - sx as f32, py - sy as f32, inside))
            {
                best = best.min(d);
            }
        }
    }
    Some(best)
}

/// Pixels past the reach that are still refined, so the value is right
/// where the ramp ends.
const EDGE_MARGIN: f32 = 2.0;

/// Which pixels of `s` satisfy `test`.
fn covered(s: &Map, test: impl Fn(f32) -> bool) -> Vec<bool> {
    s.v.iter().map(|&a| test(a)).collect()
}

/// `dist_inside` for chiselled bevels. A sharp edge pixel puts the edge
/// where its coverage says, at any angle, and the pixels near it measure to
/// that edge ([`edge_distance`]), so the distance ramps stay planar along an
/// oblique edge instead of following the pixel staircase. The plain
/// distance (to the nearest empty pixel, less half a pixel) never falls
/// short of the true one, so it caps the result where an edge lies exactly
/// on a pixel boundary and has no sharp pixel; a mask without sharp pixels
/// gives exactly `dist_inside`. Values past `reach` pixels are not refined.
pub(crate) fn bevel_dist_inside(s: &Map, sharp: &SharpEdges, reach: f32) -> Vec<f32> {
    let empty = covered(s, |a| a <= INSIDE_EPS);
    let (d, near) = edt_nearest(&empty, s.w, s.h);
    let at = |x: usize, y: usize| -> f32 {
        let i = y * s.w + x;
        if empty[i] {
            return -0.5;
        }
        if let Some(e) = sharp.get(i) {
            return e.offset;
        }
        let plain = d[i] - 0.5;
        if d[i] > reach + EDGE_MARGIN || sharp.is_empty() {
            return plain;
        }
        // The sharp pixel next to the nearest empty one that is nearest to
        // this pixel.
        let (px, py) = (x as i64, y as i64);
        let (ox, oy) = ((near[i] % s.w) as i64, (near[i] / s.w) as i64);
        let q = (-1..=1)
            .flat_map(|dy| (-1..=1).map(move |dx| (ox + dx, oy + dy)))
            .filter(|&(x, y)| x >= 0 && y >= 0 && sharp.has(x as usize, y as usize))
            .min_by_key(|&(x, y)| (x - px) * (x - px) + (y - py) * (y - py));
        match q.and_then(|(x, y)| {
            edge_distance(
                sharp,
                [px as usize, py as usize],
                [x as usize, y as usize],
                true,
            )
        }) {
            Some(refined) => refined.min(plain),
            None => plain,
        }
    };
    let mut out = vec![0.0f32; s.w * s.h];
    for y in 0..s.h {
        for x in 0..s.w {
            out[y * s.w + x] = at(x, y);
        }
    }
    out
}

/// `dist_outside` for chiselled bevels, with sharp edge pixels placed as in
/// [`bevel_dist_inside`].
pub(crate) fn bevel_dist_outside(s: &Map, sharp: &SharpEdges, reach: f32) -> Vec<f32> {
    let inside = covered(s, |a| a > INSIDE_EPS);
    let (d, near) = edt_nearest(&inside, s.w, s.h);
    let at = |x: usize, y: usize| -> f32 {
        let i = y * s.w + x;
        if let Some(e) = sharp.get(i) {
            return -e.offset;
        }
        if inside[i] {
            return -0.5;
        }
        let q = near[i];
        let Some(e) = sharp.get(q) else {
            return d[i] - (s.v.get(q).copied().unwrap_or(0.0).min(1.0) - 0.5);
        };
        let (p, qp) = ([x, y], [q % s.w, q / s.w]);
        let measured = if d[i] <= reach + EDGE_MARGIN {
            edge_distance(sharp, p, qp, false)
        } else {
            e.distance(
                p[0] as f32 - qp[0] as f32,
                p[1] as f32 - qp[1] as f32,
                false,
            )
        };
        measured.unwrap_or(d[i] - e.offset)
    };
    let mut out = vec![0.0f32; s.w * s.h];
    for y in 0..s.h {
        for x in 0..s.w {
            out[y * s.w + x] = at(x, y);
        }
    }
    out
}

/// The inside and outside bevel distances of `s`, from one set of sharp
/// edges.
pub(crate) fn bevel_dists(s: &Map, reach: f32) -> [Vec<f32>; 2] {
    let sharp = sharp_edges(s);
    [
        bevel_dist_inside(s, &sharp, reach),
        bevel_dist_outside(s, &sharp, reach),
    ]
}

#[cfg(test)]
pub(crate) mod tests {
    //! PhotoCraft's tests of these distances (`crates/compose/src/effects/
    //! tests.rs`), on one thread.
    use super::super::map::{dist_inside, dist_outside};
    use super::*;

    /// A `len` x `wid` bar through the middle of a `w` x `h` map at `deg`
    /// degrees, anti-aliased by 16 x 16 supersampling (PhotoCraft `aa_bar`).
    pub(crate) fn aa_bar(w: usize, h: usize, deg: f32, len: f32, wid: f32) -> Map {
        let (sn, cs) = deg.to_radians().sin_cos();
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
        let mut m = Map::new(w, h, 0.0);
        const N: usize = 16;
        for y in 0..h {
            for x in 0..w {
                let mut hit = 0;
                for sy in 0..N {
                    for sx in 0..N {
                        let (px, py) = (
                            x as f32 + (sx as f32 + 0.5) / N as f32 - cx,
                            y as f32 + (sy as f32 + 0.5) / N as f32 - cy,
                        );
                        let (u, v) = (px * cs + py * sn, -px * sn + py * cs);
                        hit += usize::from(u.abs() <= len / 2.0 && v.abs() <= wid / 2.0);
                    }
                }
                m.v[y * w + x] = hit as f32 / (N * N) as f32;
            }
        }
        m
    }

    /// Ripple and bias of a distance field on an `aa_bar` (PhotoCraft
    /// `bar_ripple`).
    fn bar_ripple(f: &[f32], w: usize, h: usize, deg: f32, wid: f32, inside: bool) -> (f32, f32) {
        let (sn, cs) = deg.to_radians().sin_cos();
        let mut bins: Vec<Vec<f32>> = vec![Vec::new(); 16];
        for y in 0..h {
            for x in 0..w {
                let (px, py) = (
                    x as f32 + 0.5 - w as f32 / 2.0,
                    y as f32 + 0.5 - h as f32 / 2.0,
                );
                let (u, v) = (px * cs + py * sn, -px * sn + py * cs);
                let truth = if inside {
                    wid / 2.0 - v.abs()
                } else {
                    v.abs() - wid / 2.0
                };
                if u.abs() < 40.0 && (0.6..8.0).contains(&truth) {
                    bins[(truth * 2.0) as usize].push(f[y * w + x] - truth);
                }
            }
        }
        let (mut ripple, mut bias) = (0.0f32, 0.0f32);
        for b in bins.iter().filter(|b| b.len() > 8) {
            let mean = b.iter().sum::<f32>() / b.len() as f32;
            let sd =
                (b.iter().map(|e| (e - mean) * (e - mean)).sum::<f32>() / b.len() as f32).sqrt();
            ripple = ripple.max(sd);
            bias = bias.max(mean.abs());
        }
        (ripple, bias)
    }

    fn half_plane_coverage(n: [f32; 2], s: f32) -> f32 {
        const N: usize = 64;
        let mut hit = 0;
        for y in 0..N {
            for x in 0..N {
                let (px, py) = (
                    (x as f32 + 0.5) / N as f32 - 0.5,
                    (y as f32 + 0.5) / N as f32 - 0.5,
                );
                hit += usize::from(n[0] * px + n[1] * py + s >= 0.0);
            }
        }
        hit as f32 / (N * N) as f32
    }

    pub(crate) fn aa_disc(w: usize, h: usize, r: f32) -> Map {
        let mut m = Map::new(w, h, 0.0);
        const N: usize = 16;
        for y in 0..h {
            for x in 0..w {
                let mut hit = 0;
                for sy in 0..N {
                    for sx in 0..N {
                        let (px, py) = (
                            x as f32 + (sx as f32 + 0.5) / N as f32 - w as f32 / 2.0,
                            y as f32 + (sy as f32 + 0.5) / N as f32 - h as f32 / 2.0,
                        );
                        hit += usize::from(px * px + py * py <= r * r);
                    }
                }
                m.v[y * w + x] = hit as f32 / (N * N) as f32;
            }
        }
        m
    }

    #[allow(clippy::too_many_arguments)]
    fn aa_round_rect(w: usize, h: usize, x0: f32, y0: f32, x1: f32, y1: f32, rad: f32) -> Map {
        let sdf = |px: f32, py: f32| {
            let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
            let (qx, qy) = (
                (px - cx).abs() - ((x1 - x0) / 2.0 - rad),
                (py - cy).abs() - ((y1 - y0) / 2.0 - rad),
            );
            qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - rad
        };
        let mut m = Map::new(w, h, 0.0);
        const N: usize = 16;
        for y in 0..h {
            for x in 0..w {
                let mut hit = 0;
                for sy in 0..N {
                    for sx in 0..N {
                        hit += usize::from(
                            sdf(
                                x as f32 + (sx as f32 + 0.5) / N as f32,
                                y as f32 + (sy as f32 + 0.5) / N as f32,
                            ) <= 0.0,
                        );
                    }
                }
                m.v[y * w + x] = hit as f32 / (N * N) as f32;
            }
        }
        m
    }

    #[test]
    fn edge_offset_places_a_straight_edge_by_its_coverage() {
        for step in 0..=12 {
            let (sn, cs) = (step as f32 * 7.5).to_radians().sin_cos();
            for k in -12..=12 {
                let s = k as f32 * 0.05;
                let a = half_plane_coverage([cs, sn], s);
                if !(0.03..=0.97).contains(&a) {
                    continue;
                }
                let got = edge_offset([cs, sn], a);
                assert!(
                    (got - s).abs() < 0.03,
                    "{} deg s {s}: {a} gave {got}",
                    step as f32 * 7.5
                );
            }
        }
        assert!((edge_offset([1.0, 0.0], 0.25) + 0.25).abs() < 1e-6);
        assert!((edge_offset([0.0, 1.0], 0.9) - 0.4).abs() < 1e-6);
        assert_eq!(edge_offset([0.6, 0.8], f32::NAN), 0.0);
    }

    #[test]
    fn bevel_distances_equal_the_plain_ones_without_anti_aliasing() {
        let (w, h) = (96usize, 80usize);
        for kind in 0..4 {
            let mut m = Map::new(w, h, 0.0);
            let mut seed = 12345u32;
            for y in 0..h {
                for x in 0..w {
                    let (dx, dy) = (x as f32 - 48.0, y as f32 - 40.0);
                    m.v[y * w + x] = match kind {
                        0 => f32::from(u8::from(
                            (50.0..90.0).contains(&(x as f32 * 0.6 + y as f32)),
                        )),
                        1 => f32::from(u8::from(dx * dx + dy * dy < 30.0 * 30.0)),
                        2 => {
                            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                            f32::from(u8::from(seed >> 28 < 5 && x > 10 && x < 80))
                        }
                        _ => ((20.0 - (dx * dx + dy * dy).sqrt()) / 8.0).clamp(0.0, 1.0),
                    };
                }
            }
            let sharp = sharp_edges(&m);
            assert!(sharp.is_empty(), "map {kind} has no anti-aliased edge");
            assert_eq!(
                bevel_dist_inside(&m, &sharp, 1e9),
                dist_inside(&m),
                "inside {kind}"
            );
            assert_eq!(
                bevel_dist_outside(&m, &sharp, 1e9),
                dist_outside(&m),
                "outside {kind}"
            );
        }
    }

    #[test]
    fn chisel_distance_has_no_ripple_along_oblique_edges() {
        let (w, h) = (160, 160);
        for deg in [0.0f32, 30.0, 45.0, 60.0, 75.0, 120.0, 150.0] {
            let bar = aa_bar(w, h, deg, 120.0, 40.0);
            let sharp = sharp_edges(&bar);
            let inside = bar_ripple(
                &bevel_dist_inside(&bar, &sharp, 40.0),
                w,
                h,
                deg,
                40.0,
                true,
            );
            let outside = bar_ripple(
                &bevel_dist_outside(&bar, &sharp, 40.0),
                w,
                h,
                deg,
                40.0,
                false,
            );
            for (what, (ripple, bias)) in [("inside", inside), ("outside", outside)] {
                assert!(
                    ripple < 0.008 && bias < 0.01,
                    "{deg} deg {what}: ripple {ripple}, bias {bias}"
                );
            }
        }
        let plain = aa_bar(w, h, 60.0, 120.0, 40.0);
        let (ripple, _) = bar_ripple(&dist_inside(&plain), w, h, 60.0, 40.0, true);
        assert!(ripple > 0.1, "the plain field still ripples ({ripple})");
    }

    #[test]
    fn edge_normals_follow_straight_edges_to_a_fraction_of_a_degree() {
        let (w, h, wid) = (160usize, 160usize, 40.0f32);
        for deg in [30.0f32, 60.0, 75.0, 120.0, 150.0] {
            let sharp = sharp_edges(&aa_bar(w, h, deg, 120.0, wid));
            let (sn, cs) = deg.to_radians().sin_cos();
            let (mut worst, mut seen) = (0.0f32, 0);
            for (i, e) in sharp.iter() {
                let (px, py) = (
                    (i % w) as f32 + 0.5 - w as f32 / 2.0,
                    (i / w) as f32 + 0.5 - h as f32 / 2.0,
                );
                let (u, v) = (px * cs + py * sn, -px * sn + py * cs);
                if u.abs() > 40.0 || (wid / 2.0 - v.abs()).abs() > 1.5 {
                    continue;
                }
                let into = if v > 0.0 { [sn, -cs] } else { [-sn, cs] };
                worst = worst.max(
                    (e.normal[0] * into[0] + e.normal[1] * into[1])
                        .clamp(-1.0, 1.0)
                        .acos()
                        .to_degrees(),
                );
                seen += 1;
            }
            assert!(
                seen > 100 && worst < 0.6,
                "{deg} deg: {seen} pixels, off by {worst} deg"
            );
        }
    }

    #[test]
    fn chisel_distance_is_close_on_round_shapes() {
        let worst = |f: &[f32], w: usize, h: usize, sdf: &dyn Fn(f32, f32) -> f32, inside: bool| {
            let mut mx = 0.0f32;
            for y in 0..h {
                for x in 0..w {
                    let t = sdf(x as f32 + 0.5, y as f32 + 0.5);
                    let truth = if inside { -t } else { t };
                    if (0.6..8.0).contains(&truth) {
                        mx = mx.max((f[y * w + x] - truth).abs());
                    }
                }
            }
            mx
        };
        for r in [20.0f32, 40.0, 70.0] {
            let (w, h) = (200usize, 200usize);
            let m = aa_disc(w, h, r);
            let sharp = sharp_edges(&m);
            let sdf = |x: f32, y: f32| (x - 100.0).hypot(y - 100.0) - r;
            let i = worst(&bevel_dist_inside(&m, &sharp, 12.0), w, h, &sdf, true);
            let o = worst(&bevel_dist_outside(&m, &sharp, 12.0), w, h, &sdf, false);
            assert!(
                i < 0.05 && o < 0.07,
                "disc {r}: inside off by {i}, outside by {o}"
            );
        }
        for rad in [6.0f32, 12.0, 24.0] {
            let (w, h) = (200usize, 160usize);
            let m = aa_round_rect(w, h, 20.0, 20.0, 180.0, 140.0, rad);
            let sharp = sharp_edges(&m);
            let sdf = |x: f32, y: f32| {
                let (qx, qy) = (
                    (x - 100.0).abs() - (80.0 - rad),
                    (y - 80.0).abs() - (60.0 - rad),
                );
                qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - rad
            };
            let i = worst(&bevel_dist_inside(&m, &sharp, 12.0), w, h, &sdf, true);
            let o = worst(&bevel_dist_outside(&m, &sharp, 12.0), w, h, &sdf, false);
            assert!(
                i < 0.08 && o < 0.2,
                "rounded rect {rad}: inside off by {i}, outside by {o}"
            );
        }
    }

    #[test]
    fn bevel_distances_survive_degenerate_maps() {
        let cases: [(usize, usize, f32); 7] = [
            (0, 0, 0.0),
            (1, 1, 0.5),
            (1, 1, 1.0),
            (2, 2, 0.5),
            (3, 1, 0.3),
            (5, 5, f32::NAN),
            (4, 4, 1.0),
        ];
        for (w, h, a) in cases {
            let m = Map::new(w, h, a);
            let sharp = sharp_edges(&m);
            for reach in [0.0, 8.0, f32::NAN, f32::INFINITY, -3.0] {
                assert_eq!(bevel_dist_inside(&m, &sharp, reach).len(), w * h);
                assert_eq!(bevel_dist_outside(&m, &sharp, reach).len(), w * h);
            }
        }
        let mut m = Map::new(5, 5, 0.0);
        m.v[12] = 0.4;
        let _ = bevel_dists(&m, 4.0);
        let mut m = Map::new(8, 8, 0.0);
        for y in 0..8 {
            m.v[y * 8 + 7] = 1.0;
            m.v[y * 8 + 6] = 0.5;
        }
        let _ = bevel_dists(&m, 4.0);
    }
}
