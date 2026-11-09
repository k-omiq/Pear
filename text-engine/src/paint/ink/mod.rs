//! Brush ink, painted in the box job.
//!
//! A box's hand-drawn strokes (`style.ink`) were painted by the canvas
//! (`drawInk` in `src/lib/text-paint.js`) over the engine's letters, so a box
//! with ink kept every canvas pass and none of the layer effects. Here the
//! engine paints the ink itself, as content of the box: once per box job
//! ([`Ink::prepare`]), in device pixels, and joined to the letters in every
//! way the box job paints them ([`join`]), so a shadow, a glow, an overlay,
//! a stroke effect and a bevel all take their shape from the letters and
//! the ink together.
//!
//! ```text
//! stamps.rs   strokeStamps: a stored stroke as its dabs (brush.js's twin)
//! tips.rs     imported tips: the engine's cache of them, their halvings,
//!             the sampler a stamp reads one with
//! pixels.rs   the passes over a finished stroke: grain, watercolour edge,
//!             anti-aliasing grade, Compare density
//! ```
//!
//! The ink is laid as `drawInk` lays it: each stroke's dabs into a layer of
//! its own (a round dab, hard or soft, flattened, turned), the dabs of a
//! stroke faded by the opacity dynamics laid densest-wins, the stroke's
//! passes over it on straight eight bits as `getImageData` reads them, then
//! laid on the ink under it at the stroke's opacity, or compared by
//! density. The finish is the box's own outlines (`job.bands`) round the
//! whole of the ink: the distance from every pixel to the ink, at half of
//! the ink's densest alpha (`paintFinish`). The finish's shadows are the box
//! job's own, thrown from one silhouette of letters, ink and outlines.
//!
//! A dab is the round one or an imported tip (`stampTip`): the tip's
//! coverage drawn into its rectangle under the stamp's turn, flips and
//! flatness, read bilinear from the level `pickTipLevel` picks (nearest with
//! anti-aliasing None); a ribbon unrolls the tip along the path in slices
//! (`sliceTip`). The colour is the stroke's, laid at composite. A tip the
//! engine has not been given is the round dab (`tipFor`); a tip of a cycle
//! it has not been given is the stroke's own.

mod pixels;
pub mod stamps;
pub mod tips;

pub use stamps::{stroke_bounds, stroke_stamps, Stamp};
pub use tips::Tip;

use std::rc::Rc;

use super::budget;
use super::fx::distance;
use super::geom::{Affine, IBox, Polys, Pt};
use super::job::{Job, Request, Rgba};
use super::raster::{pixel_box, strip_of, Part, Rasterizer, STRIP_ROWS};
use super::roughen::{RoughMap, Roughen};
use super::warp::{self, Mesh};
use super::{magnified, Bends, Raster, MAX_PIXELS, MAX_SIDE};
use crate::Error;
use pixels::clamped;
use stamps::js_round;

/// Where a stored point keeps its factors: width, opacity, thickness.
pub const PT_W: usize = 2;
pub const PT_O: usize = 3;
pub const PT_F: usize = 4;

/// Most strokes a box's ink takes, and most points over all of them. Guards
/// against a bad job, well past what a person draws.
pub const MAX_STROKES: usize = 4096;
pub const MAX_POINTS: usize = 1 << 20;
/// Most tips the tip table names, and the longest key.
pub const MAX_TIPS: usize = 4096;
pub const MAX_TIP_KEY: usize = 1024;
/// The tip index that is the round dab.
pub const ROUND: u32 = u32::MAX;
/// Largest coordinate a point or the ink's corner may have, job units.
const MAX_COORD: f64 = 65536.0;

/// CSP's Flip horizontal / Flip vertical.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flip {
    Off,
    On,
    Random,
}

/// CSP's Repeat method for a tip cycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TipOrder {
    Repeat,
    Reverse,
    Once,
    Random,
}

/// A taper at one end of a stroke.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Taper {
    pub on: bool,
    /// `len` is a percentage of the size, not px.
    pub pct: bool,
    pub len: f64,
    /// 0 a straight ramp, 100 a fine point.
    pub ratio: f64,
}

/// One stored stroke, as `normalizeInkStroke` (`src/lib/data.js`) keeps it.
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub ribbon: bool,
    pub follow_dir: bool,
    pub darken_tips: bool,
    /// Compare density, not plain over.
    pub density: bool,
    pub water_edge: bool,
    /// The grain, and its Emphasize density.
    pub texture: bool,
    pub texture_stress: bool,
    /// 0 None to 3 Strong.
    pub antialias: u8,
    pub flip_x: Flip,
    pub flip_y: Flip,
    pub tip_order: TipOrder,
    pub taper_in: Taper,
    pub taper_out: Taper,
    /// Opaque.
    pub color: Rgba,
    pub opacity: f64,
    pub size: f64,
    pub spacing: f64,
    pub hardness: f64,
    pub angle: f64,
    pub angle_jitter: f64,
    pub flatness: f64,
    pub corners: f64,
    pub water_edge_width: f64,
    pub water_edge_power: f64,
    pub water_edge_dark: f64,
    pub water_edge_blur: f64,
    pub texture_density: f64,
    pub texture_scale: f64,
    /// As the stroke stores it: cut to 32 bits where it is used.
    pub seed: f64,
    /// The stroke's imported tip, an index into the tip table; `None` is
    /// the round dab.
    pub tip: Option<u32>,
    /// The tip cycle, by index; an entry not in hand is `None`.
    pub cycle: Vec<Option<u32>>,
    /// `[x, y, width, opacity, thickness]`, the factors 1 where the stroke
    /// stored none.
    pub pts: Vec<[f64; 5]>,
}

impl Default for Stroke {
    /// `normalizeInkStroke`'s defaults, with no points.
    fn default() -> Self {
        let taper = Taper {
            on: false,
            pct: false,
            len: 20.0,
            ratio: 60.0,
        };
        Self {
            ribbon: false,
            follow_dir: false,
            darken_tips: false,
            density: false,
            water_edge: false,
            texture: false,
            texture_stress: false,
            antialias: 3,
            flip_x: Flip::Off,
            flip_y: Flip::Off,
            tip_order: TipOrder::Repeat,
            taper_in: taper,
            taper_out: taper,
            color: Rgba([0, 0, 0, 255]),
            opacity: 1.0,
            size: 24.0,
            spacing: 10.0,
            hardness: 100.0,
            angle: 0.0,
            angle_jitter: 0.0,
            flatness: 1.0,
            corners: 0.0,
            water_edge_width: 4.0,
            water_edge_power: 0.5,
            water_edge_dark: 0.0,
            water_edge_blur: 0.0,
            texture_density: 0.5,
            texture_scale: 100.0,
            seed: 1.0,
            tip: None,
            cycle: Vec::new(),
            pts: Vec::new(),
        }
    }
}

/// A box's ink: its strokes, where the box's corner is in the job, and,
/// once the box job has laid it, the pixels.
pub struct Ink {
    /// The box's top-left in job units: the strokes are stated from it.
    pub origin: Pt,
    /// The tip table, by key (`tips`): what a stroke's tip and cycle index.
    pub tips: Vec<String>,
    /// Each key's tip, where the engine holds it (`name_tips`).
    resolved: Vec<Option<Rc<Tip>>>,
    pub strokes: Vec<Stroke>,
    /// The box job's rim pass: the outlines round the ink with the ink cut
    /// out of them, and not the ink (`join`).
    pub(crate) rims: bool,
    /// The ink laid under one transform and one set of bends (`prepare`),
    /// and what it was laid for.
    layer: Option<InkLayer>,
    prepared_for: Option<Laying>,
}

/// What a laid ink layer is laid for: the transform, and the job's mesh and
/// roughening, which bend it. A pass of the box job with any other is laid
/// again (`join`).
type Laying = (Affine, Option<Mesh>, Option<Roughen>);

fn laying(transform: &Affine, job: &Job) -> Laying {
    (*transform, job.mesh.clone(), job.roughen)
}

impl Ink {
    pub fn new(origin: Pt, strokes: Vec<Stroke>) -> Self {
        Self {
            origin,
            tips: Vec::new(),
            resolved: Vec::new(),
            strokes,
            rims: false,
            layer: None,
            prepared_for: None,
        }
    }

    /// Names the tip table, `keys`, and takes each key's tip from the
    /// engine's cache (`tips::with_cache`), where it is; one it does not
    /// hold paints round. Names them for the job being prepared, so none is
    /// let go before it is painted.
    pub fn name_tips(&mut self, keys: Vec<String>) {
        self.resolved = tips::with_cache(|c| keys.iter().map(|k| c.get(k)).collect());
        self.tips = keys;
    }

