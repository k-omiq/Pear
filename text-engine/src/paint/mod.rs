//! The glyph painter: a paint job in, straight-alpha RGBA8 pixels out.
//!
//! [`paint_job`] does what `src/lib/text-engine/browser-painter.js` does
//! with canvas calls, for everything a job can say:
//!
//! ```text
//! job ── shape.rs ──▶ positioned glyphs
//!        outline.rs ─▶ closed polylines in job space, one set per glyph
//!        stroke.rs ──▶ a band's ring, or an outline grown (bold, silhouette)
//!        raster.rs ──▶ coverage of each layer's shape   ◀── the rasteriser
//!        shade.rs ───▶ colour of each covered pixel
//!        compose.rs ─▶ layers over each other, to RGBA8
//! ```
//!
//! A job becomes a few layers, bottom first: one per stroke band, widest
//! first, then the fill (one layer, or one per line or per glyph when each
//! has a fill of its own). Each layer is ONE shape laid down ONCE. That is
//! deliberate and it is where this painter parts from the canvas, which
//! strokes every line and every glyph on its own: a translucent band is one
//! even tone here, where on a canvas it is darker wherever the strokes of
//! two neighbouring glyphs or lines overlap.

mod blur;
mod boxjob;
pub(crate) mod budget;
mod compose;
pub mod fx;
mod geom;
pub mod ink;
mod job;
pub mod kept;
mod outline;
mod pattern;
mod raster;
mod roughen;
mod scene;
mod screen;
mod shade;
mod shape;
pub mod special;
mod stroke;
mod sweep;
mod warp;

#[cfg(any(
    feature = "raster-tiny-skia",
    feature = "raster-zeno",
    feature = "raster-vello"
))]
#[path = "raster_compare.rs"]
pub mod compare;

pub use boxjob::{
    decode_box, decode_box_kept, paint_box, paint_box_copy_by_copy, paint_box_kept,
    paint_box_with, BoxKeys, BoxRequest, Clip, ClipMode, ClipPart, ClipShape, Fade, FadePart,
    Shadow, Tap,
    BOX_MAGIC,
    BOX_WIRE_VERSION, MAX_PAGE,
};
use geom::positive;
pub use geom::{Affine, IBox, Polys, Pt};
pub use job::{
    decode, decode_swatch, Align, Band, Cuts, Effects, Fill, Job, Negative, Request, Rgba, Run, RunFaces,
    Wobble, Stop, Tile, MAGIC, MAX_RUN_FACES, MAX_WOBBLE_AMOUNT, MAX_WOBBLE_TILT, MAX_WEIGHT, MITER_LIMIT, WIRE_VERSION,
};
pub(crate) use outline::glyph_polys;
pub use outline::FLATTEN_TOLERANCE;
pub use pattern::{tile as pattern_tile, Kind as PatternKind, MAX_TILE_SIDE};
pub use raster::{Coverage, Exact, Part, PlainScratch, Rasterizer, STRIP_ROWS};
pub use roughen::Roughen;
pub use scene::Scene;
pub use screen::{swatch as pattern_swatch, Screen, KIND_NAMES};
pub use shape::{align_offset, curved_origin, shape_line_runs, shape_run, shape_spans, Placed, ShapedRun};
pub use special::{BreakOff, Crack, Lightning, Motion, Scratches, Special, Splash, MAX_SPECIAL_SIZE};
pub use stroke::{Join, Side};
use warp::Cut;
pub use warp::{Mesh, MAX_MESH_SIDE};

use compose::{compose, Layer};
use shade::Shader;

use crate::engine::{BoldAdvance, Engine, Face, WEBKIT_BOLD_ADVANCE};
use crate::font::OBLIQUE_SKEW;
use crate::metrics::bold_outset;
use crate::Error;

/// Largest surface side accepted. A guard against a bad job asking for
/// gigabytes, not a design limit.
pub const MAX_SIDE: u32 = 16384;

/// Largest surface accepted, in pixels: 256 MB of RGBA.
pub const MAX_PIXELS: usize = 1 << 26;
pub use budget::MAX_PAINT_BYTES;

/// How a synthesised bold joins its outline at a corner.
///
/// The one place this is decided. Skia mitres (SPIKE.md rule 8); the
/// engine's metrics (`bold_outset`, `line_ink`) assume a round join, which
/// grows every edge of the ink box by exactly one outset, and so does the
/// painter. To follow Skia instead, change this to
/// `Join::Miter { limit: .. }` and widen the bold ink box in `metrics.rs` to
/// match; a stroke band outside a mitred bold would then also need the
/// mitred outline as its base (see `Glyphs::band`).
pub const BOLD_JOIN: Join = Join::Round;

/// How a synthesised bold is drawn. The references do not agree
/// (P5A-REPORT.md has the measurements and the pictures), and each way
/// belongs to one way of measuring: the engine's `boldAdvance` rule decides
/// both, so the ink the engine measures (`line_ink`) is the ink painted. A
/// request can still name one outright (`boldDraw` in `paint.mjs`), which is
/// for looking at the other and for tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BoldDraw {
    /// Skia: the outline grown by [`bold_outset`] on every side, joined by
    /// [`BOLD_JOIN`]. Stems and bars thicken alike. Goes with an unchanged
    /// advance.
    #[default]
    Outset,
    /// WebKit: the glyph drawn at its place and again `size / 36` to the
    /// right ([`WEBKIT_BOLD_ADVANCE`]), as one shape. Upright stems thicken
    /// by that much, level bars not at all. Goes with WebKit's wider advance,
    /// which is that same step.
    Smear,
}

impl BoldDraw {
    /// The drawing that goes with a `boldAdvance` rule.
    pub fn for_rule(rule: BoldAdvance) -> Self {
        match rule {
            BoldAdvance::Unchanged => BoldDraw::Outset,
            BoldAdvance::WebKit => BoldDraw::Smear,
        }
    }
}

/// The pixels a job paints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raster {
    /// Device pixel of the top-left corner.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Straight-alpha RGBA8, row by row from the top.
    pub data: Vec<u8>,
}

/// What bends every outline of a job, after the glyph's own drip: the box's
/// roughening, stated in the unbent box, and then its mesh.
#[derive(Clone, Copy, Default)]
pub(crate) struct Bends<'a> {
    pub rough: Option<&'a roughen::RoughMap>,
    pub mesh: Option<&'a warp::MeshMap<'a>>,
}

impl Bends<'_> {
    /// Whether nothing bends.
    pub(crate) fn is_empty(&self) -> bool {
        self.rough.is_none() && self.mesh.is_none()
    }

    /// Where the job-space point `p` goes: roughened, then through the mesh.
    /// The letters (`GlyphPolys::placed`, after their drip) and the brush
    /// ink (`ink.rs`) are bent by this one map.
    pub(crate) fn at(&self, p: Pt) -> Pt {
        let p = self.rough.map_or(p, |r| r.at(p));
        self.mesh.map_or(p, |m| m.at(p))
    }

    /// A box (job space) that holds where [`Bends::at`] takes every point
    /// of the box `bounds`, found without bending an outline, or `None`
    /// where the mesh gives none (`MeshMap::reach`).
    pub(crate) fn reach(
        &self,
        (x0, y0, x1, y1): (f64, f64, f64, f64),
    ) -> Option<(f64, f64, f64, f64)> {
        let r = self.rough.map_or(0.0, |r| r.reach());
        // With a little over for the rounding of the move.
        let r = if r > 0.0 { r * (1.0 + 1e-9) + 1e-9 } else { 0.0 };
        let b = (x0 - r, y0 - r, x1 + r, y1 + r);
        match self.mesh {
            Some(m) => m.reach(b),
            None => Some(b),
        }
    }

    /// How an outline inside `bounds` (job space, unbent) is cut for this
    /// map: the one map's own cut where only one bends, the finer of the
    /// two (`Cut::both`) where both do, and `None` where nothing bends.
    pub(crate) fn cut(&self, bounds: (f64, f64, f64, f64), tol: f64) -> Option<Cut> {
        let cuts = [
            self.rough.map(|r| r.cut(tol)),
            self.mesh.map(|m| m.cut(bounds, tol)),
        ];
        let mut cuts = cuts.into_iter().flatten();
        let first = cuts.next()?;
        Some(cuts.fold(first, Cut::both))
    }
}

/// One glyph's outline in job space, and what a synthesised bold does to it.
struct GlyphPolys {
    polys: Polys,
    /// Half the pen an outset bold adds, in job units; 0 for none.
    bold: f64,
    /// The step a smeared bold is drawn over, in job space.
    smear: Option<Pt>,
    /// The letter's drip: the lower half of this outline pulled down.
    drip: Option<warp::Drip>,
    /// Its run's pen: a band or a negative's grow is this many times as wide.
    pen: f64,
}

/// How far a shape is grown past each glyph's outline, job units: the larger
/// of `pen` times the glyph's own pen (a band, a negative's blob) and
/// `weight` (the extra weight, the same for every glyph).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Reach {
    pub pen: f64,
    pub weight: f64,
}

impl Reach {
    /// The same for every glyph, whatever its pen.
    pub(crate) fn flat(by: f64) -> Self {
        Self {
            pen: 0.0,
            weight: by,
        }
    }

    fn of(&self, g: &GlyphPolys) -> f64 {
        (self.pen * g.pen).max(self.weight).max(0.0)
    }
}

