//! Shape kerning: neighbours spaced by the ink between them, not by their
//! advances.
//!
//! For each pair of neighbours in a group, both outlines are projected onto
//! the line between the two letters' centres, in bins across that line. In
//! every bin where both letters have ink, the gap is the nearest point of the
//! second less the farthest point of the first; the pair's gap is the
//! smallest of those. The second letter (and all after it) moves along the
//! line so that gap becomes the target: the box's letter gap, in ems of the
//! smaller letter, but never less than half the letter's own smallest gap
//! between its parts (so `ド` does not get closer to its neighbour than to
//! its own marks).
//!
//! A letter the user moved by hand is not moved. A pair with a space between
//! keeps its space. Afterwards the group is moved back onto its middle and
//! scaled so its first and last letters are as far apart as before, which
//! keeps the run on its path.

use std::collections::HashMap;

use super::place::{tighter, Ink, Lin, Params, Work};
use crate::Error;

type Contours = Vec<Vec<[f64; 2]>>;

fn area(c: &[[f64; 2]]) -> f64 {
    let n = c.len();
    (0..n)
        .map(|i| {
            let (p, q) = (c[i], c[(i + 1) % n]);
            p[0] * q[1] - q[0] * p[1]
        })
        .sum::<f64>()
        / 2.0
}

/// The smallest distance between the letter's main parts, pixels at the
/// face's size, or infinity for a letter in one part. A part is an outer
/// contour (the winding of the biggest) at least a third of its area: holes
/// and specks are left out.
fn inner_gap(contours: &Contours) -> f64 {
    let areas: Vec<f64> = contours.iter().map(|c| area(c)).collect();
    let Some(big) = areas
        .iter()
        .copied()
        .max_by(|a, b| a.abs().total_cmp(&b.abs()))
    else {
        return f64::INFINITY;
    };
    let parts: Vec<&Vec<[f64; 2]>> = contours
        .iter()
        .zip(&areas)
        .filter(|(_, &a)| a.signum() == big.signum() && a.abs() > big.abs() * 0.33)
        .map(|(c, _)| c)
        .collect();
    let mut best = f64::INFINITY;
    for i in 0..parts.len() {
        for j in i + 1..parts.len() {
            let (p, q) = (parts[i], parts[j]);
            let (sp, sq) = ((p.len() / 60).max(1), (q.len() / 60).max(1));
            for a in p.iter().step_by(sp) {
                for b in q.iter().step_by(sq) {
                    best = best.min((a[0] - b[0]).hypot(a[1] - b[1]));
                }
            }
        }
    }
    best
}