    /// Lays the ink under `transform`, cut to `surface`, for every pass of a
    /// box job that follows. `reach` is how far, in job units, an outline or
    /// a silhouette can be grown round it (the widest band's half and the
    /// most a shadow grows it).
    /// The ink is bent by the job's mesh and roughened by its field, as the
    /// letters are (`Bends`).
    pub(crate) fn prepare(
        &mut self,
        transform: &Affine,
        job: &Job,
        surface: IBox,
        reach: f64,
        rasterizer: &dyn Rasterizer,
    ) -> Result<(), Error> {
        self.layer = with_bends(job, transform, |bend| {
            InkLayer::build(
                self.origin,
                &self.strokes,
                &self.resolved,
                transform,
                Some(surface),
                reach,
                bend,
                rasterizer,
            )
        })?;
        self.prepared_for = Some(laying(transform, job));
        Ok(())
    }

    /// The ink alone, straight RGBA8: what a box with no fill keeps of it
    /// under its interior effects. `None` when it has not been laid or lays
    /// nothing.
    pub(crate) fn content(&self) -> Option<Raster> {
        let l = self.layer.as_ref()?;
        let mut out = vec![0u8; l.alpha.len() * 4];
        for (o, p) in out
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(l.content.as_chunks::<4>().0.iter())
        {
            o.copy_from_slice(&straight(p));
        }
        trimmed(l.bx, out)
    }
}

/// The laid ink, in device pixels over `bx`.
struct InkLayer {
    bx: IBox,
    /// Premultiplied RGBA.
    content: budget::Buffer<f32>,
    /// Its alpha as eight bits, as the canvas reads it back.
    alpha: budget::Buffer<u8>,
    /// Where the ink is, for the finish: half of its densest alpha.
    t: u8,
    /// Each pixel's distance to the ink, device px, where something is
    /// grown round it.
    dist: Option<budget::Buffer<f32>>,
}

/// A premultiplied pixel as straight RGBA8, the way `getImageData` reads a
/// canvas.
fn straight(p: &[f32]) -> [u8; 4] {
    let a = js_round(f64::from(p[3]) * 255.0).clamp(0.0, 255.0);
    if a <= 0.0 {
        return [0; 4];
    }
    let k = 255.0 / f64::from(p[3]);
    [
        clamped(js_round(f64::from(p[0]) * k)),
        clamped(js_round(f64::from(p[1]) * k)),
        clamped(js_round(f64::from(p[2]) * k)),
        a as u8,
    ]
}

/// Straight RGBA8 as premultiplied.
fn premul(p: &[u8]) -> [f32; 4] {
    let a = f32::from(p[3]) / 255.0;
    [
        f32::from(p[0]) / 255.0 * a,
        f32::from(p[1]) / 255.0 * a,
        f32::from(p[2]) / 255.0 * a,
        a,
    ]
}

/// `src` over `dst`, premultiplied, `src` faded by `k`.
fn over(dst: &mut [f32], src: [f32; 4], k: f32) {
    let ia = 1.0 - src[3] * k;
    for c in 0..4 {
        dst[c] = src[c] * k + dst[c] * ia;
    }
}

/// `boundsRect`: a box-local rectangle through `t` into whole device pixels,
/// grown by `pad`, cut to `surface`.
fn bounds_rect(
    (x0, y0, x1, y1): (f64, f64, f64, f64),
    t: &Affine,
    surface: IBox,
    pad: f64,
) -> Option<IBox> {
    let (mut ax, mut ay, mut bx, mut by) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
        let p = t.apply(Pt::new(x, y));
        ax = ax.min(p.x);
        bx = bx.max(p.x);
        ay = ay.min(p.y);
        by = by.max(p.y);
    }
    let limit = 1e9;
    if !(ax > -limit && ay > -limit && bx < limit && by < limit) {
        return None;
    }
    let r = IBox {
        x0: (ax - pad).floor() as i32,
        y0: (ay - pad).floor() as i32,
        x1: (bx + pad).ceil() as i32,
        y1: (by + pad).ceil() as i32,
    }
    .intersect(&surface);
    (!r.is_empty()).then_some(r)
}

/// `wantsWaterEdge`.
fn wants_water_edge(k: &Stroke) -> bool {
    k.water_edge && k.water_edge_power > 0.0 && k.water_edge_width > 0.0
}

/// How flat a round dab's polygon may be from its circle, device px.
const DAB_TOLERANCE: f64 = 0.02;

/// What bends a box's ink: the box's roughening and mesh, the letters' own
/// map (`Bends`), and how close to the bent outline a bent stamp's polygon
/// stays, job units.
#[derive(Clone, Copy)]
pub(crate) struct Bend<'a> {
    bends: Bends<'a>,
    tol: f64,
}

/// `f` with the bends `job` states, or `None` where nothing bends (no mesh,
/// one that moves nothing, no roughening): the ink is then laid as it always
/// was, to the byte. The tolerance is the letters' rule (`paint_letters`):
/// a device distance, finer by as much as the mesh enlarges.
fn with_bends<R>(
    job: &Job,
    transform: &Affine,
    f: impl FnOnce(Option<Bend<'_>>) -> Result<R, Error>,
) -> Result<R, Error> {
    let mesh = match &job.mesh {
        Some(m) => m.map()?,
        None => None,
    };
    let rough = match &job.roughen {
        Some(r) => r.map()?,
        None => None,
    };
    let bends = Bends {
        rough: rough.as_ref(),
        mesh: mesh.as_ref(),
    };
    if bends.is_empty() {
        return f(None);
    }
    let tol = DAB_TOLERANCE / (transform.max_scale() * magnified(mesh.as_ref()));
    f(Some(Bend { bends, tol }))
}

/// How far a bent ribbon slice's polygon reaches past the chords its top and
/// foot are cut on, device px: more than a pixel's half-diagonal, so a pixel
/// whose centre is inside is covered by the slice's sides alone.
const CHORD_REACH: f64 = 1.5;

/// A line a bent ribbon slice is cut on: the chord between where the two
/// ends of its top (or foot) go, in device px, and its normal toward the
/// slice. The slice before or after it is cut on the same chord from the
/// same two ends, so the two tile the band.
#[derive(Clone, Copy)]
struct Chord {
    a: Pt,
    n: Pt,
}

impl Chord {
    /// The chord from `a` to `b`, whose inside is the side `inside` is on.
    fn new(a: Pt, b: Pt, inside: Pt) -> Option<Self> {
        let d = b.minus(a);
        let len = d.len();
        if len.is_nan() || len <= 0.0 {
            return None;
        }
        let n = Pt::new(-d.y / len, d.x / len);
        let n = if n.dot(inside.minus(a)) < 0.0 {
            n.scale(-1.0)
        } else {
            n
        };
        Some(Self { a, n })
    }

    /// How far inside the chord `p` is, device px.
    fn inside(&self, p: Pt) -> f64 {
        self.n.dot(p.minus(self.a))
    }

    /// `p` moved off the chord, away from the slice, by `CHORD_REACH`.
    fn out(&self, p: Pt) -> Pt {
        p.minus(self.n.scale(CHORD_REACH))
    }
}

/// A stamp carried through the box's bends: its shape is bent exactly, and
/// what is inside it is read back from a device pixel through the mesh's
/// tangent over the stamp (the user's rule: the tip carried by the local
/// tangent) and the roughening's first-order inverse, `p + d(p)`, the very
/// lookup the pixel pass made, so a roughened tip crumples as the letters do.
struct Carried {
    /// The stamp's own frame into job space: moved, turned, flipped,
    /// squashed, then off the box's corner.
    j: Affine,
    /// The transform after the mesh's tangent over the stamp.
    ta: Affine,
    /// Device px back to before the mesh: `ta`'s inverse.
    unmesh: Affine,
    /// Device px back to job space after the mesh: the transform's inverse;
    /// and the tangent's inverse, for a round dab read through the mesh
    /// itself (`Pen::back_exact`).
    unbase: Affine,
    untangent: Affine,
    /// Job space back into the stamp's frame: `j`'s inverse.
    unframe: Affine,
    /// Device px a stamp unit is worth here: `ta`'s scale.
    scale: f64,
}

/// How what is inside a stamp's bent outline is read.
enum Read<'t> {
    /// A hard round dab: all of it.
    Hard,
    /// A soft round dab: the ramp from `r0` to the rim `r`.
    Soft { c: Carried, r: f64, r0: f64 },
    /// A tip: `level`'s `src` (level px) drawn into `dst` (the stamp's
    /// frame), as `image` draws it.
    Tip {
        c: Carried,
        level: &'t tips::Level,
        src: (f64, f64, f64, f64),
        dst: (f64, f64, f64, f64),
    },
    /// A ribbon's slice: cut on `top` and `foot`, and its parts down its
    /// length (`slice_tip`): where each starts in the slice's frame, its
    /// height there, and its rows of the level.
    Slice {
        c: Carried,
        level: &'t tips::Level,
        top: Chord,
        foot: Chord,
        size: f64,
        lw: f64,
        parts: Vec<(f64, f64, f64, f64)>,
    },
}

/// A stamp bent: its outline in device px, and how its inside is read.
struct Shape<'t> {
    polys: Polys,
    read: Read<'t>,
}
/// How far past its top and foot a ribbon's slice takes a pixel's centre,
/// in the slice's own units (`Pen::image`).
const SEAM: f64 = 1e-7;

