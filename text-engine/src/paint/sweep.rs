//! Many opaque copies of one layer, laid in one pass: an extrude.
//!
//! An SFX extrude is the letters' silhouette laid two dozen times and more,
//! each copy a step further along a line, every one opaque and in one colour
//! (`effectShadows` in `src/lib/text-paint.js`), and an edge under it is as
//! many again. Laid a copy at a time
//! ([`over_moved_in`](super::blur::over_moved_in)) each copy is a pass
//! over all of its ink, so the extrude cost as many passes as it has steps.
//!
//! Most of that work changes nothing. A copy laid opaque in one colour over
//! that colour leaves it as it was, so a pixel some copy covers whole comes
//! out the colour whatever the other copies do there, and a pixel no copy
//! reaches is as it was. Only the thin band where the copies' edges fall
//! depends on each copy. So:
//!
//! ```text
//! once a layer   each row's runs of blocks of four pixels that are all
//!                opaque ("whole"), and that have any ink ("reached")
//! each row       how many copies cover each pixel whole, and how many reach
//!                it: counts started and stopped at the runs' ends, so the
//!                work is the runs times the copies, not the pixels
//! each pixel     covered whole: the layer's colour. Reached and not covered
//!                whole: the copies laid one by one, the very sums
//!                `over_moved_in` makes, so the band is what it was
//! ```
//!
//! A copy reads, for each pixel it writes, a block of four source pixels
//! whose corner is the pixel moved back by whole pixels (`Taps`): the same
//! move for every pixel. So a row of a copy is a row of blocks moved, and its
//! runs are the layer's runs moved. The steps need not be even, nor on one
//! line.
//!
//! What can differ from the copies laid one by one: a partly covering copy
//! laid over a pixel already the layer's colour leaves it that colour within
//! a level, from the rounding of the copy's own colour at its edge; here the
//! pixel is the colour exactly. Alpha is the same.

use super::blur::{add_row, to_u8, Moved, Surface, Taps};
use super::budget;
use super::geom::IBox;
use crate::Error;

/// Blocks `[x0, x1)` of a row, by their corners' columns.
type Span = (i32, i32);

/// A block reached: a pixel of it has ink.
const REACHED: u8 = 1;
/// A block whole: all four of its pixels are opaque.
const WHOLE: u8 = 2;

/// Where a layer's blocks of four pixels are whole and where they are
/// reached, row by row, as runs `[x0, x1)` of the block's corner.
pub(crate) struct Runs {
    /// The block row of the first entry: the one above the ink, whose lower
    /// pixels are the ink's first row.
    y0: i64,
    rows: usize,
    /// Per block row, where its runs start in `whole` and `reached`; one more
    /// entry than rows.
    whole_at: budget::Buffer<usize>,
    whole: budget::Buffer<Span>,
    reached_at: budget::Buffer<usize>,
    reached: budget::Buffer<Span>,
    /// The pixel every opaque pixel of the layer is; `None` when there is
    /// no opaque pixel, or opaque pixels of more than one colour, and a pixel
    /// covered whole is not one known pixel.
    solid: Option<[u8; 4]>,
}

