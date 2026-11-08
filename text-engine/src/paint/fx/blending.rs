//! Photoshop's Advanced Blending options, the parts a box paints.
//!
//! Blend Interior Effects as Group decides whether Fill Opacity fades the
//! interior effects with the fill; how far a shadow shows through the
//! letters that knock it out depends on the fill and the mode. Knockout,
//! Blend If and Channels come later (`docs/LAYER_STYLES_PLAN.md`, phase 6).
//!
//! `shadow_see_through` is ported from PhotoCraft,
//! `crates/compose/src/effects/composite.rs`, Copyright (c) 2026 ArtCraft
//! Team and the PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).

use super::blend::Blend;

/// The Advanced Blending options of a box.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Blending {
    /// Blend Interior Effects as Group (Photoshop's default is off): Fill
    /// Opacity fades the fill and the overlays, the satin and the inner
    /// glows on it together. Off, Fill fades the fill alone.
    pub interior: bool,
}

impl Blending {
    /// The wire's flags: 1 Blend Interior Effects as Group.
    pub fn from_flags(flags: u32) -> Option<Self> {
        if flags > 1 {
            return None;
        }
        Some(Self {
            interior: flags & 1 != 0,
        })
    }
}

/// How far the letters let a knocked-out drop shadow show under them (Layer
/// Knocks Out Drop Shadow): 0 covered, 1 knocked out wholly. In Normal (and
/// Dissolve) an opaque fill covers the shadow anyway, so only the
/// see-through share of the fill knocks it out, and the anti-aliased edges
/// are not cut twice. In any other mode the letters blend with what is under
/// them, shadow and all, and Photoshop keeps the shadow out from under them
/// wholly. `blends` is whether the letters do blend in `mode` (over a page,
/// or Dissolve); `no_fill` is a fill of nothing. Ported from PhotoCraft,
/// `crates/compose/src/effects/composite.rs` `shadow_see_through`.
pub fn shadow_see_through(mode: Blend, blends: bool, fill_opacity: f64, no_fill: bool) -> f32 {
    if no_fill {
        return 1.0;
    }
    if blends && !matches!(mode, Blend::Normal | Blend::Dissolve) {
        return 1.0;
    }
    (1.0 - fill_opacity.clamp(0.0, 1.0)) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flags_are_the_options_and_nothing_else() {
        assert_eq!(Blending::from_flags(0), Some(Blending::default()));
        assert_eq!(Blending::from_flags(1), Some(Blending { interior: true }));
        assert_eq!(Blending::from_flags(2), None);
    }

    /// After PhotoCraft's `shadow_knockout_needs_see_through_fill` and
    /// `shadow_knockout_beneath_a_layer_in_a_blending_mode`
    /// (`crates/compose/src/tests.rs`): an opaque Normal layer knocks out
    /// nothing, a half fill half, a blending layer all of it.
    #[test]
    fn a_shadow_shows_through_what_the_fill_leaves() {
        assert_eq!(shadow_see_through(Blend::Normal, false, 1.0, false), 0.0);
        assert_eq!(shadow_see_through(Blend::Normal, false, 0.5, false), 0.5);
        assert_eq!(shadow_see_through(Blend::Normal, false, 0.0, false), 1.0);
        assert_eq!(shadow_see_through(Blend::Dissolve, true, 0.25, false), 0.75);
        assert_eq!(shadow_see_through(Blend::Multiply, true, 1.0, false), 1.0);
        // A mode with no page to blend with paints Normal.
        assert_eq!(shadow_see_through(Blend::Multiply, false, 1.0, false), 0.0);
        assert_eq!(shadow_see_through(Blend::Normal, false, 1.0, true), 1.0);
    }
}