/// What one stamp is pressed with: the round dab, an imported tip, or a
/// ribbon's slice of one.
#[derive(Clone, Copy)]
enum Press<'a> {
    Round,
    Tip(&'a Tip),
    Slice(&'a Tip),
}

/// A stroke's tips, where the engine holds them: its own, and its cycle's.
struct Tips<'a> {
    own: Option<&'a Tip>,
    cycle: Vec<Option<&'a Tip>>,
}

impl<'a> Tips<'a> {
    fn of(k: &Stroke, table: &'a [Option<Rc<Tip>>]) -> Self {
        let at = |i: Option<u32>| {
            i.and_then(|i| table.get(i as usize))
                .and_then(|t| t.as_deref())
        };
        let own = at(k.tip);
        let cycle = if own.is_some() {
            k.cycle.iter().map(|&c| at(c)).collect()
        } else {
            Vec::new()
        };
        Self { own, cycle }
    }

    /// `drawInk`'s `stamper`: round where the stroke's own tip is not in
    /// hand (`tipFor`); a ribbon's slice of its own tip; the cycle's tip of
    /// the stamp where that is in hand, and the stroke's own where it is not
    /// and for the cycle's first, as the canvas draws them.
    fn press(&self, s: &Stamp) -> Press<'a> {
        let Some(own) = self.own else {
            return Press::Round;
        };
        if s.ribbon.is_some() {
            return Press::Slice(own);
        }
        match s.tip {
            Some(i) if i > 0 => Press::Tip(self.cycle.get(i).copied().flatten().unwrap_or(own)),
            _ => Press::Tip(own),
        }
    }
}

/// The rasteriser's scratch, kept over a stroke's stamps.
#[derive(Default)]
struct Scratch {
    cov: Vec<f32>,
    spans: Vec<(u32, u32)>,
}

/// Called for each pixel a stamp reaches, with its index in the stroke's
/// rectangle (row by row), its coverage by the stamp's shape, the stamp's
/// strength there (the soft dab's ramp, the tip's coverage) and how much of
/// the colour it carries there (the ramp again for a soft dab, whose
/// gradient runs to clear black; all of it for a tip, tinted flat).
type Each<'e> = dyn FnMut(usize, f32, f32, f32) + 'e;

/// The coverage of `polys` over `rect`: `each` with each pixel's index in
/// `rect`, its device position and its coverage.
fn cover(
    polys: Polys,
    rect: IBox,
    rasterizer: &dyn Rasterizer,
    sc: &mut Scratch,
    mut each: impl FnMut(usize, i32, i32, f32),
) -> Result<(), Error> {
    budget::check()?;
    let Some(bx) = super::raster::pixel_box(&polys).map(|b| b.intersect(&rect)) else {
        return Ok(());
    };
    if bx.is_empty() {
        return Ok(());
    }
    let mut coverage = rasterizer.prepare(&[Part::plain(polys)], bx)?;
    let stride = bx.width() + 2;
    let rw = rect.width();
    let mut y = bx.y0;
    while y < bx.y1 {
        let y_end = ((strip_of(y) + 1) * STRIP_ROWS).min(bx.y1);
        let rows = (y_end - y) as usize;
        sc.cov.clear();
        sc.cov.resize(stride * rows, 0.0);
        sc.spans.clear();
        sc.spans.resize(rows, (0, 0));
        coverage.render(y, y_end, &mut sc.cov, stride, &mut sc.spans)?;
        for (row, &(lo, hi)) in sc.spans.iter().enumerate() {
            let dy = y + row as i32;
            let hi = (hi as usize).min(bx.width());
            for x in lo as usize..hi {
                let c = sc.cov[row * stride + x];
                if c <= 0.0 {
                    continue;
                }
                let dx = bx.x0 + x as i32;
                let i = (dy - rect.y0) as usize * rw + (dx - rect.x0) as usize;
                each(i, dx, dy, c.min(1.0));
            }
        }
        y = y_end;
    }
    Ok(())
}

/// A stamp's own frame under `t`: moved to it, turned, flipped, and
/// squashed by `flat` where that is given (a ribbon's slice is not).
fn frame(t: &Affine, s: &Stamp, flat: Option<f64>) -> Affine {
    let mut m = t.after(&Affine::translate(s.x, s.y));
    if s.angle != 0.0 {
        let (sin, cos) = ((s.angle * core::f64::consts::PI) / 180.0).sin_cos();
        m = m.after(&Affine::rotate(cos, sin));
    }
    if s.fx == -1.0 || s.fy == -1.0 {
        m = m.after(&Affine::scale(s.fx, s.fy));
    }
    if let Some(f) = flat.filter(|&f| f != 1.0) {
        m = m.after(&Affine::scale(1.0, f));
    }
    m
}

/// How a stroke is pressed, the same for each of its stamps.
struct Pen<'a> {
    k: &'a Stroke,
    tips: Tips<'a>,
    t: &'a Affine,
    /// Device px a page px is worth (`transformScale`).
    scale: f64,
    /// A tip read bilinear, not nearest: anti-aliasing above None.
    smooth: bool,
    rect: IBox,
    rasterizer: &'a dyn Rasterizer,
    /// The box's bends, where it has any, with the transform without the
    /// box's corner (`base`) and that corner (`origin`): `t` is the two.
    bend: Option<Bend<'a>>,
    base: &'a Affine,
    origin: Pt,
}

impl<'a> Pen<'a> {
    fn press(&self, s: &Stamp, sc: &mut Scratch, each: &mut Each) -> Result<(), Error> {
        if let Some(bend) = &self.bend {
            return match self.shape(s, bend)? {
                Some(shape) => self.press_bent(shape, bend, sc, each),
                None => Ok(()),
            };
        }
        match self.tips.press(s) {
            Press::Round => self.dab(s, sc, each),
            Press::Tip(tip) => self.stamp_tip(s, tip, sc, each),
            Press::Slice(tip) => self.slice_tip(s, tip, sc, each),
        }
    }

    /// The device pixels a bent stamp can reach, or `None` for one that
    /// draws nothing.
    fn bent_box(&self, s: &Stamp, bend: &Bend) -> Result<Option<IBox>, Error> {
        Ok(self.shape(s, bend)?.and_then(|sh| pixel_box(&sh.polys)))
    }

