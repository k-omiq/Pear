//! Special effects (plan 8): seeded generators that turn a handful of
//! numbers into shapes, so only the numbers cross the wire.
//!
//! - **Crack** cuts branching, tapering, jagged lines out of the letters,
//!   grown from seeded points; past 60 % the pieces between two arms near a
//!   point fall out. With Break off (wire v16, B5 shatter test) the pieces
//!   between neighbouring arms break loose, densest cracks first, and move
//!   apart or fall (`BreakOff`): `paint_letters` lays each as a copy of the
//!   letters inside its outline, moved, and leaves a clean hole.
//! - **Scratches** cut many thin, near-parallel strokes.
//! - **Splash** is paint: spiky splats, teardrop droplets and streaks in
//!   its own colour, laid on the letters' fill by the box job
//!   (`Effect::Paint`), so nothing goes past the fill.
//! - **Lightning** is paint too: jagged bolts of straight segments with
//!   forks, a bright core in a coloured glow, on the letters' fill.
//!
//! Every pattern is drawn over the whole box (the letters' ink as one, or
//! the box itself for a bolt), never restarted per letter, and from the
//! seed alone: the same numbers give the same shapes on every build, in the
//! editor and in the file (`crate::seeded::noise`). Lengths are shares of
//! the job's font size, so a pattern scales with its letters.

use std::f64::consts::{PI, TAU};
use std::rc::Rc;

use super::boxjob::ClipShape;
use super::fx::effects::PaintMark;
use super::geom::{Affine, Polys, Pt};
use super::job::Rgba;
use super::kept::{self, Hasher};
use crate::seeded::noise;
use crate::Error;

/// Largest share of the font size a Size control reaches.
pub const MAX_SPECIAL_SIZE: f64 = 4.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crack {
    /// 0 to 1: how many cracks, how long, and past 0.6 how much falls out.
    pub amount: f64,
    /// A share of the font size: the length and width of the arms.
    pub size: f64,
    /// Where the cracks gather: shares of the letters' ink box (0 to 1
    /// each way).
    pub at: (f64, f64),
    /// 0 to 1: how far from `at` they spread. 1 spreads them over all the
    /// letters, as one crack per stretch of them; less pulls them in to
    /// `at`, fewer as the area shrinks.
    pub spread: f64,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lightning {
    /// 0 to 1: how many bolts and forks.
    pub amount: f64,
    /// The bolt's bright core.
    pub core: Rgba,
    /// The glow round it, and the bolt's body.
    pub glow: Rgba,
    /// 0 to 3 times the default glow.
    pub glow_size: f64,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Splash {
    /// 0 to 1: how many splats, droplets and streaks.
    pub amount: f64,
    /// A share of the font size: how big a splat is.
    pub size: f64,
    /// The paint's colour.
    pub color: Rgba,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scratches {
    /// 0 to 1: how many scratches.
    pub amount: f64,
    /// Radians: the way they run, 0 along the line.
    pub angle: f64,
    pub seed: u32,
}

/// How a crack's broken-off pieces move (B5 test: the owner picks one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    /// A little out from the focus, turned a few degrees, close to the
    /// letters.
    Apart,
    /// Down below the letters, farther the bigger the piece, turning as it
    /// goes; a few small ones are gone.
    Fall,
}

/// A crack's pieces breaking off (glyph wire v16, kind 16).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BreakOff {
    /// Over 0 to 1: how many of the pieces between two arms break loose
    /// (the densest cracks' first) and how deep into the arms they reach.
    pub share: f64,
    pub motion: Motion,
}

/// The farthest a piece moves sideways or up, in font sizes; falling, down,
/// the box's height and `BREAK_DROP` font sizes more (special.js
/// `breakReach` pads the paint by as much).
pub const BREAK_SIDE: f64 = 0.35;
pub const BREAK_DROP: f64 = 1.0;

/// The special effects of a box (glyph wire v15). Every job of the box
/// carries them, so a shadow is cast from the cracked letters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Special {
    /// The box in job space: its corner, width and height. A bolt crosses
    /// it.
    pub rect: [f64; 4],
    pub crack: Option<Crack>,
    /// The crack's pieces breaking off (v16); only with a crack.
    pub break_off: Option<BreakOff>,
    pub lightning: Option<Lightning>,
    pub splash: Option<Splash>,
    pub scratches: Option<Scratches>,
}

