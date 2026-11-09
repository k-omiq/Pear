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
//! gradient_bake.rs   Smoothness and the interpolation Method, baked
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
pub mod gradient_bake;
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
    fn spread_takes_its_share_of_the_size() {
        assert_eq!(spread_split(10.0, 0.0), (0.0, 10.0));
        assert_eq!(spread_split(10.0, 1.0), (10.0, 0.0));
        assert_eq!(spread_split(10.0, 0.3), (3.0, 7.0));
        // The grow is whole pixels; the blur keeps the rest of the share.
        assert_eq!(spread_split(5.0, 0.02).0, 0.0);
    }
}