impl GlyphPolys {
    /// `polys`, which are this glyph's contours as they are or moved, where
    /// they are painted: through the letter's drip, then the box's
    /// roughening, then its mesh, then `transform`. The bends come after the
    /// outline is moved, so a band bends with the letter it is a stroke of.
    fn placed(
        &self,
        polys: &Polys,
        bends: Bends<'_>,
        transform: &Affine,
        tol: f64,
    ) -> Result<Polys, Error> {
        let Some(bounds) = polys.bounds() else {
            return Ok(polys.map(transform));
        };
        let drip = self.drip;
        // One map is cut as that map asks; one after another, by the finer
        // cut of them all (`Cut::both` is the least of the lengths, and
        // takes no piece on trust, in any order).
        let cut = match (drip.map(|d| d.cut(tol)), bends.cut(bounds, tol)) {
            // Nothing bends: the numbers a job always had.
            (None, None) => return Ok(polys.map(transform)),
            (Some(d), None) => d,
            (None, Some(b)) => b,
            (Some(d), Some(b)) => d.both(b),
        };
        let map = |p: Pt| bends.at(drip.map_or(p, |d| d.at(p)));
        Ok(warp::bend(polys, map, cut, tol)?.map(transform))
    }

    /// Whether the mesh turns this glyph over.
    fn mirrored(&self, mesh: Option<&warp::MeshMap<'_>>) -> bool {
        mesh.is_some_and(|m| self.tangent(m).det() < 0.0)
    }

    /// The affine map that is the mesh over this glyph: where its middle
    /// goes, and how the plane is stretched and turned across it.
    fn tangent(&self, mesh: &warp::MeshMap<'_>) -> Affine {
        self.polys
            .bounds()
            .map_or(Affine::IDENTITY, |b| mesh.tangent_over(b))
    }
}

/// A line's flat tops for Crisp mode ([`Glyphs::fit_to_grid`]): the cap
/// height and the x-height, job units above the baseline, where the face has
/// them.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Zones {
    pub cap: Option<f64>,
    pub x: Option<f64>,
}

/// What [`Glyphs::add_run`] wobbles a run's letters by: the job's wobble,
/// the run's text, and `base`, the number of letters in the job's text
/// before the run's first (`letters_in`).
pub(crate) struct Wobbling<'a> {
    pub wobble: Wobble,
    pub text: &'a str,
    pub base: usize,
}

/// Whether a character is a letter that wobbles: not a space and not a
/// hyphen. A line broken somewhere else adds or drops only those, so leaving
/// them out of the count keeps every letter's numbers when a box is resized.
fn wobbles(c: char) -> bool {
    !(c.is_whitespace() || matches!(c, '-' | '\u{00ad}' | '\u{2010}' | '\u{2011}'))
}

/// How many letters that wobble `text` holds.
pub(crate) fn letters_in(text: &str) -> usize {
    text.chars().filter(|&c| wobbles(c)).count()
}

/// A letter's place in a run's text, by characters: for the cluster at
/// UTF-16 offset `at`, the number of letters before it, or `None` when the
/// cluster's first character is a space or a hyphen. Characters, not
/// glyphs, are counted, so a ligature (`fi`) a break splits into two glyphs
/// gives each letter the number it had joined, and a right-to-left run,
/// whose glyphs come last letter first, numbers its letters in the order
/// they are written. A ligature takes its first letter's number.
fn letter_at(text: &str, at: u32) -> Option<usize> {
    let mut u = 0u32;
    let mut n = 0usize;
    for c in text.chars() {
        if u == at {
            return wobbles(c).then_some(n);
        }
        if u > at {
            break;
        }
        if wobbles(c) {
            n += 1;
        }
        u += c.len_utf16() as u32;
    }
    None
}

/// For each of `runs`, the number of the job's letters before its first, the
/// count a wobble keys a letter by (`Wobbling`), or `None` for a run that
/// does not wobble. An SFX trail's afterimages (`Run::ghost`) are not
/// letters of the text: the trail lays `copies` of them behind each letter,
/// in the letters' order, so each block of `copies` is one letter's and
/// takes its numbers. No afterimage wobbles when `copies` is zero.
pub(crate) fn wobble_bases(
    runs: &[Run],
    copies: u32,
) -> Result<Vec<Option<usize>>, Error> {
    let copies = copies as usize;
    let (mut letters, mut ghosts, mut ghost_letters, mut ghost_base) = (0, 0, 0, 0);
    budget::collect(runs.iter().map(|run| {
        Ok(if !run.ghost {
            let base = letters;
            letters += letters_in(&run.text);
            Some(base)
        } else if copies == 0 {
            None
        } else {
            if ghosts % copies == 0 {
                ghost_base = ghost_letters;
                ghost_letters += letters_in(&run.text);
            }
            ghosts += 1;
            Some(ghost_base)
        })
    }))
}

/// The drip of a glyph whose ink is `polys`: its lower half pulled down by
/// `pull` job units, from the middle of its height to its foot. `None` for
/// no pull or no height.
fn drip_of(polys: &Polys, pull: f64) -> Option<warp::Drip> {
    match polys.bounds() {
        Some((_, top, _, bottom)) if positive(pull) && bottom > top => Some(warp::Drip {
            mid: (top + bottom) / 2.0,
            bottom,
            pull,
        }),
        _ => None,
    }
}

/// The outlines of a job's glyphs, and the shapes made from them.
#[derive(Default)]
pub(crate) struct Glyphs {
    items: budget::Buffer<GlyphPolys>,
}