    /// The stamp's frame and the mesh's tangent over it, where both can be
    /// turned back; `None` for a stamp the mesh crushes to nothing (no slope
    /// to read: a fold, a horizon), which is not drawn. `rect` is the
    /// stamp's shape in its own frame.
    fn carry(
        &self,
        s: &Stamp,
        flat: Option<f64>,
        (x0, y0, x1, y1): (f64, f64, f64, f64),
        bend: &Bend,
    ) -> Option<Carried> {
        let j = Affine::translate(self.origin.x, self.origin.y).after(&frame(
            &Affine::IDENTITY,
            s,
            flat,
        ));
        let a = match bend.bends.mesh {
            None => Affine::IDENTITY,
            Some(m) => {
                // Over the stamp where the roughening has put it.
                let (mut ax, mut ay, mut bx, mut by) = (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                );
                for (x, y) in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)] {
                    let p = j.apply(Pt::new(x, y));
                    ax = ax.min(p.x);
                    bx = bx.max(p.x);
                    ay = ay.min(p.y);
                    by = by.max(p.y);
                }
                let c = j.apply(Pt::new((x0 + x1) / 2.0, (y0 + y1) / 2.0));
                let d = bend
                    .bends
                    .rough
                    .map_or(Pt::new(0.0, 0.0), |r| r.at(c).minus(c));
                m.tangent_exact((ax + d.x, ay + d.y, bx + d.x, by + d.y))
                    .ok()?
            }
        };
        let ta = self.base.after(&a);
        let unmesh = ta.invert()?;
        let unframe = j.invert()?;
        Some(Carried {
            j,
            ta,
            unmesh,
            unbase: self.base.invert()?,
            untangent: a.invert()?,
            unframe,
            scale: ta.det().abs().sqrt(),
        })
    }

    /// Where the device pixel `(x, y)`'s centre is in the stamp's frame:
    /// back through the transform and the mesh's tangent, the roughening's
    /// first-order inverse, and the stamp's frame.
    fn back(c: &Carried, rough: Option<&RoughMap>, x: i32, y: i32) -> Pt {
        let p = c
            .unmesh
            .apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
        let p = rough.map_or(p, |r| r.back(p));
        c.unframe.apply(p)
    }

    /// [`Pen::back`] through the mesh itself, for a round dab, which the
    /// user's rule has exact: where the tangent puts the pixel before the
    /// mesh, moved by the tangent's inverse of how far the mesh takes that
    /// point from the pixel (one step of Newton's method, from the tangent),
    /// then back through the roughening and the dab's frame. A round dab's
    /// soft ramp is then the bent dab's own, where the tangent alone left
    /// its fall-off up to a device pixel off the outline on a mesh that
    /// stretches by half again (`ink-bend.engine.test.js`).
    fn back_exact(c: &Carried, bend: &Bend, x: i32, y: i32) -> Pt {
        let at = c
            .unbase
            .apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
        let mut p = c.untangent.apply(at);
        if let Some(m) = bend.bends.mesh {
            let off = at.minus(m.at(p));
            let lin = c
                .untangent
                .apply(off)
                .minus(c.untangent.apply(Pt::new(0.0, 0.0)));
            let next = p.plus(lin);
            if next.x.is_finite() && next.y.is_finite() {
                p = next;
            }
        }
        let p = bend.bends.rough.map_or(p, |r| r.back(p));
        c.unframe.apply(p)
    }

    /// The closed outline `pts` (the stamp's frame) through `j`, the bends
    /// (cut as the letters are, within the bend's tolerance) and the
    /// transform. `BadSpec` where the bends send it nowhere.
    fn bent(&self, bend: &Bend, j: &Affine, pts: impl Iterator<Item = Pt>) -> Result<Polys, Error> {
        let mut polys = Polys::default();
        for p in pts {
            polys.push(j.apply(p));
        }
        polys.close();
        let Some(bounds) = polys.bounds() else {
            return Ok(polys);
        };
        let Some(cut) = bend.bends.cut(bounds, bend.tol) else {
            return Ok(polys.map(self.base));
        };
        Ok(warp::bend(&polys, |p| bend.bends.at(p), cut, bend.tol)?.map(self.base))
    }

    /// A stamp bent (`Carried`): the round dab, a tip or a ribbon's slice,
    /// as `press` lays each unbent.
    fn shape(&self, s: &Stamp, bend: &Bend) -> Result<Option<Shape<'a>>, Error> {
        let k = self.k;
        match self.tips.press(s) {
            Press::Round => {
                let r = s.size / 2.0;
                if r.is_nan() || r <= 0.0 {
                    return Ok(None);
                }
                let flat = Some(s.flat.unwrap_or(k.flatness));
                let Some(c) = self.carry(s, flat, (-r, -r, r, r), bend) else {
                    return Ok(None);
                };
                // The circle as `dab` cuts it, at its size on the device.
                let device = r * c.ta.after(&c.j).max_scale();
                let step = if DAB_TOLERANCE < device {
                    2.0 * (1.0 - DAB_TOLERANCE / device).acos()
                } else {
                    core::f64::consts::FRAC_PI_2
                };
                let n = (core::f64::consts::TAU / step).ceil().clamp(8.0, 4096.0) as usize;
                let a = core::f64::consts::TAU / n as f64;
                let wide = r * (a / a.sin()).sqrt();
                let polys = self.bent(
                    bend,
                    &c.j,
                    (0..n).map(|i| {
                        let (sin, cos) = (a * i as f64).sin_cos();
                        Pt::new(wide * cos, wide * sin)
                    }),
                )?;
                let read = if k.hardness < 100.0 {
                    Read::Soft {
                        c,
                        r,
                        r0: r * (k.hardness / 100.0),
                    }
                } else {
                    Read::Hard
                };
                Ok(Some(Shape { polys, read }))
            }
            Press::Tip(tip) => {
                let (nw, nh) = tip.natural;
                let f = s.size / nw.max(nh);
                let (dw, dh) = (nw * f, nh * f);
                if !(dw > 0.0 && dh > 0.0) {
                    return Ok(None);
                }
                let flat = Some(s.flat.unwrap_or(k.flatness));
                let (hw, hh) = (dw / 2.0, dh / 2.0);
                let Some(c) = self.carry(s, flat, (-hw, -hh, hw, hh), bend) else {
                    return Ok(None);
                };
                let level = tip.pick(s.size * c.scale);
                let polys = self.bent(
                    bend,
                    &c.j,
                    [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
                        .into_iter()
                        .map(|(x, y)| Pt::new(x, y)),
                )?;
                let src = (0.0, 0.0, level.width as f64, level.height as f64);
                Ok(Some(Shape {
                    polys,
                    read: Read::Tip {
                        c,
                        level,
                        src,
                        dst: (-hw, -hh, dw, dh),
                    },
                }))
            }
            Press::Slice(tip) => self.slice_shape(s, tip, bend),
        }
    }

    /// A ribbon's slice bent. Its sides are bent as any outline is; its top
    /// and foot are the chords between where their ends go, which the slices
    /// either side of it compute from the same ends, so a pixel is in one
    /// slice or the next (`Chord`), and the tip inside is read through the
    /// slice's own tangent.
    fn slice_shape(
        &self,
        s: &Stamp,
        tip: &'a Tip,
        bend: &Bend,
    ) -> Result<Option<Shape<'a>>, Error> {
        let Some((d, len)) = s.ribbon else {
            return Ok(None);
        };
        let (nw, nh) = tip.natural;
        let f = s.size / nw;
        let period = nh * f;
        if !(f > 0.0 && period > 0.0) {
            return Ok(None);
        }
        let (hw, hl) = (s.size / 2.0, len / 2.0);
        let Some(c) = self.carry(s, None, (-hw, -hl, hw, hl), bend) else {
            return Ok(None);
        };
        let level = tip.pick(s.size.max(len) * c.scale);
        let k = level.height as f64 / nh;
        let lw = level.width as f64;
        // The parts down the slice, as `slice_tip` draws them.
        let mut parts = Vec::new();
        let mut v0 = ((d - len / 2.0) % period + period) % period / f;
        let mut left = len / f;
        let mut y = -len / 2.0;
        while left > 1e-6 {
            let take = left.min(nh - v0);
            if take.is_nan() || take <= 0.0 {
                v0 = 0.0;
                continue;
            }
            let dh = take * f;
            parts.push((y, dh, v0 * k, take * k));
            y += dh;
            left -= take;
            v0 = 0.0;
        }
        if parts.is_empty() {
            return Ok(None);
        }
        let job = |x: f64, y: f64| c.j.apply(Pt::new(x, y));
        let (lt, lf, rf, rt) = (job(-hw, -hl), job(-hw, hl), job(hw, hl), job(hw, -hl));
        let dev = |p: Pt| self.base.apply(bend.bends.at(p));
        // Each chord's inside is toward the other's middle: the slice's own
        // middle may be carried off the strip between them (a roughening
        // moves it by its own field, the chords by their ends').
        let (dlt, drt, dlf, drf) = (dev(lt), dev(rt), dev(lf), dev(rf));
        let mid = |a: Pt, b: Pt| a.plus(b).scale(0.5);
        let (Some(top), Some(foot)) = (
            Chord::new(dlt, drt, mid(dlf, drf)),
            Chord::new(dlf, drf, mid(dlt, drt)),
        ) else {
            return Ok(None);
        };
        let x0 = lt.x.min(lf.x).min(rf.x).min(rt.x);
        let y0 = lt.y.min(lf.y).min(rf.y).min(rt.y);
        let x1 = lt.x.max(lf.x).max(rf.x).max(rt.x);
        let y1 = lt.y.max(lf.y).max(rf.y).max(rt.y);
        let Some(cut) = bend.bends.cut((x0, y0, x1, y1), bend.tol) else {
            return Ok(None);
        };
        // A side: from where its top end goes to where its foot end goes.
        let side = |a: Pt, b: Pt| {
            let mut out = Polys::default();
            out.push(bend.bends.at(a));
            warp::bend_line(&mut out, |p| bend.bends.at(p), (a, b), cut, bend.tol);
            out
        };
        let (left_side, right_side) = (side(lt, lf), side(rf, rt));
        let mut polys = Polys::default();
        polys.push(top.out(dlt));
        for p in left_side.pts.iter() {
            polys.push(self.base.apply(*p));
        }
        polys.push(foot.out(dlf));
        polys.push(foot.out(drf));
        for p in right_side.pts.iter() {
            polys.push(self.base.apply(*p));
        }
        polys.push(top.out(drt));
        polys.close();
        if !warp::sound(&polys) {
            return Err(Error::BadSpec);
        }
        Ok(Some(Shape {
            polys,
            read: Read::Slice {
                c,
                level,
                top,
                foot,
                size: s.size,
                lw,
                parts,
            },
        }))
    }

    /// A bent stamp laid: its outline's coverage, and inside it its read.
    fn press_bent(
        &self,
        shape: Shape,
        bend: &Bend,
        sc: &mut Scratch,
        each: &mut Each,
    ) -> Result<(), Error> {
        let rough = bend.bends.rough;
        let smooth = self.smooth;
        let Shape { polys, read } = shape;
        match read {
            Read::Hard => cover(polys, self.rect, self.rasterizer, sc, |i, _, _, c| {
                each(i, c, 1.0, 1.0);
            }),
            Read::Soft { c: carried, r, r0 } => {
                cover(polys, self.rect, self.rasterizer, sc, |i, x, y, c| {
                    let q = Self::back_exact(&carried, bend, x, y);
                    let d = q.x.hypot(q.y);
                    let tg = if r > r0 {
                        ((d - r0) / (r - r0)).clamp(0.0, 1.0)
                    } else if d < r {
                        0.0
                    } else {
                        1.0
                    };
                    let g = (1.0 - tg) as f32;
                    each(i, c, g, g);
                })
            }
            Read::Tip {
                c: carried,
                level,
                src: (sx, sy, sw, sh),
                dst: (dx, dy, dw, dh),
            } => {
                let (kx, ky) = (sw / dw, sh / dh);
                cover(polys, self.rect, self.rasterizer, sc, |i, x, y, c| {
                    let q = Self::back(&carried, rough, x, y);
                    let g = level.sample(sx + (q.x - dx) * kx, sy + (q.y - dy) * ky, smooth);
                    if g > 0.0 {
                        each(i, c, g, 1.0);
                    }
                })
            }
            Read::Slice {
                c: carried,
                level,
                top,
                foot,
                size,
                lw,
                parts,
            } => {
                let kx = lw / size;
                cover(polys, self.rect, self.rasterizer, sc, |i, x, y, c| {
                    let p = Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5);
                    // A hair either way, as `image` keeps it.
                    if !(top.inside(p) >= -SEAM && foot.inside(p) > -SEAM) {
                        return;
                    }
                    let q = Self::back(&carried, rough, x, y);
                    let last = parts.len() - 1;
                    let at = parts
                        .iter()
                        .position(|&(py, dh, ..)| q.y < py + dh)
                        .unwrap_or(last);
                    let (py, dh, sy, sh) = parts[at];
                    let g =
                        level.sample((q.x + size / 2.0) * kx, sy + (q.y - py) * (sh / dh), smooth);
                    if g > 0.0 {
                        each(i, c, g, 1.0);
                    }
                })
            }
        }
    }

    /// `stampRound`: one round dab. The canvas fills the dab's arc with its
    /// colour, or with a radial gradient from the colour at `hardness` of
    /// the radius to clear at the rim, interpolated before it is
    /// premultiplied: at ramp alpha `g` the colour is `g` of the way from
    /// black.
    fn dab(&self, s: &Stamp, sc: &mut Scratch, each: &mut Each) -> Result<(), Error> {
        let k = self.k;
        let r = s.size / 2.0;
        if r.is_nan() || r <= 0.0 {
            return Ok(());
        }
        let m = frame(self.t, s, Some(s.flat.unwrap_or(k.flatness)));
        // The polygon's corners on a circle a little wider than the arc, so it
        // holds the arc's area.
        let device = r * m.max_scale();
        let step = if DAB_TOLERANCE < device {
            2.0 * (1.0 - DAB_TOLERANCE / device).acos()
        } else {
            core::f64::consts::FRAC_PI_2
        };
        let n = (core::f64::consts::TAU / step).ceil().clamp(8.0, 4096.0) as usize;
        let a = core::f64::consts::TAU / n as f64;
        let wide = r * (a / a.sin()).sqrt();
        let mut polys = Polys::default();
        for i in 0..n {
            let (sin, cos) = (a * i as f64).sin_cos();
            polys.push(m.apply(Pt::new(wide * cos, wide * sin)));
        }
        polys.close();
        let soft = k.hardness < 100.0;
        let inv = if soft { m.invert() } else { None };
        if soft && inv.is_none() {
            return Ok(());
        }
        let r0 = r * (k.hardness / 100.0);
        let ramp = |x: i32, y: i32| -> f32 {
            let Some(inv) = &inv else {
                return 1.0;
            };
            let q = inv.apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
            let d = q.x.hypot(q.y);
            let tg = if r > r0 {
                ((d - r0) / (r - r0)).clamp(0.0, 1.0)
            } else if d < r {
                0.0
            } else {
                1.0
            };
            (1.0 - tg) as f32
        };
        cover(polys, self.rect, self.rasterizer, sc, |i, x, y, c| {
            let g = ramp(x, y);
            each(i, c, g, g);
        })
    }

    /// `drawImage` of the level's `src` rectangle (level px: x, y, width,
    /// height) into `dst` (the same, in the stamp's frame) under `m`: each
    /// pixel the rectangle covers, and the level read where the pixel's
    /// centre falls in it.
    ///
    /// `cut` is a ribbon's slice: its top and foot are where it meets the
    /// slices before and after it, so a pixel there is the slice's whole
    /// when its centre is in it and not at all when it is not (the top in,
    /// the foot out), and only the band's sides are anti-aliased. Laid one
    /// over the other, two slices that each covered part of such a pixel
    /// would leave it short: a seam across the band at every slice, where
    /// the canvas lays its slices close to seamless.
    #[allow(clippy::too_many_arguments)]
    fn image(
        &self,
        level: &tips::Level,
        src: (f64, f64, f64, f64),
        dst: (f64, f64, f64, f64),
        m: &Affine,
        cut: bool,
        sc: &mut Scratch,
        each: &mut Each,
    ) -> Result<(), Error> {
        let (dx, dy, dw, dh) = dst;
        let Some(inv) = m.invert() else {
            return Ok(());
        };
        // A cut slice's rectangle reaches past its top and foot, by more
        // than a pixel's half-diagonal on the device, so the coverage of a
        // pixel whose centre is in the slice is its sides' alone.
        let reach = if cut {
            let along = m.0[2].hypot(m.0[3]);
            if along.is_nan() || along <= 0.0 {
                return Ok(());
            }
            1.5 / along
        } else {
            0.0
        };
        let (y0, y1) = (dy - reach, dy + dh + reach);
        let mut polys = Polys::default();
        for (x, y) in [(dx, y0), (dx + dw, y0), (dx + dw, y1), (dx, y1)] {
            polys.push(m.apply(Pt::new(x, y)));
        }
        polys.close();
        let (sx, sy, sw, sh) = src;
        let (kx, ky) = (sw / dw, sh / dh);
        let smooth = self.smooth;
        cover(polys, self.rect, self.rasterizer, sc, |i, x, y, c| {
            let q = inv.apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
            // A hair either way: two slices state the line they meet on each
            // from its own centre, and a pixel's centre on that line must
            // not fall between them.
            if cut && !(q.y >= dy - SEAM && q.y < dy + dh + SEAM) {
                return;
            }
            let g = level.sample(sx + (q.x - dx) * kx, sy + (q.y - dy) * ky, smooth);
            if g > 0.0 {
                each(i, c, g, 1.0);
            }
        })
    }

    /// `stampTip`: one stamp of an imported tip. Its longest side is the
    /// stamp's size, and the flatness squashes its own y as it squashes the
    /// round dab's; read from the smallest level still as big as the stamp
    /// is on the device.
    fn stamp_tip(
        &self,
        s: &Stamp,
        tip: &Tip,
        sc: &mut Scratch,
        each: &mut Each,
    ) -> Result<(), Error> {
        let (nw, nh) = tip.natural;
        let f = s.size / nw.max(nh);
        let (dw, dh) = (nw * f, nh * f);
        if !(dw > 0.0 && dh > 0.0) {
            return Ok(());
        }
        let m = frame(self.t, s, Some(s.flat.unwrap_or(self.k.flatness)));
        let level = tip.pick(s.size * self.scale);
        let (lw, lh) = (level.width as f64, level.height as f64);
        self.image(
            level,
            (0.0, 0.0, lw, lh),
            (-dw / 2.0, -dh / 2.0, dw, dh),
            &m,
            false,
            sc,
            each,
        )
    }

    /// `sliceTip`: one slice of a ribbon. The tip's width is the band's,
    /// the stamp's size, and its height runs along the path at the same
    /// scale, again from the top once it is used up: the rows of the tip
    /// for the stretch of path the slice covers, in two parts where that
    /// stretch runs past the tip's foot.
    fn slice_tip(
        &self,
        s: &Stamp,
        tip: &Tip,
        sc: &mut Scratch,
        each: &mut Each,
    ) -> Result<(), Error> {
        let Some((d, len)) = s.ribbon else {
            return Ok(());
        };
        let (nw, nh) = tip.natural;
        let f = s.size / nw;
        let period = nh * f;
        if !(f > 0.0 && period > 0.0) {
            return Ok(());
        }
        let level = tip.pick(s.size.max(len) * self.scale);
        let k = level.height as f64 / nh;
        let lw = level.width as f64;
        let m = frame(self.t, s, None);
        let mut v0 = ((d - len / 2.0) % period + period) % period / f;
        let mut left = len / f;
        let mut y = -len / 2.0;
        while left > 1e-6 {
            let take = left.min(nh - v0);
            if take.is_nan() || take <= 0.0 {
                // Rounding put the start on the tip's foot: that is its top.
                v0 = 0.0;
                continue;
            }
            let dh = take * f;
            self.image(
                level,
                (0.0, v0 * k, lw, take * k),
                (-s.size / 2.0, y, s.size, dh),
                &m,
                true,
                sc,
                each,
            )?;
            y += dh;
            left -= take;
            v0 = 0.0;
        }
        Ok(())
    }
}

