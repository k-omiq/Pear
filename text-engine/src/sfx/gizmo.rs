//! The maths behind the SFX handles (`SfxGizmo.svelte`): which letter a
//! pointer is on, and what a drag on the ring, the scale handle, a letter
//! or a path's bend writes. JS forwards the pointer and draws; every number
//! a handle writes is worked out here, so the handles and the layout cannot
//! disagree about a letter's shape or a path's curve.
//!
//! The behaviour follows the reference's gizmo
//! (`docs/giongo/04-reference-controls.md` section 2): a Blender-style turn
//! that keeps counting past half a turn, a uniform scale by the distance from
//! the letter's centre, and moves in the letter's own unscaled ems.
//!
//! Points are pixels in one frame (the overlay's), y down, unless a function
//! says ems. A turn is degrees, positive clockwise on the screen.

use super::path::Path;

/// The letter scale the box may hold (`setGlyph`, data.js keeps it too).
pub const SCALE_MIN: f64 = 0.2;
pub const SCALE_MAX: f64 = 5.0;
/// A snapped scale is a multiple of this.
pub const SCALE_STEP: f64 = 0.05;
/// A move stays within this many ems of where the letter was laid.
pub const MOVE_MAX: f64 = 20.0;
/// A bend stays within this share of the chord either side.
pub const BEND_MAX: f64 = 2.0;

fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

