//! The pixel passes over one finished stroke, on straight RGBA8 as the
//! canvas's `getImageData` hands them to `src/lib/text-paint.js`: the grain
//! (`texturePixels`), the watercolour edge (`waterEdgePixels`), the
//! anti-aliasing grade (`sharpenAlpha`) and Compare density
//! (`densityOver`). Ported line for line, rounding included: a store into a
//! `Uint8ClampedArray` rounds a half to even, `Math.round` a half up.

use super::stamps::{js_round, to_uint32};
use crate::paint::geom::Affine;

/// A number stored into a `Uint8ClampedArray`.
pub(crate) fn clamped(v: f64) -> u8 {
    if v.is_nan() || v <= 0.0 {
        return 0;
    }
    if v >= 255.0 {
        return 255;
    }
    let f = v.floor();
    let rest = v - f;
    // Half-way goes to the even one.
    let r = if rest > 0.5 || (rest == 0.5 && f % 2.0 != 0.0) {
        f + 1.0
    } else {
        f
    };
    r as u8
}

/// `grainAt`: a cell's grain, 0 (a hole) to 1 (full ink).
fn grain_at(ix: f64, iy: f64) -> f64 {
    let mut h = to_uint32(ix)
        .wrapping_mul(374_761_393)
        .wrapping_add(to_uint32(iy).wrapping_mul(668_265_263));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    f64::from(h) / 4_294_967_296.0
}

/// One cell of grain at CSP's 100 %, page px.
const GRAIN_PX: f64 = 1.5;

/// `texturePixels`: the grain over `data` (`w * h` straight RGBA8 whose
/// corner is device `(ox, oy)`), looked up in page px through `t`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn texture(
    data: &mut [u8],
    w: usize,
    h: usize,
    t: &Affine,
    (ox, oy): (i32, i32),
    density: f64,
    scale: f64,
    stress: bool,
) {
    let density = density.clamp(0.0, 1.0);
    if density.is_nan() || density <= 0.0 {
        return;
    }
    let scale = if scale.is_nan() || scale == 0.0 {
        100.0
    } else {
        scale
    };
    let cell = ((GRAIN_PX * scale) / 100.0).max(0.25);
    let [a, b, c, d, e, f] = t.0;
    let det = a * d - b * c;
    if det.is_nan() || det.abs() <= 0.0 {
        return;
    }
    let ia = d / det;
    let ib = -b / det;
    let ic = -c / det;
    let id = a / det;
    let ie = (c * f - d * e) / det;
    let iff = (b * e - a * f) / det;
    for y in 0..h {
        for x in 0..w {
            let j = (y * w + x) * 4 + 3;
            let al = data[j];
            if al == 0 {
                continue;
            }
            let dx = f64::from(ox) + x as f64 + 0.5;
            let dy = f64::from(oy) + y as f64 + 0.5;
            let px = ia * dx + ic * dy + ie;
            let py = ib * dx + id * dy + iff;
            let mut g = grain_at((px / cell).floor(), (py / cell).floor());
            if stress {
                g *= g;
            }
            data[j] = js_round(f64::from(al) * (1.0 - density * (1.0 - g))) as u8;
        }
    }
}

/// `maxLine`: the largest value in every window of `2r + 1` along a line.
fn max_line(
    src: &[u8],
    dst: &mut [u8],
    n: usize,
    base: usize,
    stride: usize,
    r: usize,
    dq: &mut [usize],
) {
    let (mut head, mut tail) = (0usize, 0usize);
    for j in 0..n {
        let v = src[base + j * stride];
        while tail > head && src[base + dq[tail - 1] * stride] <= v {
            tail -= 1;
        }
        dq[tail] = j;
        tail += 1;
        if j >= 2 * r {
            let i = j - r;
            while dq[head] + 2 * r < j {
                head += 1;
            }
            dst[base + i * stride] = src[base + dq[head] * stride];
        }
    }
    for i in n.saturating_sub(r)..n {
        let mut m = 0;
        for j in i.saturating_sub(r)..n {
            m = m.max(src[base + j * stride]);
        }
        dst[base + i * stride] = m;
    }
}

/// `dilateAlpha`: the plane grown by `r` px on every side, a square.
fn dilate(alpha: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
    let mut dq = vec![0usize; w.max(h)];
    let mut tmp = vec![0u8; w * h];
    for y in 0..h {
        max_line(alpha, &mut tmp, w, y * w, 1, r, &mut dq);
    }
    for y in 0..h {
        for i in 0..r.min(w) {
            let mut m = 0;
            for j in 0..=(w - 1).min(i + r) {
                m = m.max(alpha[y * w + j]);
            }
            tmp[y * w + i] = m;
        }
    }
    let mut out = vec![0u8; w * h];
    for x in 0..w {
        max_line(&tmp, &mut out, h, x, w, r, &mut dq);
    }
    for x in 0..w {
        for i in 0..r.min(h) {
            let mut m = 0;
            for j in 0..=(h - 1).min(i + r) {
                m = m.max(tmp[j * w + x]);
            }
            out[i * w + x] = m;
        }
    }
    out
}

