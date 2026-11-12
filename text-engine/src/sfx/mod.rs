//! Sound-effect lettering: the twelve sound types, auto pick, and the layout
//! that lays a sound's letters along their paths.
//!
//! ```text
//! kinds.rs   the twelve sound types: layout numbers, look, font tag
//! pick.rs    auto pick: a type from how a sound is spelt
//! items.rs   a text cut into groups and items
//! path.rs    the curve a group runs along, walked by arc length
//! place.rs   every letter placed on its path (`mt_sfx_place`)
//! kern.rs    shape kerning by the ink between letters
//! ink.rs     advances and outlines from the engine
//! params.rs  the params as the bytes `mt_sfx_place` reads, unset numbers
//!            filled from the type and the three macros
//! gizmo.rs   the handles' maths: hit test, turn, scale, move, bend
//! ```
//!
//! Conventions. Lengths are ems of the face's size in the params and pixels
//! in the answer. A rotation is positive clockwise on the screen (y points
//! down); a positive skew leans the top of the letter to the right. Random
//! numbers come from [`noise`], a small integer hash, so the same seed lays
//! out the same way on every platform.

pub mod gizmo;
mod ink;
mod items;
mod kern;
pub mod kinds;
pub mod params;
pub mod path;
pub mod pick;
pub mod place;
#[cfg(test)]
mod tests_place;

pub use ink::EngineInk;

/// The seeded numbers a layout draws its jitter from, shared with the
/// painter's wobble (`crate::seeded`).
pub use crate::seeded::noise;
