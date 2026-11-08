//! Photoshop's soft edge: two box passes of the effect's Size (a tent).
//!
//! A drop shadow, a glow and a satin of Size `s` are not a gaussian: they are
//! the matte through a box of width `s`, twice. PhotoCraft fitted this on
//! Photoshop's own renders (psd-tools `layer_effects.psd`): drop shadow
//! coverage error 0.0064 with a gaussian of sigma `0.4 * s`, 0.0038 with the
//! tent; satin 0.014 against 0.002.
//!
//! Ported from PhotoCraft, `crates/compose/src/effects/blur.rs`
//! (`box_geom`, `box_line`, `tent_line`), Copyright (c) 2026 ArtCraft Team
//! and the PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).
//! Changed: one thread, `f64` lines handed in by the caller.

/// The widest box, device pixels: a size from a file or a command can be
/// anything, and the width sizes the work.
pub const MAX_WIDTH: f64 = 8192.0;

/// A box of (fractional) width `w`: `(r, f, 1 / w)`, where the box's taps
/// are `r - 1` whole ones each side of the centre and the two end taps
/// weigh `f`. At least 1 wide, at most [`MAX_WIDTH`].
fn geom(w: f64) -> (i64, f64, f64) {
    let w = if w.is_nan() {
        1.0
    } else {
        w.clamp(1.0, MAX_WIDTH)
    };
    let half = w / 2.0;
    let r = (half - 0.5).ceil().max(0.0) as i64;
    let f = (half - (r as f64 - 0.5)).clamp(0.0, 1.0);
    (r, f, 1.0 / w)
}

/// How far a tent of width `w` moves ink, whole pixels: two boxes of
/// radius `r`. 0 when the tent changes nothing (a width of 1 or less).
pub fn reach(w: f64) -> i32 {
    2 * geom(w).0.min(i64::from(i32::MAX / 4)) as i32
}

/// One box pass over `src` (zero outside it), read at `x0 .. x0 +
/// dst.len()`, as a running sum.
fn box_line(src: &[f64], x0: i64, dst: &mut [f64], w: f64) {
    let n = src.len() as i64;
    let (r, f, norm) = geom(w);
    let at = |i: i64| {
        if i >= 0 && i < n {
            src[i as usize]
        } else {
            0.0
        }
    };
    if r == 0 {
        for (k, d) in dst.iter_mut().enumerate() {
            *d = at(x0 + k as i64);
        }
        return;
    }
    let window = x0 - (r - 1)..=x0 + (r - 1);
    let mut inner: f64 = window.clone().map(at).sum();
    let mut last_covered = window.rev().find(|&x| at(x) != 0.0).unwrap_or(i64::MIN);
    for (k, d) in dst.iter_mut().enumerate() {
        let x = x0 + k as i64;
        *d = (inner + f * (at(x - r) + at(x + r))) * norm;
        let entering = at(x + r);
        inner += entering - at(x - r + 1);
        if entering != 0.0 {
            last_covered = x + r;
        }
        // The sum can keep a crumb of rounding once the last ink has left
        // the window, which noise would raise into a speck: an empty window
        // is reset to nothing.
        if last_covered < x - r + 2 {
            inner = 0.0;
        }
    }
}

/// `src` through the tent of width `w`, into `dst` of the same length (zero
/// outside `src`). `mid` is scratch, any length; it is resized.
pub fn line(src: &[f64], dst: &mut [f64], w: f64, mid: &mut Vec<f64>) {
    let (r, _, _) = geom(w);
    mid.clear();
    mid.resize(src.len() + 2 * r as usize, 0.0);
    box_line(src, -r, mid, w);
    // `mid[k]` holds position `k - r`: position `p` is read at `p + r`.
    box_line(mid, r, dst, w);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tented(src: &[f64], w: f64) -> Vec<f64> {
        let mut out = vec![0.0; src.len()];
        line(src, &mut out, w, &mut Vec::new());
        out
    }

    #[test]
    fn a_width_of_one_changes_nothing() {
        let src = [0.0, 0.0, 1.0, 0.5, 0.0];
        assert_eq!(tented(&src, 1.0), src.to_vec());
        assert_eq!(reach(1.0), 0);
    }

    #[test]
    fn it_keeps_the_sum_and_reaches_twice_the_box() {
        let mut src = vec![0.0; 41];
        src[20] = 1.0;
        let out = tented(&src, 5.0);
        let sum: f64 = out.iter().sum();
        assert!((sum - 1.0).abs() < 1e-9, "{sum}");
        assert_eq!(reach(5.0), 4);
        // Nothing past the reach, something at it.
        assert_eq!(out[20 - 5], 0.0);
        assert!(out[20 - 4] > 0.0);
        // A tent: highest in the middle, falling both ways alike.
        for d in 1..5 {
            assert!(out[20 - d] < out[20 - d + 1]);
            assert!((out[20 - d] - out[20 + d]).abs() < 1e-12);
        }
    }

    #[test]
    fn an_edge_falls_to_half_at_the_edge() {
        let src: Vec<f64> = (0..60).map(|i| if i < 30 { 1.0 } else { 0.0 }).collect();
        let out = tented(&src, 10.0);
        // Between the last inside pixel and the first outside one the tent
        // of an edge is a half.
        assert!(((out[29] + out[30]) / 2.0 - 0.5).abs() < 1e-9);
        assert!((out[10] - 1.0).abs() < 1e-12);
        assert_eq!(out[50], 0.0);
    }
}
