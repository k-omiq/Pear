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
mod outline;
mod pattern;
mod raster;
mod roughen;
mod scene;
mod screen;
mod shade;
mod shape;
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
    decode_box, paint_box, paint_box_copy_by_copy, paint_box_with, BoxRequest, Clip, ClipMode,
    ClipShape, Shadow, Tap, BOX_MAGIC, BOX_WIRE_VERSION, MAX_PAGE,
};
use geom::positive;
pub use geom::{Affine, IBox, Polys, Pt};
pub use job::{
    decode, decode_swatch, Align, Band, Effects, Fill, Job, Negative, Request, Rgba, Run, Stop,
    Tile, MAGIC, MAX_WEIGHT, MITER_LIMIT, WIRE_VERSION,
};
pub(crate) use outline::glyph_polys;
pub use outline::FLATTEN_TOLERANCE;
pub use pattern::{tile as pattern_tile, Kind as PatternKind, MAX_TILE_SIDE};
pub use raster::{Coverage, Exact, Part, Rasterizer, STRIP_ROWS};
pub use roughen::Roughen;
pub use scene::Scene;
pub use screen::{swatch as pattern_swatch, Screen, KIND_NAMES};
pub use shape::{align_offset, curved_origin, shape_run, Placed, ShapedRun};
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
    /// `embolden` and `slant` are the job's ([`job::Effects`]).
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
    ) -> Result<(), Error> {
        for g in &run.glyphs {
            let entry = engine.font(g.font)?;
            let per_unit = g.size / f64::from(entry.info.units_per_em);
            let skew = slant
                + if g.synth.oblique {
                    f64::from(OBLIQUE_SKEW)
                } else {
                    0.0
                };
            let mut polys = Polys::default();
            let place = frame.after(&Affine::translate(g.x, g.y));
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
            let drip = match polys.bounds() {
                Some((_, top, _, bottom)) if positive(drip) && bottom > top => Some(warp::Drip {
                    mid: (top + bottom) / 2.0,
                    bottom,
                    pull: drip,
                }),
                _ => None,
            };
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
        Ok(())
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
    // Validate both handles even when the job has no runs or draws nothing.
    engine.font(face.font)?;
    engine.check_chain(face.chain)?;
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
    // Every run's glyphs, and for each run the frame its fill is stated in.
    let mut glyphs = Glyphs::default();
    let mut runs = budget::Buffer::new();
    budget::reserve(&mut runs, job.runs.len())?;
    for run in &job.runs {
        let spacing = if job.curved { 0.0 } else { job.letter_spacing };
        let shaped = shape_run(engine, face, &run.text, spacing)?;
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
        )?;
        budget::push(&mut runs, (from..glyphs.len(), frame))?;
    }
    let all = 0..glyphs.len();
    if all.is_empty() {
        return Ok(None);
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

    let fx = &job.effects;
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

    let mut planned: budget::Buffer<Planned<'_>> = budget::Buffer::new();
    // Afterimages under everything, their fills alone.
    layers.fills(&mut planned, &ghosts)?;
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
                weight: if job.no_fill { 0.0 } else { weight },
            };
            let sel = layers.glyphs_of(&letters);
            layers.solid(&mut planned, sel, reach, false, fx.join, color, 1.0)?;
        }
    } else if fx.each {
        for &r in &letters {
            layers.letters(&mut planned, &[r])?;
        }
    } else {
        layers.letters(&mut planned, &letters)?;
    }

    // No fill: the glyphs, as heavy as they would have been filled, are taken
    // out of everything laid down so far. A canvas does it with
    // `destination-out` after the bands (browser-painter.js). The cut is last
    // and reaches no further than the glyphs, which the bands already cover,
    // so it adds nothing to the surface; with nothing under it, it is not made.
    if job.no_fill && !planned.is_empty() {
        const OPAQUE: Fill = Fill::Solid(Rgba([0, 0, 0, 255]));
        let sel = layers.glyphs_of(&letters);
        let parts = glyphs.parts(
            sel,
            Reach::flat(weight),
            false,
            Join::Round,
            bends,
            transform,
            tol,
        )?;
        let shader = Shader::new(&OPAQUE, transform, tiles);
        if let Some(mut p) = shader.and_then(|s| plan(parts, s, 1.0)) {
            p.erase = true;
            budget::push(&mut planned, p)?;
        }
    }
    budget::check()?;
    let Some(surface) = planned
        .iter()
        .filter(|p| !p.erase)
        .map(|p| p.bx)
        .reduce(|a, b| a.union(&b))
    else {
        return Ok(None);
    };
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
                    FLATTEN_TOLERANCE
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
