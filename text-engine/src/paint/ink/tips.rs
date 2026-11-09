//! Imported brush tips: the engine's own copy of each, and how a stamp
//! reads one.
//!
//! A tip is up to 2048 px a side (`TINT_MAX` in `src/lib/text-paint.js`) and
//! the same tip stamps every repaint of every box drawn with it, so it does
//! not travel in the job like a pattern tile. The page puts it once
//! (`mt_ink_tip_put`), under a key that names the brush and its size, and a
//! job names it by that key. What is put is the tip's coverage, eight bits a
//! pixel: the grey times the alpha, after the same cap to 2048 the canvas
//! makes before it tints, so the engine's base is the canvas's base. The
//! colour is the stroke's, laid at composite; nothing here is tinted.
//!
//! Kept here, per key: that base and its halvings down to a short side under
//! 64 (`buildTinted`'s mip chain), least recently used first out once the
//! whole is over [`CACHE_BYTES`] (wasm memory never shrinks, so the ceiling
//! is the cache's and not the allocator's). A key the job being prepared
//! named is never the one let go: the page names each of a job's keys
//! (`has` or `put`) before the job, and they stay held until it is painted
//! ([`end_job`]).
//!
//! The level chain, the sampler and the cache's byte-bounded least recently
//! used order follow PhotoCraft, `crates/paint/src/tile.rs` (`Mips::new`,
//! `Mips::sample_clamped`) and `crates/paint/src/mip_cache.rs` (`MipCache`),
//! Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors, MIT
//! licence (see `THIRD_PARTY.md`). Changed: levels stop at the canvas's
//! short side of 64 and round an odd side as the canvas does (an area
//! filter where PhotoCraft takes 2 x 2 to a side rounded up); eight-bit
//! coverage; the sampler carries the edge pixel past the edge, as a
//! `drawImage` of the whole image does, and reads nearest with
//! anti-aliasing None; the cache is keyed by the page's key, not by the
//! sample allocation, and keeps every key the job being prepared named.
//!
//! [`end_job`]: TipCache::end_job

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::Error;

/// Longest side and most pixels of a tip's coverage.
pub const MAX_TIP_SIDE: usize = 4096;
pub const MAX_TIP_PIXELS: usize = 16 * 1024 * 1024;
/// Most a tip's natural size may say, a side.
pub const MAX_NATURAL: u32 = 1 << 20;
/// The most every tip and all its levels may hold together.
pub const CACHE_BYTES: usize = 64 * 1024 * 1024;
/// A level is halved while its short side is at least twice this
/// (`MIP_MIN`).
const MIP_MIN: usize = 32;
/// What an entry costs past its pixels: the key, the map's slot.
const ENTRY_COST: usize = 128;

