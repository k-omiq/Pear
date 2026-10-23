//! Where every letter of an SFX goes: each group spread along its path,
//! sized, turned and sheared, then kerned by its ink.
//!
//! Per group, in this order:
//!
//! 1. Every item's width in ems: its shaped advance (a long bar run is that
//!    many bars, a `!!` run is narrowed), or one em a letter in vertical text.
//! 2. Its size factor: `flow.from` at the first item to `flow.to` at the last,
//!    eased by `flow.pow`, times a seeded size jitter.
//! 3. The group's natural length: widths times sizes, plus the gap (ems of
//!    each letter, less where letters are big if `big_tighter` says so).
//! 4. The path: the box's own, or one made from the type's path shape (or a
//!    stack of plain ones) at the natural length. The run is stretched to
//!    fill it, so dragging a path's ends resizes the letters.
//! 5. Each letter at its share of the arc length, turned by `follow` times
//!    the path's angle plus a seeded jitter, pushed sideways by a seeded
//!    offset, then the user's own move, turn and scale on top.
//! 6. Its linear map: size, turn, then the shear (`slant` leans the
//!    verticals, `rise` lifts the horizontals), then the item's own frame (a
//!    bar stretched, a bar turned upright in vertical text).
//! 7. With `kern`, the shape kerning of [`super::kern`].
//!
//! Lengths: the wire's paths and edits are in ems of the face's size;
//! everything here is pixels, origin at the box's centre, y down. Angles on
//! the wire are degrees; rotations are radians, clockwise on the screen.

use core::f64::consts::{FRAC_PI_2, PI};
use std::collections::HashMap;

use super::items::{groups, Item, ItemKind};
use super::kern;
use super::kinds::KINDS;
use super::noise;
use super::path::{Path, Walker};
use crate::Error;

/// The text's own drawing, for the layout to measure.
pub trait Ink {
    /// The advance of `text` drawn as one run, pixels at the face's size.
    fn advance(&mut self, text: &str) -> Result<f64, Error>;
    /// The outline of `text` as the painter draws a curved run of it:
    /// centred on the origin, pixels at the face's size, y down. Closed
    /// contours.
    fn outline(&mut self, text: &str) -> Result<Vec<Vec<[f64; 2]>>, Error>;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Edit {
    pub group: u32,
    pub index: u32,
    /// Ems of the letter.
    pub dx: f64,
    pub dy: f64,
    /// Degrees.
    pub rot: f64,
    pub scale: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    pub vertical: bool,
    pub join_bars: bool,
    pub kern: bool,
    pub seed: u32,
    /// Size at the start, at the end, and the ease power.
    pub flow: (f64, f64, f64),
    pub follow: f64,
    /// Ems between letters.
    pub gap: f64,
    /// 0..1: letters bigger than the face sit tighter, smaller ones looser.
    pub big_tighter: f64,
    /// Degrees.
    pub slant: f64,
    pub rise: f64,
    /// Turn in degrees, size spread, sideways offset in ems.
    pub jitter: (f64, f64, f64),
    /// One per group, in ems; a group past the end gets a made one.
    pub paths: Vec<Path>,
    pub edits: Vec<Edit>,
    /// The type whose path shapes make the missing paths.
    pub kind: Option<usize>,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            vertical: false,
            join_bars: true,
            kern: true,
            seed: 1,
            flow: (1.0, 1.0, 1.0),
            follow: 0.5,
            gap: 0.0,
            big_tighter: 0.5,
            slant: 0.0,
            rise: 0.0,
            jitter: (0.0, 0.0, 0.0),
            paths: Vec::new(),
            edits: Vec::new(),
            kind: None,
        }
    }
}

/// A 2x2 linear map in canvas order: `x' = a x + c y`, `y' = b x + d y`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Lin(pub [f64; 4]);

impl Lin {
    pub const ID: Lin = Lin([1.0, 0.0, 0.0, 1.0]);

    pub fn rot(t: f64) -> Lin {
        let (s, c) = t.sin_cos();
        Lin([c, s, -s, c])
    }