/// What one stroke has laid before it goes on the ink under it.
enum Laid {
    Premul(Vec<f32>),
    Straight(Vec<u8>),
}

impl Laid {
    fn into_straight(self) -> Vec<u8> {
        match self {
            Laid::Straight(v) => v,
            Laid::Premul(v) => {
                let mut out = vec![0u8; v.len()];
                for (o, p) in out
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(v.as_chunks::<4>().0.iter())
                {
                    o.copy_from_slice(&straight(p));
                }
                out
            }
        }
    }
}

/// One stroke laid in `rect` and put on `block` (premultiplied over `bx`):
/// `paintStrokes` for one stroke.
#[allow(clippy::too_many_arguments)]
fn paint_stroke(
    k: &Stroke,
    tips: Tips,
    stamps: &[Stamp],
    (t, scale): (&Affine, f64),
    (base, origin, bend): (&Affine, Pt, Option<Bend>),
    rect: IBox,
    (water_r, water_blur): (f64, f64),
    rasterizer: &dyn Rasterizer,
    block: &mut [f32],
    bx: IBox,
) -> Result<(), Error> {
    let fade = stamps.iter().any(|s| s.alpha < k.opacity - 1e-6);
    // Blend brush tips with Darken: only a tip has anything inside its edge
    // to keep.
    let darken = !fade && k.darken_tips && tips.own.is_some();
    let solid = k.opacity >= 0.999;
    let water = wants_water_edge(k);
    let grain = k.texture && k.texture_density > 0.0;
    let density = k.density;
    let aa = k.antialias;
    let layered = !solid || aa < 3 || water || darken || fade || grain || density;
    let (w, h) = (rect.width(), rect.height());
    let n = w * h;
    let [cr, cg, cb, _] = k.color.0;
    let rgb = [cr, cg, cb].map(|c| f32::from(c) / 255.0);
    let pen = Pen {
        k,
        tips,
        t,
        scale,
        smooth: aa > 0,
        rect,
        rasterizer,
        bend,
        base,
        origin,
    };
    let mut sc = Scratch::default();
    // A ground read back as the mask, eight bits a dab: the stroke's colour
    // at that alpha.
    let mask = |grey: Vec<u8>| {
        let mut px = vec![0u8; n * 4];
        for (p, &a) in px.as_chunks_mut::<4>().0.iter_mut().zip(&grey) {
            p.copy_from_slice(&[cr, cg, cb, a]);
        }
        Laid::Straight(px)
    };
    let mut laid = if fade {
        // Densest wins: each dab white at its own strength on black, eight
        // bits, merged by lighten, read back as the mask.
        let op = if k.opacity == 0.0 || k.opacity.is_nan() {
            1.0
        } else {
            k.opacity
        };
        let mut grey = vec![0u8; n];
        for s in stamps {
            let o = (s.alpha / op).clamp(0.0, 1.0);
            if o.is_nan() || o <= 0.0 {
                continue;
            }
            let o = o as f32;
            pen.press(s, &mut sc, &mut |i, c, g, shade| {
                let v = clamped(f64::from(shade * g * c * o) * 255.0);
                if v > grey[i] {
                    grey[i] = v;
                }
            })?;
        }
        mask(grey)
    } else if darken {
        // Each dab's density as darkness on white, merged by darken: where
        // dabs overlap the denser wins, as coverage `d + c (max(d, g) - d)`
        // for a dab of coverage `g` that covers the pixel by `c`; eight bits
        // a dab, read back as the mask.
        let mut grey = vec![0u8; n];
        for s in stamps {
            pen.press(s, &mut sc, &mut |i, c, g, _| {
                let d = f64::from(grey[i]) / 255.0;
                let v = d + f64::from(c) * (d.max(f64::from(g)) - d);
                grey[i] = clamped(v * 255.0);
            })?;
        }
        mask(grey)
    } else {
        let mut px = vec![0.0f32; n * 4];
        for s in stamps {
            let ga = if layered { 1.0 } else { s.alpha as f32 };
            pen.press(s, &mut sc, &mut |i, c, g, shade| {
                let a = g * c * ga;
                let pc = shade * a;
                over(
                    &mut px[i * 4..i * 4 + 4],
                    [rgb[0] * pc, rgb[1] * pc, rgb[2] * pc, a],
                    1.0,
                );
            })?;
        }
        Laid::Premul(px)
    };
    budget::check()?;
    // The passes, on the stroke's own eight bits, in CSP's order.
    if water || grain || aa < 3 {
        let mut px = laid.into_straight();
        if grain {
            pixels::texture(
                &mut px,
                w,
                h,
                t,
                (rect.x0, rect.y0),
                k.texture_density,
                k.texture_scale,
                k.texture_stress,
            );
        }
        if water {
            pixels::water_edge(
                &mut px,
                w,
                h,
                water_r,
                k.water_edge_power,
                k.water_edge_dark,
                water_blur,
                [cr, cg, cb],
                aa == 0,
            );
        }
        if aa < 3 {
            pixels::sharpen(&mut px, aa);
        }
        laid = Laid::Straight(px);
    }
    let bw = bx.width();
    let at =
        |x: usize, y: usize| ((rect.y0 - bx.y0) as usize + y) * bw + (rect.x0 - bx.x0) as usize + x;
    if density {
        // Compared with the ink already down, as the canvas reads both.
        let over_px = laid.into_straight();
        let mut under = vec![0u8; n * 4];
        for y in 0..h {
            for x in 0..w {
                let j = at(x, y) * 4;
                under[(y * w + x) * 4..(y * w + x) * 4 + 4]
                    .copy_from_slice(&straight(&block[j..j + 4]));
            }
        }
        pixels::density_over(&mut under, &over_px, k.opacity);
        for y in 0..h {
            for x in 0..w {
                let j = at(x, y) * 4;
                let i = (y * w + x) * 4;
                block[j..j + 4].copy_from_slice(&premul(&under[i..i + 4]));
            }
        }
        return Ok(());
    }
    let op = if layered { k.opacity as f32 } else { 1.0 };
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let src = match &laid {
                Laid::Premul(v) => [v[i], v[i + 1], v[i + 2], v[i + 3]],
                Laid::Straight(v) => premul(&v[i..i + 4]),
            };
            if src[3] <= 0.0 {
                continue;
            }
            let j = at(x, y) * 4;
            over(&mut block[j..j + 4], src, op);
        }
    }
    Ok(())
}