impl Special {
    /// Whether any effect changes the letters' shapes (Crack, Scratches).
    pub fn shapes_letters(&self) -> bool {
        self.crack.is_some() || self.scratches.is_some()
    }
}

/// What the letters' generators make, in job space: shapes cut out of every
/// pass. Nothing is added to them now (`adds` stays empty).
#[derive(Debug, Default)]
pub struct Shapes {
    pub cuts: Polys,
    pub adds: Polys,
    /// The crack's broken-off pieces, in the order they are laid: a later
    /// one never takes what an earlier one took.
    pub pieces: Vec<Piece>,
}

/// One broken-off piece: its outline in job space, where it was, and the
/// rigid move that takes it to where it lies (job space), or `None` for one
/// that is gone.
#[derive(Debug)]
pub struct Piece {
    pub outline: Vec<Pt>,
    pub moved: Option<Affine>,
}

// ===== seeded numbers =====

/// One generator's numbers: a stream of `noise` per seed.
#[derive(Clone, Copy)]
struct Dice {
    seed: u32,
    stream: usize,
}

impl Dice {
    /// In [-1, 1].
    fn pm(&self, item: usize, ch: u32) -> f64 {
        noise(self.seed, self.stream, item, ch)
    }
    /// In [0, 1].
    fn u(&self, item: usize, ch: u32) -> f64 {
        (self.pm(item, ch) + 1.0) * 0.5
    }
    /// -1 or 1.
    fn sign(&self, item: usize, ch: u32) -> f64 {
        if self.pm(item, ch) < 0.0 {
            -1.0
        } else {
            1.0
        }
    }
}

// ===== shapes =====

/// Pushes `pts` as one closed contour, wound one way (positive area), so
/// shapes that overlap add up under the non-zero rule.
fn contour(out: &mut Polys, pts: &[Pt]) {
    if pts.len() < 3 {
        return;
    }
    let mut a = 0.0;
    for i in 0..pts.len() {
        a += pts[i].cross(pts[(i + 1) % pts.len()]);
    }
    if !(a.abs() > 1e-12) {
        return;
    }
    if a > 0.0 {
        pts.iter().for_each(|&p| out.push(p));
    } else {
        pts.iter().rev().for_each(|&p| out.push(p));
    }
    out.close();
}

/// A polyline as a ribbon `width(t)` wide, `t` 0 at its start and 1 at its
/// end: its left side out, its right side back.
fn ribbon(pts: &[Pt], width: impl Fn(f64) -> f64) -> Vec<Pt> {
    let n = pts.len();
    if n < 2 {
        return Vec::new();
    }
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let a = pts[i.saturating_sub(1)];
        let b = pts[(i + 1).min(n - 1)];
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let len = dx.hypot(dy);
        let (nx, ny) = if len > 0.0 { (-dy / len, dx / len) } else { (0.0, 0.0) };
        let h = width(i as f64 / (n - 1) as f64).max(0.0) / 2.0;
        left.push(Pt::new(pts[i].x + nx * h, pts[i].y + ny * h));
        right.push(Pt::new(pts[i].x - nx * h, pts[i].y - ny * h));
    }
    right.reverse();
    left.extend(right);
    left
}

/// A jagged walk from `from`, heading `angle`, `steps` steps of `step`,
/// turning by up to `turn` radians a step.
fn walk(from: Pt, angle: f64, step: f64, steps: usize, turn: f64, dice: Dice, item: usize) -> Vec<Pt> {
    let mut pts = Vec::with_capacity(steps + 1);
    pts.push(from);
    let (mut p, mut a) = (from, angle);
    for s in 0..steps {
        a += turn * dice.pm(item, 200 + s as u32);
        let len = step * (0.6 + 0.8 * dice.u(item, 300 + s as u32));
        p = Pt::new(p.x + a.cos() * len, p.y + a.sin() * len);
        pts.push(p);
    }
    pts
}

// ===== the letters' shapes =====