/// One level of a tip: coverage, eight bits, row by row.
#[derive(Debug, PartialEq)]
pub struct Level {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

/// A tip in the engine: its natural size, which the stamp's shape is made
/// from, and its levels, biggest first.
#[derive(Debug, PartialEq)]
pub struct Tip {
    /// The tip's own pixel size (`tipSize`): the stamp's aspect.
    pub natural: (f64, f64),
    pub levels: Vec<Level>,
}

/// `Math.round`.
fn js_round(v: f64) -> f64 {
    super::stamps::js_round(v)
}

/// The sizes of a tip's levels from a base of `w` x `h`: halved, each side
/// rounded (`Math.round(w / 2)`), while the short side is at least 64.
pub fn level_sizes(w: usize, h: usize) -> Vec<(usize, usize)> {
    let mut out = vec![(w, h)];
    let (mut cw, mut ch) = (w, h);
    while cw.min(ch) >= MIP_MIN * 2 {
        let nw = (js_round(cw as f64 / 2.0) as usize).max(1);
        let nh = (js_round(ch as f64 / 2.0) as usize).max(1);
        if (nw, nh) == (cw, ch) {
            break;
        }
        out.push((nw, nh));
        (cw, ch) = (nw, nh);
    }
    out
}

/// What a tip of a `w` x `h` base holds, levels and entry together.
pub fn tip_bytes(w: usize, h: usize) -> usize {
    level_sizes(w, h).iter().map(|(a, b)| a * b).sum::<usize>() + ENTRY_COST
}

/// A `Vec` of `n` zeros, or a refusal where the memory is not to be had.
fn zeros(n: usize) -> Result<Vec<u8>, Error> {
    let mut v = Vec::new();
    v.try_reserve_exact(n).map_err(|_| Error::BadSpec)?;
    v.resize(n, 0);
    Ok(v)
}

/// One level the box filter of the one above it: each pixel the mean of the
/// area of the source it covers (2 x 2 where a side halves exactly).
fn halve(src: &Level, nw: usize, nh: usize) -> Result<Level, Error> {
    // The share of each source pixel along one axis that falls in each
    // destination pixel, as (first source pixel, weights).
    fn spans(from: usize, to: usize) -> Vec<(usize, Vec<f32>)> {
        let k = from as f64 / to as f64;
        (0..to)
            .map(|i| {
                let (a, b) = (i as f64 * k, (i + 1) as f64 * k);
                let first = a.floor() as usize;
                let last = (b.ceil() as usize).min(from);
                let w = (first..last)
                    .map(|j| {
                        let lo = a.max(j as f64);
                        let hi = b.min(j as f64 + 1.0);
                        ((hi - lo).max(0.0) / k) as f32
                    })
                    .collect();
                (first, w)
            })
            .collect()
    }
    let xs = spans(src.width, nw);
    let ys = spans(src.height, nh);
    // Across, then down.
    let mut across = vec![0f32; nw * src.height];
    for y in 0..src.height {
        let row = &src.data[y * src.width..(y + 1) * src.width];
        for (x, (first, w)) in xs.iter().enumerate() {
            let mut v = 0f32;
            for (j, k) in w.iter().enumerate() {
                v += f32::from(row[first + j]) * k;
            }
            across[y * nw + x] = v;
        }
    }
    let mut data = zeros(nw * nh)?;
    for (y, (first, w)) in ys.iter().enumerate() {
        for x in 0..nw {
            let mut v = 0f32;
            for (j, k) in w.iter().enumerate() {
                v += across[(first + j) * nw + x] * k;
            }
            data[y * nw + x] = js_round(f64::from(v)).clamp(0.0, 255.0) as u8;
        }
    }
    Ok(Level {
        width: nw,
        height: nh,
        data,
    })
}

impl Tip {
    /// A tip from its coverage, `w` x `h` (`data` row by row), and its
    /// natural size; its levels built. Refused: no pixels, a side past
    /// [`MAX_TIP_SIDE`], more than [`MAX_TIP_PIXELS`], data that is not the
    /// size, a natural size of nothing or past [`MAX_NATURAL`].
    pub fn new(w: usize, h: usize, natural: (u32, u32), data: &[u8]) -> Result<Tip, Error> {
        if w == 0
            || h == 0
            || w > MAX_TIP_SIDE
            || h > MAX_TIP_SIDE
            || w * h > MAX_TIP_PIXELS
            || data.len() != w * h
            || natural.0 == 0
            || natural.1 == 0
            || natural.0 > MAX_NATURAL
            || natural.1 > MAX_NATURAL
        {
            return Err(Error::BadSpec);
        }
        let mut base = Vec::new();
        base.try_reserve_exact(data.len())
            .map_err(|_| Error::BadSpec)?;
        base.extend_from_slice(data);
        let sizes = level_sizes(w, h);
        let mut levels = Vec::new();
        levels
            .try_reserve_exact(sizes.len())
            .map_err(|_| Error::BadSpec)?;
        levels.push(Level {
            width: w,
            height: h,
            data: base,
        });
        for &(nw, nh) in &sizes[1..] {
            let next = halve(levels.last().expect("a base"), nw, nh)?;
            levels.push(next);
        }
        Ok(Tip {
            natural: (f64::from(natural.0), f64::from(natural.1)),
            levels,
        })
    }

    /// What the tip holds, its levels and its entry.
    pub fn bytes(&self) -> usize {
        self.levels.iter().map(|l| l.data.len()).sum::<usize>() + ENTRY_COST
    }