/// Per bin across `axis`, the extreme of the projection on `along`: the
/// largest when `far`, else the smallest. Edges are cut to `bin` steps so
/// every bin a contour crosses gets a point.
fn profile(
    contours: &Contours,
    w: &Work,
    shear: &Lin,
    along: [f64; 2],
    axis: [f64; 2],
    bin: f64,
    far: bool,
) -> HashMap<i64, f64> {
    let mut out = HashMap::new();
    let mut put = |p: [f64; 2]| {
        let a = p[0] * along[0] + p[1] * along[1];
        let key = ((p[0] * axis[0] + p[1] * axis[1]) / bin).round() as i64;
        out.entry(key)
            .and_modify(|v: &mut f64| {
                if (far && a > *v) || (!far && a < *v) {
                    *v = a;
                }
            })
            .or_insert(a);
    };
    for c in contours {
        let pts: Vec<[f64; 2]> = c.iter().map(|&q| w.place(shear, q)).collect();
        for i in 0..pts.len() {
            let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
            let steps = ((q[0] - p[0]).hypot(q[1] - p[1]) / bin)
                .ceil()
                .clamp(1.0, 256.0) as usize;
            for s in 0..steps {
                let t = s as f64 / steps as f64;
                put([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
            }
        }
    }
    out
}

/// Kerns one group's letters in place, in their path order.
pub(crate) fn group(
    works: &mut [Work],
    text: &str,
    size: f64,
    p: &Params,
    shear: &Lin,
    ink: &mut impl Ink,
) -> Result<(), Error> {
    if works.len() < 2 {
        return Ok(());
    }
    // One outline and one inner gap per distinct drawn text.
    let mut shapes: HashMap<String, (Contours, f64)> = HashMap::new();
    for w in works.iter() {
        let t = w.item.text(text);
        if !shapes.contains_key(t) {
            let c = ink.outline(t)?;
            let g = inner_gap(&c);
            shapes.insert(t.to_string(), (c, g));
        }
    }
    let mean_em = works.iter().map(|w| w.k * size).sum::<f64>() / works.len() as f64;
    let bin = (mean_em * 0.035).max(0.25);
    let first = works[0].centre;
    let last = works[works.len() - 1].centre;
    let mut shift = vec![[0.0f64; 2]; works.len()];
    let mut acc = [0.0f64; 2];
    for i in 1..works.len() {
        let (a, b) = (&works[i - 1], &works[i]);
        let d = [b.centre[0] - a.centre[0], b.centre[1] - a.centre[1]];
        let len = d[0].hypot(d[1]);
        let spaced = b.index > a.index + 1;
        if len > 1e-9 && !b.hand && !spaced {
            let along = [d[0] / len, d[1] / len];
            let axis = [-along[1], along[0]];
            let (ca, ga) = &shapes[a.item.text(text)];
            let (cb, gb) = &shapes[b.item.text(text)];
            let pa = profile(ca, a, shear, along, axis, bin, true);
            let pb = profile(cb, b, shear, along, axis, bin, false);
            let mut gap = f64::INFINITY;
            for (key, near) in &pb {
                for k in key - 1..=key + 1 {
                    if let Some(far) = pa.get(&k) {
                        gap = gap.min(near - far);
                    }
                }
            }
            if !gap.is_finite() {
                let far = pa.values().copied().fold(f64::MIN, f64::max);
                let near = pb.values().copied().fold(f64::MAX, f64::min);
                gap = near - far;
            }
            let small = (a.k.min(b.k)) * size;
            let rel = (a.rel * b.rel).sqrt();
            let mut want = (p.gap + tighter(p.big_tighter, rel)) * small;
            let floor = 0.5 * (ga * a.k).min(gb * b.k);
            if floor.is_finite() {
                want = want.max(floor);
            }
            if gap.is_finite() {
                let c = (want - gap).clamp(-0.45 * small, 0.6 * small);
                acc = [acc[0] + along[0] * c, acc[1] + along[1] * c];
            }
        }
        shift[i] = acc;
    }
    let n = works.len() as f64;
    let mean = [
        shift.iter().map(|s| s[0]).sum::<f64>() / n,
        shift.iter().map(|s| s[1]).sum::<f64>() / n,
    ];
    let mid = [
        works.iter().map(|w| w.centre[0]).sum::<f64>() / n,
        works.iter().map(|w| w.centre[1]).sum::<f64>() / n,
    ];
    for (w, s) in works.iter_mut().zip(&shift) {
        w.centre = [w.centre[0] + s[0] - mean[0], w.centre[1] + s[1] - mean[1]];
    }
    let before = (last[0] - first[0]).hypot(last[1] - first[1]);
    let (f2, l2) = (works[0].centre, works[works.len() - 1].centre);
    let after = (l2[0] - f2[0]).hypot(l2[1] - f2[1]);
    if before > 1e-9 && after > 1e-9 {
        let y = (before / after).clamp(0.5, 2.0);
        for w in works.iter_mut() {
            w.centre = [
                mid[0] + (w.centre[0] - mid[0]) * y,
                mid[1] + (w.centre[1] - mid[1]) * y,
            ];
            w.k *= y;
        }
    }
    Ok(())
}