impl Glyphs {
    /// Adds the glyphs of a shaped run. `frame` maps the run's own frame
    /// (origin at its start on the baseline, y down) to job space. `drip`
    /// pulls the lower half of every glyph of the run down by that many job
    /// units: from the middle of the glyph's own height, as it stands in job
    /// space, to its foot. Zero for none. `pen` is the run's (`Run::pen`).
    /// `embolden` and `slant` are the job's ([`job::Effects`]). `wobbling`
    /// moves each letter up or down and turns it about its middle
    /// ([`job::Wobble`]); `None` places every glyph as the shaper did.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_run(
        &mut self,
        engine: &Engine,
        run: &ShapedRun,
        frame: &Affine,
        bold_draw: BoldDraw,
        drip: f64,
        pen: f64,
        embolden: f64,
        slant: f64,
        tol: f64,
        wobbling: Option<Wobbling<'_>>,
    ) -> Result<(), Error> {
        // The glyphs of one cluster (a letter and its marks, or a ligature)
        // turn together about one middle, the cluster's base glyph's: its
        // first item in `self.items` and its turn, settled when the next
        // cluster starts (`turn_cluster`).
        let mut cluster = None;
        let mut moved = (0.0, 0.0);
        let mut first = self.items.len();
        let mut turn = 0.0;
        for g in &run.glyphs {
            if let Some(w) = wobbling.as_ref() {
                if cluster != Some(g.cluster) {
                    self.turn_cluster(first, turn, drip);
                    cluster = Some(g.cluster);
                    first = self.items.len();
                    moved = match letter_at(w.text, g.cluster) {
                        Some(n) => {
                            let (k, n) = (&w.wobble, w.base + n);
                            (
                                k.amount * g.size * crate::seeded::noise(k.seed, 0, n, 0),
                                k.tilt.to_radians() * crate::seeded::noise(k.seed, 0, n, 1),
                            )
                        }
                        None => (0.0, 0.0),
                    };
                    turn = moved.1;
                }
            }
            let dy = moved.0;
            let entry = engine.font(g.font)?;
            let per_unit = g.size / f64::from(entry.info.units_per_em);
            let skew = slant
                + if g.synth.oblique {
                    f64::from(OBLIQUE_SKEW)
                } else {
                    0.0
                };
            let mut polys = Polys::default();
            let place = frame.after(&Affine::translate(g.x, g.y + dy));
            outline::glyph_polys(entry, g.glyph, &place, per_unit, skew, tol, &mut polys);
            budget::check()?;
            if polys.is_empty() {
                continue;
            }
            let (face_bold, smear) = match (g.synth.bold, bold_draw) {
                (false, _) => (0.0, None),
                (true, BoldDraw::Outset) => (bold_outset(g.size), None),
                (true, BoldDraw::Smear) => {
                    // To the right in the run's own frame, wherever the
                    // frame has turned that to.
                    let m = &frame.0;
                    let by = g.size * WEBKIT_BOLD_ADVANCE;
                    (0.0, Some(Pt::new(m[0] * by, m[1] * by)))
                }
            };
            let bold = face_bold + bold_outset(g.size) * embolden;
            budget::check()?;
            // A glyph still to be turned has its drip measured once it has
            // turned (`turn_cluster`).
            let drip = if turn == 0.0 { drip_of(&polys, drip) } else { None };
            budget::push(
                &mut self.items,
                GlyphPolys {
                    polys,
                    bold,
                    smear,
                    drip,
                    pen,
                },
            )?;
        }
        self.turn_cluster(first, turn, drip);
        Ok(())
    }

    /// Turns the glyphs of one wobbled cluster, `self.items[first..]`, by
    /// `turn` radians about the middle of its base glyph's ink: the biggest
    /// of them, as a letter is bigger than its marks. One middle for the
    /// whole cluster keeps an accent on its letter. The outlines are turned
    /// after they are flattened: a turn moves no point off its curve. Then
    /// measures each glyph's `drip` as it now stands.
    fn turn_cluster(&mut self, first: usize, turn: f64, drip: f64) {
        if turn == 0.0 || first >= self.items.len() {
            return;
        }
        let area = |b: (f64, f64, f64, f64)| (b.2 - b.0) * (b.3 - b.1);
        let Some((l, t, r, b)) = self.items[first..]
            .iter()
            .filter_map(|g| g.polys.bounds())
            .fold(None, |best: Option<(f64, f64, f64, f64)>, b| match best {
                Some(a) if area(a) >= area(b) => Some(a),
                _ => Some(b),
            })
        else {
            return;
        };
        let (sin, cos) = turn.sin_cos();
        let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
        let m = Affine::translate(cx, cy)
            .after(&Affine::rotate(cos, sin))
            .after(&Affine::translate(-cx, -cy));
        for g in self.items[first..].iter_mut() {
            for p in g.polys.pts.iter_mut() {
                *p = m.apply(*p);
            }
            g.drip = drip_of(&g.polys, drip);
        }
    }

    /// Crisp: moves the glyphs `range` of one straight line, whose
    /// baseline is at job y `baseline`, so that its baseline, its x-height
    /// and its cap height (`zones`, job units above the baseline) fall on
    /// whole pixels of the page - multiples of one job unit in device space,
    /// counted from device y `origin`, a page pixel's edge. Vertical only, and piecewise linear: the part between baseline
    /// and x-height is stretched or squeezed to land on whole pixels, then
    /// the part between x-height and cap height; what is below the baseline
    /// or above the cap height moves with its zone's edge. A letter stays the
    /// letter it was, at most half a pixel taller or shorter in each zone.
    ///
    /// `transform` maps job space to device pixels and keeps job y as device
    /// y (the caller checks: no turn, no vertical mirror).
    pub(crate) fn fit_to_grid(
        &mut self,
        range: core::ops::Range<usize>,
        baseline: f64,
        zones: Zones,
        transform: &Affine,
        origin: f64,
    ) {
        let [_, _, _, d, _, f] = transform.0;
        // One page pixel, in device pixels: one job unit.
        let grid = d;
        if !(grid > 0.0) || !baseline.is_finite() || !origin.is_finite() {
            return;
        }
        let snap = |v: f64| ((v - origin) / grid).round() * grid + origin;
        let b = d * baseline + f;
        let b2 = snap(b);
        // Zone heights in device px, each a whole number of pixels, at least
        // one, and the cap height above the x-height.
        let whole = |h: f64| ((h * d / grid).round().max(1.0)) * grid;
        let cap = zones.cap.filter(|h| *h > 0.0);
        let x = zones.x.filter(|h| *h > 0.0 && cap.is_none_or(|c| *h < c * 0.95));
        let mut knots: [(f64, f64); 3] = [(b, b2); 3];
        let mut n = 1;
        if let Some(h) = x {
            knots[n] = (b - d * h, b2 - whole(h));
            n += 1;
        }
        if let Some(h) = cap {
            let to = (b2 - whole(h)).min(knots[n - 1].1 - grid);
            knots[n] = (b - d * h, to);
            n += 1;
        }
        let knots = &knots[..n];
        // Device y to its fitted device y. Knots run upwards (y decreasing).
        let map = |y: f64| -> f64 {
            if y >= knots[0].0 || n == 1 {
                return y + (knots[0].1 - knots[0].0);
            }
            for w in knots.windows(2) {
                let ((y0, t0), (y1, t1)) = (w[0], w[1]);
                if y >= y1 {
                    return t0 + (y - y0) * (t1 - t0) / (y1 - y0);
                }
            }
            let (y1, t1) = knots[n - 1];
            y + (t1 - y1)
        };
        for g in &mut self.items[range] {
            for p in g.polys.pts.iter_mut() {
                p.y = (map(d * p.y + f) - f) / d;
            }
        }
    }

    pub(crate) fn account(&mut self) -> Result<(), Error> {
        self.items.account()?;
        for g in &mut self.items {
            g.polys.pts.account()?;
            g.polys.ends.account()?;
        }
        Ok(())
    }

    pub(crate) fn truncate(&mut self, len: usize) {
        self.items.truncate(len);
    }

    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    /// The box of the outlines of the glyphs `range`, job space, as they
    /// stand before any bend.
    fn bounds_of(&self, range: core::ops::Range<usize>) -> Option<(f64, f64, f64, f64)> {
        self.items[range]
            .iter()
            .filter_map(|g| g.polys.bounds())
            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)))
    }

    /// `polys` (job space) as one more glyph, joined to the letters: the
    /// bands go round it and the fill fills it. No bold, no drip, a pen of 1.
    fn add_shape(&mut self, polys: &Polys) -> Result<(), Error> {
        budget::push(
            &mut self.items,
            GlyphPolys {
                polys: polys.map(&Affine::IDENTITY),
                bold: 0.0,
                smear: None,
                drip: None,
                pen: 1.0,
            },
        )
    }

    /// One glyph's contours moved to `side`: by the bold pen and `extra`
    /// more, then along the smear. `extra` grows with `join`; round is what
    /// a canvas stroke with `lineJoin = "round"` adds.
    ///
    /// A synthesised bold is itself a pen run round the outline, and with a
    /// round join two round pens add up to one wider pen, so a bold glyph
    /// grown by `extra` is the plain outline grown once by both.
    ///
    /// The same holds inwards, and that is a choice: a band round a bold
    /// glyph reaches the bold pen and its own into the outline the font
    /// has, not its own pen into the bolder shape. It is what each
    /// reference does. Skia strokes the font's outline with a pen wider by
    /// the bold's (measured), and WebKit strokes it once at its place and
    /// once a step on, which is the band of the plain glyph smeared. Only a
    /// band seen through a fill that is not opaque shows the difference
    /// (`parity/band-shape.mjs` measures both and draws them).
    fn moved(g: &GlyphPolys, extra: f64, side: Side, join: Join, tol: f64) -> Polys {
        let mut out = Polys::default();
        if g.bold > 0.0 && extra > 0.0 && BOLD_JOIN != join {
            // Two different joins: grow once for the bold, then again.
            let mut bold = Polys::default();
            stroke::grow(&g.polys, g.bold, side, BOLD_JOIN, tol, &mut bold);
            stroke::grow(&bold, extra, side, join, tol, &mut out);
        } else {
            let join = if extra > 0.0 { join } else { BOLD_JOIN };
            stroke::grow(&g.polys, g.bold + extra, side, join, tol, &mut out);
        }
        match g.smear {
            Some(v) => {
                let mut swept = Polys::default();
                stroke::sweep(&out, v, side, &mut swept);
                swept
            }
            None => out,
        }
    }

    /// One part per glyph of `sel`, in device pixels: the glyph as it is
    /// filled, grown by `reach` (joined by `join`), or with `ring` the band
    /// within that reach of the shape's edge (canvas `lineWidth = 2 * reach`).
    ///
    /// Nothing here asks which way a contour runs. Each glyph is handed to
    /// the rasteriser moved both ways and the rasteriser tells grown from
    /// shrunk by the sign of what it sums (`raster.rs`). The sides are the
    /// rasteriser's, in device pixels: a transform that mirrors turns what
    /// was moved to the right in job units into what is on the left there,
    /// and so does a mesh that turns a glyph over.
    ///
    /// `bends` are the box's roughening and its warp. They and a glyph's own
    /// drip bend the outline after it is moved and before the transform
    /// (`GlyphPolys::placed`).
    #[allow(clippy::too_many_arguments)]
    fn parts(
        &self,
        sel: impl IntoIterator<Item = usize>,
        reach: Reach,
        ring: bool,
        join: Join,
        bends: Bends<'_>,
        transform: &Affine,
        tol: f64,
    ) -> Result<budget::Buffer<Part>, Error> {
        let mut parts = budget::Buffer::new();
        for i in sel {
            let g = &self.items[i];
            let extra = reach.of(g);
            if g.bold + extra <= 0.0 && g.smear.is_none() {
                // Nothing moves the outline: no band, and the fill as
                // the font drew it.
                if !ring {
                    let polys = g.placed(&g.polys, bends, transform, tol)?;
                    budget::push(&mut parts, Part::plain(polys))?;
                }
                budget::check()?;
                continue;
            }
            let (right, left) = if (transform.det() < 0.0) != g.mirrored(bends.mesh) {
                (Side::Left, Side::Right)
            } else {
                (Side::Right, Side::Left)
            };
            let part = Part {
                right: g.placed(
                    &Self::moved(g, extra, right, join, tol),
                    bends,
                    transform,
                    tol,
                )?,
                left: Some(g.placed(
                    &Self::moved(g, extra, left, join, tol),
                    bends,
                    transform,
                    tol,
                )?),
                ring,
            };
            budget::check()?;
            budget::push(&mut parts, part)?;
        }
        Ok(parts)
    }
}

/// A layer before its coverage is prepared: its parts in device pixels and
/// what to paint them with.
struct Planned<'a> {
    parts: budget::Buffer<Part>,
    bx: IBox,
    shader: Shader<'a>,
    alpha: f32,
    /// The layer takes away what is under it (`Layer::erase`).
    erase: bool,
}

fn plan<'a>(parts: budget::Buffer<Part>, shader: Shader<'a>, alpha: f64) -> Option<Planned<'a>> {
    if !positive(alpha) {
        return None;
    }
    if let Some(c) = shader.solid() {
        if c[3] <= 0.0 {
            return None;
        }
    }
    let bx = parts
        .iter()
        .filter_map(Part::pixel_box)
        .reduce(|a, b| a.union(&b))?;
    Some(Planned {
        parts,
        bx,
        shader,
        alpha: alpha.min(1.0) as f32,
        erase: false,
    })
}

fn finish(
    planned: budget::Buffer<Planned<'_>>,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Vec<u8>, Error> {
    budget::ensure(
        surface
            .width()
            .checked_mul(surface.height())
            .and_then(|n| n.checked_mul(4))
            .ok_or(Error::BadSpec)?,
    )?;
    let mut layers = budget::Buffer::new();
    for p in planned {
        let bx = p.bx.intersect(&surface);
        if !bx.is_empty() {
            let cov = rasterizer.prepare(&p.parts, bx)?;
            budget::push(
                &mut layers,
                Layer {
                    bx,
                    cov,
                    shader: p.shader,
                    alpha: p.alpha,
                    erase: p.erase,
                },
            )?;
        }
    }
    compose(&mut layers, surface)
}

