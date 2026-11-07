//! Seeded noise: the same box paints the same grain every time.
//!
//! Photoshop's effects have a Noise slider (0 to 100%) that roughens the
//! effect's matte, and Dissolve picks pixels by chance. Both need numbers
//! that look random and are not: a box repainted at another zoom or by the
//! export must not shimmer. So every number here is a hash of the pixel and
//! a seed the caller owns (a box and an effect slot).

use super::super::budget;
use crate::Error;

/// A well-mixed 32-bit hash of a pixel and a seed.
pub fn hash(x: i32, y: i32, seed: u32) -> u32 {
    // Two rounds of a murmur-style finaliser over the three words.
    let mut h = seed ^ 0x9e37_79b9;
    for v in [x as u32, y as u32] {
        h ^= v.wrapping_mul(0x85eb_ca6b);
        h = h.rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64);
    }
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// A number from 0 up to, not including, 1 for a pixel and a seed.
pub fn unit(x: i32, y: i32, seed: u32) -> f32 {
    (hash(x, y, seed) >> 8) as f32 / (1u32 << 24) as f32
}

/// How far a grain of noise moves a pixel's matte, in pixels either way.
pub const SCATTER: i32 = 4;

/// Noise over a matte: every pixel takes the matte of a pixel up to
/// [`SCATTER`] away, picked by the hash, and the result is mixed with the
/// matte as it was by `amount` (0 to 1). The grain is in device pixels, as
/// Photoshop's is in the document's.
///
/// `alpha` is `width * height` values row by row; `bx` limits the work to
/// the rows and columns that can change (the matte's ink grown by the
/// scatter), and is `(x0, y0, x1, y1)`.
pub fn scatter(
    alpha: &mut [u8],
    width: usize,
    height: usize,
    bx: (i32, i32, i32, i32),
    amount: f32,
    seed: u32,
) -> Result<(), Error> {
    if amount <= 0.0 || width == 0 || height == 0 {
        return Ok(());
    }
    let amount = amount.min(1.0);
    let x0 = bx.0.max(0);
    let y0 = bx.1.max(0);
    let x1 = bx.2.min(width as i32);
    let y1 = bx.3.min(height as i32);
    if x1 <= x0 || y1 <= y0 {
        return Ok(());
    }
    let src = budget::collect(alpha.iter().map(|&a| Ok(a)))?;
    let span = (2 * SCATTER + 1) as u32;
    for y in y0..y1 {
        for x in x0..x1 {
            let h = hash(x, y, seed);
            let dx = (h % span) as i32 - SCATTER;
            let dy = ((h >> 8) % span) as i32 - SCATTER;
            let sx = (x + dx).clamp(0, width as i32 - 1) as usize;
            let sy = (y + dy).clamp(0, height as i32 - 1) as usize;
            let i = y as usize * width + x as usize;
            let was = f32::from(src[i]);
            let moved = f32::from(src[sy * width + sx]);
            alpha[i] = (was + (moved - was) * amount + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_pixel_and_seed_give_the_same_number() {
        assert_eq!(hash(3, 7, 11), hash(3, 7, 11));
        assert_ne!(hash(3, 7, 11), hash(3, 7, 12));
        assert_ne!(hash(3, 7, 11), hash(7, 3, 11));
    }

    #[test]
    fn units_spread_over_zero_to_one() {
        let mut low = 0;
        for i in 0..1000 {
            let u = unit(i, i * 3, 5);
            assert!((0.0..1.0).contains(&u));
            low += usize::from(u < 0.5);
        }
        assert!((400..600).contains(&low), "{low}");
    }

    #[test]
    fn no_noise_changes_nothing_and_full_noise_moves_the_edge() {
        let (w, h) = (16, 16);
        let mut a: Vec<u8> = (0..w * h)
            .map(|i| if i % w < 8 { 255 } else { 0 })
            .collect();
        let before = a.clone();
        scatter(&mut a, w, h, (0, 0, 16, 16), 0.0, 1).unwrap();
        assert_eq!(a, before);
        scatter(&mut a, w, h, (0, 0, 16, 16), 1.0, 1).unwrap();
        assert_ne!(a, before);
        // Far from the edge nothing can change.
        assert_eq!(a[8 * w], 255);
        assert_eq!(a[8 * w + 15], 0);
    }
}