/// The cuts and adds of `sp` for letters whose ink (job space, unbent) is
/// `ink`, at font size `size`. Kept under its numbers, so a move or an edit
/// of anything else reads them back.
pub fn letter_shapes(sp: &Special, size: f64, ink: (f64, f64, f64, f64)) -> Result<Rc<Shapes>, Error> {
    let mut key = Hasher::new("special shapes")
        .debug(&(sp.crack, sp.scratches))
        .f64(size)
        .f64(ink.0)
        .f64(ink.1)
        .f64(ink.2)
        .f64(ink.3);
    // Pieces fall by the box's height.
    if let Some(b) = sp.break_off {
        key = key.debug(&b).f64(sp.rect[3]);
    }
    let key = key.finish();
    if let Some(hit) = key.and_then(kept::get::<Rc<Shapes>>) {
        return Ok(Rc::clone(&*hit));
    }
    let mut out = Shapes::default();
    if let Some(c) = sp.crack {
        let mut stars = Vec::new();
        let want = sp.break_off.filter(|b| b.share > 0.0);
        crack(&c, size, ink, &mut out.cuts, want.map(|_| &mut stars));
        if let Some(b) = want {
            out.pieces = pieces(&c, &b, &stars, size, ink, sp.rect[3]);
        }
    }
    if let Some(s) = sp.scratches {
        scratches(&s, size, ink, &mut out.cuts);
    }
    super::budget::check()?;
    let out = Rc::new(out);
    if let Some(k) = key {
        let outlines: usize = out.pieces.iter().map(|p| p.outline.len()).sum();
        let bytes = (out.cuts.pts.len() + out.adds.pts.len() + outlines) * 16;
        kept::put(k, Rc::clone(&out), bytes);
    }
    Ok(out)
}

/// One crack point and its arms, for the pieces between them.
type Star = (Pt, Vec<Vec<Pt>>);

fn crack(
    c: &Crack,
    size: f64,
    (x0, y0, x1, y1): (f64, f64, f64, f64),
    cuts: &mut Polys,
    mut stars: Option<&mut Vec<Star>>,
) {
    let a = c.amount.clamp(0.0, 1.0);
    let u = size * c.size.clamp(0.01, MAX_SPECIAL_SIZE);
    if !(a > 0.0) || !(u > 0.0) {
        return;
    }
    let dice = Dice { seed: c.seed, stream: 1 };
    let (w, h) = (x1 - x0, y1 - y0);
    let spread = c.spread.clamp(0.0, 1.0);
    let focus = Pt::new(x0 + c.at.0.clamp(0.0, 1.0) * w, y0 + c.at.1.clamp(0.0, 1.0) * h);
    let points = (1.0 + a * (w * h * spread * spread) / (u * u) * 0.6).round().clamp(1.0, 24.0) as usize;
    // Past 60 % the pieces between two arms start to fall out.
    let fall = ((a - 0.6) / 0.4).clamp(0.0, 1.0);
    let step = u * 0.08;
    let mut item = 0usize;
    for i in 0..points {
        // Spread along the letters, one point to each equal stretch, then
        // pulled in to the focus by the spread.
        let even = Pt::new(x0 + (i as f64 + dice.u(i, 0)) / points as f64 * w, y0 + dice.u(i, 1) * h);
        let centre = Pt::new(focus.x + (even.x - focus.x) * spread, focus.y + (even.y - focus.y) * spread);
        let arms = 3 + (dice.u(i, 2) * 3.0) as usize + (a * 2.0) as usize;
        let turn0 = dice.u(i, 3) * std::f64::consts::TAU;
        let width0 = u * (0.03 + 0.04 * a);
        let mut paths: Vec<Vec<Pt>> = Vec::with_capacity(arms);
        for j in 0..arms {
            item += 1;
            let dir = turn0 + j as f64 * std::f64::consts::TAU / arms as f64
                + dice.pm(item, 0) * 0.45 * std::f64::consts::PI / arms as f64;
            let len = u * (0.5 + 1.1 * a) * (0.7 + 0.6 * dice.u(item, 1));
            let steps = ((len / step).ceil() as usize).clamp(3, 40);
            let arm = walk(centre, dir, step, steps, 0.5, dice, item);
            contour(cuts, &ribbon(&arm, |t| width0 * (1.0 - t).powf(0.8)));
            // Side branches off the arm, thinner and shorter, each a crack
            // of its own.
            for (s, &at) in arm.iter().enumerate().skip(2).take(steps.saturating_sub(3)) {
                if dice.u(item, 500 + s as u32) > 0.12 + 0.2 * a {
                    continue;
                }
                item += 1;
                let side = if dice.pm(item, 0) < 0.0 { -1.0 } else { 1.0 };
                let heading = {
                    let p = arm[s - 1];
                    (at.y - p.y).atan2(at.x - p.x)
                };
                let bsteps = ((steps - s) / 2).max(2);
                let branch = walk(at, heading + side * (0.5 + 0.5 * dice.u(item, 1)), step, bsteps, 0.5, dice, item);
                let bw = width0 * (1.0 - s as f64 / steps as f64).powf(0.8) * 0.6;
                contour(cuts, &ribbon(&branch, |t| bw * (1.0 - t)));
            }
            paths.push(arm);
        }
        // The pieces that fall: between two neighbouring arms, from the
        // point out to a jagged edge.
        if fall > 0.0 {
            for j in 0..arms {
                item += 1;
                if dice.u(item, 0) > fall * 0.6 {
                    continue;
                }
                // A chip near the point: from a little way out to a little
                // further, so what falls is a piece, not the letter.
                let (p, q) = (&paths[j], &paths[(j + 1) % arms]);
                let most = p.len().min(q.len()) - 1;
                let k = ((most as f64 * (0.12 + 0.2 * fall * dice.u(item, 1))).round() as usize).clamp(1, most);
                let k0 = (k / 3).min(k - 1);
                let mut piece: Vec<Pt> = p[k0..=k].to_vec();
                let (pe, qe) = (p[k], q[k]);
                for t in [1.0 / 3.0, 2.0 / 3.0] {
                    let m = Pt::new(pe.x + (qe.x - pe.x) * t, pe.y + (qe.y - pe.y) * t);
                    let j2 = step * 0.6 * dice.pm(item, (t * 3.0) as u32 + 2);
                    piece.push(Pt::new(m.x + j2, m.y - j2));
                }
                piece.extend(q[k0.max(1)..=k].iter().rev());
                if k0 == 0 {
                    piece.push(p[0]);
                }
                contour(cuts, &piece);
            }
        }
        if let Some(st) = stars.as_mut() {
            st.push((centre, paths));
        }
    }
}