/// How much finer than the transform asks an outline bent by `mesh` is
/// flattened: by the most the mesh enlarges it, and never coarser. A mesh
/// that only moves, turns or shrinks what it bends is flattened as if it were
/// not there, to the byte.
pub(crate) fn magnified(mesh: Option<&warp::MeshMap<'_>>) -> f64 {
    match mesh.map(warp::MeshMap::stretch) {
        Some(k) if k > 1.0 + 1e-6 => k,
        _ => 1.0,
    }
}

/// What a job's layers are made from, once its glyphs are placed.
struct Layers<'a> {
    job: &'a Job,
    glyphs: &'a Glyphs,
    /// Per run: its glyphs, and the frame its own fill is stated in.
    runs: &'a [(core::ops::Range<usize>, Affine)],
    bends: Bends<'a>,
    transform: &'a Affine,
    tiles: &'a [Tile],
    tol: f64,
    weight: f64,
}

impl<'a> Layers<'a> {
    /// The glyphs of the runs `idx`.
    fn glyphs_of<'s>(&'s self, idx: &'s [usize]) -> impl Iterator<Item = usize> + 's {
        idx.iter().flat_map(move |&r| self.runs[r].0.clone())
    }

    /// One layer of `sel` in one flat colour.
    #[allow(clippy::too_many_arguments)]
    fn solid(
        &self,
        planned: &mut budget::Buffer<Planned<'a>>,
        sel: impl IntoIterator<Item = usize>,
        reach: Reach,
        ring: bool,
        join: Join,
        color: Rgba,
        alpha: f64,
    ) -> Result<(), Error> {
        let parts =
            self.glyphs
                .parts(sel, reach, ring, join, self.bends, self.transform, self.tol)?;
        let shader = Shader::new(&Fill::Solid(color), self.transform, self.tiles);
        if let Some(p) = shader.and_then(|s| plan(parts, s, alpha)) {
            budget::push(planned, p)?;
        }
        Ok(())
    }

    /// The runs `idx` as letters: every band, outermost first, then a
    /// negative's blob, then the fill.
    ///
    /// With a negative a band is round the blob: the blob grown by half the
    /// band's pen, laid whole, and the blob over it hides its inner half. A
    /// band that is not opaque is then one even tone over the blob's area
    /// too, where a ring would leave it clear.
    fn letters(
        &self,
        planned: &mut budget::Buffer<Planned<'a>>,
        idx: &[usize],
    ) -> Result<(), Error> {
        let fx = &self.job.effects;
        for band in &self.job.bands {
            if !positive(band.line) {
                continue;
            }
            // The weight is not in it: Safari, whose heavier fills the
            // weight is there to follow, strokes a glyph exactly on its
            // outline (P5B-REPORT.md).
            let reach = band.line / 2.0;
            let (pen, ring) = match fx.negative {
                Some(n) => (n.grow + reach, false),
                None => (reach, true),
            };
            let reach = Reach { pen, weight: 0.0 };
            let sel = self.glyphs_of(idx);
            self.solid(planned, sel, reach, ring, fx.join, band.color, band.opacity)?;
        }
        if let Some(n) = fx.negative {
            let reach = Reach {
                pen: n.grow,
                weight: self.weight,
            };
            self.solid(
                planned,
                self.glyphs_of(idx),
                reach,
                false,
                fx.join,
                n.color,
                1.0,
            )?;
        }
        if self.job.no_fill {
            return Ok(());
        }
        self.fills(planned, idx)
    }

    /// One fill layer per stretch of the runs `idx` that share a fill. A
    /// job-wide fill is one layer; per-line and per-glyph fills are one each,
    /// except that neighbours with the same flat colour are merged.
    fn fills(&self, planned: &mut budget::Buffer<Planned<'a>>, idx: &[usize]) -> Result<(), Error> {
        let job = self.job;
        let mut groups: budget::Buffer<(core::ops::Range<usize>, &Fill, Affine)> =
            budget::Buffer::new();
        for &i in idx {
            let (run, (range, frame)) = (&job.runs[i], &self.runs[i]);
            // A run's own fill is stated in the run's frame, the job's in
            // the job's.
            let (fill, frame) = match (&run.fill, &job.fill) {
                (Some(fill), _) => (fill, *frame),
                (None, Some(fill)) => (fill, Affine::IDENTITY),
                (None, None) => continue,
            };
            match groups.last_mut() {
                // A flat colour is the same in every frame.
                Some((r, f, fr))
                    if r.end == range.start
                        && *f == fill
                        && (*fr == frame || matches!(fill, Fill::Solid(_))) =>
                {
                    r.end = range.end;
                }
                _ => budget::push(&mut groups, (range.clone(), fill, frame))?,
            }
        }
        let mesh = self.bends.mesh;
        let flat = Reach::flat(self.weight);
        for (range, fill, frame) in groups {
            if range.is_empty() {
                continue;
            }
            // A gradient or a pattern is bent with the letters it fills, as
            // it was when the mesh was run over the finished picture: each
            // glyph is a layer of its own, and its fill is stated in the
            // frame the mesh carries that glyph's own place to (the map's
            // tangent there, which within one letter is the map). A flat
            // colour is the same wherever it is bent to.
            let bent = mesh.filter(|_| !matches!(fill, Fill::Solid(_)));
            let (bends, transform, tol) = (self.bends, self.transform, self.tol);
            let Some(m) = bent else {
                let parts =
                    self.glyphs
                        .parts(range, flat, false, Join::Round, bends, transform, tol)?;
                let shader = Shader::new(fill, &transform.after(&frame), self.tiles);
                if let Some(p) = shader.and_then(|s| plan(parts, s, 1.0)) {
                    budget::push(planned, p)?;
                }
                continue;
            };
            for g in range {
                let parts =
                    self.glyphs
                        .parts(g..g + 1, flat, false, Join::Round, bends, transform, tol)?;
                let carried = self.glyphs.items[g].tangent(m).after(&frame);
                let shader = Shader::new(fill, &transform.after(&carried), self.tiles);
                if let Some(p) = shader.and_then(|s| plan(parts, s, 1.0)) {
                    budget::push(planned, p)?;
                }
            }
        }
        Ok(())
    }
}

/// Paints one job with the exact-area rasteriser.
///
/// Returns the pixels and where they go, in a raster no larger than the ink
/// (strokes included) needs, or `None` when the job draws nothing.
pub fn paint_job(engine: &mut Engine, request: &Request) -> Result<Option<Raster>, Error> {
    paint_job_with(engine, request, &Exact)
}

/// [`paint_job`] with a rasteriser of the caller's choice.
pub fn paint_job_with(
    engine: &mut Engine,
    request: &Request,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let _budget = budget::Scope::new();
    let glyphs = paint_letters(engine, request, rasterizer)?;
    // A box's brush ink, joined to its letters in the way this job paints
    // them: a silhouette, the letters, or the rims (`ink::join`).
    match &request.ink {
        Some(ink) => ink::join(glyphs, ink, request, rasterizer),
        None => Ok(glyphs),
    }
}