impl InkLayer {
    /// `drawInk`'s strokes under `transform * translate(origin)`, cut to
    /// `surface` (or refused past the painter's guards without one), with
    /// room `reach` job units round them for what is grown from them.
    ///
    /// With `bend`, every stamp is bent (`Pen::shape`), and a stroke's
    /// rectangle and the layer's are found from the bent stamps: each
    /// stroke's own, grown by what its passes reach (the water edge), and
    /// each grown by `reach` for the layer, so an outline round bent ink is
    /// not cut where the mesh carried the ink.
    #[allow(clippy::too_many_arguments)]
    fn build(
        origin: Pt,
        strokes: &[Stroke],
        tips: &[Option<Rc<Tip>>],
        transform: &Affine,
        surface: Option<IBox>,
        reach: f64,
        bend: Option<Bend>,
        rasterizer: &dyn Rasterizer,
    ) -> Result<Option<Self>, Error> {
        let t = transform.after(&Affine::translate(origin.x, origin.y));
        let det = t.det();
        if !t.is_finite() || det.is_nan() || det == 0.0 {
            return Ok(None);
        }
        let scale = det.abs().sqrt();
        let clip = surface.unwrap_or(IBox {
            x0: -(1 << 28),
            y0: -(1 << 28),
            x1: 1 << 28,
            y1: 1 << 28,
        });
        let mut laid = Vec::new();
        let mut all: Option<(f64, f64, f64, f64)> = None;
        let margin = (reach.max(0.0) * scale).ceil().min(1e6) + 2.0;
        // With bends, the layer: each bent stroke's pixels grown by `margin`.
        let mut grown: Option<IBox> = None;
        for k in strokes {
            let stamps = stroke_stamps(k);
            let Some(b) = stroke_bounds(k, &stamps) else {
                continue;
            };
            all = Some(all.map_or(b, |a| {
                (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))
            }));
            let water = wants_water_edge(k);
            let r = if water {
                js_round(k.water_edge_width * scale).max(1.0)
            } else {
                0.0
            };
            let bl = if water {
                js_round(k.water_edge_blur * scale)
            } else {
                0.0
            };
            let rect = match &bend {
                None => bounds_rect(b, &t, clip, r + bl + 2.0),
                Some(bend) => {
                    // Every stamp bent once to find where the stroke lands;
                    // bent again when it is laid, so no stroke's outlines
                    // are held while the next is found.
                    let pen = Pen {
                        k,
                        tips: Tips::of(k, tips),
                        t: &t,
                        scale,
                        smooth: k.antialias > 0,
                        rect: clip,
                        rasterizer,
                        bend: Some(*bend),
                        base: transform,
                        origin,
                    };
                    let mut core: Option<IBox> = None;
                    for s in &stamps {
                        if let Some(b) = pen.bent_box(s, bend)? {
                            core = Some(core.map_or(b, |c| c.union(&b)));
                        }
                        budget::check()?;
                    }
                    core.and_then(|c| {
                        let around = |by: f64| {
                            let by = by.ceil().min(1e6) as i32;
                            IBox {
                                x0: c.x0.saturating_sub(by),
                                y0: c.y0.saturating_sub(by),
                                x1: c.x1.saturating_add(by),
                                y1: c.y1.saturating_add(by),
                            }
                            .intersect(&clip)
                        };
                        let g = around(margin);
                        if !g.is_empty() {
                            grown = Some(grown.map_or(g, |a| a.union(&g)));
                        }
                        let rect = around(r + bl + 2.0);
                        (!rect.is_empty()).then_some(rect)
                    })
                }
            };
            if let Some(rect) = rect {
                laid.push((k, stamps, rect, (r, bl)));
            }
            budget::check()?;
        }
        let Some(all) = all else {
            return Ok(None);
        };
        let mut bx = match &bend {
            None => bounds_rect(all, &t, clip, margin),
            Some(_) => grown,
        };
        for (_, _, rect, _) in &laid {
            bx = Some(bx.map_or(*rect, |b| b.union(rect)));
        }
        let Some(bx) = bx else {
            return Ok(None);
        };
        let (w, h) = (bx.width(), bx.height());
        if w > MAX_SIDE as usize || h > MAX_SIDE as usize || w * h > MAX_PIXELS {
            return Err(Error::BadSpec);
        }
        let mut content = budget::filled(w * h * 4, 0.0f32)?;
        for (k, stamps, rect, water) in &laid {
            paint_stroke(
                k,
                Tips::of(k, tips),
                stamps,
                (&t, scale),
                (transform, origin, bend),
                *rect,
                *water,
                rasterizer,
                &mut content,
                bx,
            )?;
        }
        let mut alpha = budget::filled(w * h, 0u8)?;
        let mut top = 0u8;
        for (a, p) in alpha.iter_mut().zip(content.as_chunks::<4>().0.iter()) {
            *a = straight(p)[3];
            top = top.max(*a);
        }
        if top == 0 {
            return Ok(None);
        }
        let t = (u32::from(top).div_ceil(2)).max(1) as u8;
        let dist = if reach > 0.0 {
            let inside: Vec<bool> = alpha.iter().map(|&a| a >= t).collect();
            let mut d = distance::squared(&inside, w, h)?;
            for v in d.iter_mut() {
                *v = v.sqrt();
            }
            Some(d)
        } else {
            None
        };
        Ok(Some(Self {
            bx,
            content,
            alpha,
            t,
            dist,
        }))
    }

    /// `paintFinish`'s `grown`: the ink's silhouette grown by `r` device px,
    /// a one-pixel ramp off the distance; inside the ink's own fringe its
    /// coverage over the threshold where that is more.
    fn grown(&self, i: usize, r: f64) -> f64 {
        let a = self.alpha[i];
        if a >= self.t {
            return 1.0;
        }
        let edge = self
            .dist
            .as_ref()
            .map_or(f64::NEG_INFINITY, |d| r + 0.5 - f64::from(d[i]));
        (f64::from(a) / f64::from(self.t)).max(edge).clamp(0.0, 1.0)
    }
}