    pub fn scale(x: f64, y: f64) -> Lin {
        Lin([x, 0.0, 0.0, y])
    }

    /// `self` after `first`.
    pub fn after(&self, first: &Lin) -> Lin {
        let [a, b, c, d] = self.0;
        let [p, q, r, s] = first.0;
        Lin([a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s])
    }

    pub fn apply(&self, v: [f64; 2]) -> [f64; 2] {
        let [a, b, c, d] = self.0;
        [a * v[0] + c * v[1], b * v[0] + d * v[1]]
    }

    /// The same map as the painter's curved run states it: turn, then lean,
    /// then scale (`rotate(rot) * skewX(skew) * scale(sx, sy)`). `None` when
    /// the map mirrors or flattens, which no layout here makes.
    pub fn decompose(&self) -> Option<(f64, f64, f64, f64)> {
        let [a, b, c, d] = self.0;
        let sx = a.hypot(b);
        if sx.is_nan() || sx <= 1e-12 {
            return None;
        }
        let (cos, sin) = (a / sx, b / sx);
        let r01 = cos * c + sin * d;
        let sy = -sin * c + cos * d;
        if sy.is_nan() || sy <= 1e-12 {
            return None;
        }
        Some((sin.atan2(cos), sx, sy, (-r01 / sy).atan()))
    }
}

/// One letter placed.
#[derive(Clone, Debug, PartialEq)]
pub struct Letter {
    /// The point the painter centres the run on.
    pub x: f64,
    pub y: f64,
    pub rot: f64,
    pub sx: f64,
    pub sy: f64,
    pub skew: f64,
    /// The text to draw, in UTF-16 units of the input.
    pub utf16: core::ops::Range<u32>,
    pub group: u32,
    /// The item's index in its group, spaces counted: the key of an edit.
    pub index: u32,
    /// Unit direction of the path at the letter: where a trail points from.
    pub dir: [f64; 2],
    /// The letter's em in pixels.
    pub em: f64,
    /// The drawn text's advance at the face's size, before the letter's
    /// own scale.
    pub adv: f64,
    /// Pixels per em of the letter's hand edit: its em before the edit's own
    /// scale, which is the em an edit's `dx` and `dy` are in. `em` is this
    /// times the edit's scale.
    pub unit: f64,
    /// The letter's ink box: the bounds of its outline in glyph space, their
    /// corners taken through the letter's whole map (size, turn, lean, the
    /// item's frame), pixels from the box's centre. Top left, top right,
    /// bottom right, bottom left of the glyph; a letter with no ink has its
    /// advance by the face's height instead.
    pub quad: [[f64; 2]; 4],
    /// The middle of `quad`, which the gizmo turns and scales the letter
    /// about.
    pub centre: [f64; 2],
    /// Glyph-centred pixels at the face's size to pixels from `x, y`, in
    /// canvas order (`x' = a x + c y`, `y' = b x + d y`): the map `rot`,
    /// `sx`, `sy` and `skew` state, kept whole for the outline export.
    pub map: [f64; 4],
    /// The text to draw, in bytes of the input.
    pub bytes: core::ops::Range<usize>,
    /// How much wider than at the face's size the letter's outlines are
    /// drawn: its area scale to the 0.4, so small letters do not get fat rims
    /// and big ones are not left with hairlines.
    pub pen: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    /// The path each group ran along, in ems: the box's own or the one made.
    pub paths: Vec<Path>,
    /// The letters' boxes together: x0, y0, x1, y1 in pixels.
    pub bounds: [f64; 4],
    pub letters: Vec<Letter>,
    /// For each code point of the text, the index of the letter that draws
    /// it, or -1: a letter's later code points (a voiced mark, the rest of a
    /// bar run, the second `!`), spaces, newlines and the `/` between groups
    /// draw nothing. JS keeps one layout entry per code point (`sfxLayout`)
    /// and reads this rather than matching offsets itself.
    pub cp: Vec<i32>,
}

type Contours = Vec<Vec<[f64; 2]>>;