/// The letters of a job, without its ink.
fn paint_letters(
    engine: &mut Engine,
    request: &Request,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let Request {
        job,
        face,
        bold_draw,
        weight,
        transform,
        tiles,
        ..
    } = request;
    let face: Face = *face;
    let bold_draw = bold_draw.unwrap_or(BoldDraw::for_rule(engine.rules.bold_advance));
    // Validate both handles even when the job has no runs or draws nothing,
    // and those of every face its lines are set in.
    engine.font(face.font)?;
    engine.check_chain(face.chain)?;
    for f in &request.faces.faces {
        engine.font(f.font)?;
        engine.check_chain(f.chain)?;
    }
    if !transform.is_finite() || transform.invert().is_none() || !positive(face.size) {
        return Ok(None);
    }
    // The box's mesh, when it moves anything.
    let mesh = match &job.mesh {
        Some(m) => m.map()?,
        None => None,
    };
    let mesh = mesh.as_ref();
    // The flattening tolerance is a distance in device pixels. The outline
    // is flattened before the mesh bends it, and a mesh that enlarges it
    // enlarges each chord's distance from its curve as much as a transform
    // would, so it is flattened finer by that too (`MeshMap::stretch`).
    let tol = FLATTEN_TOLERANCE / (transform.max_scale() * magnified(mesh));
    // The weight is stated in device pixels and applied in job units, where
    // every other pen is: divided by the scale that keeps areas, which is
    // the scale itself for every transform that does not stretch one way
    // more than another.
    let weight = if positive(*weight) {
        *weight / transform.det().abs().sqrt()
    } else {
        0.0
    };

    if job
        .runs
        .iter()
        .any(|r| r.text.len() > budget::MAX_RUN_BYTES)
    {
        return Err(Error::BadSpec);
    }
    // Crisp only where a job y is a device y (no turn, no vertical mirror)
    // and nothing moves the outlines after they are fitted: a curved run's
    // letters are turned one by one, a mesh or a roughening bends them, and
    // a wobble moves and turns each letter on its own.
    let crisp = job.effects.crisp.filter(|_| {
        !job.curved
        && job.mesh.is_none()
        && job.roughen.is_none()
        && job.effects.wobble.is_none()
        && transform.0[1] == 0.0
        && transform.0[2] == 0.0
        && transform.0[3] > 0.0
    });
    // Every run's glyphs, and for each run the frame its fill is stated in.
    let mut glyphs = Glyphs::default();
    let mut runs = budget::Buffer::new();
    budget::reserve(&mut runs, job.runs.len())?;
    // Where each run's letters start in the count a wobble keys them by.
    let bases = match job.effects.wobble {
        Some(w) => wobble_bases(&job.runs, w.copies)?,
        None => Vec::new(),
    };
    // A curved line's runs, shaped as the line (`Effects::line`); `None`
    // shapes each run on its own. An afterimage is an SFX letter's, never a
    // line's. A curved job never carries faces (the decoder refuses one), so
    // the line is always in the job's face.
    let mut line = None;
    if job.curved && job.effects.line && !job.runs.iter().any(|r| r.ghost) {
        let texts = job.runs.iter().map(|r| r.text.as_str());
        line = shape::shape_line_runs(engine, face, texts, job.letter_spacing != 0.0)?
            .map(IntoIterator::into_iter);
    }
    for (i, run) in job.runs.iter().enumerate() {
        let spacing = if job.curved { 0.0 } else { job.letter_spacing };
        // A line set in several faces is shaped by its stretches, each in
        // its face: what the layout measured it by. From here on its glyphs
        // are glyphs like any other - each names its own font and synthetic
        // style, as a letter borrowed from a fallback font always has - so
        // the bands, the fill, a wobble, a mesh and a mask need nothing of
        // their own for it.
        let shaped = match (line.as_mut().and_then(Iterator::next), request.faces.of(i)) {
            (Some(shaped), _) => shaped,
            (None, Some(spans)) => shape_spans(engine, &spans, &run.text, spacing)?,
            (None, None) => shape_run(engine, face, &run.text, spacing)?,
        };
        let frame = if job.curved {
            // translate(x, y); rotate(rot); the glyph centred on the origin.
            let (sin, cos) = run.rot.sin_cos();
            Affine::translate(run.x, run.y).after(&Affine::rotate(cos, sin))
        } else {
            Affine::IDENTITY
        };
        // The glyph's own frame is the fill's, leaned and scaled; the fill
        // stays in `frame` so a gradient is not stretched per letter. A run
        // that is not scaled or leaned skips the product so its numbers are
        // the ones a plain curved run always had.
        // The outline is flattened after it is placed (`FlattenPen::map`),
        // so a bigger letter gets its finer chords from the frame itself.
        let glyph_frame = if job.curved && (run.sx, run.sy, run.skew) != (1.0, 1.0, 0.0) {
            // skewX(skew) * scale(sx, sy): y points down, so a positive
            // skew moves the top of the letter right.
            let lean = Affine([1.0, 0.0, -run.skew.tan(), 1.0, 0.0, 0.0]);
            frame.after(&lean.after(&Affine::scale(run.sx, run.sy)))
        } else {
            frame
        };
        let start = if job.curved {
            let (dx, dy) = curved_origin(engine, face, shaped.advance)?;
            glyph_frame.after(&Affine::translate(dx, dy))
        } else {
            Affine::translate(run.x + align_offset(job.align, shaped.advance), run.y)
        };
        let from = glyphs.len();
        let drip = if job.curved { run.drip } else { 0.0 };
        let pen = if job.curved { run.pen } else { 1.0 };
        glyphs.add_run(
            engine,
            &shaped,
            &start,
            bold_draw,
            drip,
            pen,
            job.effects.embolden,
            job.effects.slant,
            tol,
            job.effects.wobble.and_then(|wobble| {
                Some(Wobbling {
                    wobble,
                    text: &run.text,
                    base: (*bases.get(i)?)?,
                })
            }),
        )?;
        if let Some(grid) = crisp {
            let entry = engine.font(face.font)?;
            let per_unit = face.size / f64::from(entry.info.units_per_em);
            let (cap, x) = entry.zones();
            let zones = Zones {
                cap: cap.map(|v| f64::from(v) * per_unit),
                x: x.map(|v| f64::from(v) * per_unit),
            };
            glyphs.fit_to_grid(from..glyphs.len(), run.y, zones, transform, grid.y);
        }
        budget::push(&mut runs, (from..glyphs.len(), frame))?;
    }
    let all = 0..glyphs.len();
    if all.is_empty() {
        return Ok(None);
    }
    // The special effects that shape the letters (wire v14), drawn over the
    // letters' ink as one, so a pattern runs across the whole word. The
    // shapes added go with the last letter, whose fill fills them; what is
    // cut is cut from everything, last.
    let special = match job.effects.special.filter(Special::shapes_letters) {
        Some(sp) => {
            let ink = (0..job.runs.len())
                .filter(|&i| !job.runs[i].ghost)
                .filter_map(|i| glyphs.bounds_of(runs[i].0.clone()))
                .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3)));
            match ink {
                Some(ink) => Some(special::letter_shapes(&sp, face.size, ink)?),
                None => None,
            }
        }
        None => None,
    };
    if let Some(sh) = &special {
        let last = job.runs.len().checked_sub(1).filter(|&i| !job.runs[i].ghost);
        if let (Some(i), false) = (last, sh.adds.is_empty()) {
            glyphs.add_shape(&sh.adds)?;
            runs[i].0.end = glyphs.len();
        }
    }
    // And its roughening, which is stated in the box before the mesh bends it.
    let rough = match &job.roughen {
        Some(r) => r.map()?,
        None => None,
    };
    let bends = Bends {
        rough: rough.as_ref(),
        mesh,
    };

    let layers = Layers {
        job,
        glyphs: &glyphs,
        runs: &runs,
        bends,
        transform,
        tiles,
        tol,
        weight,
    };
    let ghosts: budget::Buffer<usize> =
        (0..job.runs.len()).filter(|&i| job.runs[i].ghost).collect();
    let letters: budget::Buffer<usize> = (0..job.runs.len())
        .filter(|&i| !job.runs[i].ghost)
        .collect();
    let shapes = special.as_deref();
    let planned = plan_letters(&layers, &ghosts, &letters, shapes)?;
    match shapes.filter(|sh| !sh.pieces.is_empty()) {
        Some(sh) => break_off(planned, &layers, &ghosts, &letters, sh, rasterizer),
        None => finish_planned(planned, within(job.effects.cuts), rasterizer),
    }
}

/// Every layer of the letters as `l` places them: the afterimages' fills,
/// the letters (or their silhouette), a no-fill's cut and the special
/// effects' cuts (`shapes`), as `Effects::cuts` asks; with `Cuts::Alone`
/// the cuts alone, opaque.
fn plan_letters<'a>(
    l: &Layers<'a>,
    ghosts: &[usize],
    letters: &[usize],
    shapes: Option<&special::Shapes>,
) -> Result<budget::Buffer<Planned<'a>>, Error> {
    let job = l.job;
    let fx = &job.effects;
    // The cuts alone: a box's own strokes cut by them as a glyph band is
    // (`Cuts::Alone`).
    if let Cuts::Alone(_) = fx.cuts {
        let mut planned = budget::Buffer::new();
        if let Some(p) = shapes.map(|sh| poly_plan(&sh.cuts, l.bends, l.transform, l.tiles, l.tol)).transpose()?.flatten() {
            budget::push(&mut planned, p)?;
        }
        return Ok(planned);
    }
    let mut planned: budget::Buffer<Planned<'a>> = budget::Buffer::new();
    // Afterimages under everything, their fills alone.
    l.fills(&mut planned, &ghosts)?;
    if let Some(color) = job.silhouette {
        // The letters and their widest band as one solid shape: grown by
        // half that band's pen (and a negative's grow, and the silhouette's
        // own), not a stroke laid over a fill. A band is not moved by the
        // weight, so the shape is as wide as the wider of the heavier fill
        // and the band.
        //
        // With no fill the glyphs are cut out of it below, so it is the band
        // alone that makes it: no band, no shape.
        let band = job.bands.first().map_or(0.0, |b| (b.line / 2.0).max(0.0));
        let pen = band + fx.negative.map_or(0.0, |n| n.grow) + fx.grow;
        if !job.no_fill || positive(pen) {
            let reach = Reach {
                pen,
                weight: if job.no_fill { 0.0 } else { l.weight },
            };
            let sel = l.glyphs_of(&letters);
            l.solid(&mut planned, sel, reach, false, fx.join, color, 1.0)?;
        }
    } else if fx.each {
        for &r in letters {
            l.letters(&mut planned, &[r])?;
        }
    } else {
        l.letters(&mut planned, &letters)?;
    }

    // No fill: the glyphs, as heavy as they would have been filled, are taken
    // out of everything laid down so far. A canvas does it with
    // `destination-out` after the bands (browser-painter.js). The cut is last
    // and reaches no further than the glyphs, which the bands already cover,
    // so it adds nothing to the surface; with nothing under it, it is not made.
    if job.no_fill && !planned.is_empty() {
        const OPAQUE: Fill = Fill::Solid(Rgba([0, 0, 0, 255]));
        let sel = l.glyphs_of(&letters);
        let parts = l.glyphs.parts(
            sel,
            Reach::flat(l.weight),
            false,
            Join::Round,
            l.bends,
            l.transform,
            l.tol,
        )?;
        let shader = Shader::new(&OPAQUE, l.transform, l.tiles);
        if let Some(mut p) = shader.and_then(|s| plan(parts, s, 1.0)) {
            p.erase = true;
            budget::push(&mut planned, p)?;
        }
    }
    // A special effect's cuts, out of everything: bent with the letters, so
    // a crack stays on the letter it crosses under a mesh.
    if fx.cuts == Cuts::Made && !planned.is_empty() {
        if let Some(mut p) = shapes.map(|sh| poly_plan(&sh.cuts, l.bends, l.transform, l.tiles, l.tol)).transpose()?.flatten() {
            p.erase = true;
            budget::push(&mut planned, p)?;
        }
    }
    Ok(planned)
}