    /// `pickTipLevel`: the smallest level whose longest side is still at
    /// least `device_px`, or the biggest where none is.
    pub fn pick(&self, device_px: f64) -> &Level {
        let mut out = &self.levels[0];
        for l in &self.levels[1..] {
            if (l.width.max(l.height) as f64) < device_px {
                break;
            }
            out = l;
        }
        out
    }
}

impl Level {
    /// The coverage at `(x, y)` in the level's pixels (a pixel's centre at
    /// its half), 0 to 1: bilinear between the four nearest centres, the
    /// edge pixels carried on past the edge; or the pixel it falls in,
    /// with `smooth` off.
    // Read inside every pixel of a tip's stamp: kept in its caller's loop
    // (measured in WebKit, 2026-11-09).
    #[inline(always)]
    pub fn sample(&self, x: f64, y: f64, smooth: bool) -> f32 {
        let (w, h) = (self.width as i64, self.height as i64);
        let at = |px: i64, py: i64| -> f32 {
            let px = px.clamp(0, w - 1) as usize;
            let py = py.clamp(0, h - 1) as usize;
            f32::from(self.data[py * self.width + px])
        };
        if !smooth {
            return at(x.floor() as i64, y.floor() as i64) / 255.0;
        }
        let (fx, fy) = (x - 0.5, y - 0.5);
        let (x0, y0) = (fx.floor(), fy.floor());
        let (tx, ty) = ((fx - x0) as f32, (fy - y0) as f32);
        let (x0, y0) = (x0 as i64, y0 as i64);
        let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1, y0) * tx;
        let bottom = at(x0, y0 + 1) * (1.0 - tx) + at(x0 + 1, y0 + 1) * tx;
        (top * (1.0 - ty) + bottom * ty) / 255.0
    }
}

struct Entry {
    tip: Rc<Tip>,
    bytes: usize,
    /// When it was last named, for least recently used.
    used: u64,
    /// The job it was last named for.
    job: u64,
}

/// The engine's tips, by key.
pub struct TipCache {
    map: HashMap<String, Entry>,
    bytes: usize,
    clock: u64,
    job: u64,
    ceiling: usize,
}

impl Default for TipCache {
    fn default() -> Self {
        Self::with_ceiling(CACHE_BYTES)
    }
}

impl TipCache {
    pub fn with_ceiling(ceiling: usize) -> Self {
        Self {
            map: HashMap::new(),
            bytes: 0,
            clock: 0,
            job: 0,
            ceiling,
        }
    }

    fn touch(&mut self, key: &str) -> Option<&Entry> {
        self.clock += 1;
        let (clock, job) = (self.clock, self.job);
        let e = self.map.get_mut(key)?;
        e.used = clock;
        e.job = job;
        Some(e)
    }

    /// Whether the tip is here; named for the job being prepared if it is.
    pub fn has(&mut self, key: &str) -> bool {
        self.touch(key).is_some()
    }

    /// The tip, named for the job being prepared.
    pub fn get(&mut self, key: &str) -> Option<Rc<Tip>> {
        self.touch(key).map(|e| Rc::clone(&e.tip))
    }

    /// Puts the tip under `key`, in place of any there: room made first by
    /// letting go of the least recently used tips the job being prepared has
    /// not named, then the levels built. Refused where that cannot make room
    /// (nothing else is let go; the key's old tip is), or as [`Tip::new`]
    /// refuses.
    pub fn put(
        &mut self,
        key: &str,
        w: usize,
        h: usize,
        natural: (u32, u32),
        data: &[u8],
    ) -> Result<(), Error> {
        if key.len() > super::MAX_TIP_KEY
            || w == 0
            || h == 0
            || w > MAX_TIP_SIDE
            || h > MAX_TIP_SIDE
            || w * h > MAX_TIP_PIXELS
        {
            return Err(Error::BadSpec);
        }
        // Built (and so checked) before anything is let go for it: a tip
        // that is refused costs the cache nothing.
        let tip = Tip::new(w, h, natural, data)?;
        let need = tip.bytes();
        if let Some(old) = self.map.remove(key) {
            self.bytes -= old.bytes;
        }
        // What can go, oldest first, until the new one fits.
        let free = self.ceiling.saturating_sub(self.bytes);
        if need > free {
            let mut can: Vec<(u64, &str, usize)> = self
                .map
                .iter()
                .filter(|(_, e)| e.job != self.job)
                .map(|(k, e)| (e.used, k.as_str(), e.bytes))
                .collect();
            can.sort_unstable();
            let mut freed = 0;
            let mut out = Vec::new();
            for (_, k, b) in can {
                if need <= free + freed {
                    break;
                }
                freed += b;
                out.push(k.to_owned());
            }
            if need > free + freed {
                return Err(Error::BadSpec);
            }
            for k in out {
                if let Some(e) = self.map.remove(&k) {
                    self.bytes -= e.bytes;
                }
            }
        }
        let bytes = need;
        self.clock += 1;
        self.map.try_reserve(1).map_err(|_| Error::BadSpec)?;
        self.map.insert(
            key.to_owned(),
            Entry {
                tip: Rc::new(tip),
                bytes,
                used: self.clock,
                job: self.job,
            },
        );
        self.bytes += bytes;
        Ok(())
    }

