//! Photoshop's layer effects: the parts they share.
//!
//! `docs/LAYER_STYLES_PLAN.md` is the plan; these are its shared blocks:
//!
//! ```text
//! blend.rs     the 27 blend modes, and laying a layer over another in one
//! contour.rs   the curve a matte is passed through, and Range
//! noise.rs     seeded grain, so a box paints the same every time
//! distance.rs  the exact distance transform; a matte grown by a distance
//! ```
//!
//! and here, how an effect's Size, Spread and Choke become a grow and a
//! blur.

pub mod blend;
pub mod contour;
pub mod distance;
pub mod noise;

/// The gaussian's sigma, in the same units, for an effect of Photoshop
/// `size`. Size is how far the soft edge reaches, not a sigma: the kernel
/// that reaches `size` has a sigma of about `0.3 * size + 0.3` (three sigmas
/// either side). 0 is a hard edge.
pub fn size_sigma(size: f64) -> f64 {
    if size > 0.0 {
        0.3 * size + 0.3
    } else {
        0.0
    }
}

/// How far a soft edge of `size` reaches past its matte, in the same units:
/// the farthest a pixel of the effect can be from the letters, before it is
/// moved.
pub fn size_reach(size: f64) -> f64 {
    if size > 0.0 {
        size + 1.0
    } else {
        0.0
    }
}

/// Spread (outside) or Choke (inside), `share` of `size` from 0 to 1: the
/// matte is grown by the first number and the rest of the size is blurred
/// (Photoshop's split).
pub fn spread_split(size: f64, share: f64) -> (f64, f64) {
    let size = size.max(0.0);
    let grow = size * share.clamp(0.0, 1.0);
    (grow, size - grow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_zero_is_a_hard_edge() {
        assert_eq!(size_sigma(0.0), 0.0);
        assert_eq!(size_reach(0.0), 0.0);
        assert!((size_sigma(10.0) - 3.3).abs() < 1e-12);
        // Three sigmas fit inside the reach.
        for s in [1.0, 5.0, 40.0, 250.0] {
            assert!(3.0 * size_sigma(s) <= size_reach(s));
        }
    }

    #[test]
    fn spread_takes_its_share_of_the_size() {
        assert_eq!(spread_split(10.0, 0.0), (0.0, 10.0));
        assert_eq!(spread_split(10.0, 1.0), (10.0, 0.0));
        assert_eq!(spread_split(10.0, 0.3), (3.0, 7.0));
    }
}
