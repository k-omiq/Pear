//! The params of `mt_sfx_place` as bytes: little-endian, read in this order.
//!
//! ```text
//! u32 flags: 1 vertical, 2 join long bars, 4 shape kerning,
//!     8 direction unset (the type's, and bit 1 is not read)
//! u32 seed
//! u32 kind: an index into KINDS, or 0xFFFF_FFFF for none
//! f64 power, rough, momentum (0..100, 50 is the type as designed),
//!     flow from, flow to, flow pow, follow, gap, big tighter,
//!     slant, rise, jitter turn, jitter size, jitter offset
//! u32 path count, then per path: f64 ax, ay, bx, by, bend   (ems)
//! u32 edit count, then per edit: u32 group, u32 index, f64 dx, dy, rot, scale
//! ```
//!
//! A box leaves most layout numbers unset (null in `style.sfx`), meaning "the
//! type's". Unset goes on the wire as NaN, and [`decode`] fills it in, one
//! number at a time, from the type ([`KINDS`]) moved by the three macros
//! ([`macros`]), or from [`PLAIN`] with no type. That way the type table and
//! what the macros do live here only: JS never copies a type's numbers, it
//! hands over what the box has and asks (`mt_sfx_resolve`) when it wants to
//! show what the layout will use.
//!
//! A number the box does set is used as it is: the macros move the type's
//! numbers, not the user's, as the reference's macros rewrite the fine
//! sliders from the type (`docs/giongo/04-reference-controls.md` 1.3).
//!
//! `src/lib/sfx.js` (through `text-engine/js/engine.mjs`) writes it. An
//! infinite number, a NaN where nothing can stand in (a path or an edit), a
//! kind past the table, more paths than groups can have, or bytes left over
//! is `BadSpec`.

use super::items::{MAX_GROUPS, MAX_ITEMS};
use super::kinds::{Kind, KINDS};
use super::path::Path;
use super::place::{Edit, Params};
use crate::Error;

pub const NO_KIND: u32 = u32::MAX;

/// Flag bits of the first word.
pub const VERTICAL: u32 = 1;
pub const JOIN_BARS: u32 = 2;
pub const KERN: u32 = 4;
/// The direction is unset: the type's (horizontal with no type).
pub const DIR_UNSET: u32 = 8;

/// The three macros, then the eleven layout numbers.
const MACROS: usize = 3;
const LAYOUT: usize = 11;

/// Where each macro sits when the box leaves it unset: the type as designed.
pub const MACRO_MID: f64 = 50.0;

/// The layout numbers with no type, in wire order (flow from, to, pow,
/// follow, gap, big tighter, slant, rise, jitter turn, size, offset): a plain
/// row of letters at the face's size, half turned with the path. The
/// big-letter tightening is not the type's to set, so this is its value with
/// a type too.
pub const PLAIN: [f64; LAYOUT] = [1.0, 1.0, 1.0, 0.5, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0];

/// The type's layout numbers in wire order.
fn kind_numbers(k: &Kind) -> [f64; LAYOUT] {
    [
        k.flow.0, k.flow.1, k.flow.2, k.follow, k.gap, PLAIN[5], k.slant, k.rise, k.jitter.0,
        k.jitter.1, k.jitter.2,
    ]
}

