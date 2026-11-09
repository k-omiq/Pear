//! Seeded noise: the same box paints the same grain every time.
//!
//! Photoshop's effects have a Noise slider (0 to 100%) that roughens the
//! effect's matte, and Dissolve picks pixels by chance. Both need numbers
//! that look random and are not: a box repainted at another zoom or by the
//! export must not shimmer. So every number here is a hash of the pixel and
//! a seed the caller owns (a box and an effect slot).

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

/// Photoshop's Noise slider over an effect's matte: a monochrome speckle in
/// the coverage, `amount` from 0 to 1, after the contour. A pixel keeps `1 +
/// (n - 0.5) * 2 * amount` of itself for its hashed `n`, so the speckle fades
/// out with the effect rather than lighting the blur's faint tail.
///
/// From PhotoCraft's `noise` (`crates/compose/src/effects/paint.rs`),
/// Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors, MIT
/// licence (see `THIRD_PARTY.md`). Changed: 8-bit mattes, a seed per effect.
///
/// `alpha` is `width * height` values row by row; only `bx`, `(x0, y0, x1,
/// y1)`, is touched. Its corner is device pixel `origin`, anchored to the
/// page, which a pixel's number is hashed from as PhotoCraft's adds the
/// map's origin: the same page pixel keeps its grain however the surface
/// round the box is cut.
pub fn grain(
    alpha: &mut [u8],
    width: usize,
    height: usize,
    bx: (i32, i32, i32, i32),
    amount: f32,
    seed: u32,
    origin: (i32, i32),
) {
    if amount.is_nan() || amount <= 0.0 || width == 0 || height == 0 {
        return;
    }
    let amount = amount.min(1.0);
    let x0 = bx.0.max(0);
    let y0 = bx.1.max(0);
    let x1 = bx.2.min(width as i32);
    let y1 = bx.3.min(height as i32);
    for y in y0..y1 {
        for x in x0..x1 {
            let a = &mut alpha[y as usize * width + x as usize];
            if *a == 0 {
                continue;
            }
            let n = unit(origin.0.wrapping_add(x), origin.1.wrapping_add(y), seed);
            let v = f32::from(*a) * (1.0 + (n - 0.5) * 2.0 * amount);
            *a = (v + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
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
    fn no_noise_changes_nothing_and_noise_never_reaches_past_the_matte() {
        let (w, h) = (16, 16);
        let mut a: Vec<u8> = (0..w * h)
            .map(|i| if i % w < 8 { 200 } else { 0 })
            .collect();
        let before = a.clone();
        grain(&mut a, w, h, (0, 0, 16, 16), 0.0, 1, (0, 0));
        assert_eq!(a, before);
        grain(&mut a, w, h, (0, 0, 16, 16), 1.0, 1, (0, 0));
        assert_ne!(a, before);
        // Nothing appears where the matte had nothing.
        for (i, v) in a.iter().enumerate() {
            if before[i] == 0 {
                assert_eq!(*v, 0);
            }
        }
    }

    #[test]
    fn the_grain_is_hashed_from_the_surface_corner_on() {
        // A matte cut out of a larger one, its corner (5, 3) further on,
        // grains as that part of the larger one does.
        let (w, h) = (16, 12);
        let mut big: Vec<u8> = vec![180; w * h];
        grain(&mut big, w, h, (0, 0, 16, 12), 0.6, 9, (100, 40));
        let (cw, ch) = (8, 6);
        let mut part = vec![180u8; cw * ch];
        grain(&mut part, cw, ch, (0, 0, 8, 6), 0.6, 9, (105, 43));
        for y in 0..ch {
            for x in 0..cw {
                assert_eq!(part[y * cw + x], big[(y + 3) * w + x + 5], "{x} {y}");
            }
        }
    }
}