/// `blurPlane`: a box blur of radius `r`, run twice, in place.
fn blur_plane(plane: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 {
        return;
    }
    let pass = |src: &[f32], dst: &mut [f32], n: usize, base: usize, stride: usize| {
        let mut sum = 0.0f64;
        for j in 0..=(n - 1).min(r) {
            sum += f64::from(src[base + j * stride]);
        }
        for i in 0..n {
            let lo = i as isize - r as isize;
            let hi = i + r;
            let count = (n - 1).min(hi) as isize - lo.max(0) + 1;
            dst[base + i * stride] = (sum / count as f64) as f32;
            if lo >= 0 {
                sum -= f64::from(src[base + lo as usize * stride]);
            }
            if hi + 1 < n {
                sum += f64::from(src[base + (hi + 1) * stride]);
            }
        }
    };
    let mut tmp = vec![0.0f32; w * h];
    for _ in 0..2 {
        for y in 0..h {
            pass(plane, &mut tmp, w, y * w, 1);
        }
        for x in 0..w {
            pass(&tmp, plane, h, x, w);
        }
    }
}

/// `waterEdgePixels`: CSP's watercolour rim, laid outside the ink and under
/// it, in place over straight RGBA8.
#[allow(clippy::too_many_arguments)]
pub(crate) fn water_edge(
    data: &mut [u8],
    w: usize,
    h: usize,
    radius: f64,
    power: f64,
    dark: f64,
    blur: f64,
    rgb: [u8; 3],
    hard: bool,
) {
    let p = power.clamp(0.0, 1.0);
    let r = js_round(radius).max(1.0) as usize;
    let dk = dark.clamp(0.0, 1.0);
    let b = js_round(blur).max(0.0) as usize;
    if p.is_nan() || p <= 0.0 || w == 0 || h == 0 {
        return;
    }
    let n = w * h;
    let alpha: Vec<u8> = data.as_chunks::<4>().0.iter().map(|px| px[3]).collect();
    let grown = dilate(&alpha, w, h, r);
    let mut band: Vec<f32> = (0..n)
        .map(|i| f32::from(grown[i].saturating_sub(alpha[i])))
        .collect();
    if b > 0 {
        blur_plane(&mut band, w, h, b);
    }
    let rr = f64::from(rgb[0]) * (1.0 - dk);
    let rg = f64::from(rgb[1]) * (1.0 - dk);
    let rb = f64::from(rgb[2]) * (1.0 - dk);
    for i in 0..n {
        let mut ar = f64::from(band[i]) * p;
        if ar <= 0.0 {
            continue;
        }
        if hard {
            ar = if ar >= 32.0 { 255.0 } else { 0.0 };
        }
        if ar <= 0.0 {
            continue;
        }
        let a = f64::from(alpha[i]) / 255.0;
        let under = (ar / 255.0) * (1.0 - a);
        let ao = a + under;
        if ao <= 0.0 {
            continue;
        }
        let j = i * 4;
        data[j] = clamped((f64::from(data[j]) * a + rr * under) / ao);
        data[j + 1] = clamped((f64::from(data[j + 1]) * a + rg * under) / ao);
        data[j + 2] = clamped((f64::from(data[j + 2]) * a + rb * under) / ao);
        data[j + 3] = js_round(ao * 255.0).min(255.0) as u8;
    }
}

/// CSP's anti-aliasing grades as ramps over the alpha: None, Weak, Middle.
const AA_RAMPS: [[u32; 2]; 3] = [[128, 128], [96, 160], [48, 208]];

/// `sharpenAlpha`: grade `level` (0 to 2; 3, Strong, keeps all) in place.
pub(crate) fn sharpen(data: &mut [u8], level: u8) {
    let Some(&[lo, hi]) = AA_RAMPS.get(level as usize) else {
        return;
    };
    for px in data.as_chunks_mut::<4>().0.iter_mut() {
        let a = u32::from(px[3]);
        if a == 0 {
            continue;
        }
        px[3] = if a >= hi {
            255
        } else if a < lo {
            0
        } else if hi > lo {
            js_round(f64::from((a - lo) * 255) / f64::from(hi - lo)) as u8
        } else {
            px[3]
        };
    }
}

/// `densityOver`: CSP's Compare density, the denser of `src` (at `op`) and
/// `dst` kept, in place over `dst`.
pub(crate) fn density_over(dst: &mut [u8], src: &[u8], op: f64) {
    for (d, s) in dst
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(src.as_chunks::<4>().0.iter())
    {
        let sa = f64::from(s[3]) * op;
        if sa <= 0.0 || sa <= f64::from(d[3]) {
            continue;
        }
        d[..3].copy_from_slice(&s[..3]);
        d[3] = js_round(sa) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clamped_store_rounds_a_half_to_even() {
        assert_eq!(
            [0.5, 1.5, 2.5, 2.6, -3.0, 300.0, f64::NAN].map(clamped),
            [0, 2, 2, 3, 0, 255, 0]
        );
    }

    #[test]
    fn the_square_dilation_is_the_js_one() {
        // One dot in a row of nine, grown by two: five wide, centred.
        let mut a = vec![0u8; 9];
        a[4] = 200;
        assert_eq!(
            dilate(&a, 9, 1, 2),
            vec![0, 0, 200, 200, 200, 200, 200, 0, 0]
        );
        // At the ends, what is left of the window.
        let mut a = vec![0u8; 5];
        a[0] = 9;
        assert_eq!(dilate(&a, 5, 1, 3), vec![9, 9, 9, 9, 0]);
    }

    #[test]
    fn the_grades_are_ramps() {
        let mut px = [0, 0, 0, 100, 0, 0, 0, 200, 0, 0, 0, 40, 0, 0, 0, 255];
        sharpen(&mut px, 1);
        assert_eq!([px[3], px[7], px[11], px[15]], [16, 255, 0, 255]);
    }
}