/// The type's numbers `n` (wire order) moved by the macros, each 0..100 with
/// 50 the type as designed. The amounts are the reference's, measured on its
/// Intensity panel (`docs/giongo/04-reference-controls.md` 1.3), with
/// `p`, `r`, `q` each -1..1:
///
/// - Power scales the size flow away from even: a run that grows starts
///   18 % smaller and ends 18 % bigger at full power, one that shrinks the
///   other way round; an even run has nothing to scale.
/// - Rough adds up to 8 degrees of turn jitter (never below none) and, upward
///   only, up to 0.2 of size jitter.
/// - Momentum adds up to 0.35 of follow (kept to 0..1), 12 degrees of slant
///   (the way the type leans; forward for a type that does not) and 3 of
///   rise.
pub fn macros(n: [f64; LAYOUT], power: f64, rough: f64, momentum: f64) -> [f64; LAYOUT] {
    let unit = |m: f64| (m.clamp(0.0, 100.0) - MACRO_MID) / MACRO_MID;
    let (p, r, q) = (unit(power), unit(rough), unit(momentum));
    let mut o = n;
    let (from, to) = (n[0], n[1]);
    if from < to {
        o[0] = from * (1.0 - 0.18 * p);
        o[1] = to * (1.0 + 0.18 * p);
    } else if from > to {
        o[0] = from * (1.0 + 0.18 * p);
        o[1] = to * (1.0 - 0.18 * p);
    }
    o[8] = (n[8] + 8.0 * r).max(0.0);
    o[9] = n[9] + 0.2 * r.max(0.0);
    o[3] = (n[3] + 0.35 * q).clamp(0.0, 1.0);
    let lean = if n[6] < 0.0 { -1.0 } else { 1.0 };
    o[6] = n[6] + 12.0 * q * lean;
    o[7] = n[7] + 3.0 * q;
    o
}

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

    /// A number the box may leave unset: NaN is unset (`None`), infinity is
    /// refused.
    fn f64_or_unset(&mut self) -> Result<Option<f64>, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_nan() {
            Ok(None)
        } else if v.is_finite() {
            Ok(Some(v))
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A number that must be there.
    fn f64(&mut self) -> Result<f64, Error> {
        self.f64_or_unset()?.ok_or(Error::BadSpec)
    }

    fn left(&self) -> usize {
        self.bytes.len() - self.at
    }
}

/// The params `bytes` say, every unset number filled in (see the top of the
/// file).
pub fn decode(bytes: &[u8]) -> Result<Params, Error> {
    let mut r = Reader { bytes, at: 0 };
    let flags = r.u32()?;
    let seed = r.u32()?;
    let kind = match r.u32()? {
        NO_KIND => None,
        k if (k as usize) < KINDS.len() => Some(k as usize),
        _ => return Err(Error::BadSpec),
    };
    let mut m = [MACRO_MID; MACROS];
    for v in &mut m {
        *v = r.f64_or_unset()?.unwrap_or(MACRO_MID);
    }
    let designed = kind.map_or(PLAIN, |k| kind_numbers(&KINDS[k]));
    let fallback = macros(designed, m[0], m[1], m[2]);
    let mut f = [0.0f64; LAYOUT];
    for (v, d) in f.iter_mut().zip(fallback) {
        *v = r.f64_or_unset()?.unwrap_or(d);
    }
    let vertical = if flags & DIR_UNSET != 0 {
        kind.is_some_and(|k| KINDS[k].vertical)
    } else {
        flags & VERTICAL != 0
    };
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
        vertical,
        join_bars: flags & JOIN_BARS != 0,
        kern: flags & KERN != 0,
        seed,
        flow: (f[0], f[1], f[2]),
        follow: f[3],
        gap: f[4],
        big_tighter: f[5],
        slant: f[6],
        rise: f[7],
        jitter: (f[8], f[9], f[10]),
        paths,
        edits,
        kind,
    })
}

/// The bytes [`decode`] reads back as `p`: every number set, the macros at
/// the middle. For tests and tools; the app's writer is `engine.mjs`.
pub fn encode(p: &Params) -> Vec<u8> {
    let mut b = Vec::new();
    let flags = (u32::from(p.vertical) * VERTICAL)
        | (u32::from(p.join_bars) * JOIN_BARS)
        | (u32::from(p.kern) * KERN);
    for v in [flags, p.seed, p.kind.map_or(NO_KIND, |k| k as u32)] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    for v in [MACRO_MID; MACROS] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    for v in resolved(p).into_iter().skip(1) {
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

/// The byte offset of number `i` of the fourteen (the macros first), for
/// tests that write one by hand.
pub const fn number_at(i: usize) -> usize {
    12 + 8 * i
}

/// The layout numbers `p` lays out with, as `mt_sfx_resolve` answers them:
/// vertical (1 or 0), flow from, to, pow, follow, gap, big tighter, slant,
/// rise, jitter turn, size, offset. The macros are in them already.
pub fn resolved(p: &Params) -> [f64; 12] {
    [
        f64::from(u8::from(p.vertical)),
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
    ]
}
