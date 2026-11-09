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
//! Changed: one thread, `f64` lines handed in by the caller, and only the
//! span of a line that holds anything is worked.

use super::super::budget;
use crate::Error;

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

/// The variance of one box of width `w` as [`geom`] lays its taps, pixels
/// squared: 0 at a width of 1 or less (the box changes nothing).
pub fn variance(w: f64) -> f64 {
    let (r, f, norm) = geom(w);
    if r == 0 {
        return 0.0;
    }
    let r = r as f64;
    // The whole taps 1 ..= r - 1 each side, and the two end ones at r.
    let whole = (r - 1.0) * r * (2.0 * r - 1.0) / 6.0;
    (2.0 * whole + 2.0 * f * r * r) * norm
}

/// The width of the box whose [`variance`] is `v`: the inverse of it, at
/// least 1 (a box that changes nothing), at most [`MAX_WIDTH`]. Between
/// widths `2r - 1` and `2r + 1` the end taps sit at `r` and weigh
/// `w / 2 - r + 1/2`, so `v * w = 2 S + r^2 (w - 2r + 1)` (`S` the whole
/// taps' sum of squares), which is solved for `w`.
pub fn width_of_variance(v: f64) -> f64 {
    if v.is_nan() || v <= 0.0 {
        return 1.0;
    }
    if v >= variance(MAX_WIDTH) {
        return MAX_WIDTH;
    }
    // Near `sqrt(12 v) / 2` (a box's `w^2 / 12`), a little below it.
    let mut r = (((12.0 * v).sqrt() / 2.0).floor() - 2.0).max(1.0);
    while r > 1.0 && variance(2.0 * r - 1.0) > v {
        r -= 1.0;
    }
    while variance(2.0 * r + 1.0) < v {
        r += 1.0;
    }
    let whole = (r - 1.0) * r * (2.0 * r - 1.0) / 6.0;
    let w = (2.0 * whole - 2.0 * r * r * r + r * r) / (v - r * r);
    w.clamp(2.0 * r - 1.0, 2.0 * r + 1.0)
}

/// One box pass along `buf`, read with nothing to mind at its ends:
/// `out[k]` is the box centred on `buf[c0 + k]`, which reads
/// `buf[c0 - r .. c0 + out.len() + r]`. A running sum.
///
/// The sum can keep a crumb of rounding once the last ink has left the
/// window, which noise would raise into a speck: an empty window is reset to
/// nothing. `dead_from` is the first centre whose window the last ink seen
/// has left.
fn run(buf: &[f64], c0: usize, out: &mut [f64], r: usize, f: f64, norm: f64) {
    let n = out.len();
    let lo = &buf[c0 - r..c0 - r + n];
    let lo1 = &buf[c0 - r + 1..c0 - r + 1 + n];
    let hi = &buf[c0 + r..c0 + r + n];
    let window = &buf[c0 + 1 - r..c0 + r];
    let mut inner: f64 = window.iter().sum();
    let mut dead_from = window
        .iter()
        .rposition(|v| *v != 0.0)
        .map_or(0, |i| c0 + 1 - r + i + r - 1);
    for (k, d) in out.iter_mut().enumerate() {
        let x = c0 + k;
        let entering = hi[k];
        *d = (inner + f * (lo[k] + entering)) * norm;
        inner += entering - lo1[k];
        if entering != 0.0 {
            dead_from = x + 2 * r - 1;
        }
        if x >= dead_from {
            inner = 0.0;
        }
    }
}