impl Runs {
    /// The runs of `layer`, whose ink is `ink`.
    pub(crate) fn new(layer: &Surface, ink: IBox) -> Result<Self, Error> {
        let w = layer.width;
        let (x0, x1) = (ink.x0 as usize, ink.x1 as usize);
        let (rows, cols) = (ink.height() + 1, ink.width() + 1);
        // Each pixel of two rows as `REACHED` and `WHOLE` (inked, opaque),
        // with a clear one each side so a block over the ink's edge reads
        // nothing without a test.
        let mut upper = budget::filled(cols + 1, 0u8)?;
        let mut lower = budget::filled(cols + 1, 0u8)?;
        let mut out = Runs {
            y0: i64::from(ink.y0) - 1,
            rows,
            whole_at: budget::Buffer::new(),
            whole: budget::Buffer::new(),
            reached_at: budget::Buffer::new(),
            reached: budget::Buffer::new(),
            solid: None,
        };
        // A row of blocks: block `i` has its corner at column `ink.x0 - 1 + i`.
        let mut blocks = budget::filled(cols, 0u8)?;
        let corner = |i: usize| (i64::from(ink.x0) - 1 + i as i64) as i32;
        let (mut solid, mut mixed) = (None, false);
        budget::reserve(&mut out.whole_at, rows + 1)?;
        budget::reserve(&mut out.reached_at, rows + 1)?;
        for r in 0..rows {
            // Block row `r` reads pixel rows `r - 1` and `r` of the ink: what
            // was the lower row is now the upper, and the next row comes in.
            core::mem::swap(&mut upper, &mut lower);
            let y = ink.y0 as usize + r;
            if y < ink.y1 as usize {
                let row = &layer.data[(y * w + x0) * 4..(y * w + x1) * 4];
                for (f, p) in lower[1..].iter_mut().zip(row.as_chunks::<4>().0) {
                    let a = p[3];
                    *f = u8::from(a != 0) | u8::from(a == 255) << 1;
                    if a == 255 && !mixed {
                        match solid {
                            None => solid = Some(*p),
                            Some(s) => mixed = s != *p,
                        }
                    }
                }
            } else {
                lower.fill(0);
            }
            let pixels = upper.windows(2).zip(lower.windows(2));
            for (b, (u, l)) in blocks.iter_mut().zip(pixels) {
                *b = ((u[0] | u[1] | l[0] | l[1]) & REACHED) | (u[0] & u[1] & l[0] & l[1] & WHOLE);
            }
            budget::push(&mut out.whole_at, out.whole.len())?;
            budget::push(&mut out.reached_at, out.reached.len())?;
            for (flag, runs) in [(WHOLE, &mut out.whole), (REACHED, &mut out.reached)] {
                let mut from = None;
                for (i, b) in blocks.iter().enumerate() {
                    match (b & flag != 0, from) {
                        (true, None) => from = Some(i),
                        (false, Some(a)) => {
                            budget::push(runs, (corner(a), corner(i)))?;
                            from = None;
                        }
                        _ => {}
                    }
                }
                if let Some(a) = from {
                    budget::push(runs, (corner(a), corner(cols)))?;
                }
            }
            if r % 64 == 0 {
                budget::check()?;
            }
        }
        budget::push(&mut out.whole_at, out.whole.len())?;
        budget::push(&mut out.reached_at, out.reached.len())?;
        out.solid = if mixed { None } else { solid };
        Ok(out)
    }

    /// The runs of block row `y`, whole and reached.
    fn row(&self, y: i64) -> Option<(&[Span], &[Span])> {
        let r = y - self.y0;
        if r < 0 || r >= self.rows as i64 {
            return None;
        }
        let r = r as usize;
        Some((
            &self.whole[self.whole_at[r]..self.whole_at[r + 1]],
            &self.reached[self.reached_at[r]..self.reached_at[r + 1]],
        ))
    }
}

/// A run of blocks as the pixels a copy reading them writes: moved back by
/// the copy's whole-pixel shift `ix`, and cut to a row `w` wide.
fn moved((a, b): Span, ix: i64, w: usize) -> (usize, usize) {
    let at = |v: i32| (i64::from(v) - ix).clamp(0, w as i64) as usize;
    (at(a), at(b))
}