fn cross(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

/// `v` to the nearest multiple of `step`.
fn snap_to(v: f64, step: f64) -> f64 {
    (v / step).round() * step
}

/// `v` to the nearest `1 / per`: dividing by a whole number gives the
/// nearest double to 2.01, where multiplying by 0.01 would not.
fn round_per(v: f64, per: f64) -> f64 {
    (v * per).round() / per
}

/// Whether `p` is in the quad `q` (corners in order, either way round). A
/// letter's quad is its ink box through a map that never mirrors, so it is
/// a parallelogram and so convex: inside is on the same side of every edge.
fn inside(q: &[[f64; 2]; 4], p: [f64; 2]) -> bool {
    let (mut neg, mut pos) = (false, false);
    for i in 0..4 {
        let c = cross(sub(q[(i + 1) % 4], q[i]), sub(p, q[i]));
        neg |= c < 0.0;
        pos |= c > 0.0;
    }
    !(neg && pos)
}

/// How far `p` is from the segment `a`..`b`.
fn to_segment(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    let ab = sub(b, a);
    let len2 = dot(ab, ab);
    let t = if len2 > 1e-24 {
        (dot(sub(p, a), ab) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let c = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    (p[0] - c[0]).hypot(p[1] - c[1])
}

/// The letter under `p`: the topmost whose quad holds it (a later letter is
/// drawn over an earlier one), else, within `slop` pixels of one, the
/// nearest, so a thin bar or a dot can still be picked. `None` for neither.
pub fn hit(quads: &[[[f64; 2]; 4]], p: [f64; 2], slop: f64) -> Option<usize> {
    if let Some(i) = quads.iter().rposition(|q| inside(q, p)) {
        return Some(i);
    }
    let mut best: Option<(usize, f64)> = None;
    for (i, q) in quads.iter().enumerate() {
        let d = (0..4)
            .map(|k| to_segment(q[k], q[(k + 1) % 4], p))
            .fold(f64::INFINITY, f64::min);
        // `<=`: on a tie the later letter, the one on top, wins.
        if d <= slop && best.is_none_or(|(_, b)| d <= b) {
            best = Some((i, d));
        }
    }
    best.map(|(i, _)| i)
}

/// The angle swept round `centre` from `from` to `to`, degrees clockwise on
/// the screen, in `(-180, 180]`. Nothing for a point on the centre, whose
/// direction is not known.
fn swept(centre: [f64; 2], from: [f64; 2], to: [f64; 2]) -> f64 {
    let (a, b) = (sub(from, centre), sub(to, centre));
    if dot(a, a) < 1e-18 || dot(b, b) < 1e-18 {
        return 0.0;
    }
    // y points down, so the cross product is positive turning clockwise.
    cross(a, b).atan2(dot(a, b)).to_degrees()
}

/// A turn folded into `(-180, 180]`.
fn wrap_deg(d: f64) -> f64 {
    let w = (d + 180.0).rem_euclid(360.0) - 180.0;
    if w <= -180.0 {
        w + 360.0
    } else {
        w
    }
}

/// One pointer move on the ring, Blender style: the angle the pointer swept
/// round `centre` from `from` (the last point) to `to` is added to `total`,
/// the running turn so far. Called on every move, each sweep is a small one,
/// so the total counts on past half a turn without jumping.
///
/// Returns `(total, shown)`: `total` is the new running turn, unrounded and
/// unwrapped, which the caller hands back on the next move; `shown` is what
/// the letter's edit stores: `total` snapped to `snap` degrees when `snap`
/// is above 0 (Shift's 15), in whole degrees, wrapped to -180..180.
pub fn turn(centre: [f64; 2], from: [f64; 2], to: [f64; 2], total: f64, snap: f64) -> (f64, f64) {
    let total = total + swept(centre, from, to);
    let snapped = if snap > 0.0 {
        snap_to(total, snap)
    } else {
        total
    };
    (total, wrap_deg(snapped.round()))
}

/// One pointer move on the scale handle: the scale at grab times how much
/// farther from `centre` the pointer is now than at `start`, kept to
/// [`SCALE_MIN`]..[`SCALE_MAX`], in steps of [`SCALE_STEP`] when `snap`, else
/// to two decimals. A grab on the centre itself changes nothing.
pub fn scale(centre: [f64; 2], start: [f64; 2], now: [f64; 2], from: f64, snap: bool) -> f64 {
    let d0 = sub(start, centre);
    let d1 = sub(now, centre);
    let (l0, l1) = (d0[0].hypot(d0[1]), d1[0].hypot(d1[1]));
    let s = if l0 > 1e-9 { from * l1 / l0 } else { from };
    let s = round_per(
        s,
        if snap {
            (1.0 / SCALE_STEP).round()
        } else {
            100.0
        },
    );
    s.clamp(SCALE_MIN, SCALE_MAX)
}

/// One pointer move dragging a letter: its hand edit's offset at grab
/// (`from`, ems) plus the pointer's travel from `start` to `now` in the
/// letter's ems. `unit` is the letter's pixels per em of its edit (the
/// layout's `unit`, its em before its own scale), so a letter scaled by hand
/// still follows the pointer one to one. Three decimals, within
/// [`MOVE_MAX`].
pub fn moved(unit: f64, start: [f64; 2], now: [f64; 2], from: [f64; 2]) -> [f64; 2] {
    if unit <= 1e-9 {
        return from;
    }
    let d = sub(now, start);
    [0, 1].map(|i| round_per(from[i] + d[i] / unit, 1000.0).clamp(-MOVE_MAX, MOVE_MAX))
}

/// The bend that puts the middle of `path`'s curve (its point at t = 0.5,
/// where the bend handle sits) as near `pt` as it can go, in the path's
/// units. The middle is the chord's middle plus half the bend times the
/// chord turned a quarter ([`Path::control`]), so the bend is twice the
/// share of that quarter-turned chord `pt` sits off the middle. Three
/// decimals, within [`BEND_MAX`]; a path with no length has no side to
/// bend to, and keeps its bend.
pub fn bend_for(path: &Path, pt: [f64; 2]) -> f64 {
    let [ax, ay] = path.a;
    let [bx, by] = path.b;
    let n = [-(by - ay), bx - ax];
    let len2 = dot(n, n);
    if len2 <= 1e-18 {
        return path.bend;
    }
    let mid = [(ax + bx) / 2.0, (ay + by) / 2.0];
    let bend = 2.0 * dot(sub(pt, mid), n) / len2;
    round_per(bend, 1000.0).clamp(-BEND_MAX, BEND_MAX)
}

/// The control point and the middle (t = 0.5) of `path`'s curve, in its
/// units: what the overlay draws the curve with, and where the bend handle
/// sits.
pub fn curve(path: &Path) -> ([f64; 2], [f64; 2]) {
    (path.control(), path.at_t(0.5).0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sfx::place::Lin;

    const EPS: f64 = 1e-9;

    /// A 40 by 20 box turned `deg` about `c`.
    fn turned(c: [f64; 2], deg: f64) -> [[f64; 2]; 4] {
        let m = Lin::rot(deg.to_radians());
        [[-20.0, -10.0], [20.0, -10.0], [20.0, 10.0], [-20.0, 10.0]].map(|p| {
            let q = m.apply(p);
            [c[0] + q[0], c[1] + q[1]]
        })
    }

    #[test]
    fn a_turned_letter_is_hit_by_its_turned_box_and_the_top_one_wins() {
        let q = turned([0.0, 0.0], 90.0);
        // Turned a quarter, the box is 20 wide and 40 tall.
        assert_eq!(hit(&[q], [0.0, 18.0], 0.0), Some(0));
        assert_eq!(hit(&[q], [18.0, 0.0], 0.0), None);
        // Two over each other: the later one is on top.
        let r = turned([5.0, 0.0], 0.0);
        assert_eq!(hit(&[q, r], [2.0, 2.0], 0.0), Some(1));
        assert_eq!(hit(&[r, q], [2.0, 2.0], 0.0), Some(1));
        // Just off a thin letter: only with slop, and the nearest.
        let thin = [[0.0, 0.0], [30.0, 0.0], [30.0, 1.0], [0.0, 1.0]];
        assert_eq!(hit(&[thin], [10.0, 4.0], 0.0), None);
        assert_eq!(hit(&[thin], [10.0, 4.0], 4.0), Some(0));
        assert_eq!(hit(&[], [0.0, 0.0], 10.0), None);
    }

    #[test]
    fn a_turn_counts_on_past_half_a_turn_without_jumping() {
        let c = [0.0, 0.0];
        // Round the centre clockwise in 30 degree moves, from 3 o'clock.
        let at = |deg: f64| {
            let (s, k) = deg.to_radians().sin_cos();
            [k * 50.0, s * 50.0]
        };
        let mut total = 15.0;
        for i in 0..12 {
            let (t, _) = turn(
                c,
                at(i as f64 * 30.0),
                at((i + 1) as f64 * 30.0),
                total,
                0.0,
            );
            total = t;
        }
        assert!((total - 375.0).abs() < 1e-6, "{total}");
        // What is stored is whole degrees, wrapped.
        let (t, shown) = turn(c, at(0.0), at(160.0), 15.0, 0.0);
        assert!((t - 175.0).abs() < 1e-6);
        assert_eq!(shown, 175.0);
        let (t, shown) = turn(c, at(160.0), at(200.0), t, 0.0);
        assert!((t - 215.0).abs() < 1e-6);
        assert_eq!(shown, -145.0);
        // Anticlockwise is negative, and a point on the centre turns nothing.
        assert_eq!(turn(c, at(0.0), at(-61.0), 0.0, 0.0).1, -61.0);
        assert_eq!(turn(c, c, at(90.0), 7.0, 0.0), (7.0, 7.0));
    }

    #[test]
    fn a_snapped_turn_snaps_what_is_shown_and_keeps_the_running_total() {
        let c = [0.0, 0.0];
        let (t, shown) = turn(c, [10.0, 0.0], [10.0, 2.0], 20.0, 15.0);
        // About 11.3 degrees swept: 31.3 in all, 30 shown.
        assert!((t - 31.309_932_474).abs() < 1e-6);
        assert_eq!(shown, 30.0);
        let (_, shown) = turn(c, [10.0, 0.0], [10.0, 0.5], 172.0, 15.0);
        assert_eq!(shown, 180.0);
        let (_, shown) = turn(c, [10.0, 0.0], [10.0, 0.5], -185.0, 15.0);
        assert_eq!(shown, 180.0);
    }

    #[test]
    fn a_scale_follows_the_distance_from_the_centre_within_its_range() {
        let c = [10.0, 10.0];
        // The reference's test: 37 px out dragged to 74.5 px is 1 -> 2.01.
        assert_eq!(scale(c, [47.0, 10.0], [84.5, 10.0], 1.0, false), 2.01);
        assert_eq!(scale(c, [47.0, 10.0], [84.5, 10.0], 1.0, true), 2.0);
        assert_eq!(scale(c, [20.0, 10.0], [10.0, 11.0], 1.0, false), SCALE_MIN);
        assert_eq!(scale(c, [11.0, 10.0], [200.0, 10.0], 1.0, false), SCALE_MAX);
        assert_eq!(scale(c, c, [50.0, 10.0], 1.5, false), 1.5);
    }

    #[test]
    fn a_move_is_in_the_letters_own_ems() {
        // The reference's test: 40 px on a 114 px letter is 0.351.
        let d = moved(114.0, [0.0, 0.0], [40.0, 0.0], [0.0, 0.0]);
        assert_eq!(d, [0.351, 0.0]);
        let d = moved(50.0, [10.0, 10.0], [10.0, -15.0], [0.1, 0.2]);
        assert!((d[0] - 0.1).abs() < EPS && (d[1] + 0.3).abs() < EPS);
        assert_eq!(moved(1.0, [0.0, 0.0], [1e6, 0.0], [0.0, 0.0])[0], MOVE_MAX);
        assert_eq!(moved(0.0, [0.0, 0.0], [5.0, 5.0], [0.4, 0.5]), [0.4, 0.5]);
    }

    #[test]
    fn the_bend_for_the_curves_middle_goes_round_trip() {
        for bend in [-0.75, -0.1, 0.0, 0.05, 0.4, 1.25] {
            let p = Path {
                a: [-2.0, 1.0],
                b: [3.0, -0.5],
                bend,
            };
            let (ctrl, mid) = curve(&p);
            assert_eq!(ctrl, p.control());
            assert!((bend_for(&p, mid) - bend).abs() < 1e-9, "{bend}");
            // Any point: the middle of the bend found is the nearest it gets.
            let pt = [0.7, 2.2];
            let q = Path {
                bend: bend_for(&p, pt),
                ..p
            };
            let d = |b: f64| {
                let m = Path { bend: b, ..p }.at_t(0.5).0;
                (m[0] - pt[0]).hypot(m[1] - pt[1])
            };
            assert!(d(q.bend) <= d(q.bend + 0.002) && d(q.bend) <= d(q.bend - 0.002));
        }
        let far = Path {
            a: [0.0, 0.0],
            b: [1.0, 0.0],
            bend: 0.0,
        };
        assert_eq!(bend_for(&far, [0.5, 100.0]), BEND_MAX);
        let dot = Path {
            a: [1.0, 1.0],
            b: [1.0, 1.0],
            bend: 0.3,
        };
        assert_eq!(bend_for(&dot, [0.0, 0.0]), 0.3);
    }
}
