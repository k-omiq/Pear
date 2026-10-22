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
//! params.rs  the params as the bytes `mt_sfx_place` reads
//! ```
//!
//! Conventions. Lengths are ems of the face's size in the params and pixels
//! in the answer. A rotation is positive clockwise on the screen (y points
//! down); a positive skew leans the top of the letter to the right. Random
//! numbers come from [`noise`], a small integer hash, so the same seed lays
//! out the same way on every platform.

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

/// A random number in `[-1, 1]` for one channel of one stream at one item.
///
/// `lowbias32` (a bijective 32-bit integer mixer) is folded over the seed,
/// the stream, the item's index and the channel. Integer arithmetic only,
/// then one division, so the number is the same in every build.
pub fn noise(seed: u32, stream: usize, item: usize, channel: u32) -> f64 {
    fn mix(mut x: u32) -> u32 {
        x ^= x >> 16;
        x = x.wrapping_mul(0x7feb_352d);
        x ^= x >> 15;
        x = x.wrapping_mul(0x846c_a68b);
        x ^ (x >> 16)
    }
    let mut h = mix(seed ^ 0x9e37_79b9);
    h = mix(h ^ (stream as u32).wrapping_mul(0x85eb_ca6b));
    h = mix(h ^ (item as u32).wrapping_mul(0xc2b2_ae35));
    h = mix(h ^ channel.wrapping_mul(0x27d4_eb2f));
    f64::from(h) / f64::from(u32::MAX) * 2.0 - 1.0
}
