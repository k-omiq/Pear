//! Seeded numbers that are the same in every build.
//!
//! Anything the editor and the export both paint from a seed (an SFX
//! layout's jitter, a letter's wobble) takes its numbers from here, so the
//! picture on screen and the one in the file are the same to the byte.

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