/// The pieces of a crack that break off (`BreakOff`), from its points and
/// arms (`stars`), so what breaks off is what is seen cracked: each piece
/// lies between two neighbouring arms of a point, from the point out along
/// them and closed by a jagged break. The densest cracks break first. On a
/// stream of its own, so the cracks are the same whatever breaks.
fn pieces(c: &Crack, b: &BreakOff, stars: &[Star], size: f64, ink: (f64, f64, f64, f64), box_h: f64) -> Vec<Piece> {
    let share = b.share.clamp(0.0, 1.0);
    let u = size * c.size.clamp(0.01, MAX_SPECIAL_SIZE);
    if !(share > 0.0) || !(u > 0.0) || stars.is_empty() {
        return Vec::new();
    }
    let dice = Dice { seed: c.seed, stream: 3 };
    let (w, h) = (ink.2 - ink.0, ink.3 - ink.1);
    let focus = Pt::new(ink.0 + c.at.0.clamp(0.0, 1.0) * w, ink.1 + c.at.1.clamp(0.0, 1.0) * h);
    // How crowded each point is: its neighbours within about an arm, and
    // how near the focus, where Focus and Spread gather the cracks.
    let diag = w.hypot(h).max(u);
    let crowd: Vec<f64> = stars
        .iter()
        .map(|(p, _)| {
            let near: f64 = stars.iter().map(|(q, _)| (-(p.minus(*q).len() / u).powi(2)).exp()).sum();
            near + 2.0 * (1.0 - p.minus(focus).len() / diag).max(0.0)
        })
        .collect();
    let mut wedges: Vec<(f64, usize, usize)> = Vec::new();
    for (i, (_, arms)) in stars.iter().enumerate() {
        for j in 0..arms.len() {
            wedges.push((crowd[i] + 0.35 * dice.u(i * 16 + j, 0), i, j));
        }
    }
    wedges.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let n = ((share * wedges.len() as f64).round() as usize).clamp(1, wedges.len().min(48));
    let step = u * 0.08;
    let side = BREAK_SIDE * size;
    let (up, down) = match b.motion {
        Motion::Apart => (side, side),
        Motion::Fall => (side, box_h.max(0.0) + BREAK_DROP * size),
    };
    let mut out = Vec::with_capacity(n);
    for &(_, i, j) in &wedges[..n] {
        let (centre, arms) = &stars[i];
        let (p, q) = (&arms[j], &arms[(j + 1) % arms.len()]);
        let most = p.len().min(q.len()).saturating_sub(1);
        if most < 1 {
            continue;
        }
        let item = i * 16 + j;
        let depth = 0.5 + 0.45 * share * dice.u(item, 1);
        let k = ((most as f64 * depth).round() as usize).clamp(1, most);
        let mut outline: Vec<Pt> = p[..=k].to_vec();
        let (pe, qe) = (p[k], q[k]);
        for (e, t) in [0.25, 0.5, 0.75].into_iter().enumerate() {
            let m = Pt::new(pe.x + (qe.x - pe.x) * t, pe.y + (qe.y - pe.y) * t);
            let j2 = step * 0.7 * dice.pm(item, 2 + e as u32);
            outline.push(Pt::new(m.x + j2, m.y - j2));
        }
        outline.extend(q[1..=k].iter().rev());
        // Its middle and how big it is.
        let (mut a2, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for t in 0..outline.len() {
            let (s, e) = (outline[t], outline[(t + 1) % outline.len()]);
            let x = s.cross(e);
            a2 += x;
            cx += (s.x + e.x) * x;
            cy += (s.y + e.y) * x;
        }
        if !(a2.abs() > 1e-9) {
            continue;
        }
        let mid = Pt::new(cx / (3.0 * a2), cy / (3.0 * a2));
        // Wound one way, so outlines laid together add up (non-zero).
        if a2 < 0.0 {
            outline.reverse();
        }
        let r = (a2.abs() / 2.0 / PI).sqrt();
        let away = {
            let d = mid.minus(focus);
            let d = if d.len() > 1e-6 { d } else { mid.minus(*centre) };
            if d.len() > 1e-6 {
                d.scale(1.0 / d.len())
            } else {
                let a = dice.u(item, 5) * TAU;
                Pt::new(a.cos(), a.sin())
            }
        };
        let (shift, turn) = match b.motion {
            Motion::Apart => {
                let len = size * (0.04 + 0.06 * share) * (0.7 + 0.6 * dice.u(item, 6));
                let deg = (2.0 + 5.0 * share) * dice.pm(item, 7);
                (away.scale(len), deg)
            }
            Motion::Fall => {
                // Gone: a few of the small ones.
                if r < 0.15 * size && dice.u(item, 8) < 0.35 {
                    out.push(Piece { outline, moved: None });
                    continue;
                }
                let drop = (ink.3 - mid.y) + r * (1.0 + 1.5 * share) * (0.8 + 0.4 * dice.u(item, 6)) + 0.1 * size;
                let dx = away.x * size * 0.12 * dice.u(item, 9);
                let deg = dice.sign(item, 7) * (10.0 + 40.0 * share) * (0.5 + 0.5 * dice.u(item, 10))
                    * (0.3 * size / r.max(1e-6)).min(1.0);
                (Pt::new(dx, drop), deg)
            }
        };
        // Never farther than the paint is padded for (`BREAK_SIDE`,
        // `BREAK_DROP`): shrink the move until every corner is within.
        let rigid = |k: f64| {
            let a = turn * k * PI / 180.0;
            Affine::translate(mid.x + shift.x * k, mid.y + shift.y * k)
                .after(&Affine::rotate(a.cos(), a.sin()))
                .after(&Affine::translate(-mid.x, -mid.y))
        };
        let within = |m: &Affine| {
            outline.iter().all(|&v| {
                let d = m.apply(v).minus(v);
                d.x.abs() <= side && d.y >= -up && d.y <= down
            })
        };
        let mut k = 1.0;
        let mut moved = rigid(k);
        while !within(&moved) && k > 1e-3 {
            k *= 0.8;
            moved = rigid(k);
        }
        if !within(&moved) {
            moved = Affine::IDENTITY;
        }
        out.push(Piece { outline, moved: Some(moved) });
    }
    out
}

fn scratches(s: &Scratches, size: f64, (x0, y0, x1, y1): (f64, f64, f64, f64), cuts: &mut Polys) {
    let a = s.amount.clamp(0.0, 1.0);
    if !(a > 0.0) || !(size > 0.0) {
        return;
    }
    let dice = Dice { seed: s.seed, stream: 2 };
    let m = size * 0.3;
    let (x0, y0, x1, y1) = (x0 - m, y0 - m, x1 + m, y1 + m);
    let (w, h) = (x1 - x0, y1 - y0);
    let n = (1.0 + a * (w * h) / (size * size) * 5.0).round().clamp(1.0, 240.0) as usize;
    for i in 0..n {
        let c = Pt::new(x0 + dice.u(i, 0) * w, y0 + dice.u(i, 1) * h);
        let dir = s.angle + dice.pm(i, 2) * 0.08;
        let len = size * (0.4 + 2.2 * dice.u(i, 3).powi(2));
        let width = size * (0.008 + 0.022 * dice.u(i, 4));
        let (cx, cy) = (dir.cos(), dir.sin());
        const N: usize = 8;
        let wave = size * 0.008;
        let pts: Vec<Pt> = (0..=N)
            .map(|k| {
                let t = k as f64 / N as f64 - 0.5;
                let off = wave * dice.pm(i, 10 + k as u32);
                Pt::new(c.x + cx * len * t - cy * off, c.y + cy * len * t + cx * off)
            })
            .collect();
        contour(cuts, &ribbon(&pts, |t| width * (std::f64::consts::PI * t).sin().powf(0.6)));
    }
}


// ===== paint =====

/// An angular walk from `from` along `heading`: straight segments of about
/// `seg`, each turned sharply off the heading, mostly the other way from the
/// last, so the line zigzags and keeps its way. Stops after `len`, or when
/// `stop` says a point is past where it may go.
#[allow(clippy::too_many_arguments)]
fn zig(
    from: Pt,
    heading: f64,
    seg: f64,
    len: f64,
    turn: f64,
    dice: Dice,
    item: usize,
    stop: impl Fn(Pt) -> bool,
) -> Vec<Pt> {
    let mut pts = vec![from];
    let (mut p, mut dev, mut sign, mut gone) = (from, 0.0f64, dice.sign(item, 0), 0.0);
    for s in 0..64u32 {
        if gone >= len {
            break;
        }
        if dice.u(item, 10 + s) < 0.72 {
            sign = -sign;
        }
        dev = (dev * 0.35 + sign * turn * (0.35 + 0.65 * dice.u(item, 100 + s))).clamp(-1.1 * turn, 1.1 * turn);
        let a = heading + dev;
        let l = (seg * (0.6 + 0.8 * dice.u(item, 200 + s))).min(len - gone).max(seg * 0.25);
        p = Pt::new(p.x + a.cos() * l, p.y + a.sin() * l);
        gone += l;
        pts.push(p);
        if stop(p) {
            break;
        }
    }
    pts
}

/// A splat: a rough disc of radius `r` about `c` with a few long, narrow
/// spikes.
fn splat(c: Pt, r: f64, dice: Dice, item: usize) -> Vec<Pt> {
    const N: usize = 30;
    let mut pts = Vec::with_capacity(N * 2);
    for i in 0..N {
        let t = i as f64 / N as f64 * TAU;
        let ch = i as u32;
        if dice.u(item, 300 + ch) < 0.28 {
            // A spike: in, far out, back in.
            let d = TAU / N as f64 * 0.32;
            let base = r * 0.85;
            let tip = r * (1.45 + 0.9 * dice.u(item, 400 + ch));
            pts.push(Pt::new(c.x + (t - d).cos() * base, c.y + (t - d).sin() * base));
            pts.push(Pt::new(c.x + t.cos() * tip, c.y + t.sin() * tip));
            pts.push(Pt::new(c.x + (t + d).cos() * base, c.y + (t + d).sin() * base));
        } else {
            let k = 0.82 + 0.26 * dice.u(item, 500 + ch);
            pts.push(Pt::new(c.x + t.cos() * r * k, c.y + t.sin() * r * k));
        }
    }
    pts
}

/// A teardrop thrown along `dir`: a round head of radius `r` at `c`, its
/// tail pointing back the way it came, `tail` long.
fn teardrop(c: Pt, r: f64, dir: f64, tail: f64) -> Vec<Pt> {
    const N: usize = 12;
    let mut pts = Vec::with_capacity(N + 2);
    for k in 0..=N {
        let ang = dir - PI / 2.0 + PI * k as f64 / N as f64;
        pts.push(Pt::new(c.x + ang.cos() * r, c.y + ang.sin() * r));
    }
    pts.push(Pt::new(c.x - dir.cos() * tail, c.y - dir.sin() * tail));
    pts
}

/// The marks of a splash over the box `rect` (job space) at font size
/// `size`, stated from the box's corner: laid on the letters' fill, so what
/// falls off it is not seen. Kept under its numbers.
pub fn splash_marks(s: &Splash, rect: [f64; 4], size: f64) -> Rc<Vec<PaintMark>> {
    kept_marks(Hasher::new("splash marks").debug(s), rect, size, || splats(s, rect[2], rect[3], size))
}

fn splats(s: &Splash, w: f64, h: f64, size: f64) -> Vec<PaintMark> {
    let a = s.amount.clamp(0.0, 1.0);
    let u = size * s.size.clamp(0.01, MAX_SPECIAL_SIZE);
    if !(a > 0.0) || !(u > 0.0) || !(w > 0.0 && h > 0.0) {
        return Vec::new();
    }
    let dice = Dice { seed: s.seed, stream: 3 };
    let mark = |pts: Vec<Pt>| PaintMark { shape: ClipShape::Polygon(pts), color: s.color, opacity: 1.0, soft: 0.0, erase: false };
    let mut marks = Vec::new();
    // One splat to each equal stretch of the box, about its middle line,
    // where the letters are.
    let splats = 1 + (a * 3.0).round() as usize;
    let mut item = 0usize;
    for i in 0..splats {
        let c = Pt::new(
            (i as f64 + 0.2 + 0.6 * dice.u(i, 0)) / splats as f64 * w,
            h * (0.3 + 0.4 * dice.u(i, 1)),
        );
        let r = u * (0.2 + 0.1 * a) * (0.75 + 0.5 * dice.u(i, 2));
        marks.push(mark(splat(c, r, dice, i)));
        // Droplets thrown out of it, smaller the farther they go, each a
        // teardrop pointing the way it flew.
        let drops = (3.0 + 9.0 * a).round() as usize;
        for _ in 0..drops {
            item += 1;
            let dir = dice.u(item, 0) * TAU;
            let far = dice.u(item, 1).powf(0.8);
            let d = r * (1.2 + 1.8 * far);
            let dr = (r * 0.3 * (1.0 - 0.7 * far) * (0.6 + 0.6 * dice.u(item, 2))).max(size * 0.02);
            let q = Pt::new(c.x + dir.cos() * d, c.y + dir.sin() * d);
            marks.push(mark(teardrop(q, dr, dir, dr * (1.8 + 1.4 * dice.u(item, 3)))));
        }
        // A few thin streaks out of its edge.
        let streaks = (1.0 + 2.0 * a).round() as usize;
        for _ in 0..streaks {
            item += 1;
            let dir = dice.u(item, 0) * TAU;
            let from = Pt::new(c.x + dir.cos() * r * 0.7, c.y + dir.sin() * r * 0.7);
            let l = r * (1.0 + 1.0 * dice.u(item, 1));
            let to = Pt::new(from.x + dir.cos() * l, from.y + dir.sin() * l);
            let sw = (r * 0.18).max(size * 0.02);
            let mid = Pt::new((from.x + to.x) / 2.0, (from.y + to.y) / 2.0);
            marks.push(mark(ribbon(&[from, mid, to], |t| sw * (1.0 - t))));
        }
    }
    marks
}

/// `make`'s marks, kept under `key` and the box's size and the font size (a
/// move of the box keeps them).
fn kept_marks(key: Hasher, rect: [f64; 4], size: f64, make: impl FnOnce() -> Vec<PaintMark>) -> Rc<Vec<PaintMark>> {
    let key = key.f64(rect[2]).f64(rect[3]).f64(size).finish();
    if let Some(hit) = key.and_then(kept::get::<Rc<Vec<PaintMark>>>) {
        return Rc::clone(&*hit);
    }
    let marks = Rc::new(make());
    if let Some(k) = key {
        let bytes = marks.iter().map(|m| match &m.shape {
            ClipShape::Polygon(p) | ClipShape::Stroke { pts: p, .. } => p.len() * 16,
            ClipShape::Ellipse { .. } => 32,
        });
        kept::put(k, Rc::clone(&marks), bytes.sum());
    }
    marks
}

// ===== lightning =====

/// The marks of a lightning over the box `rect` (job space) at font size
/// `size`, stated from the box's corner. Kept under its numbers.
pub fn lightning_marks(l: &Lightning, rect: [f64; 4], size: f64) -> Rc<Vec<PaintMark>> {
    kept_marks(Hasher::new("lightning v15").debug(l), rect, size, || bolts(l, rect[2], rect[3], size))
}

fn bolts(l: &Lightning, w: f64, h: f64, size: f64) -> Vec<PaintMark> {
    let a = l.amount.clamp(0.0, 1.0);
    if !(a > 0.0) || !(size > 0.0) || !(w > 0.0 && h > 0.0) {
        return Vec::new();
    }
    let dice = Dice { seed: l.seed, stream: 4 };
    let core_w = size * 0.05;
    let body_w = core_w * 2.6;
    let glow = l.glow_size.clamp(0.0, 3.0);
    // Every line of the lightning: its points and how wide, 1 for a bolt.
    let mut lines: Vec<(Vec<Pt>, f64)> = Vec::new();
    let count = 1 + (a * 2.0 + 0.2).round() as usize;
    let inside = |p: Pt| p.x < -0.08 * w || p.x > 1.08 * w;
    for i in 0..count {
        // Slanted across the word: from high on one side to low on the
        // other, or the other way, so a bolt crosses the letters' height.
        let (hi, lo) = (h * (0.1 + 0.3 * dice.u(i, 0)), h * (0.6 + 0.3 * dice.u(i, 1)));
        let (y0, y1) = if dice.u(i, 2) < 0.5 { (hi, lo) } else { (lo, hi) };
        let (from, to) = if i % 2 == 0 { (Pt::new(-0.05 * w, y0), Pt::new(1.05 * w, y1)) } else { (Pt::new(1.05 * w, y0), Pt::new(-0.05 * w, y1)) };
        let heading = (to.y - from.y).atan2(to.x - from.x);
        let main = zig(from, heading, size * 0.24, (to.x - from.x).hypot(to.y - from.y) * 1.3, 0.95, dice, 100 + i, inside);
        // Forks off its corners, more with the amount.
        let forks = (1.0 + a * 4.0).round() as usize;
        for f in 0..forks {
            let item = 1000 + i * 50 + f;
            if main.len() < 4 {
                break;
            }
            let k = 1 + (dice.u(item, 0) * (main.len() - 2) as f64) as usize;
            let p = main[k - 1];
            let hd = (main[k].y - p.y).atan2(main[k].x - p.x);
            let fd = hd + dice.sign(item, 1) * (0.45 + 0.6 * dice.u(item, 2));
            let fl = size * (0.6 + 1.2 * dice.u(item, 3)) * (0.7 + 0.5 * a);
            let fork = zig(main[k], fd, size * 0.18, fl, 0.9, dice, 3000 + item, |_| false);
            if a > 0.55 && fork.len() > 2 && dice.u(item, 4) < a {
                let m = fork.len() / 2;
                let q = fork[m - 1];
                let h2 = (fork[m].y - q.y).atan2(fork[m].x - q.x) - dice.sign(item, 5) * (0.5 + 0.5 * dice.u(item, 6));
                lines.push((zig(fork[m], h2, size * 0.14, fl * 0.5, 0.9, dice, 7000 + item, |_| false), 0.5));
            }
            lines.push((fork, 0.75));
        }
        lines.push((main, 1.0));
    }
    let mut marks = Vec::with_capacity(lines.len() * 3);
    // The glow under everything, then the bodies, then the cores.
    if glow > 0.0 {
        for (pts, k) in &lines {
            marks.push(PaintMark {
                shape: ClipShape::Stroke { size: body_w * k * (1.0 + 0.6 * glow), pts: pts.clone() },
                color: l.glow,
                opacity: 0.75,
                soft: size * 0.03 * glow * k.sqrt(),
                erase: false,
            });
        }
    }
    for (pts, k) in &lines {
        let tip = if *k < 1.0 { 0.35 } else { 0.75 };
        marks.push(PaintMark {
            shape: ClipShape::Polygon(ribbon(pts, |t| body_w * k * (1.0 - (1.0 - tip) * t))),
            color: l.glow,
            opacity: 1.0,
            soft: 0.0,
            erase: false,
        });
    }
    for (pts, k) in &lines {
        let tip = if *k < 1.0 { 0.3 } else { 0.7 };
        marks.push(PaintMark {
            shape: ClipShape::Polygon(ribbon(pts, |t| core_w * k * (1.0 - (1.0 - tip) * t))),
            color: l.core,
            opacity: 1.0,
            soft: 0.0,
            erase: false,
        });
    }
    marks
}