    /// Lets go of every tip.
    pub fn forget(&mut self) {
        self.map = HashMap::new();
        self.bytes = 0;
    }

    /// The job is painted: what it named may go again.
    pub fn end_job(&mut self) {
        self.job += 1;
    }

    /// What the tips hold, levels and entries.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

thread_local! {
    static CACHE: RefCell<TipCache> = RefCell::new(TipCache::default());
}

/// The engine's tip cache.
pub fn with_cache<R>(f: impl FnOnce(&mut TipCache) -> R) -> R {
    CACHE.with(|c| f(&mut c.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(w: usize, h: usize) -> Vec<u8> {
        (0..w * h)
            .map(|i| ((i % w) * 255 / (w - 1)) as u8)
            .collect()
    }

    #[test]
    fn the_levels_halve_as_the_canvas_halves_them() {
        assert_eq!(level_sizes(63, 500), vec![(63, 500)]);
        assert_eq!(level_sizes(257, 130), vec![(257, 130), (129, 65), (65, 33)]);
        assert_eq!(
            level_sizes(2048, 2048).last(),
            Some(&(32, 32)),
            "down to a short side under 64"
        );
        assert_eq!(level_sizes(2048, 2048).len(), 7);
        let t = Tip::new(4, 64, (4, 64), &ramp(4, 64)).unwrap();
        assert_eq!(t.levels.len(), 1);
    }

    #[test]
    fn a_halving_is_the_mean_of_what_it_covers() {
        let src = Level {
            width: 4,
            height: 2,
            data: vec![0, 100, 200, 255, 100, 100, 0, 0],
        };
        let l = halve(&src, 2, 1).unwrap();
        assert_eq!(l.data, vec![75, 114]);
        // An odd side shares its middle pixel.
        let src = Level {
            width: 3,
            height: 1,
            data: vec![0, 90, 180],
        };
        assert_eq!(halve(&src, 2, 1).unwrap().data, vec![30, 150]);
    }

    #[test]
    fn the_level_picked_is_the_smallest_at_least_as_big() {
        let t = Tip::new(512, 256, (512, 256), &vec![9; 512 * 256]).unwrap();
        let sizes: Vec<_> = t.levels.iter().map(|l| l.width).collect();
        assert_eq!(sizes, vec![512, 256, 128, 64]);
        assert_eq!(t.pick(600.0).width, 512);
        assert_eq!(t.pick(300.0).width, 512);
        assert_eq!(t.pick(256.0).width, 256);
        assert_eq!(t.pick(129.0).width, 256);
        assert_eq!(t.pick(128.0).width, 128);
        assert_eq!(t.pick(20.0).width, 64);
    }

    #[test]
    fn the_sampler_is_bilinear_between_centres() {
        let l = Level {
            width: 2,
            height: 2,
            data: vec![0, 255, 0, 255],
        };
        assert_eq!(l.sample(0.5, 0.5, true), 0.0);
        assert_eq!(l.sample(1.5, 0.5, true), 1.0);
        assert!((l.sample(1.0, 1.0, true) - 0.5).abs() < 1e-6);
        assert!((l.sample(0.75, 1.3, true) - 0.25).abs() < 1e-6);
        // Past the edge, the edge.
        assert_eq!(l.sample(-3.0, 0.5, true), 0.0);
        assert_eq!(l.sample(9.0, 9.0, true), 1.0);
        // Nearest: the pixel it falls in.
        assert_eq!(l.sample(0.99, 0.2, false), 0.0);
        assert_eq!(l.sample(1.01, 0.2, false), 1.0);
    }

    #[test]
    fn a_tip_past_the_limits_is_refused() {
        let mut c = TipCache::default();
        assert_eq!(c.put("a", 0, 4, (1, 1), &[]), Err(Error::BadSpec));
        assert_eq!(c.put("a", 4097, 1, (1, 1), &[0; 4097]), Err(Error::BadSpec));
        // 4096 x 4096 is 16 MP: the most there may be; one more row is not.
        assert!(Tip::new(4096, 4097, (1, 1), &[]).is_err());
        assert_eq!(c.put("a", 2, 2, (1, 1), &[0; 3]), Err(Error::BadSpec));
        assert_eq!(c.put("a", 2, 2, (0, 1), &[0; 4]), Err(Error::BadSpec));
        assert_eq!(
            c.put(&"k".repeat(1025), 2, 2, (1, 1), &[0; 4]),
            Err(Error::BadSpec)
        );
        assert!(c.is_empty());
        assert!(c.put("a", 2, 2, (1, 1), &[0; 4]).is_ok());
        assert!(c.has("a"));
    }

    #[test]
    fn the_cache_lets_the_oldest_go_and_keeps_what_the_job_named() {
        let side = 256;
        let one = tip_bytes(side, side);
        let mut c = TipCache::with_ceiling(one * 3);
        let px = vec![7u8; side * side];
        for k in ["a", "b", "c"] {
            c.put(k, side, side, (side as u32, side as u32), &px)
                .unwrap();
        }
        c.end_job();
        assert_eq!(c.bytes(), one * 3);
        // "a" named again: "b" is now the oldest.
        assert!(c.has("a"));
        c.end_job();
        c.put("d", side, side, (1, 1), &px).unwrap();
        assert!(c.has("a") && !c.has("b") && c.has("c") && c.has("d"));
        assert!(c.bytes() <= one * 3);
        // A job naming all three it holds: a fourth has no room, and nothing
        // it named is let go for it.
        c.end_job();
        for k in ["a", "c", "d"] {
            assert!(c.has(k));
        }
        assert_eq!(c.put("e", side, side, (1, 1), &px), Err(Error::BadSpec));
        assert!(c.has("a") && c.has("c") && c.has("d") && !c.has("e"));
        // Put again under the same key: replaced, not counted twice.
        c.put("a", side, side, (2, 2), &px).unwrap();
        assert_eq!(c.get("a").unwrap().natural, (2.0, 2.0));
        assert_eq!(c.bytes(), one * 3);
        c.forget();
        assert!(c.is_empty() && c.bytes() == 0 && !c.has("a"));
    }

    #[test]
    fn a_refused_tip_lets_nothing_go() {
        let side = 256;
        let one = tip_bytes(side, side);
        let mut c = TipCache::with_ceiling(one * 2);
        let px = vec![7u8; side * side];
        for k in ["a", "b"] {
            c.put(k, side, side, (side as u32, side as u32), &px)
                .unwrap();
        }
        c.end_job();
        // Full, and the new tip is bad (no natural size; then too few bytes):
        // nothing is let go for it, the same key included.
        assert_eq!(c.put("c", side, side, (0, 0), &px), Err(Error::BadSpec));
        assert_eq!(c.put("a", side, side, (1, 1), &px[1..]), Err(Error::BadSpec));
        assert!(c.has("a") && c.has("b") && !c.has("c"));
        assert_eq!(c.bytes(), one * 2);
    }

    #[test]
    fn a_tip_is_the_same_tip_twice() {
        let data = ramp(300, 200);
        let a = Tip::new(300, 200, (600, 400), &data).unwrap();
        let b = Tip::new(300, 200, (600, 400), &data).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.bytes(), tip_bytes(300, 200));
    }
}