/// An ink that asks for each drawn text's outline once: kerning and the
/// letters' ink boxes both read them.
struct Kept<'a, I: Ink> {
    ink: &'a mut I,
    outlines: HashMap<String, Contours>,
}

impl<I: Ink> Kept<'_, I> {
    fn contours(&mut self, text: &str) -> Result<&Contours, Error> {
        if !self.outlines.contains_key(text) {
            let c = self.ink.outline(text)?;
            self.outlines.insert(text.to_string(), c);
        }
        Ok(&self.outlines[text])
    }

    /// The bounds of `text`'s outline, x0, y0, x1, y1, or `None` with no ink.
    fn ink_box(&mut self, text: &str) -> Result<Option<[f64; 4]>, Error> {
        let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for p in self.contours(text)?.iter().flatten() {
            b = [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ];
        }
        Ok((b[0] <= b[2] && b[1] <= b[3]).then_some(b))
    }
}

impl<I: Ink> Ink for Kept<'_, I> {
    fn advance(&mut self, text: &str) -> Result<f64, Error> {
        self.ink.advance(text)
    }

    fn outline(&mut self, text: &str) -> Result<Contours, Error> {
        self.contours(text).cloned()
    }
}

/// A letter on its way out: where it is and its map, before the painter's
/// numbers are taken from them.
pub(crate) struct Work {
    pub item: Item,
    pub group: u32,
    pub index: u32,
    pub centre: [f64; 2],
    /// Turn and size of the letter; the shear and the item's frame follow.
    pub rot: f64,
    pub k: f64,
    /// The item's own frame (bar stretch, vertical turn) and its offset in
    /// it, pixels at the face's size.
    pub frame: Lin,
    pub nudge: [f64; 2],
    /// Its drawn text's advance at the face's size, for the bounds.
    pub drawn: f64,
    pub dir: [f64; 2],
    /// The user's hand edit, put on after kerning, so it moves this letter
    /// and no other.
    pub edit: Option<Edit>,
    /// Size relative to the face, for the gap.
    pub rel: f64,
}

impl Work {
    /// Glyph-centred pixels at the face's size to the box.
    pub fn map(&self, shear: &Lin) -> Lin {
        Lin::scale(self.k, self.k)
            .after(&Lin::rot(self.rot))
            .after(shear)
            .after(&self.frame)
    }

    /// A point of the letter's outline (glyph-centred pixels at the face's
    /// size) in the box.
    pub fn place(&self, shear: &Lin, p: [f64; 2]) -> [f64; 2] {
        let m = self.map(shear);
        let q = m.apply([p[0] + self.nudge[0], p[1] + self.nudge[1]]);
        [self.centre[0] + q[0], self.centre[1] + q[1]]
    }
}

