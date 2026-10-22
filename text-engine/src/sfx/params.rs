//! The params of `mt_sfx_place` as bytes: little-endian, read in this order.
//!
//! ```text
//! u32 flags: 1 vertical, 2 join long bars, 4 shape kerning
//! u32 seed
//! u32 kind: an index into KINDS, or 0xFFFF_FFFF for none
//! f64 strength, flow from, flow to, flow pow, follow, gap, big tighter,
//!     slant, rise, jitter turn, jitter size, jitter offset
//! u32 path count, then per path: f64 ax, ay, bx, by, bend   (ems)
//! u32 edit count, then per edit: u32 group, u32 index, f64 dx, dy, rot, scale
//! ```
//!
//! `src/lib/sfx.js` writes it. A number that is not finite, a kind past the
//! table, more paths than groups can have, or bytes left over is `BadSpec`.

use super::items::{MAX_GROUPS, MAX_ITEMS};
use super::kinds::KINDS;
use super::path::Path;
use super::place::{Edit, Params};
use crate::Error;

pub const NO_KIND: u32 = u32::MAX;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::BadSpec)?;
        let s = self.bytes.get(self.at..end).ok_or(Error::BadSpec)?;
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    fn left(&self) -> usize {
        self.bytes.len() - self.at
    }
}

pub fn decode(bytes: &[u8]) -> Result<Params, Error> {
    let mut r = Reader { bytes, at: 0 };
    let flags = r.u32()?;
    let seed = r.u32()?;
    let kind = match r.u32()? {
        NO_KIND => None,
        k if (k as usize) < KINDS.len() => Some(k as usize),
        _ => return Err(Error::BadSpec),
    };
    let mut f = [0.0f64; 12];
    for v in &mut f {
        *v = r.f64()?;
    }
    let paths_n = r.u32()? as usize;
    if paths_n > MAX_GROUPS || paths_n * 40 > r.left() {
        return Err(Error::BadSpec);
    }
    let mut paths = Vec::with_capacity(paths_n);
    for _ in 0..paths_n {
        paths.push(Path {
            a: [r.f64()?, r.f64()?],
            b: [r.f64()?, r.f64()?],
            bend: r.f64()?,
        });
    }
    let edits_n = r.u32()? as usize;
    if edits_n > MAX_ITEMS || edits_n * 40 > r.left() {
        return Err(Error::BadSpec);
    }
    let mut edits = Vec::with_capacity(edits_n);
    for _ in 0..edits_n {
        edits.push(Edit {
            group: r.u32()?,
            index: r.u32()?,
            dx: r.f64()?,
            dy: r.f64()?,
            rot: r.f64()?,
            scale: r.f64()?,
        });
    }
    if r.left() != 0 {
        return Err(Error::BadSpec);
    }
    Ok(Params {
        vertical: flags & 1 != 0,
        join_bars: flags & 2 != 0,
        kern: flags & 4 != 0,
        seed,
        strength: f[0],
        flow: (f[1], f[2], f[3]),
        follow: f[4],
        gap: f[5],
        big_tighter: f[6],
        slant: f[7],
        rise: f[8],
        jitter: (f[9], f[10], f[11]),
        paths,
        edits,
        kind,
    })
}

/// The bytes [`decode`] reads back as `p`. For tests and tools; the app's
/// writer is `sfx.js`.
pub fn encode(p: &Params) -> Vec<u8> {
    let mut b = Vec::new();
    let flags = u32::from(p.vertical) | u32::from(p.join_bars) << 1 | u32::from(p.kern) << 2;
    for v in [flags, p.seed, p.kind.map_or(NO_KIND, |k| k as u32)] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    for v in [
        p.strength,
        p.flow.0,
        p.flow.1,
        p.flow.2,
        p.follow,
        p.gap,
        p.big_tighter,
        p.slant,
        p.rise,
        p.jitter.0,
        p.jitter.1,
        p.jitter.2,
    ] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&(p.paths.len() as u32).to_le_bytes());
    for q in &p.paths {
        for v in [q.a[0], q.a[1], q.b[0], q.b[1], q.bend] {
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    b.extend_from_slice(&(p.edits.len() as u32).to_le_bytes());
    for e in &p.edits {
        b.extend_from_slice(&e.group.to_le_bytes());
        b.extend_from_slice(&e.index.to_le_bytes());
        for v in [e.dx, e.dy, e.rot, e.scale] {
            b.extend_from_slice(&v.to_le_bytes());
        }
    }
    b
}