/// Straight RGBA8 over `bx` cut to its pixels with any alpha.
fn trimmed(bx: IBox, data: Vec<u8>) -> Option<Raster> {
    let w = bx.width();
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
    for (i, p) in data.as_chunks::<4>().0.iter().enumerate() {
        if p[3] != 0 {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
    }
    if x0 >= x1 {
        return None;
    }
    if (x0, y0, x1, y1) == (0, 0, w, bx.height()) {
        return Some(Raster {
            x: bx.x0,
            y: bx.y0,
            width: w as u32,
            height: bx.height() as u32,
            data,
        });
    }
    let cw = x1 - x0;
    let mut out = Vec::with_capacity(cw * (y1 - y0) * 4);
    for y in y0..y1 {
        out.extend_from_slice(&data[(y * w + x0) * 4..(y * w + x1) * 4]);
    }
    Some(Raster {
        x: bx.x0 + x0 as i32,
        y: bx.y0 + y0 as i32,
        width: cw as u32,
        height: (y1 - y0) as u32,
        data: out,
    })
}

/// The box of a raster.
fn box_of(r: &Raster) -> IBox {
    IBox {
        x0: r.x,
        y0: r.y,
        x1: r.x.saturating_add(r.width as i32),
        y1: r.y.saturating_add(r.height as i32),
    }
}

/// The widest band's half, job units.
fn outer_band(job: &Job) -> f64 {
    job.bands.first().map_or(0.0, |b| (b.line / 2.0).max(0.0))
}

/// The letters' raster `glyphs` with the ink joined to it, in the way the
/// job paints:
///
/// - a silhouette: the ink grown by the widest band's half and the
///   silhouette's own grow, in its colour, the denser of it and the
///   letters'; with nothing to grow, the ink's own alpha;
/// - the letters (a fill, a fill and its outlines, or a box with no fill,
///   whose ink stays drawn): the outlines round the ink, outermost first,
///   over the letters, and the ink over them, as `drawInk` lays them;
/// - the rim pass ([`Ink::rims`]): the outlines round the ink, and
///   everything cut out where the ink is, which the fill pass has laid.
pub(crate) fn join(
    glyphs: Option<Raster>,
    ink: &Ink,
    request: &Request,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let job = &request.job;
    let transient;
    let layer = if ink.prepared_for.as_ref() == Some(&laying(&request.transform, job)) {
        ink.layer.as_ref()
    } else {
        let reach = outer_band(job) + job.effects.grow.max(0.0);
        transient = with_bends(job, &request.transform, |bend| {
            InkLayer::build(
                ink.origin,
                &ink.strokes,
                &ink.resolved,
                &request.transform,
                None,
                reach,
                bend,
                rasterizer,
            )
        })?;
        transient.as_ref()
    };
    let Some(layer) = layer else {
        return Ok(glyphs);
    };
    let scale = request.transform.det().abs().sqrt();
    let bx = glyphs
        .as_ref()
        .map_or(layer.bx, |g| box_of(g).union(&layer.bx));
    let (w, h) = (bx.width(), bx.height());
    if w > MAX_SIDE as usize || h > MAX_SIDE as usize || w * h > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let lw = layer.bx.width();
    let in_layer = |i: usize| {
        let (x, y) = ((i % lw) as i32 + layer.bx.x0, (i / lw) as i32 + layer.bx.y0);
        ((y - bx.y0) as usize) * w + (x - bx.x0) as usize
    };
    if let Some(color) = job.silhouette {
        let mut out = vec![0u8; w * h * 4];
        let [r, g, b, ca] = color.0;
        if let Some(gl) = &glyphs {
            let gw = gl.width as usize;
            for (i, p) in gl.data.as_chunks::<4>().0.iter().enumerate() {
                let (x, y) = ((i % gw) as i32 + gl.x, (i / gw) as i32 + gl.y);
                let j = (((y - bx.y0) as usize) * w + (x - bx.x0) as usize) * 4;
                out[j..j + 4].copy_from_slice(p);
            }
        }
        let grow = (outer_band(job) + job.effects.grow.max(0.0)) * scale;
        let ca = f64::from(ca) / 255.0;
        for i in 0..layer.alpha.len() {
            let a = if grow > 0.0 {
                layer.grown(i, grow)
            } else {
                f64::from(layer.alpha[i]) / 255.0
            };
            let v = js_round(a * ca * 255.0).clamp(0.0, 255.0) as u8;
            let j = in_layer(i) * 4;
            if v > out[j + 3] {
                out[j..j + 4].copy_from_slice(&[r, g, b, v]);
            }
        }
        return Ok(trimmed(bx, out));
    }
    let mut out = budget::filled(w * h * 4, 0.0f32)?;
    if let Some(gl) = &glyphs {
        let gw = gl.width as usize;
        for (i, p) in gl.data.as_chunks::<4>().0.iter().enumerate() {
            let (x, y) = ((i % gw) as i32 + gl.x, (i / gw) as i32 + gl.y);
            let j = (((y - bx.y0) as usize) * w + (x - bx.x0) as usize) * 4;
            out[j..j + 4].copy_from_slice(&premul(p));
        }
    }
    drop(glyphs);
    for band in &job.bands {
        let r = (band.line / 2.0).max(0.0) * scale;
        let [br, bg, bb, ba] = band.color.0;
        let col = [br, bg, bb].map(|c| f32::from(c) / 255.0);
        let k = (band.opacity.clamp(0.0, 1.0) * f64::from(ba) / 255.0) as f32;
        if k <= 0.0 {
            continue;
        }
        for i in 0..layer.alpha.len() {
            let c = f32::from(clamped(layer.grown(i, r) * 255.0)) / 255.0;
            if c <= 0.0 {
                continue;
            }
            let j = in_layer(i) * 4;
            over(
                &mut out[j..j + 4],
                [col[0] * c, col[1] * c, col[2] * c, c],
                k,
            );
        }
    }
    for i in 0..layer.alpha.len() {
        let j = in_layer(i) * 4;
        if ink.rims {
            let keep = 1.0 - f32::from(layer.alpha[i]) / 255.0;
            for v in &mut out[j..j + 4] {
                *v *= keep;
            }
        } else {
            let p = &layer.content[i * 4..i * 4 + 4];
            if p[3] > 0.0 {
                over(&mut out[j..j + 4], [p[0], p[1], p[2], p[3]], 1.0);
            }
        }
    }
    let mut data = vec![0u8; w * h * 4];
    for (o, p) in data
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(out.as_chunks::<4>().0.iter())
    {
        o.copy_from_slice(&straight(p));
    }
    Ok(trimmed(bx, data))
}

/// Reads the ink record of a box job (`decode_box`): see there for the
/// layout. `None` for a box with no ink.
pub(crate) fn read(bytes: &[u8], at: &mut usize) -> Result<Option<Ink>, Error> {
    let mut r = Reader { bytes, at: *at };
    let ink = match r.u32()? {
        0 => None,
        1 => Some(r.ink()?),
        _ => return Err(Error::BadSpec),
    };
    *at = r.at;
    Ok(ink)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::BadSpec)?;
        let s = self.bytes.get(self.at..end).ok_or(Error::BadSpec)?;
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// A number from `lo` to `hi`.
    fn num(&mut self, lo: f64, hi: f64) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if (lo..=hi).contains(&v) {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A count of at most `max` records of at least `min_size` bytes each.
    fn count(&mut self, max: usize, min_size: usize) -> Result<usize, Error> {
        let n = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        if n > max || n.checked_mul(min_size).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        Ok(n)
    }

    fn tip(&mut self, tips: usize) -> Result<Option<u32>, Error> {
        match self.u32()? {
            ROUND => Ok(None),
            i if (i as usize) < tips => Ok(Some(i)),
            _ => Err(Error::BadSpec),
        }
    }

    fn ink(&mut self) -> Result<Ink, Error> {
        let origin = Pt::new(
            self.num(-MAX_COORD, MAX_COORD)?,
            self.num(-MAX_COORD, MAX_COORD)?,
        );
        let n = self.count(MAX_TIPS, 4)?;
        let mut tips = Vec::new();
        budget::reserve_raw(&mut tips, n)?;
        for _ in 0..n {
            let len = self.u32()? as usize;
            if len > MAX_TIP_KEY {
                return Err(Error::BadSpec);
            }
            let key = core::str::from_utf8(self.take(len)?).map_err(|_| Error::BadText)?;
            tips.push(key.to_owned());
        }
        let n = self.count(MAX_STROKES, 200)?;
        let mut strokes = Vec::new();
        budget::reserve_raw(&mut strokes, n)?;
        let mut points = 0usize;
        for _ in 0..n {
            let k = self.stroke(tips.len(), &mut points)?;
            strokes.push(k);
        }
        let mut ink = Ink::new(origin, strokes);
        ink.name_tips(tips);
        Ok(ink)
    }

    fn stroke(&mut self, tips: usize, points: &mut usize) -> Result<Stroke, Error> {
        let flags = self.u32()?;
        // Bits 7 and 20 up are not a stroke anyone wrote.
        if flags & !0x000f_ff7f != 0 {
            return Err(Error::BadSpec);
        }
        let flip = |v: u32| match v {
            0 => Ok(Flip::Off),
            1 => Ok(Flip::On),
            2 => Ok(Flip::Random),
            _ => Err(Error::BadSpec),
        };
        let tip_order = match (flags >> 14) & 3 {
            0 => TipOrder::Repeat,
            1 => TipOrder::Reverse,
            2 => TipOrder::Once,
            _ => TipOrder::Random,
        };
        let b = self.take(4)?;
        let color = Rgba([b[0], b[1], b[2], 255]);
        let opacity = self.num(0.0, 1.0)?;
        let size = self.num(0.5, 2000.0)?;
        let spacing = self.num(1.0, 200.0)?;
        let hardness = self.num(0.0, 100.0)?;
        let angle = self.num(-36000.0, 36000.0)?;
        let angle_jitter = self.num(0.0, 100.0)?;
        let flatness = self.num(0.01, 1.0)?;
        let corners = self.num(0.0, 180.0)?;
        let mut taper = |on: u32, pct: u32| -> Result<Taper, Error> {
            Ok(Taper {
                on: flags & on != 0,
                pct: flags & pct != 0,
                len: self.num(0.0, 500.0)?,
                ratio: self.num(0.0, 100.0)?,
            })
        };
        let taper_in = taper(1 << 16, 1 << 17)?;
        let taper_out = taper(1 << 18, 1 << 19)?;
        let water_edge_width = self.num(1.0, 20.0)?;
        let water_edge_power = self.num(0.0, 1.0)?;
        let water_edge_dark = self.num(0.0, 1.0)?;
        let water_edge_blur = self.num(0.0, 20.0)?;
        let texture_density = self.num(0.0, 1.0)?;
        let texture_scale = self.num(10.0, 1000.0)?;
        let seed = self.num(-9_007_199_254_740_991.0, 9_007_199_254_740_991.0)?;
        let tip = self.tip(tips)?;
        let n = self.count(MAX_TIPS, 4)?;
        let mut cycle = Vec::new();
        budget::reserve_raw(&mut cycle, n)?;
        for _ in 0..n {
            cycle.push(self.tip(tips)?);
        }
        let n = self.u32()? as usize;
        let stride = self.u32()? as usize;
        if n == 0 || !(stride == 3 || stride == 5) {
            return Err(Error::BadSpec);
        }
        *points = points.checked_add(n).ok_or(Error::BadSpec)?;
        let left = self.bytes.len() - self.at;
        if *points > MAX_POINTS || n.checked_mul(stride * 8).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        let mut pts = Vec::new();
        budget::reserve_raw(&mut pts, n)?;
        for _ in 0..n {
            let mut p = [1.0; 5];
            p[0] = self.num(-MAX_COORD, MAX_COORD)?;
            p[1] = self.num(-MAX_COORD, MAX_COORD)?;
            for v in p.iter_mut().take(stride).skip(2) {
                *v = self.num(0.0, 1.0)?;
            }
            pts.push(p);
        }
        Ok(Stroke {
            ribbon: flags & 1 != 0,
            follow_dir: flags & 2 != 0,
            darken_tips: flags & 4 != 0,
            density: flags & 8 != 0,
            water_edge: flags & 16 != 0,
            texture: flags & 32 != 0,
            texture_stress: flags & 64 != 0,
            antialias: ((flags >> 8) & 3) as u8,
            flip_x: flip((flags >> 10) & 3)?,
            flip_y: flip((flags >> 12) & 3)?,
            tip_order,
            taper_in,
            taper_out,
            color,
            opacity,
            size,
            spacing,
            hardness,
            angle,
            angle_jitter,
            flatness,
            corners,
            water_edge_width,
            water_edge_power,
            water_edge_dark,
            water_edge_blur,
            texture_density,
            texture_scale,
            seed,
            tip,
            cycle,
            pts,
        })
    }
}

#[cfg(test)]
mod bend_tests {
    use super::super::raster::Exact;
    use super::*;

    fn heavy() -> Vec<Stroke> {
        (0..100)
            .map(|n| Stroke {
                size: 14.0,
                seed: f64::from(n),
                pts: (0..24)
                    .map(|i| {
                        let t = f64::from(i) / 23.0;
                        [
                            10.0 + t * 170.0,
                            20.0 + f64::from(n) * 0.9 + (t * core::f64::consts::TAU).sin() * 15.0,
                            1.0,
                            1.0,
                            1.0,
                        ]
                    })
                    .collect(),
                ..Stroke::default()
            })
            .collect()
    }

    fn job(bent: bool) -> Job {
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
        Job {
            mesh: bent.then_some(Mesh {
                cols: 3,
                rows: 3,
                pts,
                x: 20.0,
                y: 30.0,
                w: 200.0,
                h: 120.0,
            }),
            roughen: bent.then_some(Roughen {
                amount: 6.0,
                detail: 0.07,
                seed: 7.0,
                origin: Pt::new(20.0, 30.0),
                grit: 0.0,
            }),
            curved: false,
            align: super::super::Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: None,
            effects: super::super::Effects::default(),
            runs: Vec::new(),
        }
    }

    /// The most the painter's budget held while the ink of a heavy box (a
    /// hundred strokes) was laid at 2.74, bent and not, and how long each
    /// took (`--nocapture` prints them). A bent stamp's outline is let go
    /// once it is laid, and found again for the next pass, so the bent
    /// peak is the flat one and a stamp's outline more.
    #[test]
    fn a_heavy_box_of_bent_ink_holds_no_more_than_the_flat_one_and_a_stamp() {
        let t = Affine::scale(2.74, 2.74);
        let surface = IBox {
            x0: 0,
            y0: 0,
            x1: 800,
            y1: 600,
        };
        let mut peaks = Vec::new();
        for bent in [false, true] {
            let mut ink = Ink::new(Pt::new(20.0, 30.0), heavy());
            let _scope = budget::Scope::new();
            let start = std::time::Instant::now();
            ink.prepare(&t, &job(bent), surface, 3.0, &Exact).unwrap();
            let took = start.elapsed();
            assert!(ink.layer.is_some());
            let peak = budget::peak_for_test();
            println!("heavy ink, bent {bent}: peak {peak} bytes, {took:?}");
            peaks.push(peak);
        }
        assert!(peaks[1] < peaks[0] + (1 << 20), "{peaks:?}");
    }
}