/// The letters with a crack's pieces broken off (`special::Piece`):
/// `planned` (the letters where they stand) less every piece's outline, a
/// clean hole, and over them each piece that is not gone: the letters laid
/// again with the piece's rigid move, fill, bands, afterimages and cuts all
/// moved alike, kept inside its outline (less those laid before it), both
/// rastered where the piece lies, so its edges are as sharp as the
/// letters'. A box's own strokes read the letters whole with the holes
/// among the cuts (`Cuts`), so they are cut through at the holes too.
fn break_off<'a>(
    mut planned: budget::Buffer<Planned<'a>>,
    l: &Layers<'a>,
    ghosts: &[usize],
    letters: &[usize],
    shapes: &special::Shapes,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let fx = &l.job.effects;
    let outlines = |pieces: &[special::Piece]| {
        let mut p = Polys::default();
        for piece in pieces {
            piece.outline.iter().for_each(|&v| p.push(v));
            p.close();
        }
        p
    };
    let holes = outlines(&shapes.pieces);
    if matches!(fx.cuts, Cuts::Alone(_)) || !planned.is_empty() {
        if let Some(mut p) = poly_plan(&holes, l.bends, l.transform, l.tiles, l.tol)? {
            match fx.cuts {
                Cuts::Made => p.erase = true,
                Cuts::Alone(_) => {}
                Cuts::Skipped => p.alpha = 0.0,
            }
            if p.alpha > 0.0 {
                budget::push(&mut planned, p)?;
            }
        }
    }
    let mut out = finish_planned(planned, within(fx.cuts), rasterizer)?;
    // How far past a glyph's outline its layers reach (its widest band, a
    // grow, the weight): a glyph farther than that from a piece has nothing
    // inside it, so a piece lays only the glyphs near it. Bent letters move
    // off their outlines, so they lay them all.
    let reach = l.job.bands.iter().map(|b| b.line / 2.0).fold(0.0, f64::max)
        + fx.grow.max(0.0)
        + fx.negative.map_or(0.0, |n| n.grow.max(0.0))
        + l.weight
        + 1.0;
    let near = |outline: &[Pt]| -> Option<Vec<(core::ops::Range<usize>, Affine)>> {
        if !l.bends.is_empty() {
            return None;
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for v in outline {
            (x0, y0, x1, y1) = (x0.min(v.x), y0.min(v.y), x1.max(v.x), y1.max(v.y));
        }
        let hit = |g: usize| {
            l.glyphs.bounds_of(g..g + 1).is_some_and(|b| {
                b.0 - reach <= x1 && b.2 + reach >= x0 && b.1 - reach <= y1 && b.3 + reach >= y0
            })
        };
        let all = 0..l.glyphs.len();
        // None near: every run empty.
        let lo = all.clone().find(|&g| hit(g)).unwrap_or(0);
        let hi = all.rev().find(|&g| hit(g)).map_or(0, |g| g + 1);
        Some(
            l.runs
                .iter()
                .map(|(r, f)| {
                    let (a, b) = (r.start.max(lo), r.end.min(hi));
                    (a..b.max(a), *f)
                })
                .collect(),
        )
    };
    for (i, piece) in shapes.pieces.iter().enumerate() {
        let Some(m) = piece.moved else {
            continue;
        };
        let moved = l.transform.after(&m);
        let own = outlines(core::slice::from_ref(piece));
        let Some(mask) = poly_plan(&own, l.bends, &moved, l.tiles, l.tol)? else {
            continue;
        };
        let bx = match within(fx.cuts) {
            Some(c) => mask.bx.intersect(&c),
            None => mask.bx,
        };
        if bx.is_empty() {
            continue;
        }
        let mut cover = budget::Buffer::new();
        budget::push(&mut cover, mask)?;
        // The pieces before it that overlap it (the same move takes both).
        let bound = |o: &[Pt]| {
            o.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, v| {
                (b.0.min(v.x), b.1.min(v.y), b.2.max(v.x), b.3.max(v.y))
            })
        };
        let b = bound(&piece.outline);
        let mut earlier = Polys::default();
        for e in &shapes.pieces[..i] {
            let c = bound(&e.outline);
            if c.0 <= b.2 && c.2 >= b.0 && c.1 <= b.3 && c.3 >= b.1 {
                e.outline.iter().for_each(|&v| earlier.push(v));
                earlier.close();
            }
        }
        if let Some(mut e) = poly_plan(&earlier, l.bends, &moved, l.tiles, l.tol)? {
            e.erase = true;
            budget::push(&mut cover, e)?;
        }
        let cover = finish(cover, bx, rasterizer)?;
        let runs = near(&piece.outline);
        let li = Layers {
            job: l.job,
            glyphs: l.glyphs,
            runs: runs.as_deref().unwrap_or(l.runs),
            bends: l.bends,
            transform: &moved,
            tiles: l.tiles,
            tol: l.tol,
            weight: l.weight,
        };
        // Its cuts: only the crack lines that cross its box.
        let mut cuts = Polys::default();
        for c in shapes.cuts.contours() {
            let cb = bound(c);
            if cb.0 <= b.2 && cb.2 >= b.0 && cb.1 <= b.3 && cb.3 >= b.1 {
                c.iter().for_each(|&v| cuts.push(v));
                cuts.close();
            }
        }
        let own_cuts = special::Shapes { cuts, ..special::Shapes::default() };
        let copy = plan_letters(&li, ghosts, letters, Some(&own_cuts))?;
        if copy.is_empty() {
            continue;
        }
        let mut data = finish(copy, bx, rasterizer)?;
        for (px, c) in data.chunks_exact_mut(4).zip(cover.chunks_exact(4)) {
            let a = u32::from(c[3]);
            if a != 255 {
                px.iter_mut().for_each(|ch| *ch = ((u32::from(*ch) * a + 127) / 255) as u8);
            }
        }
        let piece = Raster {
            x: bx.x0,
            y: bx.y0,
            width: bx.width() as u32,
            height: bx.height() as u32,
            data,
        };
        out = Some(match out {
            Some(under) => over(under, &piece)?,
            None => piece,
        });
        budget::check()?;
    }
    Ok(out)
}

/// `top` laid over `under` (both premultiplied), in one raster as big as
/// both.
fn over(under: Raster, top: &Raster) -> Result<Raster, Error> {
    let bx = |r: &Raster| IBox {
        x0: r.x,
        y0: r.y,
        x1: r.x + r.width as i32,
        y1: r.y + r.height as i32,
    };
    let (a, b) = (bx(&under), bx(top));
    let u = a.union(&b);
    if u == a {
        let mut under = under;
        lay_over(&mut under.data, a, &top.data, b);
        return Ok(under);
    }
    let (width, height) = (u.width(), u.height());
    if width > MAX_SIDE as usize || height > MAX_SIDE as usize || width * height > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let mut data = budget::filled(width * height * 4, 0u8)?.into_vec();
    for y in 0..under.height as usize {
        let from = y * under.width as usize * 4;
        let to = ((y + (a.y0 - u.y0) as usize) * width + (a.x0 - u.x0) as usize) * 4;
        data[to..to + under.width as usize * 4].copy_from_slice(&under.data[from..from + under.width as usize * 4]);
    }
    lay_over(&mut data, u, &top.data, b);
    Ok(Raster {
        x: u.x0,
        y: u.y0,
        width: width as u32,
        height: height as u32,
        data,
    })
}

/// Source-over of premultiplied `src` (over `sb`) into `dst` (over `db`,
/// which holds `sb`).
fn lay_over(dst: &mut [u8], db: IBox, src: &[u8], sb: IBox) {
    let dw = db.width();
    let sw = sb.width();
    for y in 0..sb.height() {
        for x in 0..sw {
            let s = &src[(y * sw + x) * 4..][..4];
            let sa = u32::from(s[3]);
            if sa == 0 {
                continue;
            }
            let (dx, dy) = ((sb.x0 - db.x0) as usize + x, (sb.y0 - db.y0) as usize + y);
            let d = &mut dst[(dy * dw + dx) * 4..][..4];
            for c in 0..4 {
                d[c] = (u32::from(s[c]) + (u32::from(d[c]) * (255 - sa) + 127) / 255).min(255) as u8;
            }
        }
    }
}

/// Where a pass's raster may reach: the cuts alone, no further than the box
/// asks (`Cuts::Alone`); any other, all it paints.
fn within(cuts: Cuts) -> Option<IBox> {
    match cuts {
        Cuts::Alone(b) => Some(b),
        _ => None,
    }
}

/// The planned layers laid in one raster as big as what they paint (their
/// erasers reach no further), within `clip` when there is one. `None` with
/// nothing painted.
fn finish_planned(
    planned: budget::Buffer<Planned<'_>>,
    clip: Option<IBox>,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    budget::check()?;
    let Some(surface) = planned
        .iter()
        .filter(|p| !p.erase)
        .map(|p| p.bx)
        .reduce(|a, b| a.union(&b))
    else {
        return Ok(None);
    };
    let surface = clip.map_or(surface, |c| surface.intersect(&c));
    if surface.is_empty() {
        return Ok(None);
    }
    let (width, height) = (surface.width(), surface.height());
    if width > MAX_SIDE as usize || height > MAX_SIDE as usize || width * height > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let data = finish(planned, surface, rasterizer)?;
    Ok(Some(Raster {
        x: surface.x0,
        y: surface.y0,
        width: width as u32,
        height: height as u32,
        data,
    }))
}