/// A Gaussian number for one channel of one letter, from the seed.
fn gauss(seed: u32, group: u32, index: u32, channel: u32) -> f64 {
    let u =
        |c: u32| ((noise(seed, group as usize, index as usize, c) + 1.0) / 2.0).clamp(1e-9, 1.0);
    let (u1, u2) = (u(channel * 2), u(channel * 2 + 1));
    (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos()
}

/// Ems a gap shrinks by where letters are `rel` times the face.
pub(crate) fn tighter(big_tighter: f64, rel: f64) -> f64 {
    (-0.5 * big_tighter * rel.max(0.05).ln()).clamp(-0.45, 0.6)
}

/// An angle folded into `(-PI, PI]`.
fn wrap(a: f64) -> f64 {
    let t = (a + PI).rem_euclid(2.0 * PI) - PI;
    if t <= -PI {
        t + 2.0 * PI
    } else {
        t
    }
}

pub(crate) fn shear(p: &Params) -> Lin {
    let ts = p.slant.clamp(-45.0, 45.0).to_radians().tan();
    let tr = p.rise.clamp(-30.0, 30.0).to_radians().tan();
    // Leaning the verticals moves a point's x by its height; lifting the
    // horizontals moves its y by its x. Up is negative y.
    Lin([1.0, -tr, -ts, 1.0])
}

fn finite(p: &Params, size: f64) -> bool {
    let nums = [
        size,
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
    ];
    nums.iter().all(|v| v.is_finite())
        && p.paths.iter().all(|q| {
            [q.a[0], q.a[1], q.b[0], q.b[1], q.bend]
                .iter()
                .all(|v| v.is_finite())
        })
        && p.edits
            .iter()
            .all(|e| [e.dx, e.dy, e.rot, e.scale].iter().all(|v| v.is_finite()))
}

/// The made path of group `g` of `count`, `len` ems long.
fn made_path(p: &Params, g: usize, count: usize, len: f64) -> Path {
    let base = if p.vertical { 90.0 } else { 0.0 };
    let off = (g as f64 - (count as f64 - 1.0) / 2.0) * 1.6;
    let stacked = if p.vertical { [-off, 0.0] } else { [0.0, off] };
    let kind = p.kind.and_then(|k| KINDS.get(k));
    let (centre, angle, bend) = match kind {
        Some(k) => {
            let kind_base = if k.vertical { 90.0 } else { 0.0 };
            match k.paths.get(g) {
                Some(s) if count <= k.paths.len() => {
                    ([s.dx, s.dy], base + (s.angle - kind_base), s.bend)
                }
                _ => {
                    let first = k.paths.first().map_or(kind_base, |s| s.angle);
                    (stacked, base + (first - kind_base), 0.0)
                }
            }
        }
        None => (stacked, base, 0.0),
    };
    let (sin, cos) = angle.to_radians().sin_cos();
    let h = len / 2.0;
    Path {
        a: [centre[0] - cos * h, centre[1] - sin * h],
        b: [centre[0] + cos * h, centre[1] + sin * h],
        bend,
    }
}

/// Lays out `text` at a face of `size` pixels. A text with no letters is
/// an empty layout. A number that is not finite, a text past the item limit,
/// or a map that would mirror a letter is `BadSpec`.
pub fn place(text: &str, size: f64, p: &Params, ink: &mut impl Ink) -> Result<Layout, Error> {
    if !finite(p, size) || size <= 0.0 {
        return Err(Error::BadSpec);
    }
    let ink = &mut Kept {
        ink,
        outlines: HashMap::new(),
    };
    let groups = groups(text, p.join_bars).ok_or(Error::BadSpec)?;
    let (from, to) = (p.flow.0, p.flow.1);
    let pow = p.flow.2.clamp(0.2, 5.0);
    let (jrot, jsize, joff) = p.jitter;
    let shear = shear(p);
    let bar_adv = if groups
        .iter()
        .flatten()
        .any(|i| matches!(i.kind, ItemKind::Bar(_)))
        && !p.vertical
    {
        ink.advance("ー")?
    } else {
        0.0
    };

    let mut works: Vec<Work> = Vec::new();
    let mut paths = Vec::with_capacity(groups.len());
    let mut spans: Vec<core::ops::Range<usize>> = Vec::with_capacity(groups.len());
    for (g, items) in groups.iter().enumerate() {
        let n = items.len();
        let mut width = Vec::with_capacity(n);
        let mut drawn = Vec::with_capacity(n);
        let mut frame = Vec::with_capacity(n);
        for it in items {
            let t = it.text(text);
            let (w, d, f) = match (it.kind, p.vertical) {
                (ItemKind::Space, _) => (0.45, 0.0, Lin::ID),
                (ItemKind::Bar(k), false) => (
                    k as f64 * bar_adv / size,
                    bar_adv,
                    Lin::scale(k as f64, 1.0),
                ),
                (ItemKind::Bar(k), true) => {
                    let a = ink.advance(t)?;
                    (
                        k as f64,
                        a,
                        Lin::scale(1.0, k as f64).after(&Lin::rot(FRAC_PI_2)),
                    )
                }
                (ItemKind::Punct(k), false) => {
                    let a = ink.advance(t)?;
                    let narrow = if k >= 2 { 0.7 } else { 1.0 };
                    (a * narrow / size, a, Lin::scale(narrow, 1.0))
                }
                (ItemKind::Punct(_), true) => {
                    let a = ink.advance(t)?;
                    let fit = if a > 0.0 {
                        (0.9 * size / a).min(1.0)
                    } else {
                        1.0
                    };
                    (1.0, a, Lin::scale(fit, 1.0))
                }
                (ItemKind::Letter, false) => {
                    let a = ink.advance(t)?;
                    (a / size, a, Lin::ID)
                }
                (ItemKind::Letter, true) => {
                    let a = ink.advance(t)?;
                    let f = if it.turns_upright(text) {
                        Lin::rot(FRAC_PI_2)
                    } else {
                        Lin::ID
                    };
                    (1.0, a, f)
                }
            };
            width.push(w);
            drawn.push(d);
            frame.push(f);
        }
        let factor: Vec<f64> = (0..n)
            .map(|j| {
                let t = if n > 1 {
                    j as f64 / (n - 1) as f64
                } else {
                    0.5
                };
                let f = from + (to - from) * t.powf(pow);
                let spread = (jsize * gauss(p.seed, g as u32, j as u32, 0) * 0.5).exp();
                (f * spread).clamp(0.1, 8.0)
            })
            .collect();
        let gap = |j: usize| {
            if j + 1 >= n {
                return 0.0;
            }
            let rel = (factor[j] * factor[j + 1]).sqrt();
            (p.gap + tighter(p.big_tighter, rel)) * factor[j]
        };
        let natural: f64 = (0..n).map(|j| width[j] * factor[j] + gap(j)).sum();
        let path_em = match p.paths.get(g) {
            Some(q) => *q,
            None => made_path(p, g, groups.len(), natural),
        };
        paths.push(path_em);
        let walker = Walker::new(path_em.scaled(size));
        // Pixels per em: the run fills the path. A path with no length keeps
        // the face's size and runs from its start along the base direction.
        let (unit, flat) = if walker.len() > 1e-6 * size && natural > 1e-9 {
            (walker.len() / natural, false)
        } else {
            (size, true)
        };
        let base = if p.vertical { FRAC_PI_2 } else { 0.0 };
        let start = works.len();
        let mut along = 0.0;
        for (j, it) in items.iter().enumerate() {
            let em = factor[j] * unit;
            let half = width[j] * em / 2.0;
            let at = along + half;
            along += width[j] * em + gap(j) * unit;
            if it.kind == ItemKind::Space {
                continue;
            }
            let (pt, dir) = if flat {
                let d = [base.cos(), base.sin()];
                let a = path_em.a;
                ([a[0] * size + d[0] * at, a[1] * size + d[1] * at], d)
            } else {
                walker.at(at)
            };
            let phi = dir[1].atan2(dir[0]);
            let (gi, ji) = (g as u32, j as u32);
            let rot = p.follow.clamp(0.0, 1.0) * wrap(phi - base)
                + (jrot * gauss(p.seed, gi, ji, 1) * 0.6).to_radians();
            let push = joff * gauss(p.seed, gi, ji, 2) * 0.3 * em;
            let centre = [pt[0] - dir[1] * push, pt[1] + dir[0] * push];
            let k = em / size;
            let edit = p
                .edits
                .iter()
                .find(|e| e.group == gi && e.index == ji)
                .copied();
            let nudge = if p.vertical && it.is_small_kana(text) {
                [0.12 * size, -0.2 * size]
            } else {
                [0.0, 0.0]
            };
            works.push(Work {
                item: it.clone(),
                group: gi,
                index: ji,
                centre,
                rot,
                k,
                frame: frame[j],
                nudge,
                drawn: drawn[j],
                dir,
                edit,
                rel: factor[j],
            });
        }
        spans.push(start..works.len());
    }

    if p.kern {
        for span in &spans {
            kern::group(&mut works[span.clone()], text, size, p, &shear, ink)?;
        }
    }
    // The hand edits, in ems of the letter as it was laid out and kerned.
    let mut units = Vec::with_capacity(works.len());
    for w in works.iter_mut() {
        units.push(w.k * size);
        if let Some(e) = w.edit {
            let em = w.k * size;
            w.centre[0] += e.dx * em;
            w.centre[1] += e.dy * em;
            w.rot += e.rot.to_radians();
            w.k *= e.scale.clamp(0.05, 20.0);
        }
    }

    let mut letters = Vec::with_capacity(works.len());
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (w, &unit) in works.iter().zip(&units) {
        let m = w.map(&shear);
        let (rot, sx, sy, skew) = m.decompose().ok_or(Error::BadSpec)?;
        let at = w.place(&shear, [0.0, 0.0]);
        let (hw, hh) = (w.drawn / 2.0, size / 2.0);
        for c in [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] {
            let q = w.place(&shear, c);
            x0 = x0.min(q[0]);
            y0 = y0.min(q[1]);
            x1 = x1.max(q[0]);
            y1 = y1.max(q[1]);
        }
        // The outline is drawn centred on `at` and mapped by `m` (the
        // painter's curved run), so a glyph-space corner lands at `at + m c`.
        let [gx0, gy0, gx1, gy1] = ink
            .ink_box(w.item.text(text))?
            .unwrap_or([-hw, -hh, hw, hh]);
        let quad = [[gx0, gy0], [gx1, gy0], [gx1, gy1], [gx0, gy1]].map(|c| {
            let q = m.apply(c);
            [at[0] + q[0], at[1] + q[1]]
        });
        let centre = [
            (quad[0][0] + quad[2][0]) / 2.0,
            (quad[0][1] + quad[2][1]) / 2.0,
        ];
        letters.push(Letter {
            x: at[0],
            y: at[1],
            rot,
            sx,
            sy,
            skew,
            utf16: w.item.utf16.clone(),
            group: w.group,
            index: w.index,
            dir: w.dir,
            em: w.k * size,
            adv: w.drawn,
            unit,
            quad,
            centre,
            map: m.0,
            bytes: w.item.bytes.clone(),
            pen: (sx * sy).abs().sqrt().powf(0.4).clamp(0.01, 100.0),
        });
    }
    let bounds = if letters.is_empty() {
        [0.0; 4]
    } else {
        [x0, y0, x1, y1]
    };
    let sound = letters.iter().all(|l| {
        [l.x, l.y, l.rot, l.sx, l.sy, l.skew, l.em, l.unit]
            .iter()
            .chain(l.quad.iter().flatten())
            .all(|v| v.is_finite())
    }) && bounds.iter().all(|v| v.is_finite());
    if !sound {
        return Err(Error::BadSpec);
    }
    let cp = code_points(text, &letters);
    Ok(Layout {
        paths,
        bounds,
        letters,
        cp,
    })
}

/// [`Layout::cp`]: a letter draws the code point its text starts at.
fn code_points(text: &str, letters: &[Letter]) -> Vec<i32> {
    let mut starts: Vec<(u32, i32)> = letters
        .iter()
        .enumerate()
        .map(|(i, l)| (l.utf16.start, i as i32))
        .collect();
    starts.sort_unstable();
    let mut out = Vec::with_capacity(text.len());
    let mut u = 0u32;
    for c in text.chars() {
        let at = starts.binary_search_by_key(&u, |s| s.0);
        out.push(at.map_or(-1, |i| starts[i].1));
        u += c.len_utf16() as u32;
    }
    out
}

/// The outline of letter `index` of `text`'s layout, as the painter draws
/// it: closed contours, holes included, pixels from the box's centre. For
/// the gizmo's picked letter (`mt_sfx_outline`). A letter past the layout
/// is `BadSpec`.
pub fn letter_outline(
    text: &str,
    size: f64,
    p: &Params,
    ink: &mut impl Ink,
    index: usize,
) -> Result<Contours, Error> {
    let layout = place(text, size, p, ink)?;
    let l = layout.letters.get(index).ok_or(Error::BadSpec)?;
    let m = Lin(l.map);
    let mut c = ink.outline(&text[l.bytes.clone()])?;
    for q in c.iter_mut().flatten() {
        let v = m.apply(*q);
        *q = [l.x + v[0], l.y + v[1]];
    }
    Ok(c)
}