/// Lays `layer`, whose ink is `ink` and whose runs are `runs`, on `dst` once
/// for each of `moves` (pixels, the first laid first), every copy opaque:
/// what [`over_moved_in`](super::blur::over_moved_in) at opacity 1 does a
/// copy at a time.
pub(crate) fn over_swept(
    dst: &mut Surface,
    layer: &Surface,
    ink: IBox,
    runs: &Runs,
    moves: &[(f64, f64)],
) -> Result<(), Error> {
    let Some(solid) = runs.solid else {
        // No one pixel a copy covering whole lays: each copy is laid itself.
        let mut acc = budget::filled(dst.width * 4, 0.0f32)?;
        for &m in moves {
            over_runs(dst, layer, ink, runs, m, 1.0, &mut acc);
        }
        return Ok(());
    };
    let (w, h) = (dst.width, dst.height);
    // Only the copies that can land on the surface; the rest lay nothing.
    let mut taps = budget::Buffer::new();
    let far = (w.max(h) + 2) as i64;
    for &(dx, dy) in moves {
        let t = Taps::new(&Moved { dx, dy, weight: 1.0 });
        if t.ix.abs() <= far && t.iy.abs() <= far {
            budget::push(&mut taps, t)?;
        }
    }
    let Some(top) = taps.iter().map(|t| runs.y0 - t.iy).min() else {
        return Ok(());
    };
    let bottom = taps.iter().map(|t| runs.y0 + runs.rows as i64 - t.iy).max().unwrap_or(top);
    let (top, bottom) = (top.max(0) as usize, bottom.clamp(0, h as i64) as usize);
    // How many copies cover a pixel whole, and how many reach it, kept as
    // changes at the runs' ends.
    let mut whole = budget::filled(w + 1, 0i32)?;
    let mut reached = budget::filled(w + 1, 0i32)?;
    // The band's pixels in the row, left to right.
    let mut band: budget::Buffer<usize> = budget::Buffer::new();
    budget::reserve(&mut band, w)?;
    let lw = layer.width;
    for y in top..bottom {
        let (mut lo, mut hi) = (w, 0);
        for t in taps.iter() {
            let Some((wr, rr)) = runs.row(y as i64 + t.iy) else {
                continue;
            };
            for (counts, spans) in [(&mut whole, wr), (&mut reached, rr)] {
                for &(a, b) in spans {
                    let (a, b) = moved((a, b), t.ix, w);
                    if a < b {
                        counts[a] += 1;
                        counts[b] -= 1;
                        lo = lo.min(a);
                        hi = hi.max(b);
                    }
                }
            }
        }
        if lo >= hi {
            continue;
        }
        let (mut cw, mut cr) = (0, 0);
        let row = &mut dst.data[y * w * 4..(y + 1) * w * 4];
        band.clear();
        for x in lo..hi {
            cw += whole[x];
            cr += reached[x];
            whole[x] = 0;
            reached[x] = 0;
            if cw > 0 {
                row[x * 4..x * 4 + 4].copy_from_slice(&solid);
            } else if cr > 0 {
                band.push(x);
            }
        }
        whole[hi] = 0;
        reached[hi] = 0;
        // The band, a copy at a time, each copy only where it reaches: a
        // pixel sees the copies in their order, as `over_moved_in` lays them.
        if !band.is_empty() {
            for t in taps.iter() {
                let Some((_, rr)) = runs.row(y as i64 + t.iy) else {
                    continue;
                };
                for &span in rr {
                    let (a, b) = moved(span, t.ix, w);
                    let from = band.partition_point(|&x| x < a);
                    for &x in band[from..].iter().take_while(|&&x| x < b) {
                        let mut s = [0.0f32; 4];
                        let pairs = [(y as i64 + t.iy, [t.k[0], t.k[1]]), (y as i64 + t.iy + 1, [t.k[2], t.k[3]])];
                        for (sy, k) in pairs {
                            if sy < i64::from(ink.y0) || sy >= i64::from(ink.y1) || (k[0] == 0.0 && k[1] == 0.0) {
                                continue;
                            }
                            for (sx, k) in [(x as i64 + t.ix, k[0]), (x as i64 + t.ix + 1, k[1])] {
                                if k == 0.0 || sx < i64::from(ink.x0) || sx >= i64::from(ink.x1) {
                                    continue;
                                }
                                let i = (sy as usize * lw + sx as usize) * 4;
                                for (s, v) in s.iter_mut().zip(&layer.data[i..i + 4]) {
                                    *s += f32::from(*v) * k;
                                }
                            }
                        }
                        if s[3] <= 0.0 {
                            continue;
                        }
                        let keep = 1.0 - s[3] / 255.0;
                        let p = &mut row[x * 4..x * 4 + 4];
                        for c in 0..4 {
                            p[c] = to_u8(s[c] + f32::from(p[c]) * keep);
                        }
                    }
                }
            }
        }
        if y % 64 == 0 {
            budget::check()?;
        }
    }
    Ok(())
}

