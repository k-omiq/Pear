//! The exact Euclidean distance transform, and a matte grown by it.
//!
//! Felzenszwalb and Huttenlocher, "Distance Transforms of Sampled Functions"
//! (2012): the squared distance to the nearest inked pixel, a row at a time
//! and then a column at a time, each pass linear in its length. Photoshop's
//! Spread and Choke grow a matte by a distance, and its Precise technique
//! measures one; both are this.

use super::super::budget;
use crate::Error;

const FAR: f32 = 1e20;

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

/// Grows a matte by `by` pixels: the edge of its inside (the pixels half
/// covered or more) moves out by `by`, and a pixel the new edge crosses is
/// covered by the share of it inside. The matte only gains.
pub fn grow(alpha: &mut [u8], width: usize, height: usize, by: f64) -> Result<(), Error> {
    if by <= 0.0 || width == 0 || height == 0 {
        return Ok(());
    }
    let inside = budget::collect(alpha.iter().map(|&a| Ok(a >= 128)))?;
    let d2 = squared(&inside, width, height)?;
    // An inside pixel's edge is half a pixel from its centre, and a pixel
    // `d` away spans `d - 0.5` to `d + 0.5`.
    let reach = by as f32 + 1.0;
    for (a, d2) in alpha.iter_mut().zip(d2.iter()) {
        if *d2 >= FAR {
            continue;
        }
        let cover = (reach - d2.sqrt()).clamp(0.0, 1.0);
        let v = (cover * 255.0 + 0.5) as u8;
        if v > *a {
            *a = v;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn grow_reaches_as_far_as_asked() {
        let (w, h) = (21, 1);
        let mut a = vec![0u8; w];
        a[10] = 255;
        grow(&mut a, w, h, 3.5).unwrap();
        assert_eq!(a[13], 255);
        assert_eq!(a[7], 255);
        assert!(a[14] > 0 && a[14] < 255);
        assert_eq!(a[15], 0);
    }
}