/// `src` through the tent of width `w`, into `dst` of the same length (zero
/// outside `src`). `scratch` is any length; it is resized. Hands back
/// whether `dst` holds anything but nothing.
///
/// Two box passes, the first read `r` past each end of `src`. Only the span
/// that holds anything is worked: `r` either side of it the first box lays
/// nothing, and `2 r` either side the tent lays nothing, exactly (the running
/// sum is nothing before the first ink and is reset to nothing after the
/// last). A line of nothing costs one read of it.
pub fn line(src: &[f64], dst: &mut [f64], w: f64, scratch: &mut Vec<f64>) -> bool {
    let (r, f, norm) = geom(w);
    let n = src.len().min(dst.len());
    let (src, dst) = (&src[..n], &mut dst[..n]);
    if r == 0 {
        dst.copy_from_slice(src);
        return true;
    }
    // Anything that is not a plain zero is worked through the sums.
    let holds = |v: &f64| v.to_bits() != 0;
    let Some(first) = src.iter().position(holds) else {
        dst.fill(0.0);
        return false;
    };
    let last = src.iter().rposition(holds).unwrap_or(first);
    let span = last - first + 1;
    let r = r as usize;
    // The span with `2 r` of nothing each side, and after it the first
    // pass's line, with `2 r` of nothing each side of what it lays.
    scratch.clear();
    scratch.resize(2 * span + 10 * r, 0.0);
    let (padded, mid) = scratch.split_at_mut(span + 4 * r);
    padded[2 * r..2 * r + span].copy_from_slice(&src[first..=last]);
    // Positions `first - r ..= last + r`; `mid[j]` is position
    // `first - 3 r + j`.
    run(padded, r, &mut mid[2 * r..span + 4 * r], r, f, norm);
    let from = first.saturating_sub(2 * r);
    let to = (last + 2 * r).min(n - 1);
    dst[..from].fill(0.0);
    dst[to + 1..].fill(0.0);
    run(mid, from + 3 * r - first, &mut dst[from..=to], r, f, norm);
    true
}

/// A grid's value, to and from the `f64` a line is worked in.
pub(crate) trait Cell: Copy {
    fn get(self) -> f64;
    fn put(v: f64) -> Self;
}

impl Cell for f32 {
    fn get(self) -> f64 {
        f64::from(self)
    }
    fn put(v: f64) -> Self {
        v as f32
    }
}

impl Cell for f64 {
    fn get(self) -> f64 {
        self
    }
    fn put(v: f64) -> Self {
        v
    }
}

/// How many columns are worked at a time: read and written back a row of
/// them at a time, so the grid is walked along its rows.
const COLUMNS: usize = 16;