/// `layer` moved by `(dx, dy)` pixels, laid source-over on `dst` at
/// `opacity`: [`over_moved_in`](super::blur::over_moved_in) laid only along
/// the runs the copy reaches, and so the same pixels. Letters are mostly the
/// space between them, and a copy's sums over that space came to nothing.
pub(crate) fn over_runs(
    dst: &mut Surface,
    layer: &Surface,
    ink: IBox,
    runs: &Runs,
    (dx, dy): (f64, f64),
    opacity: f64,
    acc: &mut [f32],
) {
    let t = Taps::new(&Moved {
        dx,
        dy,
        weight: opacity.clamp(0.0, 1.0),
    });
    let (w, h) = (dst.width, dst.height);
    let far = (w.max(h) + 2) as i64;
    if t.ix.abs() > far || t.iy.abs() > far {
        return;
    }
    let top = (runs.y0 - t.iy).clamp(0, h as i64) as usize;
    let bottom = (runs.y0 + runs.rows as i64 - t.iy).clamp(0, h as i64) as usize;
    for y in top..bottom {
        let Some((_, spans)) = runs.row(y as i64 + t.iy) else {
            continue;
        };
        for &span in spans {
            let (x0, x1) = moved(span, t.ix, w);
            if x0 >= x1 {
                continue;
            }
            acc[x0 * 4..x1 * 4].fill(0.0);
            add_row(acc, layer, ink, y as i64, (x0, x1), &t);
            let to = (y * w + x0) * 4;
            let pairs = dst.data[to..to + (x1 - x0) * 4]
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(acc[x0 * 4..x1 * 4].as_chunks::<4>().0);
            for (d, s) in pairs {
                if s[3] <= 0.0 {
                    continue;
                }
                let keep = 1.0 - s[3] / 255.0;
                for c in 0..4 {
                    d[c] = to_u8(s[c] + f32::from(d[c]) * keep);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::blur::{over_moved, over_moved_in};
    use super::*;

    /// A layer in one colour, its shapes anti-aliased: a disc, a ring and a
    /// slanted bar, with a soft ramp of alpha at every edge.
    fn layer(w: usize, h: usize, rgb: [u8; 3]) -> Surface {
        let mut s = Surface::new(w, h).unwrap();
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                let disc = 14.0 - ((fx - 30.0).powi(2) + (fy - 30.0).powi(2)).sqrt();
                let r = ((fx - 70.0).powi(2) + (fy - 34.0).powi(2)).sqrt();
                let ring = 4.5 - (r - 13.0).abs();
                let bar = 5.0 - (fx * 0.8 - fy * 0.6 - 40.0).abs();
                let bar = if (10.0..60.0).contains(&fy) { bar } else { -1.0 };
                let cover = disc.max(ring).max(bar).clamp(0.0, 1.0);
                let a = (cover * 255.0).round() as u32;
                if a == 0 {
                    continue;
                }
                let px = [
                    ((u32::from(rgb[0]) * a + 127) / 255) as u8,
                    ((u32::from(rgb[1]) * a + 127) / 255) as u8,
                    ((u32::from(rgb[2]) * a + 127) / 255) as u8,
                    a as u8,
                ];
                s.data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&px);
            }
        }
        s
    }

    /// Something to lay the copies over, so what is under them counts.
    fn ground(w: usize, h: usize) -> Surface {
        let mut s = Surface::new(w, h).unwrap();
        for y in 0..h {
            for x in 0..w {
                if (x / 7 + y / 5) % 3 == 0 {
                    let a = (60 + (x * 3 + y) % 190) as u8;
                    s.data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[a / 3, a / 2, a, a]);
                }
            }
        }
        s
    }

    /// Steps along `(ux, uy)`, `len` long, `n` of them: an extrude's.
    fn steps(ux: f64, uy: f64, len: f64, n: usize) -> Vec<(f64, f64)> {
        (1..=n)
            .rev()
            .map(|k| (ux * len * k as f64 / n as f64, uy * len * k as f64 / n as f64))
            .collect()
    }

    fn worst(a: &Surface, b: &Surface) -> ([u8; 4], usize) {
        let mut worst = [0u8; 4];
        let mut differ = 0;
        for (p, q) in a.data.as_chunks::<4>().0.iter().zip(b.data.as_chunks::<4>().0) {
            if p != q {
                differ += 1;
            }
            for c in 0..4 {
                worst[c] = worst[c].max(p[c].abs_diff(q[c]));
            }
        }
        (worst, differ)
    }

    #[test]
    fn a_sweep_is_the_copies_laid_one_by_one() {
        let (w, h) = (160, 120);
        let rgb = [30, 200, 90];
        let src = layer(w, h, rgb);
        let ink = src.ink().unwrap();
        let _scope = budget::Scope::new();
        let runs = Runs::new(&src, ink).unwrap();
        let cases: &[(f64, f64, f64, usize)] = &[
            (1.0, 0.0, 30.0, 20),
            (0.0, 1.0, 24.0, 16),
            (core::f64::consts::FRAC_1_SQRT_2, core::f64::consts::FRAC_1_SQRT_2, 36.0, 24),
            (-0.6, 0.8, 50.0, 48),
            (0.97, -0.24, 17.3, 11),
            (-1.0, -0.0, 9.0, 9),
            (0.3, 0.95, 80.0, 7),
            // Off the surface and back.
            (1.0, 0.2, 400.0, 30),
        ];
        for &(ux, uy, len, n) in cases {
            let moves = steps(ux, uy, len, n);
            let mut one = ground(w, h);
            let mut acc = vec![0.0f32; w * 4];
            for &m in &moves {
                over_moved_in(&mut one, &src, ink, m, 1.0, &mut acc);
            }
            let mut swept = ground(w, h);
            over_swept(&mut swept, &src, ink, &runs, &moves).unwrap();
            let (worst, differ) = worst(&one, &swept);
            // Alpha is the same; a colour is within a level, and rarely off.
            assert_eq!(worst[3], 0, "({ux}, {uy}) x {n}: alpha");
            assert!(worst[..3].iter().all(|&d| d <= 1), "({ux}, {uy}) x {n}: {worst:?}");
            assert!(differ * 200 < w * h, "({ux}, {uy}) x {n}: {differ} pixels differ");
        }
    }

    #[test]
    fn a_layer_of_more_than_one_colour_has_no_solid() {
        let _scope = budget::Scope::new();
        let mut s = layer(100, 70, [10, 20, 30]);
        assert_eq!(Runs::new(&s, s.ink().unwrap()).unwrap().solid, Some([10, 20, 30, 255]));
        let i = (30 * 100 + 30) * 4;
        s.data[i..i + 4].copy_from_slice(&[11, 20, 30, 255]);
        assert_eq!(Runs::new(&s, s.ink().unwrap()).unwrap().solid, None);
        // Nothing opaque: nothing a pixel covered whole could be.
        let mut faint = Surface::new(8, 8).unwrap();
        faint.data[(3 * 8 + 3) * 4..(3 * 8 + 3) * 4 + 4].copy_from_slice(&[0, 0, 100, 100]);
        assert_eq!(Runs::new(&faint, faint.ink().unwrap()).unwrap().solid, None);
    }

    /// Laid along its runs, a copy is the copy: every pixel, any opacity,
    /// and a layer of many colours swept is its copies one by one.
    #[test]
    fn copies_along_the_runs_are_the_copies() {
        let (w, h) = (150, 100);
        let mut src = layer(w, h, [200, 60, 10]);
        for p in src.data.as_chunks_mut::<4>().0.iter_mut().step_by(7) {
            p[0] /= 2;
        }
        let ink = src.ink().unwrap();
        let _scope = budget::Scope::new();
        let runs = Runs::new(&src, ink).unwrap();
        assert_eq!(runs.solid, None);
        let mut acc = vec![0.0f32; w * 4];
        for (m, opacity) in [((6.3, -2.2), 0.45), ((-7.0, 0.0), 0.3), ((0.5, 0.5), 1.0), ((140.0, 3.0), 0.9)] {
            let mut one = ground(w, h);
            over_moved_in(&mut one, &src, ink, m, opacity, &mut acc);
            let mut along = ground(w, h);
            over_runs(&mut along, &src, ink, &runs, m, opacity, &mut acc);
            assert_eq!(worst(&one, &along).0, [0; 4], "{m:?} at {opacity}");
        }
        let moves = steps(0.6, 0.8, 30.0, 20);
        let mut one = ground(w, h);
        for &m in &moves {
            over_moved_in(&mut one, &src, ink, m, 1.0, &mut acc);
        }
        let mut swept = ground(w, h);
        over_swept(&mut swept, &src, ink, &runs, &moves).unwrap();
        assert_eq!(worst(&one, &swept).0, [0; 4]);
    }

    #[test]
    fn whole_moves_and_one_copy_are_exact() {
        let (w, h) = (120, 90);
        let src = layer(w, h, [255, 255, 255]);
        let ink = src.ink().unwrap();
        let _scope = budget::Scope::new();
        let runs = Runs::new(&src, ink).unwrap();
        for moves in [vec![(3.0, -2.0)], vec![(0.0, 0.0), (5.0, 5.0), (10.0, 10.0)], vec![(2.5, 0.25)]] {
            let mut one = Surface::new(w, h).unwrap();
            for &m in &moves {
                over_moved(&mut one, &src, m, 1.0).unwrap();
            }
            let mut swept = Surface::new(w, h).unwrap();
            over_swept(&mut swept, &src, ink, &runs, &moves).unwrap();
            assert_eq!(worst(&one, &swept).0, [0; 4], "{moves:?}");
        }
    }
}
