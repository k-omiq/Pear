//! Special effects (plan 8): seeded generators that turn a handful of
//! numbers into shapes, so only the numbers cross the wire.
//!
//! - **Crack** cuts branching, tapering, jagged lines out of the letters,
//!   grown from seeded points; past 60 % the pieces between two arms near a
//!   point fall out.
//! - **Scratches** cut many thin, near-parallel strokes.
//! - **Splash** adds blobs and droplets round the letters (outlines and
//!   shadows wrap them) and cuts spatter holes in them.
//! - **Lightning** is paint: jagged bolts with branches and a soft halo,
//!   laid on the letters' fill by the box job (`Effect::Paint`).
//!
//! Every pattern is drawn over the whole box (the letters' ink as one, or
//! the box itself for a bolt), never restarted per letter, and from the
//! seed alone: the same numbers give the same shapes on every build, in the
//! editor and in the file (`crate::seeded::noise`). Lengths are shares of
//! the job's font size, so a pattern scales with its letters.

use std::rc::Rc;

use super::boxjob::ClipShape;
use super::fx::effects::PaintMark;
use super::geom::{Polys, Pt};
use super::job::Rgba;
use super::kept::{self, Hasher};
use crate::seeded::noise;
use crate::Error;

/// Largest share of the font size a Size control reaches.
pub const MAX_SPECIAL_SIZE: f64 = 4.0;

