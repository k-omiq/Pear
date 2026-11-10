//! The exact Euclidean distance transform, and a matte grown by it.
//!
//! Felzenszwalb and Huttenlocher, "Distance Transforms of Sampled Functions"
//! (2012): the squared distance to the nearest inked pixel, a row at a time
//! and then a column at a time, each pass linear in its length: what a
//! Precise glow and a chiselled bevel measure. Spread and Choke grow a matte
//! by the cheaper 5 x 5 chamfer instead ([`dilate`]), as Photoshop does.

use super::super::budget;
use crate::Error;

pub(crate) const FAR: f32 = 1e20;

/// The lower envelope of parabolas rooted at `f`, written to `d`: for each
/// `q`, the least of `(q - p)^2 + f[p]`. `v` and `z` are scratch of length
/// `n` and `n + 1`.
fn pass(f: &[f32], d: &mut [f32], v: &mut [usize], z: &mut [f32]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0usize;
    v[0] = 0;
    z[0] = -FAR;
    z[1] = FAR;
    for q in 1..n {
        if f[q] >= FAR {
            continue;
        }
        loop {
            let p = v[k];
            if f[p] >= FAR {
                // Nothing kept yet worth meeting: this parabola replaces it.
                v[k] = q;
                z[k] = -FAR;
                z[k + 1] = FAR;
                break;
            }
            let s =
                ((f[q] + (q * q) as f32) - (f[p] + (p * p) as f32)) / (2.0 * (q as f32 - p as f32));
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                v[k] = q;
                z[k] = -FAR;
                z[k + 1] = FAR;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = FAR;
            break;
        }
    }
    if f[v[0]] >= FAR {
        d.fill(FAR);
        return;
    }
    let mut k = 0usize;
    for (q, out) in d.iter_mut().enumerate() {
        while z[k + 1] < q as f32 {
            k += 1;
        }
        let p = v[k];
        let dq = q as f32 - p as f32;
        *out = dq * dq + f[p];
    }
}

/// The squared distance from every pixel to the nearest pixel `inside` says
/// is in, `width * height` row by row. All `FAR` when none is.
pub fn squared(inside: &[bool], width: usize, height: usize) -> Result<budget::Buffer<f32>, Error> {
    let n = width.max(height);
    let mut out = budget::filled(width * height, FAR)?;
    let mut f = budget::filled(n, FAR)?;
    let mut d = budget::filled(n, FAR)?;
    let mut v = budget::filled(n, 0usize)?;
    let mut z = budget::filled(n + 1, 0.0f32)?;
    for y in 0..height {
        for x in 0..width {
            f[x] = if inside[y * width + x] { 0.0 } else { FAR };
        }
        pass(&f[..width], &mut d[..width], &mut v, &mut z);
        out[y * width..(y + 1) * width].copy_from_slice(&d[..width]);
    }
    for x in 0..width {
        for y in 0..height {
            f[y] = out[y * width + x];
        }
        pass(&f[..height], &mut d[..height], &mut v, &mut z);
        for y in 0..height {
            out[y * width + x] = d[y];
        }
    }
    Ok(out)
}

/// Photoshop's Spread and Choke: a matte grown by `by` pixels with the 5 x 5
/// chamfer metric, keeping its soft edge. A partly covered pixel grows by
/// `by` from its own coverage, so a small spread does not make every
/// anti-aliased edge pixel solid; a pixel outside takes `by + 0.5` less its
/// distance to the edge, which starts inside the nearest inked pixel by its
/// coverage.
///
/// Photoshop's spread of a drop shadow round an ellipse is round at 0 and 45
/// degrees and falls short between, as the chamfer does; an exact Euclidean
/// grow is 5 levels lighter there, the chamfer within 2.
///
/// Ported from PhotoCraft, `crates/compose/src/effects/blur.rs` (`dilate`)
/// and `distance.rs` (`chamfer_from`, `dist_outside_by`), Copyright (c) 2026
/// ArtCraft Team and the PhotoCraft contributors, MIT licence (see
/// `THIRD_PARTY.md`). Changed: 8-bit mattes, no nearest-seed index.
pub fn dilate(alpha: &mut [u8], width: usize, height: usize, by: f64) -> Result<(), Error> {
    if by.is_nan() || by <= 0.0 || width == 0 || height == 0 {
        return Ok(());
    }
    let by = by as f32;
    let mut d = budget::filled(width * height, FAR)?;
    for (d, &a) in d.iter_mut().zip(alpha.iter()) {
        if a > 0 {
            *d = 1.0 - f32::from(a) / 255.0;
        }
    }
    chamfer(&mut d, width, height);
    for (o, &d) in alpha.iter_mut().zip(d.iter()) {
        let a = f32::from(*o) / 255.0;
        let v = if *o > 0 {
            (a + by).min(1.0)
        } else {
            (by + 0.5 - (d - 0.5)).clamp(0.0, 1.0)
        };
        *o = (v * 255.0 + 0.5) as u8;
    }
    Ok(())
}