/// `polys` (job space) as one opaque layer in device space, bent with the
/// letters, so a crack stays on the letter it crosses under a mesh. `None`
/// with nothing in it.
fn poly_plan<'a>(
    polys: &Polys,
    bends: Bends<'_>,
    transform: &'a Affine,
    tiles: &'a [Tile],
    tol: f64,
) -> Result<Option<Planned<'a>>, Error> {
    const OPAQUE: Fill = Fill::Solid(Rgba([0, 0, 0, 255]));
    if polys.is_empty() {
        return Ok(None);
    }
    let cut = match (bends.is_empty(), polys.bounds()) {
        (false, Some(b)) => match bends.cut(b, tol) {
            Some(c) => warp::bend(polys, |p| bends.at(p), c, tol)?.map(transform),
            None => polys.map(transform),
        },
        _ => polys.map(transform),
    };
    let mut parts = budget::Buffer::new();
    budget::push(&mut parts, Part::plain(cut))?;
    Ok(Shader::new(&OPAQUE, transform, tiles).and_then(|s| plan(parts, s, 1.0)))
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    #[test]
    fn thousands_of_parts_are_bounded_and_the_next_job_paints() {
        let mut engine = Engine::new();
        let path = format!(
            "{}/../src/test/fonts/DejaVuSans.ttf",
            env!("CARGO_MANIFEST_DIR")
        );
        let font = engine
            .add_font_bytes(std::fs::read(path).unwrap(), 0)
            .unwrap();
        let run = shape_run(&mut engine, Face::new(font, 40.0), &"I".repeat(6000), 0.0).unwrap();
        {
            let _scope = budget::Scope::new();
            budget::limit_for_test(64 * 1024);
            let _held = budget::filled(64 * 1024, 0u8).unwrap();
            // Exercise the production consumer. Failed outline callbacks have
            // no contours; bypassing its check would silently accept no ink.
            let mut glyphs = Glyphs::default();
            assert_eq!(
                glyphs.add_run(
                    &engine,
                    &run,
                    &Affine::IDENTITY,
                    BoldDraw::Outset,
                    0.0,
                    1.0,
                    0.0,
                    0.0,
                    FLATTEN_TOLERANCE,
                    None
                ),
                Err(Error::BadSpec)
            );
        }
        let mut scene = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        scene
            .add_line(&mut engine, Face::new(font, 40.), "I", 10., 50.)
            .unwrap();
        scene.fill(Rgba([0, 0, 0, 255])).unwrap();
        assert!(scene.into_rgba().unwrap().iter().any(|&v| v != 0));
    }
    #[test]
    fn scene_add_line_reports_a_latched_outline_failure() {
        let mut engine = Engine::new();
        let path = format!(
            "{}/../src/test/fonts/DejaVuSans.ttf",
            env!("CARGO_MANIFEST_DIR")
        );
        let font = engine
            .add_font_bytes(std::fs::read(path).unwrap(), 0)
            .unwrap();
        let mut scene = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        let _scope = budget::Scope::new();
        budget::limit_for_test(512);
        assert_eq!(
            scene.add_line(&mut engine, Face::new(font, 40.), "W", 10., 50.),
            Err(Error::BadSpec)
        );
        assert!(scene.into_rgba().is_err());
    }
    fn test_font(e: &mut Engine) -> crate::engine::FontId {
        e.add_font_bytes(
            std::fs::read(format!(
                "{}/../src/test/fonts/DejaVuSans.ttf",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
            0,
        )
        .unwrap()
    }
    #[test]
    fn raster_bytes_are_refused_before_preparing_edges() {
        struct MustNotPrepare;
        impl Rasterizer for MustNotPrepare {
            fn prepare(&self, _: &[Part], _: IBox) -> Result<Box<dyn raster::Coverage>, Error> {
                panic!("raster precheck must precede edges");
            }
        }
        let fill = Fill::Solid(Rgba([0, 0, 0, 255]));
        let p = Planned {
            parts: budget::Buffer::new(),
            bx: IBox {
                x0: 0,
                y0: 0,
                x1: 64,
                y1: 64,
            },
            shader: Shader::new(&fill, &Affine::IDENTITY, &[]).unwrap(),
            alpha: 1.,
            erase: false,
        };
        let planned = [p].into_iter().collect();
        let _scope = budget::Scope::new();
        budget::limit_for_test(64 * 64 * 4 - 1);
        assert_eq!(
            finish(
                planned,
                IBox {
                    x0: 0,
                    y0: 0,
                    x1: 64,
                    y1: 64
                },
                &MustNotPrepare
            )
            .err(),
            Some(Error::BadSpec)
        );
    }

    #[test]
    fn job_run_limit_precedes_work_on_any_earlier_run() {
        let mut e = Engine::new();
        let font = test_font(&mut e);
        let face = Face::new(font, 40.);
        e.measure_line(face, "W", crate::engine::ShapeMode::MEASURE)
            .unwrap();
        let before = e.line.clone();
        let req = Request {
            face,
            bold_draw: None,
            weight: 0.,
            transform: Affine::IDENTITY,
            tiles: vec![],
            ink: None,
            faces: Default::default(),
            job: job::Job {
                curved: false,
                align: job::Align::Left,
                letter_spacing: 0.,
                bands: vec![],
                silhouette: None,
                no_fill: false,
                fill: Some(Fill::Solid(Rgba([0, 0, 0, 255]))),
                mesh: None,
                roughen: None,
                effects: job::Effects::default(),
                runs: ["III".to_owned(), "I".repeat(262_145)]
                    .into_iter()
                    .map(|text| job::Run {
                        text,
                        x: 10.,
                        y: 50.,
                        rot: 0.,
                        sx: 1.,
                        sy: 1.,
                        skew: 0.,
                        drip: 0.,
                        pen: 1.0,
                        ghost: false,
                        fill: None,
                    })
                    .collect(),
            },
        };
        assert_eq!(paint_job(&mut e, &req).err(), Some(Error::BadSpec));
        assert_eq!(e.line, before);
    }
}

#[cfg(test)]
mod bends_tests {
    use super::*;

    fn bumpy() -> warp::Mesh {
        let mut pts = Vec::new();
        for j in 0..=3u32 {
            for i in 0..=3u32 {
                pts.push(Pt::new(
                    200.0 * f64::from(i) / 3.0,
                    120.0 * f64::from(j) / 3.0,
                ));
            }
        }
        pts[5] = Pt::new(pts[5].x - 12.0, pts[5].y - 18.0);
        pts[10] = Pt::new(pts[10].x - 20.0, pts[10].y - 12.0);
        warp::Mesh {
            cols: 3,
            rows: 3,
            pts,
            x: 20.0,
            y: 30.0,
            w: 200.0,
            h: 120.0,
        }
    }

    fn rough() -> roughen::Roughen {
        roughen::Roughen {
            amount: 6.0,
            detail: 0.07,
            seed: 7.0,
            origin: Pt::new(20.0, 30.0),
            grit: 1.5,
        }
    }

    /// The letters' map before it was shared (a858107), written out by
    /// hand: their drip, then the roughening, then the mesh, and the cut
    /// as a left fold of every map's own.
    #[test]
    fn the_shared_map_is_roughen_then_mesh_bit_for_bit_and_cuts_as_the_old_fold() {
        let m = bumpy();
        let mesh = m.map().unwrap().unwrap();
        let rough = rough().map().unwrap().unwrap();
        let drip = warp::Drip {
            mid: 60.0,
            bottom: 110.0,
            pull: 9.0,
        };
        let (bounds, tol) = ((25.0, 40.0, 180.0, 130.0), 0.01);
        for (r, ms) in [(true, true), (true, false), (false, true), (false, false)] {
            let bends = Bends {
                rough: r.then_some(&rough),
                mesh: ms.then_some(&mesh),
            };
            for i in 0..200 {
                let p = Pt::new(15.0 + f64::from(i) * 1.13, 25.0 + f64::from(i * 7 % 130));
                let mut want = p;
                if r {
                    want = rough.at(want);
                }
                if ms {
                    want = mesh.at(want);
                }
                let got = bends.at(p);
                assert_eq!(
                    (got.x.to_bits(), got.y.to_bits()),
                    (want.x.to_bits(), want.y.to_bits())
                );
            }
            for with_drip in [false, true] {
                let old = [
                    with_drip.then(|| drip.cut(tol)),
                    r.then(|| rough.cut(tol)),
                    ms.then(|| mesh.cut(bounds, tol)),
                ];
                let mut old = old.into_iter().flatten();
                let old = old.next().map(|first| old.fold(first, Cut::both));
                let new = match (with_drip.then(|| drip.cut(tol)), bends.cut(bounds, tol)) {
                    (None, None) => None,
                    (Some(d), None) => Some(d),
                    (None, Some(b)) => Some(b),
                    (Some(d), Some(b)) => Some(d.both(b)),
                };
                assert_eq!(new, old, "rough {r}, mesh {ms}, drip {with_drip}");
            }
        }
    }
}

#[cfg(test)]
mod wobble_tests {
    use super::*;
    use crate::FontId;

    fn font(file: &str) -> (Engine, FontId) {
        let path = format!("{}/../src/test/fonts/{file}", env!("CARGO_MANIFEST_DIR"));
        let mut engine = Engine::new();
        let font = engine
            .add_font_bytes(std::fs::read(path).unwrap(), 0)
            .unwrap();
        (engine, font)
    }

    const WOBBLE: Wobble = Wobble {
        amount: 0.2,
        tilt: 15.0,
        seed: 7,
        copies: 0,
    };

    /// One glyph as a wobble left it: the letter number its cluster starts
    /// at in the job's text (`None` for a space or a hyphen), how far its
    /// ink moved (its bounds' four edges less the unwobbled glyph's), and
    /// its points before and after.
    struct Moved {
        letter: Option<usize>,
        by: [f64; 4],
        plain: Vec<Pt>,
        wobbled: Vec<Pt>,
    }

    /// The glyphs of `lines`, laid as the runs of one job in `file`, each
    /// line counting on from the letters of the lines before it as
    /// `paint_letters` counts them. A move is the same wherever the line
    /// puts the glyph.
    fn moves_in(file: &str, lines: &[&str]) -> Vec<Moved> {
        let (mut engine, font) = font(file);
        let face = Face::new(font, 40.0);
        let mut out = Vec::new();
        let mut base = 0;
        for (i, line) in lines.iter().enumerate() {
            let run = shape_run(&mut engine, face, line, 0.0).unwrap();
            let at = Affine::translate(3.0 * i as f64, 60.0 * i as f64);
            let tol = FLATTEN_TOLERANCE;
            let (mut plain, mut wobbled) = (Glyphs::default(), Glyphs::default());
            plain
                .add_run(&engine, &run, &at, BoldDraw::Outset, 0.0, 1.0, 0.0, 0.0, tol, None)
                .unwrap();
            let w = Some(Wobbling {
                wobble: WOBBLE,
                text: line,
                base,
            });
            wobbled
                .add_run(&engine, &run, &at, BoldDraw::Outset, 0.0, 1.0, 0.0, 0.0, tol, w)
                .unwrap();
            // A space has no ink and is no item.
            let starts = |g: &&Placed| {
                let mut u = 0;
                let c = line.chars().find(|c| {
                    let here = u == g.cluster;
                    u += c.len_utf16() as u32;
                    here
                });
                !c.unwrap().is_whitespace()
            };
            let inked: Vec<&Placed> = run.glyphs.iter().filter(starts).collect();
            assert_eq!(plain.items.len(), inked.len());
            for ((g, p), w) in inked.iter().zip(plain.items.iter()).zip(wobbled.items.iter()) {
                let (a, b) = (p.polys.bounds().unwrap(), w.polys.bounds().unwrap());
                out.push(Moved {
                    letter: letter_at(line, g.cluster).map(|n| base + n),
                    by: [b.0 - a.0, b.1 - a.1, b.2 - a.2, b.3 - a.3],
                    plain: p.polys.pts.to_vec(),
                    wobbled: w.polys.pts.to_vec(),
                });
            }
            base += letters_in(line);
        }
        out
    }

    fn moves(lines: &[&str]) -> Vec<[f64; 4]> {
        moves_in("Bangers-Regular.ttf", lines).iter().map(|m| m.by).collect()
    }

    fn same(a: &[[f64; 4]], b: &[[f64; 4]]) {
        assert_eq!(a.len(), b.len());
        for (i, (x, y)) in a.iter().zip(b).enumerate() {
            for k in 0..4 {
                assert!((x[k] - y[k]).abs() < 1e-6, "letter {i}: {x:?} against {y:?}");
            }
        }
    }

    /// The move of each letter, by its number, from the first glyph of its
    /// cluster.
    fn by_letter(m: &[Moved]) -> std::collections::BTreeMap<usize, [f64; 4]> {
        let mut out = std::collections::BTreeMap::new();
        for g in m {
            if let Some(n) = g.letter {
                out.entry(n).or_insert(g.by);
            }
        }
        out
    }

    #[test]
    fn a_rewrap_gives_every_letter_the_move_it_had() {
        let one = moves(&["WOBBLE THESE LETTERS ABOUT"]);
        // Every letter moves, and not all by the same.
        assert!(one.iter().all(|m| m.iter().any(|v| v.abs() > 1e-3)));
        assert!(one.windows(2).any(|w| (w[0][1] - w[1][1]).abs() > 0.5));
        same(&one, &moves(&["WOBBLE THESE", "LETTERS ABOUT"]));
        same(&one, &moves(&["WOBBLE", "THESE LETTERS", "ABOUT"]));
        // A word hyphenated across two lines: the hyphen is no letter and
        // does not move, and the letters after it keep their numbers.
        let mut cut = moves(&["WOBBLE THESE LET-", "TERS ABOUT"]);
        let hyphen = cut.remove(14);
        assert_eq!(hyphen, [0.0; 4]);
        same(&one, &cut);
    }

    #[test]
    fn a_ligature_a_hyphen_splits_keeps_every_letter_its_move() {
        let file = "DejaVuSans.ttf";
        let whole = moves_in(file, &["office hours"]);
        // The font joins letters here (fewer glyphs than letters, the space
        // aside), so the count is of letters, not of glyphs.
        assert!(whole.len() < "officehours".len(), "no ligature to test");
        let cut = moves_in(file, &["of-", "fice hours"]);
        let (a, b) = (by_letter(&whole), by_letter(&cut));
        // Every letter after the joined ones (c onward, letter 4) moves the
        // same in both layouts. Before it the glyphs differ (a ligature
        // against single letters), so their bounds move differently.
        let mut shared = 0;
        for (n, m) in b.range(4..) {
            if let Some(w) = a.get(n) {
                same(&[*w], &[*m]);
                shared += 1;
            }
        }
        // c, e and the five of "hours" at least.
        assert!(shared >= 7, "{shared}");
        assert_eq!(a.keys().last(), b.keys().last());
    }

    #[test]
    fn a_right_to_left_run_numbers_its_letters_in_the_order_they_are_written() {
        let file = "DejaVuSans.ttf";
        let word = "\u{5e9}\u{5dc}\u{5d5}\u{5dd}";
        let run = moves_in(file, &[word]);
        assert_eq!(run.len(), 4);
        // The shaper gives the last letter first.
        assert_eq!(run[0].letter, Some(3));
        for (n, c) in word.chars().enumerate() {
            let alone = moves_in(file, &["", &"x".repeat(n), &c.to_string()]);
            let mine = run.iter().find(|m| m.letter == Some(n)).unwrap();
            same(&[alone.last().unwrap().by], &[mine.by]);
        }
    }

    #[test]
    fn a_mark_turns_with_its_letter_about_the_letter_s_middle() {
        // q has no accented form, so the accent stays a glyph of its own in
        // the letter's cluster.
        let got = moves_in("DejaVuSans.ttf", &["q\u{301}"]);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].letter, Some(0));
        assert_eq!(got[1].letter, Some(0));
        let dy = WOBBLE.amount * 40.0 * crate::seeded::noise(7, 0, 0, 0);
        let turn = WOBBLE.tilt.to_radians() * crate::seeded::noise(7, 0, 0, 1);
        assert!(turn.abs() > 1e-3);
        // The base is the bigger ink; its middle, moved by dy, is the one
        // middle both glyphs turn about.
        let bounds = |p: &[Pt]| {
            let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for q in p {
                b = (b.0.min(q.x), b.1.min(q.y), b.2.max(q.x), b.3.max(q.y));
            }
            b
        };
        let (l, t, r, b) = bounds(&got[0].plain);
        let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0 + dy);
        let (sin, cos) = turn.sin_cos();
        for g in &got {
            for (p, w) in g.plain.iter().zip(&g.wobbled) {
                let (x, y) = (p.x - cx, p.y + dy - cy);
                let want = (cx + x * cos - y * sin, cy + x * sin + y * cos);
                assert!((w.x - want.0).abs() < 1e-6 && (w.y - want.1).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn typing_at_the_end_leaves_the_letters_before_it_still() {
        let short = moves(&["WOBBLE THES"]);
        let long = moves(&["WOBBLE THESE LETTERS"]);
        same(&short, &long[..short.len()]);
    }

    #[test]
    fn a_letter_moves_no_further_than_the_amount_and_the_tilt_allow() {
        // Up or down by at most a fifth of 40, plus what a 15 degree turn
        // about its middle adds to a letter at most 40 high.
        let reach = 0.2 * 40.0 + 20.0 * 15f64.to_radians().sin() + 1e-6;
        for m in moves(&["WOBBLE THESE LETTERS ABOUT"]) {
            assert!(m.iter().all(|v| v.abs() <= reach), "{m:?}");
        }
    }

    fn run(text: &str, ghost: bool) -> Run {
        Run {
            text: text.into(),
            x: 0.0,
            y: 0.0,
            rot: 0.0,
            sx: 1.0,
            sy: 1.0,
            skew: 0.0,
            drip: 0.0,
            fill: None,
            pen: 1.0,
            ghost,
        }
    }

    #[test]
    fn an_arc_counts_its_letters_one_run_each_and_skips_its_spaces() {
        let runs: Vec<Run> = ["W", "O", " ", "B", "-", "Y"].iter().map(|t| run(t, false)).collect();
        assert_eq!(
            wobble_bases(&runs, 0).unwrap(),
            [Some(0), Some(1), Some(2), Some(2), Some(3), Some(3)]
        );
        // The same letters on one line are numbered the same.
        let line = "WO B-Y";
        let at = |n: u32| letter_at(line, n);
        assert_eq!([at(0), at(1), at(3), at(5)], [Some(0), Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn a_trail_s_copies_take_their_letter_s_numbers() {
        // Two copies behind each letter, laid first, in the letters' order.
        let mut runs: Vec<Run> = ["B", "B", "O", "O", "O", "O", "M", "M"]
            .iter()
            .map(|t| run(t, true))
            .collect();
        runs.extend(["B", "O", "O", "M"].iter().map(|t| run(t, false)));
        let want = [0, 0, 1, 1, 2, 2, 3, 3, 0, 1, 2, 3].map(Some);
        assert_eq!(wobble_bases(&runs, 2).unwrap(), want);
        // The copies alone, as a box paints its afterimages apart, keep
        // their numbers.
        assert_eq!(wobble_bases(&runs[..8], 2).unwrap(), want[..8]);
        // With no count of copies, no copy wobbles.
        assert_eq!(wobble_bases(&runs[..2], 0).unwrap(), [None, None]);
    }
}