/// How far a splash reaches past the letters' ink, in units of its size
/// times the font size: the farthest droplet's edge. The app grows a box's
/// footprint by this much (`specialReach` in exporter.js).
pub const SPLASH_REACH: f64 = 1.2;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crack {
    /// 0 to 1: how many cracks, how long, and past 0.6 how much falls out.
    pub amount: f64,
    /// A share of the font size: the length and width of the arms.
    pub size: f64,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lightning {
    /// 0 to 1: how many bolts and branches.
    pub amount: f64,
    /// Radians: the way the bolts run, 0 along the line.
    pub angle: f64,
    /// Straight; the halo is this colour, the core this colour lit.
    pub color: Rgba,
    pub seed: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Splash {
    /// 0 to 1: how many blobs, droplets and holes.
    pub amount: f64,
    /// A share of the font size: how big a blob is and how far it throws.
    pub size: f64,
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

/// The special effects of a box (glyph wire v14). Every job of the box
/// carries them, so a shadow is cast from the cracked letters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Special {
    /// The box in job space: its corner, width and height. A bolt crosses
    /// it.
    pub rect: [f64; 4],
    pub crack: Option<Crack>,
    pub lightning: Option<Lightning>,
    pub splash: Option<Splash>,
    pub scratches: Option<Scratches>,
}

impl Special {
    /// Whether any effect changes the letters' shapes (all but Lightning).
    pub fn shapes_letters(&self) -> bool {
        self.crack.is_some() || self.splash.is_some() || self.scratches.is_some()
    }
}

/// What the letters' generators make, in job space: shapes cut out of every
/// pass, and ink joined to the letters.
#[derive(Debug, Default)]
pub struct Shapes {
    pub cuts: Polys,
    pub adds: Polys,
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

/// A wobbly round blob of radius `r` about `c`, `bump` of it either way.
fn blob(c: Pt, r: f64, bump: f64, dice: Dice, item: usize) -> Vec<Pt> {
    const N: usize = 18;
    (0..N)
        .map(|i| {
            let t = i as f64 / N as f64 * std::f64::consts::TAU;
            let k = 1.0 + bump * dice.pm(item, 100 + i as u32);
            Pt::new(c.x + t.cos() * r * k, c.y + t.sin() * r * k)
        })
        .collect()
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

/// `a` to `b` cut into `2^depth` pieces, each midpoint moved sideways by up
/// to `rough` of its piece: a bolt's zigzag.
fn zigzag(a: Pt, b: Pt, depth: u32, rough: f64, dice: Dice, item: usize) -> Vec<Pt> {
    let mut pts = vec![a, b];
    let mut k = 0u32;
    for _ in 0..depth {
        let mut next = Vec::with_capacity(pts.len() * 2);
        for w in pts.windows(2) {
            let (p, q) = (w[0], w[1]);
            let (dx, dy) = (q.x - p.x, q.y - p.y);
            let len = dx.hypot(dy);
            let off = rough * len * dice.pm(item, 400 + k);
            k += 1;
            let (nx, ny) = if len > 0.0 { (-dy / len, dx / len) } else { (0.0, 0.0) };
            next.push(p);
            next.push(Pt::new((p.x + q.x) / 2.0 + nx * off, (p.y + q.y) / 2.0 + ny * off));
        }
        next.push(*pts.last().unwrap_or(&b));
        pts = next;
    }
    pts
}

// ===== the letters' shapes =====

/// The cuts and adds of `sp` for letters whose ink (job space, unbent) is
/// `ink`, at font size `size`. Kept under its numbers, so a move or an edit
/// of anything else reads them back.
pub fn letter_shapes(sp: &Special, size: f64, ink: (f64, f64, f64, f64)) -> Result<Rc<Shapes>, Error> {
    let key = Hasher::new("special shapes")
        .debug(&(sp.crack, sp.splash, sp.scratches))
        .f64(size)
        .f64(ink.0)
        .f64(ink.1)
        .f64(ink.2)
        .f64(ink.3)
        .finish();
    if let Some(hit) = key.and_then(kept::get::<Rc<Shapes>>) {
        return Ok(Rc::clone(&*hit));
    }
    let mut out = Shapes::default();
    if let Some(c) = sp.crack {
        crack(&c, size, ink, &mut out.cuts);
    }
    if let Some(s) = sp.scratches {
        scratches(&s, size, ink, &mut out.cuts);
    }
    if let Some(s) = sp.splash {
        splash(&s, size, ink, &mut out);
    }
    super::budget::check()?;
    let out = Rc::new(out);
    if let Some(k) = key {
        let bytes = (out.cuts.pts.len() + out.adds.pts.len()) * 16;
        kept::put(k, Rc::clone(&out), bytes);
    }
    Ok(out)
}

fn crack(c: &Crack, size: f64, (x0, y0, x1, y1): (f64, f64, f64, f64), cuts: &mut Polys) {
    let a = c.amount.clamp(0.0, 1.0);
    let u = size * c.size.clamp(0.01, MAX_SPECIAL_SIZE);
    if !(a > 0.0) || !(u > 0.0) {
        return;
    }
    let dice = Dice { seed: c.seed, stream: 1 };
    let (w, h) = (x1 - x0, y1 - y0);
    let points = (1.0 + a * (w * h) / (u * u) * 0.6).round().clamp(1.0, 24.0) as usize;
    // Past 60 % the pieces between two arms start to fall out.
    let fall = ((a - 0.6) / 0.4).clamp(0.0, 1.0);
    let step = u * 0.08;
    let mut item = 0usize;
    for i in 0..points {
        // Spread along the letters: one point to each equal stretch.
        let centre = Pt::new(x0 + (i as f64 + dice.u(i, 0)) / points as f64 * w, y0 + dice.u(i, 1) * h);
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
    }
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

fn splash(s: &Splash, size: f64, (x0, y0, x1, y1): (f64, f64, f64, f64), out: &mut Shapes) {
    let a = s.amount.clamp(0.0, 1.0);
    let u = size * s.size.clamp(0.01, MAX_SPECIAL_SIZE);
    if !(a > 0.0) || !(u > 0.0) {
        return;
    }
    let dice = Dice { seed: s.seed, stream: 3 };
    let (w, h) = (x1 - x0, y1 - y0);
    let my = (y0 + y1) / 2.0;
    let splats = (1.0 + a * 2.0 + a * (w * h) / (size * size) * 0.15).round().clamp(1.0, 8.0) as usize;
    let reach = SPLASH_REACH * u;
    let mut item = 0usize;
    for i in 0..splats {
        // Spread along the letters, one to each equal stretch, and pulled
        // a little towards their middle line.
        let c = Pt::new(
            x0 + (i as f64 + 0.15 + 0.7 * dice.u(i, 0)) / splats as f64 * w,
            my + (dice.u(i, 1) - 0.5) * h * 0.85,
        );
        let r = u * (0.12 + 0.12 * a) * (0.6 + 0.8 * dice.u(i, 2));
        contour(&mut out.adds, &blob(c, r, 0.18, dice, i));
        // Fingers thrown out of the blob, a droplet at the end of some.
        let fingers = 4 + (dice.u(i, 3) * 4.0) as usize;
        for f in 0..fingers {
            item += 1;
            let dir = dice.u(item, 0) * std::f64::consts::TAU;
            let len = r * (1.2 + 1.0 * dice.u(item, 1));
            let (cx, cy) = (dir.cos(), dir.sin());
            let tip = Pt::new(c.x + cx * len, c.y + cy * len);
            let fw = r * (0.25 + 0.2 * dice.u(item, 2));
            contour(&mut out.adds, &ribbon(&[Pt::new(c.x + cx * r * 0.5, c.y + cy * r * 0.5), tip], |t| fw * (1.0 - 0.85 * t)));
            if f % 2 == 0 {
                let dr = r * (0.1 + 0.1 * dice.u(item, 3));
                let d = (len + r * (0.3 + 0.6 * dice.u(item, 4))).min(reach - dr);
                contour(&mut out.adds, &blob(Pt::new(c.x + cx * d, c.y + cy * d), dr, 0.1, dice, item));
            }
        }
        // Loose droplets round it, within the reach.
        let drops = (4.0 + 14.0 * a) as usize;
        for _ in 0..drops {
            item += 1;
            let dir = dice.u(item, 0) * std::f64::consts::TAU;
            let dr = r * (0.09 + 0.14 * dice.u(item, 1));
            let d = (r * (1.3 + 3.0 * dice.u(item, 2).powf(0.7))).min(reach - dr);
            contour(&mut out.adds, &blob(Pt::new(c.x + dir.cos() * d, c.y + dir.sin() * d), dr, 0.1, dice, item));
        }
    }
    // Spatter holes inside the letters.
    let holes = (a * (w * h) / (size * size) * 2.5).round().clamp(0.0, 120.0) as usize;
    for k in 0..holes {
        item += 1;
        let c = Pt::new(x0 + dice.u(item, 0) * w, y0 + dice.u(item, 1) * h);
        let r = u * (0.015 + 0.05 * dice.u(item, 2).powi(2));
        contour(&mut out.cuts, &blob(c, r, 0.15, dice, 10_000 + k));
    }
}

// ===== lightning =====

/// The marks of a lightning over the box `rect` (job space) at font size
/// `size`, stated from the box's corner. Kept under its numbers.
pub fn lightning_marks(l: &Lightning, rect: [f64; 4], size: f64) -> Rc<Vec<PaintMark>> {
    let key = Hasher::new("lightning")
        .debug(l)
        .f64(rect[2])
        .f64(rect[3])
        .f64(size)
        .finish();
    if let Some(hit) = key.and_then(kept::get::<Rc<Vec<PaintMark>>>) {
        return Rc::clone(&*hit);
    }
    let marks = Rc::new(bolts(l, rect[2], rect[3], size));
    if let Some(k) = key {
        let bytes = marks.iter().map(|m| match &m.shape {
            ClipShape::Polygon(p) | ClipShape::Stroke { pts: p, .. } => p.len() * 16,
            ClipShape::Ellipse { .. } => 32,
        });
        kept::put(k, Rc::clone(&marks), bytes.sum());
    }
    marks
}

fn bolts(l: &Lightning, w: f64, h: f64, size: f64) -> Vec<PaintMark> {
    let a = l.amount.clamp(0.0, 1.0);
    let mut marks = Vec::new();
    if !(a > 0.0) || !(size > 0.0) || !(w > 0.0 && h > 0.0) {
        return marks;
    }
    let dice = Dice { seed: l.seed, stream: 4 };
    let [r, g, b, _] = l.color.0;
    let lit = |v: u8| (f64::from(v) + (255.0 - f64::from(v)) * 0.65).round() as u8;
    let core = Rgba([lit(r), lit(g), lit(b), 255]);
    let halo = Rgba([r, g, b, 255]);
    let count = (1.0 + a * 4.0).round() as usize;
    let reach = 0.5 * w.hypot(h) * 1.05;
    let width = size * (0.035 + 0.03 * a);
    let mut item = 0usize;
    for i in 0..count {
        let c = Pt::new(dice.u(i, 0) * w, dice.u(i, 1) * h);
        let dir = l.angle + dice.pm(i, 2) * 0.3;
        let (cx, cy) = (dir.cos(), dir.sin());
        let from = Pt::new(c.x - cx * reach, c.y - cy * reach);
        let to = Pt::new(c.x + cx * reach, c.y + cy * reach);
        let main = zigzag(from, to, 6, 0.22, dice, i);
        marks.push(PaintMark {
            shape: ClipShape::Stroke { size: width * 3.0, pts: main.clone() },
            color: halo,
            opacity: 0.45,
            soft: size * 0.05,
            erase: false,
        });
        marks.push(PaintMark {
            shape: ClipShape::Polygon(ribbon(&main, |t| width * (1.0 - 0.5 * t))),
            color: halo,
            opacity: 1.0,
            soft: 0.0,
            erase: false,
        });
        // A lit core down the middle of the bolt.
        marks.push(PaintMark {
            shape: ClipShape::Polygon(ribbon(&main, |t| width * 0.4 * (1.0 - 0.5 * t))),
            color: core,
            opacity: 1.0,
            soft: 0.0,
            erase: false,
        });
        let branches = (1.0 + a * 4.0).round() as usize;
        for _ in 0..branches {
            item += 1;
            let at = 4 + (dice.u(item, 0) * (main.len() - 8) as f64) as usize;
            let p = main[at];
            let side = if dice.pm(item, 1) < 0.0 { -1.0 } else { 1.0 };
            let bdir = dir + side * (0.3 + 0.6 * dice.u(item, 2));
            let len = reach * (0.2 + 0.35 * dice.u(item, 3));
            let end = Pt::new(p.x + bdir.cos() * len, p.y + bdir.sin() * len);
            let arm = zigzag(p, end, 4, 0.25, dice, 1000 + item);
            let bw = width * (1.0 - 0.5 * at as f64 / main.len() as f64) * 0.55;
            marks.push(PaintMark {
                shape: ClipShape::Polygon(ribbon(&arm, |t| bw * (1.0 - t))),
                color: halo,
                opacity: 0.95,
                soft: 0.0,
                erase: false,
            });
        }
    }
    marks
}