/// The 5 x 5 chamfer distance from the seeds of `d` (a start value; [`FAR`]
/// is no seed): two raster passes, each pixel taking the least of its own
/// and a visited neighbour's plus the step to it.
pub(crate) fn chamfer(d: &mut [f32], width: usize, height: usize) {
    if width == 0 || height == 0 || d.len() < width * height {
        return;
    }
    let d = &mut d[..width * height];
    let (w, h) = (width as i64, height as i64);
    // A pixel near the grid's edge: each neighbour looked for.
    let edge = |d: &mut [f32], x: i64, y: i64, sign: i64| {
        let i = (y * w + x) as usize;
        let mut best = d[i];
        for &(ox, oy, step) in &FWD {
            let (nx, ny) = (x + ox * sign, y + oy * sign);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let c = d[(ny * w + nx) as usize] + step;
            if c < best {
                best = c;
            }
        }
        d[i] = best;
    };
    // The least of a pixel's own value and the seven neighbours in the two
    // rows already done; the eighth, the pixel just done in its own row, is
    // taken last, so only one sum and one compare wait on it. The least of a
    // set is the same in any order.
    #[inline(always)]
    fn rest(own: f32, near: &[f32], far: &[f32]) -> f32 {
        let mut best = own;
        for c in [
            near[1] + S2,
            near[2] + 1.0,
            near[3] + S2,
            far[0] + S5,
            far[2] + S5,
            near[0] + S5,
            near[4] + S5,
        ] {
            if c < best {
                best = c;
            }
        }
        best
    }
    for y in 0..height {
        if y < 2 || width < 5 {
            for x in 0..w {
                edge(d, x, y as i64, 1);
            }
            continue;
        }
        edge(d, 0, y as i64, 1);
        edge(d, 1, y as i64, 1);
        {
            let (above, row) = d.split_at_mut(y * width);
            let far = &above[(y - 2) * width..(y - 1) * width];
            let near = &above[(y - 1) * width..];
            let mut last = row[1];
            let cells = row[2..width - 2].iter_mut();
            for ((cell, near), far) in cells.zip(near.windows(5)).zip(far[1..width - 1].windows(3)) {
                let mut best = rest(*cell, near, far);
                let c = last + 1.0;
                if c < best {
                    best = c;
                }
                *cell = best;
                last = best;
            }
        }
        edge(d, w - 2, y as i64, 1);
        edge(d, w - 1, y as i64, 1);
    }
    for y in (0..height).rev() {
        if y + 2 >= height || width < 5 {
            for x in (0..w).rev() {
                edge(d, x, y as i64, -1);
            }
            continue;
        }
        edge(d, w - 1, y as i64, -1);
        edge(d, w - 2, y as i64, -1);
        {
            let (upper, below) = d.split_at_mut((y + 1) * width);
            let row = &mut upper[y * width..];
            let near = &below[..width];
            let far = &below[width..2 * width];
            let mut last = row[width - 2];
            let cells = row[2..width - 2].iter_mut().rev();
            for ((cell, near), far) in cells
                .zip(near.windows(5).rev())
                .zip(far[1..width - 1].windows(3).rev())
            {
                // The same seven mirrored: the rows below, right for left.
                let mut best = rest(*cell, near, far);
                let c = last + 1.0;
                if c < best {
                    best = c;
                }
                *cell = best;
                last = best;
            }
        }
        edge(d, 1, y as i64, -1);
        edge(d, 0, y as i64, -1);
    }
}