/// The tent of width `w` each way over a grid `gw` wide and `gh` high, row by
/// row and then column by column, each line as [`line`] has it.
pub(crate) fn grid<T: Cell>(v: &mut [T], gw: usize, gh: usize, w: f64) -> Result<(), Error> {
    if gw == 0 || gh == 0 {
        return Ok(());
    }
    let mut scratch = Vec::new();
    let mut src = budget::filled(gw.max(gh * COLUMNS), 0f64)?;
    let mut dst = budget::filled(gw.max(gh), 0f64)?;
    for row in v.chunks_exact_mut(gw).take(gh) {
        for (s, c) in src.iter_mut().zip(row.iter()) {
            *s = c.get();
        }
        if line(&src[..gw], &mut dst[..gw], w, &mut scratch) {
            for (c, d) in row.iter_mut().zip(dst.iter()) {
                *c = T::put(*d);
            }
        }
    }
    let mut x0 = 0;
    while x0 < gw {
        let cols = COLUMNS.min(gw - x0);
        for (y, row) in v.chunks_exact(gw).take(gh).enumerate() {
            for (j, c) in row[x0..x0 + cols].iter().enumerate() {
                src[j * gh + y] = c.get();
            }
        }
        let mut any = false;
        for j in 0..cols {
            let col = &mut src[j * gh..(j + 1) * gh];
            if line(col, &mut dst[..gh], w, &mut scratch) {
                col.copy_from_slice(&dst[..gh]);
                any = true;
            }
        }
        if any {
            for (y, row) in v.chunks_exact_mut(gw).take(gh).enumerate() {
                for (j, c) in row[x0..x0 + cols].iter_mut().enumerate() {
                    *c = T::put(src[j * gh + y]);
                }
            }
        }
        x0 += cols;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The box pass as it was first written, every read minding the ends:
    /// what [`line`] must give, to the bit.
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
            if last_covered < x - r + 2 {
                inner = 0.0;
            }
        }
    }

    fn line_as_first_written(src: &[f64], dst: &mut [f64], w: f64) {
        let (r, _, _) = geom(w);
        let mut mid = vec![0.0; src.len() + 2 * r as usize];
        box_line(src, -r, &mut mid, w);
        box_line(&mid, r, dst, w);
    }

    /// A small generator, the same on every machine.
    fn next(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }

    #[test]
    fn a_line_is_what_it_was_to_the_bit() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let widths = [0.5, 1.0, 1.2, 2.0, 2.5, 3.0, 3.7, 4.0, 9.0, 16.5, 41.0, 200.0];
        let mut scratch = Vec::new();
        for round in 0..4000 {
            let n = 1 + (next(&mut seed) % 97) as usize;
            let w = widths[(next(&mut seed) % widths.len() as u64) as usize];
            let kind = round % 8;
            let mut src = vec![0.0f64; n];
            // Runs of ink in a line of nothing, a full line, a lone pixel,
            // and odd values: a minus zero, a huge one, a tiny one.
            let (a, b) = ((next(&mut seed) as usize) % n, (next(&mut seed) as usize) % n);
            let (a, b) = (a.min(b), a.max(b));
            for (i, v) in src.iter_mut().enumerate() {
                let u = (next(&mut seed) >> 11) as f64 / (1u64 << 53) as f64;
                *v = match kind {
                    0 => u,
                    1 if i == a => u,
                    2 | 3 if i >= a && i <= b => u,
                    4 if i >= a && i <= b => 1.0,
                    5 if i >= a && i <= b => (u * 255.0).round() / 255.0,
                    6 if i == a => -0.0,
                    6 if i == b => u * 1e-300,
                    7 if i >= a && i <= b && u < 0.5 => u * 1e12,
                    _ => 0.0,
                };
            }
            let mut want = vec![7.0; n];
            line_as_first_written(&src, &mut want, w);
            let mut got = vec![9.0; n];
            let any = line(&src, &mut got, w, &mut scratch);
            for i in 0..n {
                assert_eq!(got[i].to_bits(), want[i].to_bits(), "round {round} w {w} n {n} at {i}");
            }
            assert!(any || want.iter().all(|v| v.to_bits() == 0));
        }
    }

    #[test]
    fn a_grid_is_its_lines_rows_then_columns() {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        for (gw, gh, w) in [(37usize, 21usize, 5.0), (5, 40, 3.5), (40, 3, 12.0), (1, 1, 4.0), (33, 33, 1.0)] {
            let mut v: Vec<f32> = (0..gw * gh)
                .map(|i| {
                    let u = (next(&mut seed) >> 40) as f32 / (1u32 << 24) as f32;
                    // A block of ink with nothing round it.
                    let (x, y) = (i % gw, i / gw);
                    if x * 3 >= gw && x * 3 < 2 * gw + 3 && y * 4 >= gh { u } else { 0.0 }
                })
                .collect();
            let mut want = v.clone();
            for y in 0..gh {
                let src: Vec<f64> = (0..gw).map(|x| f64::from(want[y * gw + x])).collect();
                let mut dst = vec![0.0; gw];
                line_as_first_written(&src, &mut dst, w);
                for x in 0..gw {
                    want[y * gw + x] = dst[x] as f32;
                }
            }
            for x in 0..gw {
                let src: Vec<f64> = (0..gh).map(|y| f64::from(want[y * gw + x])).collect();
                let mut dst = vec![0.0; gh];
                line_as_first_written(&src, &mut dst, w);
                for y in 0..gh {
                    want[y * gw + x] = dst[y] as f32;
                }
            }
            grid(&mut v, gw, gh, w).unwrap();
            for i in 0..gw * gh {
                assert_eq!(v[i].to_bits(), want[i].to_bits(), "{gw}x{gh} w {w} at {i}");
            }
        }
    }

    fn tented(src: &[f64], w: f64) -> Vec<f64> {
        let mut out = vec![0.0; src.len()];
        line(src, &mut out, w, &mut Vec::new());
        out
    }

    #[test]
    fn the_variance_is_the_taps_own_and_its_inverse_finds_the_width() {
        // Measured on the taps a box lays.
        let mut src = vec![0.0; 81];
        src[40] = 1.0;
        for w in [1.0, 1.5, 2.0, 2.7, 3.0, 4.0, 5.5, 10.0, 17.25] {
            let mut out = vec![0.0; 81];
            box_line(&src, 0, &mut out, w);
            let got: f64 = out
                .iter()
                .enumerate()
                .map(|(i, v)| v * (i as f64 - 40.0).powi(2))
                .sum();
            assert!((got - variance(w)).abs() < 1e-9, "{w}: {got}");
            if w > 1.0 {
                assert!((width_of_variance(variance(w)) - w).abs() < 1e-9, "{w}");
            }
        }
        assert_eq!(width_of_variance(0.0), 1.0);
        // Rising: a wider box spreads further.
        let mut last = 0.0;
        for i in 1..400 {
            let v = variance(f64::from(i) * 0.25);
            assert!(v >= last);
            last = v;
        }
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
