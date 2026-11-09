//! Photoshop's layer effects: the parts they share.
//!
//! `docs/LAYER_STYLES_PLAN.md` is the plan; these are its shared blocks:
//!
//! ```text
//! blend.rs     the 27 blend modes, and laying a layer over another in one
//! blending.rs  the Advanced Blending options: interior as group, see-through
//! contour.rs   the curve a matte is passed through, and its presets
//! noise.rs     seeded grain, so a box paints the same every time
//! distance.rs  distance transforms; a matte grown by a distance
//! tent.rs      the soft edge of an effect: two box passes of its Size
//! map.rs       the glows' and the inner shadow's maps
//! bevel.rs     Bevel & Emboss: the height, the shading, where it lies
//! edges.rs     a chisel's distances, the edge placed by its coverage
//! noise_gradient.rs  Photoshop's noise gradients (ours, not PhotoCraft's)
//! ```
//!
//! and here, how an effect's Size, Spread and Choke become a grow and a
//! blur.
//!
//! Much of the effect maths is PhotoCraft's (github.com/storytold/photocraft),
//! which fitted it on renders from Photoshop itself; each ported piece names
//! its source. Copyright (c) 2026 ArtCraft Team and the PhotoCraft
//! contributors, MIT licence (see `THIRD_PARTY.md`).

pub mod bevel;
pub mod blend;
pub mod blending;
pub mod contour;
pub mod distance;
pub(crate) mod edges;
pub mod effects;
pub mod gradient;
pub(crate) mod map;
pub mod noise;
pub mod noise_gradient;
pub mod tent;

/// How far a soft edge of `size` reaches past its matte, in the same units:
/// the farthest a pixel of the effect can be from the letters, before it is
/// moved. The tent of `size` reaches at most `size`; the spread's grow is
/// whole pixels inside that, and one more is the edge's own half.
pub fn size_reach(size: f64) -> f64 {
    if size > 0.0 {
        size + 1.0
    } else {
        0.0
    }
}

/// Spread (outside) or Choke (inside), `share` of `size` from 0 to 1: the
/// matte is grown by the first number, whole pixels, and blurred by the
/// second. A 2 % spread of a 5 px shadow does not grow it at all.
///
/// From PhotoCraft's `spread_split` (`crates/compose/src/effects/paint.rs`),
/// fitted on Photoshop renders.
pub fn spread_split(size: f64, share: f64) -> (f64, f64) {
    let size = size.max(0.0);
    let share = share.clamp(0.0, 1.0);
    ((size * share).round(), size * (1.0 - share))
}

/// The device width of the tent (`tent`) for a soft edge of `size` job
/// units at `scale` device pixels to a job unit, so it spreads as far, in
/// job units, at every zoom as at 1, where it is `size`, unchanged.
///
/// A tent of `size * scale` does not: a box of `w` whole and fractional
/// taps spreads more or less than `w` scaled would (`tent::variance`: a
/// box of 2 spreads as far as a box of 2.45, one of 10 as one of 10.1, one
/// of 15 as one of 14.97), and how much more swings with the width. A
/// plain Outer Glow of 5 laid 3 % more per page pixel at zoom 2 than at 1
/// (a box of 10 against one of 5). Here each of the tent's two boxes takes
/// `scale^2` times the variance its box has at zoom 1: its taps a job unit
/// apart are `scale` device pixels apart. A Size of 1 or less is no tent
/// at zoom 1, and none at any zoom.
///
/// PhotoCraft has nothing to port here: it paints at the document's
/// resolution only and keeps its proxy off any layer with effects
/// (`crates/compose/src/proxy.rs`), so a size there is never zoomed.
pub fn tent_width(size: f64, scale: f64) -> f64 {
    let plain = size * scale;
    if !plain.is_finite() || scale <= 0.0 || (scale - 1.0).abs() < 1e-12 {
        return plain;
    }
    let v = scale * scale * tent::variance(size);
    if v <= 0.0 {
        return plain.min(1.0);
    }
    // Inside the room a box is padded by: a Size reaches `size + 1`
    // (`size_reach`). A tent reaches twice its box's radius, which stays
    // `r` up to a width of `2r + 1`.
    let room = ((size + 1.0) * scale).floor();
    tent::width_of_variance(v).min(2.0 * (room / 2.0).floor() + 1.0)
}

/// How far a soft edge of `size` with `share` of it spread or choked
/// reaches, device pixels at `scale`: the grow's whole pixels and the
/// tent's ([`tent_width`]), and never less than `size * scale`.
pub(crate) fn soft_room(size: f64, share: f64, scale: f64) -> f64 {
    let (grow, rest) = spread_split(size, share);
    let soft = tent::reach(tent_width(rest, scale));
    (grow * scale + f64::from(soft)).max(size * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_zero_is_a_hard_edge() {
        assert_eq!(size_reach(0.0), 0.0);
        // The tent fits inside the reach.
        for s in [1.0, 5.0, 40.0, 250.0] {
            assert!(f64::from(tent::reach(s)) <= size_reach(s));
        }
    }

    #[test]
    fn a_tent_keeps_its_zoom_one_spread_and_stays_in_its_reach() {
        // Unchanged at zoom 1.
        for s in [0.0, 0.5, 1.0, 2.0, 5.0, 40.0] {
            assert_eq!(tent_width(s, 1.0), s);
        }
        // Each box of the tent: its zoom-1 spread, `scale` times as far.
        for (size, scale) in [(5.0, 2.0), (2.0, 3.0), (7.5, 1.5)] {
            let w = tent_width(size, scale);
            let want = scale * scale * tent::variance(size);
            assert!(
                (tent::variance(w) - want).abs() < 1e-9,
                "{size} {scale}: {w}"
            );
        }
        for size in (0..200).map(|i| f64::from(i) * 0.25) {
            for scale in [0.25, 0.5, 1.5, 2.0, 3.0, 4.0, 8.0] {
                let w = tent_width(size, scale);
                assert!(w.is_finite() && w >= 0.0, "{size} {scale}");
                // Inside the room a box is padded by: a Size's `size + 1`.
                assert!(
                    f64::from(tent::reach(w)) <= size_reach(size) * scale,
                    "{size} {scale}: {w}"
                );
                // Close to the plain width once the box is wide enough
                // that its end taps hardly count.
                if size >= 10.0 && scale >= 1.0 {
                    assert!(
                        (w / (size * scale) - 1.0).abs() < 0.05,
                        "{size} {scale}: {w}"
                    );
                }
            }
        }
    }

    #[test]
    fn spread_takes_its_share_of_the_size() {
        assert_eq!(spread_split(10.0, 0.0), (0.0, 10.0));
        assert_eq!(spread_split(10.0, 1.0), (10.0, 0.0));
        assert_eq!(spread_split(10.0, 0.3), (3.0, 7.0));
        // The grow is whole pixels; the blur keeps the rest of the share.
        assert_eq!(spread_split(5.0, 0.02).0, 0.0);
    }
}