const S2: f32 = core::f32::consts::SQRT_2;
const S5: f32 = 2.236_068;
/// The neighbours a forward pass has already visited, and the step to each.
const FWD: [(i64, i64, f32); 8] = [
    (-1, 0, 1.0),
    (-1, -1, S2),
    (0, -1, 1.0),
    (1, -1, S2),
    (-1, -2, S5),
    (1, -2, S5),
    (-2, -1, S5),
    (2, -1, S5),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// The chamfer as it was first written, every neighbour looked for:
    /// what [`chamfer`] must give, to the bit.
    fn chamfer_as_first_written(d: &mut [f32], width: usize, height: usize) {
        let (w, h) = (width as i64, height as i64);
        let mut relax = |x: i64, y: i64, sign: i64| {
            let i = (y * w + x) as usize;
            let mut best = d[i];
            for &(ox, oy, step) in &FWD {
                let (nx, ny) = (x + ox * sign, y + oy * sign);
                if nx < 0 || ny < 0 || nx >= w || ny >= h {
                    continue;
                }
                let c = d[(ny * w + nx) as usize] + step;
                if c < best {
                    best = c;
                }
            }
            d[i] = best;
        };
        for y in 0..h {
            for x in 0..w {
                relax(x, y, 1);
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                relax(x, y, -1);
            }
        }
    }

    #[test]
    fn the_chamfer_is_what_it_was_to_the_bit() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..600 {
            let (w, h) = (1 + (next() % 23) as usize, 1 + (next() % 19) as usize);
            let odds = [2, 5, 40, 1000][round % 4];
            let mut d: Vec<f32> = (0..w * h)
                .map(|_| {
                    if next() % odds == 0 {
                        (next() >> 40) as f32 / (1u32 << 24) as f32
                    } else {
                        FAR
                    }
                })
                .collect();
            let mut want = d.clone();
            chamfer_as_first_written(&mut want, w, h);
            chamfer(&mut d, w, h);
            for i in 0..w * h {
                assert_eq!(d[i].to_bits(), want[i].to_bits(), "round {round} {w}x{h} at {i}");
            }
        }
    }


    fn brute(inside: &[bool], w: usize, h: usize) -> Vec<f32> {
        let mut out = vec![FAR; w * h];
        for y in 0..h {
            for x in 0..w {
                for j in 0..h {
                    for i in 0..w {
                        if inside[j * w + i] {
                            let dx = x as f32 - i as f32;
                            let dy = y as f32 - j as f32;
                            out[y * w + x] = out[y * w + x].min(dx * dx + dy * dy);
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn matches_brute_force() {
        let (w, h) = (13, 9);
        let inside: Vec<bool> = (0..w * h).map(|i| (i * 7919) % 11 == 0).collect();
        let fast = squared(&inside, w, h).unwrap();
        let slow = brute(&inside, w, h);
        for (a, b) in fast.iter().zip(&slow) {
            assert!((a - b).abs() < 1e-3, "{a} vs {b}");
        }
    }

    #[test]
    fn nothing_inside_is_far_everywhere() {
        let d = squared(&[false; 12], 4, 3).unwrap();
        assert!(d.iter().all(|&v| v >= FAR));
    }

    #[test]
    fn a_chamfer_dilate_grows_by_whole_pixels_and_keeps_partial_edges() {
        let (w, h) = (21, 21);
        let mut a = vec![0u8; w * h];
        a[10 * w + 10] = 255;
        a[10 * w + 11] = 64;
        dilate(&mut a, w, h, 3.0).unwrap();
        // Straight out, three pixels and the half of the edge.
        assert_eq!(a[10 * w + 7], 255);
        assert_eq!(a[10 * w + 5], 0);
        // A quarter-covered pixel grows by its own coverage, to full.
        assert_eq!(a[10 * w + 11], 255);
        let mut b = vec![0u8; w * h];
        b[10 * w + 10] = 64;
        dilate(&mut b, w, h, 0.25).unwrap();
        assert_eq!(b[10 * w + 10], 128);
    }
}
