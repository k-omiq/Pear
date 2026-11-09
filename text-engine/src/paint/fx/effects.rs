//! The layer effects past the drop shadow: Outer Glow, Inner Glow, Inner
//! Shadow, Color Overlay, Gradient Overlay, Pattern Overlay, Satin, Stroke
//! and Bevel & Emboss, and how each is laid.
//!
//! The order is Photoshop's, as PhotoCraft composites it
//! (`crates/compose/src/effects/composite.rs`): behind the letters the drop
//! shadows, then the outer glows; on the letters their fill at Fill Opacity,
//! then the pattern, gradient and colour overlays, the satin, the inner glows, the inner
//! shadows, the inside of the strokes and an Inner Bevel, laid inside the
//! letters at full strength and then cut to the letters' own alpha; the
//! outside of the strokes slid under the letters, and an Outer Bevel after
//! them; then the outlines (`strokes`, the bands); then, over the finished
//! letters, an Emboss, a Pillow Emboss or a Stroke Emboss.
//!
//! An interior effect is painted relative to the letters' shape: it is laid
//! over the fill as if every covered pixel were whole, and the pixel's
//! coverage applies after, so an overlay at 100 % recolours a half-covered
//! edge without adding to it. At Fill Opacity 0 the effects still show.
//!
//! Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors for the
//! order and the compositing it follows, MIT licence (see `THIRD_PARTY.md`).

use super::super::blur::Surface;
use super::super::geom::{Affine, IBox, Pt};
use super::super::job::{Fill, Rgba, Tile};
use super::super::shade::Shader;
use super::super::Raster;
use super::bevel::{self, Reach, Shading};
pub use super::bevel::{BevelStyle, BevelTechnique};
use super::blend::{self, Backdrop, Blend};
use super::contour::{Lut, Table};
use super::gradient::{self, Frame, Gradient};
pub use super::map::Technique;
use super::map::{self, Map, Soft};
use super::{noise, spread_split};
use crate::paint::budget::{self, Buffer};
use crate::paint::MAX_PIXELS;
use crate::Error;

/// Outer Glow or Inner Glow.
#[derive(Clone, Debug, PartialEq)]
pub struct Glow {
    pub color: Rgba,
    /// A gradient along the glow in place of the colour.
    pub gradient: Option<Gradient>,
    pub opacity: f64,
    pub blend: Blend,
    pub technique: Technique,
    /// Size, job units.
    pub size: f64,
    /// Spread (outer) or Choke (inner), 0 to 1.
    pub spread: f64,
    /// Range, 0 to 1.
    pub range: f64,
    /// Noise, 0 to 1.
    pub noise: f64,
    /// `None` is Linear.
    pub contour: Option<Lut>,
    /// An inner glow's Source is the Center rather than the Edge.
    pub center: bool,
    /// Quality > Jitter, 0 to 1: how far each pixel's sample of the
    /// gradient is moved at random (`jittered`). Nothing on a colour glow.
    pub jitter: f64,
    pub seed: u32,
}

/// Inner Shadow: thrown from the letters' outside into them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InnerShadow {
    pub color: Rgba,
    pub opacity: f64,
    pub blend: Blend,
    /// How far it is thrown, job units.
    pub x: f64,
    pub y: f64,
    /// Size, job units.
    pub size: f64,
    /// Choke, 0 to 1.
    pub choke: f64,
    /// Noise, 0 to 1.
    pub noise: f64,
    pub contour: Option<Lut>,
    pub seed: u32,
}

/// Color Overlay.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Overlay {
    pub color: Rgba,
    pub opacity: f64,
    pub blend: Blend,
}

/// Satin: two softened copies of the letters thrown apart along `angle`,
/// the gap between them laid inside the letters. One per box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Satin {
    pub color: Rgba,
    pub opacity: f64,
    pub blend: Blend,
    /// Degrees, the box's own (Satin has no Global Light).
    pub angle: f64,
    /// How far each copy is thrown, job units.
    pub distance: f64,
    /// Size, job units.
    pub size: f64,
    pub invert: bool,
    /// As the style states it; `None` is Linear. Read through its Satin
    /// table (`Lut::satin`) when laid.
    pub contour: Option<Lut>,
}

/// Bevel & Emboss's Texture: a pattern's luminance raises the height.
#[derive(Clone, Debug, PartialEq)]
pub struct BevelTexture {
    /// Texture Depth, -10 to 10 (1 is 100 %); negative carves.
    pub depth: f64,
    pub invert: bool,
    /// The pattern, as a glyph job's fill: its Scale, Link and Phase are
    /// the fill's.
    pub fill: Fill,
}

/// Bevel & Emboss: the letters raised and lit (`bevel.rs`).
#[derive(Clone, Debug, PartialEq)]
pub struct Bevel {
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    /// Depth, 0 to 10 (1 is 100 %).
    pub depth: f64,
    /// Direction Up; false is Down, which swaps the lit and the dark sides.
    pub up: bool,
    /// Size and Soften, job units.
    pub size: f64,
    pub soften: f64,
    /// Degrees, Global Light already resolved. The light turns with a
    /// turned or mirrored box, as a shadow's throw does.
    pub angle: f64,
    pub altitude: f64,
    pub highlight: Overlay,
    pub shadow: Overlay,
    /// Gloss Contour; `None` is Linear.
    pub gloss: Option<Table>,
    /// Anti-aliased boxes: carried, not painted (PhotoCraft paints none).
    pub gloss_aa: bool,
    /// The Contour element on the height; `None` is off. Ticked, a Linear
    /// contour is a table too ([`Table::charged_on`]): it changes no height
    /// from 0 to 1 but clamps a chisel's past 1, as PhotoCraft's does.
    pub contour: Option<Table>,
    /// The Contour's Range, 0 to 1: carried, never applied. PhotoCraft
    /// found that Photoshop's bevel does not stretch the contour by it as a
    /// glow does, and what it does instead is unmeasured.
    pub range: f64,
    pub contour_aa: bool,
    pub texture: Option<BevelTexture>,
}

/// What an effect paints with: Photoshop's Fill Type.
#[derive(Clone, Debug, PartialEq)]
pub enum Paint {
    Color(Rgba),
    Gradient(Gradient),
    /// A pattern: one of the fills a glyph job takes (a screen or a tile).
    Fill(Fill),
}

/// Where a stroke lies on the letters' edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Outside,
    Inside,
    Center,
}

/// Photoshop's Stroke effect: a band of `size` along the letters' edge,
/// measured in pixels from it.
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    /// Size, job units.
    pub size: f64,
    pub position: Position,
    pub opacity: f64,
    pub blend: Blend,
    pub paint: Paint,
    pub seed: u32,
}

impl Stroke {
    /// (inside width, outside width), job units.
    pub fn widths(&self) -> (f64, f64) {
        let s = self.size.max(0.0);
        match self.position {
            Position::Outside => (0.0, s),
            Position::Inside => (s, 0.0),
            Position::Center => (s / 2.0, s / 2.0),
        }
    }
}

/// Gradient Overlay or Pattern Overlay: a paint over the fill.
#[derive(Clone, Debug, PartialEq)]
pub struct PaintOverlay {
    pub opacity: f64,
    pub blend: Blend,
    pub paint: Paint,
}

/// One layer effect of a box past its drop shadows. Each kind may come more
/// than once; of a kind, the first listed is on top.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    OuterGlow(Glow),
    InnerGlow(Glow),
    InnerShadow(InnerShadow),
    ColorOverlay(Overlay),
    GradientOverlay(PaintOverlay),
    PatternOverlay(PaintOverlay),
    Satin(Satin),
    Stroke(Stroke),
    Bevel(Bevel),
}

impl Effect {
    /// Laid on the letters rather than behind them.
    pub fn interior(&self) -> bool {
        !matches!(self, Effect::OuterGlow(_))
    }

    fn opacity(&self) -> f64 {
        match self {
            Effect::OuterGlow(g) | Effect::InnerGlow(g) => g.opacity,
            Effect::InnerShadow(s) => s.opacity,
            Effect::ColorOverlay(o) => o.opacity,
            Effect::GradientOverlay(o) | Effect::PatternOverlay(o) => o.opacity,
            Effect::Satin(s) => s.opacity,
            Effect::Stroke(s) => s.opacity * f64::from(u8::from(s.size > 0.0)),
            Effect::Bevel(b) => b.highlight.opacity.max(b.shadow.opacity),
        }
    }

    /// Lays anything at all.
    pub fn shows(&self) -> bool {
        self.opacity() > 0.0
    }
}

/// What a glow or an inner shadow asks of its map, whose corner is device
/// pixel `origin` (where its Noise is hashed from). `size` is job units and
/// `scale` device pixels to a job unit: the Spread or Choke takes its whole
/// pixels of the size in job units first, as a drop shadow's does
/// (`boxjob::lay_styled`), so the effect looks the same at every zoom and in
/// the export (review F24).
#[allow(clippy::too_many_arguments)]
fn soft(
    size: f64,
    spread: f64,
    scale: f64,
    range: f64,
    noise: f64,
    contour: Option<Lut>,
    seed: u32,
    origin: (i32, i32),
) -> Soft {
    let (grow, rest) = spread_split(size, spread);
    Soft {
        size: (size * scale) as f32,
        spread: spread as f32,
        grow: (grow * scale) as f32,
        blur: (rest * scale) as f32,
        contour,
        range: range as f32,
        noise: noise as f32,
        seed,
        origin,
    }
}

/// An outer glow's map over the letters' outline `shape` (their whole
/// silhouette, bands included), whose corner is device pixel `origin`,
/// `scale` device pixels to a job unit. Where the fill is see-through the
/// glow is kept from behind it: `fill` is the fill's own matte, at
/// `fill_opacity`.
pub(crate) fn outer_glow(
    shape: &Map,
    fill: Option<&Map>,
    fill_opacity: f64,
    g: &Glow,
    scale: f64,
    origin: (i32, i32),
) -> Result<Map, Error> {
    let s = soft(
        g.size, g.spread, scale, g.range, g.noise, g.contour, g.seed, origin,
    );
    let mut m = map::glow(shape, g.technique, false, false, &s)?;
    if let Some(fill) = fill {
        let see_through = (1.0 - fill_opacity.clamp(0.0, 1.0)) as f32;
        for (v, a) in m.v.iter_mut().zip(fill.v.iter()) {
            *v *= 1.0 - a * see_through;
        }
    }
    Ok(m)
}

/// Where a map has anything, or `None`, in the map's own pixels.
fn ink(m: &Map) -> Option<IBox> {
    ink_where(m, |v| v > 0.0)
}

/// Where a map's values pass `on`, or `None`, in the map's own pixels.
fn ink_where(m: &Map, on: impl Fn(f32) -> bool) -> Option<IBox> {
    let mut b: Option<IBox> = None;
    for y in 0..m.h {
        let row = &m.v[y * m.w..(y + 1) * m.w];
        let Some(x0) = row.iter().position(|v| on(*v)) else {
            continue;
        };
        let x1 = row.iter().rposition(|v| on(*v)).unwrap_or(x0) + 1;
        let r = IBox {
            x0: x0 as i32,
            y0: y as i32,
            x1: x1 as i32,
            y1: y as i32 + 1,
        };
        b = Some(b.map_or(r, |b| b.union(&r)));
    }
    b
}

/// The alpha of raster `r` over `region` of the surface, as a map.
pub(crate) fn alpha_map(r: &Raster, region: IBox) -> Result<Map, Error> {
    let (w, h) = (region.width(), region.height());
    let mut m = Map::filled(w, h, 0.0)?;
    let rw = r.width as usize;
    for y in 0..h {
        let ry = region.y0 + y as i32 - r.y;
        if ry < 0 || ry >= r.height as i32 {
            continue;
        }
        for x in 0..w {
            let rx = region.x0 + x as i32 - r.x;
            if rx < 0 || rx >= r.width as i32 {
                continue;
            }
            let a = r.data[(ry as usize * rw + rx as usize) * 4 + 3];
            m.v[y * w + x] = f32::from(a) / 255.0;
        }
    }
    Ok(m)
}

/// Where the box is: what carries its units to device pixels, and the
/// pattern tiles its job holds.
pub(crate) struct Place<'a> {
    /// Job units to device pixels.
    pub transform: Affine,
    pub tiles: &'a [Tile],
}

impl Place<'_> {
    /// One device pixel, job units.
    fn px(&self) -> f32 {
        let s = self.transform.det().abs().sqrt();
        if s > 0.0 && s.is_finite() {
            (1.0 / s) as f32
        } else {
            1.0
        }
    }
}

/// The colour a paint lays at a device pixel: straight RGB and alpha, 0 to 1.
/// One lives per effect while it is laid, so its size is no matter.
#[allow(clippy::large_enum_variant)]
enum Brush<'a> {
    Flat([f32; 4]),
    Ramp {
        g: &'a Gradient,
        frame: Frame,
        to_job: Affine,
        px: f32,
    },
    /// Shape Burst: the gradient by each pixel's depth in the shape it
    /// paints, 0 at the edge to 1 deepest, over a grid `w` wide whose corner
    /// is device `dev`.
    Burst {
        g: &'a Gradient,
        depth: &'a [f32],
        dev: (i32, i32),
        w: usize,
    },
    Shade(Shader<'a>),
}

impl Brush<'_> {
    fn at(&self, x: i32, y: i32) -> [f32; 4] {
        match self {
            Brush::Flat(c) => *c,
            Brush::Ramp {
                g,
                frame,
                to_job,
                px,
            } => {
                let p = to_job.apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
                g.sample(g.t(*frame, *px, p.x as f32, p.y as f32))
            }
            Brush::Burst { g, depth, dev, w } => {
                let (ix, iy) = (x - dev.0, y - dev.1);
                let d = if ix >= 0 && iy >= 0 && (ix as usize) < *w {
                    depth.get(iy as usize * w + ix as usize).copied()
                } else {
                    None
                };
                g.sample(g.burst(d.unwrap_or(0.0)))
            }
            Brush::Shade(s) => {
                let p = s.at(x, y);
                if p[3] <= 0.0 {
                    [0.0; 4]
                } else {
                    [p[0] / p[3], p[1] / p[3], p[2] / p[3], p[3]]
                }
            }
        }
    }
}

fn flat(c: Rgba) -> [f32; 4] {
    let [r, g, b, _] = c.0;
    [
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
        1.0,
    ]
}

/// The brush for `paint` over a gradient frame `frame` (job units); `None`
/// paints nothing.
fn brush<'a>(paint: &'a Paint, frame: Frame, place: &Place<'a>) -> Option<Brush<'a>> {
    Some(match paint {
        Paint::Color(c) => Brush::Flat(flat(*c)),
        Paint::Gradient(g) => Brush::Ramp {
            g,
            frame,
            to_job: place.transform.invert()?,
            px: place.px(),
        },
        Paint::Fill(f) => Brush::Shade(Shader::new(f, &place.transform, place.tiles)?),
    })
}

/// Whether `paint` is a Shape Burst gradient, which runs by depth.
fn is_burst(paint: &Paint) -> bool {
    matches!(paint, Paint::Gradient(g) if g.style == gradient::Style::ShapeBurst)
}

/// The brush for `paint`: a Shape Burst gradient run by `depth` (each
/// pixel's depth, 0 to 1, over a grid `w` wide whose corner is device
/// `dev`; worked out once by the caller, and only for a Shape Burst), any
/// other paint as [`brush`] has it over `frame`.
fn brush_in<'a>(
    paint: &'a Paint,
    frame: Option<Frame>,
    place: &Place<'a>,
    dev: (i32, i32),
    w: usize,
    depth: Option<&'a [f32]>,
) -> Option<Brush<'a>> {
    match paint {
        Paint::Gradient(g) if g.style == gradient::Style::ShapeBurst => Some(Brush::Burst {
            g,
            depth: depth.unwrap_or(&[]),
            dev,
            w,
        }),
        _ => brush(paint, frame?, place),
    }
}

/// Each pixel's depth in a shape from `dist`, its coverage-seeded distance
/// in from the shape's edge ([`map::chamfer_inside`], negative outside), as
/// a share of the deepest one: Shape Burst's run, 0 at the edge and 1 at
/// the deepest point (`gradient.rs`). Seeded by coverage, a partly covered
/// edge pixel lies its coverage in, so the letters' anti-aliased edge takes
/// the edge stop; with the exact distance every edge pixel read 0.5
/// whatever its coverage (review F27). PhotoCraft has no Shape Burst.
fn depth_share(dist: &[f32]) -> Result<Buffer<f32>, Error> {
    let deepest = dist.iter().copied().fold(0.0f32, f32::max).max(1e-3);
    budget::exact(
        dist.len(),
        dist.iter().map(|d| (d.max(0.0) / deepest).min(1.0)),
    )
}

/// Lays a paint through map `m`, whose corner is `at` on `dst`, at `opacity`
/// in `mode`. `dev` is `dst`'s corner in device pixels; `color(x, y, i)` is
/// the paint at device pixel `(x, y)`, map pixel `i`: straight RGB and an
/// alpha the map's coverage is multiplied by. Hands back where it can have
/// laid ink, in `dst`'s pixels.
#[allow(clippy::too_many_arguments)]
fn lay_with(
    dst: &mut Surface,
    m: &Map,
    at: (i32, i32),
    dev: (i32, i32),
    color: &dyn Fn(i32, i32, usize) -> [f32; 4],
    opacity: f64,
    mode: Blend,
    page: Option<&Backdrop<'_>>,
    seed: u32,
) -> Result<Option<IBox>, Error> {
    let Some(bx) = ink(m) else {
        return Ok(None);
    };
    let bx = IBox {
        x0: bx.x0 + at.0,
        y0: bx.y0 + at.1,
        x1: bx.x1 + at.0,
        y1: bx.y1 + at.1,
    }
    .intersect(&IBox {
        x0: 0,
        y0: 0,
        x1: dst.width as i32,
        y1: dst.height as i32,
    });
    if bx.is_empty() {
        return Ok(None);
    }
    // The paint through the map, premultiplied, on a surface of `dst`'s
    // size: only `bx` is written or read.
    let mut src = Surface::new(dst.width, dst.height)?;
    for y in bx.y0..bx.y1 {
        for x in bx.x0..bx.x1 {
            let i = (y - at.1) as usize * m.w + (x - at.0) as usize;
            let v = m.v[i].clamp(0.0, 1.0);
            if v <= 0.0 {
                continue;
            }
            let c = color(x + dev.0, y + dev.1, i);
            let a = (v * c[3].clamp(0.0, 1.0)).clamp(0.0, 1.0);
            let p = &mut src.data[(y as usize * dst.width + x as usize) * 4..][..4];
            for k in 0..3 {
                p[k] = (c[k].clamp(0.0, 1.0) * a * 255.0 + 0.5) as u8;
            }
            p[3] = (a * 255.0 + 0.5) as u8;
        }
    }
    blend::lay_from(dst, &src, bx, opacity as f32, mode, page, seed, dev);
    Ok(Some(bx))
}

/// A glow's paint over its map: its colour, or its gradient run along the
/// glow, opaque from strength `range^2` on (`gradient::glow_gain`).
#[allow(clippy::too_many_arguments)]
fn lay_glow(
    dst: &mut Surface,
    m: &Map,
    at: (i32, i32),
    dev: (i32, i32),
    g: &Glow,
    page: Option<&Backdrop<'_>>,
) -> Result<Option<IBox>, Error> {
    match &g.gradient {
        None => {
            let c = flat(g.color);
            lay_with(
                dst,
                m,
                at,
                dev,
                &|_, _, _| c,
                g.opacity,
                g.blend,
                page,
                g.seed,
            )
        }
        Some(grad) => {
            let gain = gradient::glow_gain(g.range as f32);
            let strength = Map::collect(m.w, m.h, m.v.iter().map(|v| (v * gain).min(1.0)))?;
            let jitter = g.jitter.clamp(0.0, 1.0) as f32;
            let color = |x: i32, y: i32, i: usize| {
                let t = 1.0 - m.v[i].clamp(0.0, 1.0);
                grad.sample(jittered(t, jitter, x, y, g.seed))
            };
            lay_with(
                dst, &strength, at, dev, &color, g.opacity, g.blend, page, g.seed,
            )
        }
    }
}

/// A glow's gradient position `t` (0 at the glow's strong end) moved by
/// Photoshop's Jitter, `jitter` from 0 to 1, at device pixel `(x, y)`.
///
/// Ours, not PhotoCraft's (it carries Jitter and paints none) nor a
/// measured match: a design from how Photoshop's Jitter behaves, after the
/// rule Krita's layer styles state (`kis_ls_utils.cpp`, behaviour only: the
/// gradient index moved on by a random share of Jitter, wrapping past the
/// end). Each pixel's sample moves on towards the clear end by `n * jitter`
/// of the ramp, `n` from 0 to 1 hashed from the pixel and the glow's seed
/// as its Noise is (`noise::unit`, salted apart from the grain), and only a
/// sample carried past 1 wraps round to the strong end: 0 leaves the
/// gradient smooth, a small Jitter keeps each pixel near its place on the
/// ramp (a solid band, `t` 0, stays solid), 100 % picks every pixel's colour
/// from anywhere along it. A centred step wrapped both ways once threw half
/// of a solid band to the clear end at any Jitter (review F6). The glow's
/// strength is not touched, only which colour (and stop opacity) it takes.
pub(crate) fn jittered(t: f32, jitter: f32, x: i32, y: i32, seed: u32) -> f32 {
    if jitter.is_nan() || jitter <= 0.0 {
        return t;
    }
    let n = noise::unit(x, y, seed ^ JITTER_SALT);
    let v = t.clamp(0.0, 1.0) + n * jitter.min(1.0);
    if v > 1.0 {
        v - 1.0
    } else {
        v
    }
}

/// Keeps a glow's Jitter apart from its Noise, which hashes the same seed.
const JITTER_SALT: u32 = 0x6a09_e667;

/// Lays the outer glows, the last listed first, behind the letters on `dst`.
/// `shape` is the letters' outline (their whole silhouette, bands included)
/// over `region` of `dst`; `fill`, over the same pixels, is the fill's own
/// matte where the fill is see-through, at `fill_opacity`, and keeps each
/// glow from behind it. Hands back where they can have laid ink.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lay_outer_glows(
    dst: &mut Surface,
    effects: &[Effect],
    shape: &Map,
    fill: Option<&Map>,
    fill_opacity: f64,
    region: IBox,
    scale: f64,
    page: Option<&Backdrop<'_>>,
) -> Result<Option<IBox>, Error> {
    let mut laid: Option<IBox> = None;
    for e in effects.iter().rev().filter(|e| e.shows()) {
        let Effect::OuterGlow(g) = e else {
            continue;
        };
        let m = outer_glow(shape, fill, fill_opacity, g, scale, (region.x0, region.y0))?;
        if let Some(b) = lay_glow(dst, &m, (region.x0, region.y0), (0, 0), g, page)? {
            laid = Some(laid.map_or(b, |l| l.union(&b)));
        }
    }
    Ok(laid)
}

/// How far past the letters the outer glows, the strokes and the outer and
/// emboss bevels reach, device pixels: a Size moves the edge `size + 1` at
/// most (Precise), with a pixel spare; a bevel as [`bevel::outward`] says.
pub(crate) fn outer_reach(effects: &[Effect], scale: f64) -> i32 {
    let size = effects
        .iter()
        .filter(|e| e.shows())
        .filter_map(|e| match e {
            Effect::OuterGlow(g) => Some(g.size * scale),
            Effect::Stroke(s) => Some(s.widths().1 * scale),
            Effect::Bevel(b) => Some(f64::from(bevel_outward(b, scale))),
            _ => None,
        })
        .fold(0.0, f64::max);
    (size.min(4096.0).ceil() as i32) + 3
}

/// How far a bevel reaches past the letters, device pixels.
fn bevel_outward(b: &Bevel, scale: f64) -> f32 {
    bevel::outward(
        b.style,
        b.technique,
        (b.size * scale).min(4096.0) as f32,
        (b.soften * scale).min(4096.0) as f32,
    )
}

/// The frame of `shape` (pixels from device `dev`) in job units: every
/// covered pixel's corners carried back.
fn job_frame(shape: &Map, dev: (i32, i32), place: &Place<'_>) -> Option<Frame> {
    let to_job = place.transform.invert()?;
    let b = ink_where(shape, |a| a > map::INSIDE_EPS)?;
    // The covered box's corners are enough for a box that is not turned;
    // a turned one carries every covered pixel's.
    let [a, bb, c, d, ..] = place.transform.0;
    let axis = (bb == 0.0 && c == 0.0) || (a == 0.0 && d == 0.0);
    let mut f = [
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    ];
    let mut take = |x: i32, y: i32| {
        let p = to_job.apply(Pt::new(f64::from(x + dev.0), f64::from(y + dev.1)));
        f = [
            f[0].min(p.x as f32),
            f[1].min(p.y as f32),
            f[2].max(p.x as f32),
            f[3].max(p.y as f32),
        ];
    };
    if axis {
        for (x, y) in [(b.x0, b.y0), (b.x1, b.y0), (b.x0, b.y1), (b.x1, b.y1)] {
            take(x, y);
        }
    } else {
        for y in b.y0..b.y1 {
            for x in b.x0..b.x1 {
                if shape.v[y as usize * shape.w + x as usize] > map::INSIDE_EPS {
                    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                        take(x + dx, y + dy);
                    }
                }
            }
        }
    }
    f.iter().all(|v| v.is_finite()).then_some(f)
}

/// The frame a stroke's gradient spans: the letters' frame grown by the
/// stroke's outside width less a pixel (PhotoCraft `stroke_frame`: a 4 px
/// outside stroke round a 22 px square runs its gradient over 28 px).
fn stroke_frame(f: Frame, st: &Stroke, px: f32) -> Frame {
    let out = (st.widths().1 / f64::from(px)).min(4096.0) as f32;
    let by = (out.ceil() - 1.0).max(0.0) * px;
    [f[0] - by, f[1] - by, f[2] + by, f[3] + by]
}

/// Coverage of an outside stroke under an edge pixel the letters cover `cov`
/// of and end at alpha `l`: Photoshop treats the stroke and the letters as
/// disjoint, so the stroke fills the part outside the path and the letters
/// add their own alpha (psd-tools stroke-effects).
pub fn outline_share(cov: f32, l: f32) -> f32 {
    let outside = (1.0 - cov.clamp(0.0, 1.0)).max(0.0);
    if outside <= 1e-6 {
        return 0.0;
    }
    let rest = 1.0 - l.clamp(0.0, 1.0);
    if rest <= 1e-6 {
        1.0
    } else {
        (outside / rest).min(1.0)
    }
}

/// The outside parts of the strokes, to slide under the letters: for each
/// stroke (first listed first) the share of each pixel it takes, over a
/// region whose corner is device `dev`.
pub(crate) struct Outside {
    pub dev: (i32, i32),
    pub w: usize,
    pub h: usize,
    /// The letters' frame, job units, for the gradients.
    frame: Option<Frame>,
    /// Effect index, share, and a Shape Burst stroke's depth.
    items: Vec<(usize, Buffer<f32>, Option<Buffer<f32>>)>,
}

impl Outside {
    /// Where the strokes can have ink, device pixels.
    pub fn bounds(&self) -> IBox {
        IBox {
            x0: self.dev.0,
            y0: self.dev.1,
            x1: self.dev.0 + self.w as i32,
            y1: self.dev.1 + self.h as i32,
        }
    }
}

/// The straight colour of a premultiplied RGBA8 pixel.
fn straight(p: &[u8]) -> [f32; 4] {
    let a = f32::from(p[3]) / 255.0;
    if a <= 0.0 {
        return [0.0; 4];
    }
    [
        f32::from(p[0]) / 255.0 / a,
        f32::from(p[1]) / 255.0 / a,
        f32::from(p[2]) / 255.0 / a,
        a,
    ]
}

/// `s` (straight, alpha `s[3]`) over `b` in `mode`: the W3C rule.
fn over(mode: Blend, b: [f32; 4], s: [f32; 4]) -> [f32; 4] {
    let (ab, as_) = (b[3], s[3]);
    let ao = as_ + ab * (1.0 - as_);
    if ao <= 0.0 {
        return [0.0; 4];
    }
    let m = mode.mix([b[0], b[1], b[2]], [s[0], s[1], s[2]]);
    let c = |k: usize| (as_ * (1.0 - ab) * s[k] + as_ * ab * m[k] + (1.0 - as_) * ab * b[k]) / ao;
    [c(0), c(1), c(2), ao]
}

/// Slides the outside parts of the strokes under what `dst` will hold: each
/// stroke blended over `dst` in its own mode, and its share of each pixel
/// laid in. A higher stroke covers the ones below it: a Multiply stroke
/// listed above a wider Normal one multiplies what is under them both.
/// Ported from PhotoCraft's `paint_outside_strokes`.
///
/// With a `page` (the page under the surface, as `blend::lay` takes it),
/// what a stroke blends with is `dst` over the page, so a Multiply stroke
/// multiplies the art where `dst` is clear, and `dst` is left in its
/// over-the-page form: laid source-over on the page it shows the blend.
pub(crate) fn lay_outside(
    dst: &mut Surface,
    o: &Outside,
    effects: &[Effect],
    place: &Place<'_>,
    page: Option<&Backdrop<'_>>,
) -> Result<(), Error> {
    let (w, h) = (o.w, o.h);
    let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
    // The share-weighted sum of each stroke blended in: premultiplied over
    // `dst` alone, or with a page, the colour shown over it (`[3]` is the
    // alpha either way).
    let mut acc = budget::filled(n, [0.0f32; 4])?;
    let mut cover = budget::filled(n, 0.0f32)?;
    let px = place.px();
    // Only a mode that reads what is under it needs the page; Normal over
    // the page shows what Normal over `dst` does.
    let page = page.filter(|pg| {
        pg.pixels.len() >= dst.data.len()
            && o.items.iter().any(|(k, _, _)| {
                matches!(effects.get(*k), Some(Effect::Stroke(st))
                    if !matches!(st.blend, Blend::Normal | Blend::Dissolve))
            })
    });
    let page_at = |i: usize| -> [f32; 3] {
        let p: &[u8] = match page {
            Some(pg) => &pg.pixels[i * 4..i * 4 + 4],
            None => &[0; 4],
        };
        [
            f32::from(p[0]) / 255.0,
            f32::from(p[1]) / 255.0,
            f32::from(p[2]) / 255.0,
        ]
    };
    for (k, share, depth) in &o.items {
        let Some(Effect::Stroke(st)) = effects.get(*k) else {
            continue;
        };
        let frame = o.frame.map(|f| stroke_frame(f, st, px));
        let depth = depth.as_ref().map(|d| d.as_slice());
        let Some(br) = brush_in(&st.paint, frame, place, o.dev, w, depth) else {
            continue;
        };
        // The share already carries Dissolve's choice: the paint is Normal.
        let mode = if st.blend == Blend::Dissolve {
            Blend::Normal
        } else {
            st.blend
        };
        for y in 0..h {
            let dy = o.dev.1 + y as i32;
            if dy < 0 || dy >= dst.height as i32 {
                continue;
            }
            for x in 0..w {
                let i = y * w + x;
                let s = share[i];
                if s <= 0.0 {
                    continue;
                }
                let dx = o.dev.0 + x as i32;
                if dx < 0 || dx >= dst.width as i32 {
                    continue;
                }
                let at = dy as usize * dst.width + dx as usize;
                let base = straight(&dst.data[at * 4..][..4]);
                let paint = br.at(dx, dy);
                let b = over(mode, base, paint);
                if page.is_some() {
                    // Over what is under the box here, opaque.
                    let pg = page_at(at);
                    let da = base[3];
                    let under = [0, 1, 2].map(|c| base[c] * da + pg[c] * (1.0 - da));
                    let shown = over(mode, [under[0], under[1], under[2], 1.0], paint);
                    for c in 0..3 {
                        acc[i][c] += s * shown[c];
                    }
                } else {
                    for c in 0..3 {
                        acc[i][c] += s * b[c] * b[3];
                    }
                }
                acc[i][3] += s * b[3];
                cover[i] += s;
            }
        }
    }
    for y in 0..h {
        let dy = o.dev.1 + y as i32;
        if dy < 0 || dy >= dst.height as i32 {
            continue;
        }
        for x in 0..w {
            let i = y * w + x;
            if cover[i] <= 0.0 {
                continue;
            }
            let dx = o.dev.0 + x as i32;
            if dx < 0 || dx >= dst.width as i32 {
                continue;
            }
            let at = dy as usize * dst.width + dx as usize;
            let p = &mut dst.data[at * 4..][..4];
            let keep = 1.0 - cover[i].min(1.0);
            let a = (f32::from(p[3]) / 255.0 * keep + acc[i][3]).clamp(0.0, 1.0);
            if page.is_some() {
                // What shows over the page, and the colour that, laid at
                // `a` over it, shows that.
                let base = straight(p);
                let pg = page_at(at);
                if a <= 0.0 {
                    p.copy_from_slice(&[0; 4]);
                    continue;
                }
                for c in 0..3 {
                    let under = base[c] * base[3] + pg[c] * (1.0 - base[3]);
                    let shown = under * keep + acc[i][c];
                    let v = ((shown - pg[c] * (1.0 - a)) / a).clamp(0.0, 1.0);
                    p[c] = (v * a * 255.0 + 0.5) as u8;
                }
            } else {
                for c in 0..3 {
                    let v = f32::from(p[c]) / 255.0 * keep + acc[i][c];
                    p[c] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
            p[3] = (a * 255.0 + 0.5) as u8;
        }
    }
    Ok(())
}

/// The bevels laid outside `interior()`: an Outer Bevel's maps go under the
/// letters, after the strokes' outside parts; an Emboss's, a Pillow
/// Emboss's and a Stroke Emboss's over the finished letters (PhotoCraft
/// `composite.rs`: `paint_bevel` with `BevelPaint::Outer` onto the backdrop
/// before the layer, `Both` onto the composited layer). Over a region whose
/// corner is device `dev`.
pub(crate) struct Bevels {
    pub dev: (i32, i32),
    /// Effect index, laid over the letters (`true`) or under them, and the
    /// highlight and shadow maps; of a kind the last listed first.
    items: Vec<(usize, bool, Map, Map)>,
}

/// The unit vector towards a bevel's light, y down, turned with the box:
/// `(cos a, -sin a)` carried as a shadow's throw is and brought back to
/// `cos(altitude)` long; the altitude is the box's own.
fn bevel_light(b: &Bevel, carried: impl Fn(f64, f64) -> (f64, f64)) -> [f32; 3] {
    let (sa, ca) = b.angle.to_radians().sin_cos();
    let (se, ce) = b.altitude.to_radians().sin_cos();
    let (x, y) = carried(ca, -sa);
    let len = x.hypot(y);
    let (x, y) = if len > 1e-12 && len.is_finite() {
        (x / len, y / len)
    } else {
        (ca, -sa)
    };
    [(x * ce) as f32, (y * ce) as f32, se as f32]
}

/// The Photoshop strokes' band over `shape`, `scale` device pixels to a job
/// unit: what a Stroke Emboss raises. Each stroke's inside part (its band
/// times the letters' coverage) and outside part (all of a pixel the
/// letters leave, out to the stroke's width, as the strokes are painted),
/// united over the strokes as `1 - prod(1 - band)`. `None` with no stroke.
/// Ours, not PhotoCraft's: PhotoCraft draws a Stroke Emboss as an Inner
/// Bevel of the letters, and there is no Photoshop measurement of it.
/// `din` is the letters' [`map::chamfer_inside`], there when a stroke has
/// an inside part.
fn stroke_band(
    shape: &Map,
    strokes: &[(usize, &Stroke)],
    scale: f64,
    din: Option<&[f32]>,
) -> Result<Option<Map>, Error> {
    if strokes.is_empty() {
        return Ok(None);
    }
    let (w, h) = (shape.w, shape.h);
    let mut chamfer = None;
    let mut exact = None;
    let mut rest = budget::filled(shape.v.len(), 1.0f32)?;
    for (_, st) in strokes {
        let (in_w, out_w) = st.widths();
        let (in_w, out_w) = ((in_w * scale) as f32, (out_w * scale) as f32);
        let dout = if out_w <= 0.0 {
            None
        } else {
            Some(outside_dist(shape, out_w, &mut chamfer, &mut exact)?)
        };
        for (i, r) in rest.iter_mut().enumerate() {
            let a = shape.v[i];
            let band = if a > map::INSIDE_EPS {
                let inner = match din {
                    Some(d) if in_w > 0.0 => (in_w + 0.5 - d[i]).clamp(0.0, 1.0) * a.min(1.0),
                    _ => 0.0,
                };
                let outer = if dout.is_some() {
                    1.0 - a.min(1.0)
                } else {
                    0.0
                };
                (inner + outer).min(1.0)
            } else {
                dout.map_or(0.0, |d| (out_w + 0.5 - d[i]).clamp(0.0, 1.0))
            };
            *r *= 1.0 - band;
        }
    }
    for r in rest.iter_mut() {
        *r = 1.0 - *r;
    }
    Ok(Some(Map { w, h, v: rest }))
}

/// The distance outside the letters a stroke `out_w` device pixels wide
/// measures by (the chamfer, or the exact one from
/// [`map::STROKE_CHAMFER_MAX`] on), worked out once into its slot.
fn outside_dist<'a>(
    shape: &Map,
    out_w: f32,
    chamfer: &'a mut Option<Buffer<f32>>,
    exact: &'a mut Option<Buffer<f32>>,
) -> Result<&'a [f32], Error> {
    let near = out_w < map::STROKE_CHAMFER_MAX;
    let slot = if near { chamfer } else { exact };
    if slot.is_none() {
        *slot = Some(if near {
            map::chamfer_outside(shape)?
        } else {
            map::dist_outside(shape)?
        });
    }
    Ok(slot.as_ref().map_or(&[][..], |d| d.as_slice()))
}

/// A bevel's highlight and shadow maps over `shape`, whose corner is device
/// `dev`, and where they paint. `None` when the budget cannot hold them.
fn bevel_maps(
    shape: &Map,
    b: &Bevel,
    scale: f64,
    carried: impl Fn(f64, f64) -> (f64, f64),
    place: &Place<'_>,
    dev: (i32, i32),
) -> Result<(Map, Map, Reach), Error> {
    // The height, two distances, four shading maps and a mix, as floats.
    budget::ensure(shape.v.len().saturating_mul(4 * 8))?;
    let shader = b
        .texture
        .as_ref()
        .and_then(|t| Some((t, Shader::new(&t.fill, &place.transform, place.tiles)?)));
    let lum = |x: usize, y: usize| -> f32 {
        let Some((_, s)) = &shader else {
            return 0.0;
        };
        let p = s.at(dev.0 + x as i32, dev.1 + y as i32);
        // Premultiplied: the luminance already times the alpha.
        0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]
    };
    let s = Shading {
        style: b.style,
        technique: b.technique,
        depth: b.depth as f32,
        up: b.up,
        size: (b.size * scale).min(4096.0) as f32,
        soften: (b.soften * scale).min(4096.0) as f32,
        light: bevel_light(b, carried),
        gloss: b.gloss.as_ref(),
        contour: b.contour.as_ref(),
        texture: shader.as_ref().map(|(t, _)| bevel::Texture {
            depth: t.depth as f32,
            invert: t.invert,
            lum: &lum,
        }),
        scale: scale as f32,
    };
    bevel::try_maps(shape, &s)
}

/// Lays the bevels of `stage` (over the letters, `true`, or under them) on
/// `dst`, whose corner is device `(0, 0)`: each highlight, then its shadow,
/// in their own colour, opacity and mode. Hands back where they can have
/// laid ink.
pub(crate) fn lay_bevels(
    dst: &mut Surface,
    b: &Bevels,
    effects: &[Effect],
    over: bool,
    page: Option<&Backdrop<'_>>,
) -> Result<Option<IBox>, Error> {
    let mut laid: Option<IBox> = None;
    for (k, top, hi, sh) in &b.items {
        let Some(Effect::Bevel(bv)) = effects.get(*k) else {
            continue;
        };
        if *top != over {
            continue;
        }
        for (m, o) in [(hi, &bv.highlight), (sh, &bv.shadow)] {
            let c = flat(o.color);
            if let Some(bx) = lay_with(
                dst,
                m,
                b.dev,
                (0, 0),
                &|_, _, _| c,
                o.opacity,
                o.blend,
                page,
                0,
            )? {
                laid = Some(laid.map_or(bx, |l| l.union(&bx)));
            }
        }
    }
    Ok(laid)
}

/// `v` rounded to a whole pixel, halves away from zero, after snapping it
/// to a millionth: a leg that is half a pixel but for the float error of a
/// cosine (sin 30 is 0.49999999999999994 in f64) rounds as the half it is
/// (review F26).
fn whole(v: f64) -> f64 {
    ((v * 1e6).round() / 1e6).round()
}

/// A drop or inner shadow's throw `(x, y)`, job units, in device pixels
/// and rounded to whole pixels as Photoshop does (PhotoCraft
/// `crates/compose/src/effects/paint.rs` `offset`, which rounds each axis of
/// the offset). The rounding applies in job units first, so a box shows its
/// shadow the same way at every zoom and in the export, then in device
/// pixels after `carried` (a zoom, a turn or a mirror), so the shadow is
/// laid without a resample. Rust's `round` takes halves away from zero, as
/// PhotoCraft's does; each leg is snapped first (see [`whole`]), so a turn
/// that leaves a leg at a half pixel rounds it the same way every time.
pub(crate) fn whole_throw(x: f64, y: f64, carried: impl Fn(f64, f64) -> (f64, f64)) -> (f64, f64) {
    let (dx, dy) = carried(whole(x), whole(y));
    (whole(dx), whole(dy))
}

/// A satin's throw in device pixels: `(-cos a, sin a) * distance`, at least
/// a pixel long (Photoshop draws Distance 0 as 1 px, an edge band of 2 /
/// size, measured by PhotoCraft in Photoshop 27.11), rounded to whole
/// pixels as Photoshop does. As [`whole_throw`], the rounding applies in
/// job units first, so the editor at any zoom throws what the export does
/// (review F25), then in device pixels after `carried`; each leg is snapped
/// before it rounds (review F26). The floor applies in job units, then
/// again in device pixels, where a zoom out could round the throw away.
/// Ported from PhotoCraft `crates/compose/src/effects/bevel.rs`
/// `satin_distance` and `effects/paint.rs` `offset`.
pub(crate) fn satin_throw(s: &Satin, carried: impl Fn(f64, f64) -> (f64, f64)) -> (f64, f64) {
    let a = s.angle.to_radians();
    // At least 1 job unit long, a leg of it at least 1/sqrt 2: it never
    // rounds to nothing.
    let d = s.distance.max(1.0);
    let (jx, jy) = (whole(-a.cos() * d), whole(a.sin() * d));
    let (dx, dy) = carried(jx, jy);
    let (wx, wy) = (whole(dx), whole(dy));
    if wx != 0.0 || wy != 0.0 {
        return (wx, wy);
    }
    // Rounded away: a device pixel along the throw.
    let len = dx.hypot(dy);
    if len > 0.0 && len.is_finite() {
        (whole(dx / len), whole(dy / len))
    } else {
        (0.0, 0.0)
    }
}

/// The fill raster `r` with the interior effects laid on it at Fill Opacity
/// `fill_opacity`, the outside parts of its strokes, and the bevels laid
/// outside it. `carried` turns a job-unit throw into device pixels; `scale`
/// is device pixels to a job unit.
///
/// `group` is Blend Interior Effects as Group: the fill is laid whole, the
/// overlays, the satin and the inner glows on it, and then Fill Opacity
/// fades them all together; the inner shadows, the strokes and the bevel
/// come after and are not faded. Off (Photoshop's default), Fill fades the
/// fill alone. Ported from PhotoCraft,
/// `crates/compose/src/effects/composite.rs` (`interior_group`,
/// `layer_pixels`, `paint_interior`), MIT licence.
#[allow(clippy::too_many_arguments)]
pub(crate) fn interior(
    r: &Raster,
    effects: &[Effect],
    fill_opacity: f64,
    group: bool,
    scale: f64,
    carried: impl Fn(f64, f64) -> (f64, f64),
    place: &Place<'_>,
) -> Result<(Raster, Option<Outside>, Option<Bevels>), Error> {
    let pad = interior_pad(effects, scale);
    interior_at(r, effects, fill_opacity, group, scale, carried, place, pad)
}

/// Room round the letters, device pixels, for a soft edge to come in from
/// outside them, and for the strokes and bevels outside them.
///
/// A throw needs no room: an Inner Shadow reads "outside" (1) and a Satin
/// "nothing" (0) where its copy comes in from off the map, which is what
/// the room round the letters would have held, so its Distance does not
/// grow the map (a Distance of 2000 once cost a GB a paint for the same
/// pixels). Only the soft edge reads past the letters: the Size, and a pixel
/// or two spare. A Precise Inner Glow measures to the nearest pixel outside
/// the letters, which the 2 px ring always holds; a Softer one blurs and
/// needs its Size.
fn interior_pad(effects: &[Effect], scale: f64) -> usize {
    let mut pad = 2.0f64;
    for e in effects.iter().filter(|e| e.shows()) {
        pad = pad.max(match e {
            Effect::InnerGlow(g) => match g.technique {
                Technique::Precise => 2.0,
                Technique::Softer => g.size * scale + 2.0,
            },
            Effect::InnerShadow(s) => s.size * scale + 2.0,
            Effect::Stroke(s) => s.widths().1 * scale + 2.0,
            Effect::Satin(s) => s.size * scale + 2.0,
            // The height's tent (or a chisel's ramp, a pixel past it) and
            // Soften's, inside the letters or out past them.
            Effect::Bevel(b) => {
                let inner = (b.size * scale).max(1.0) + b.soften * scale + 4.0;
                inner.max(f64::from(bevel_outward(b, scale)))
            }
            _ => 0.0,
        });
    }
    if pad.is_finite() {
        pad.ceil().min(4096.0) as usize
    } else {
        4096
    }
}

/// [`interior`] over a map `pad` device pixels round the fill raster `r`.
#[allow(clippy::too_many_arguments)]
fn interior_at(
    r: &Raster,
    effects: &[Effect],
    fill_opacity: f64,
    group: bool,
    scale: f64,
    carried: impl Fn(f64, f64) -> (f64, f64),
    place: &Place<'_>,
    pad: usize,
) -> Result<(Raster, Option<Outside>, Option<Bevels>), Error> {
    let (rw, rh) = (r.width as usize, r.height as usize);
    let (w, h) = (rw + 2 * pad, rh + 2 * pad);
    // The frame is a surface of its own: past the painter's largest it is
    // refused, as a surface is.
    let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
    if n > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let dev = (r.x - pad as i32, r.y - pad as i32);
    let group = group && fill_opacity < 1.0;
    // Grouped, the fill is whole until the group is faded.
    let content_fill = if group { 1.0 } else { fill_opacity };
    // The fill, straight, as a surface at its own alpha, and its shape.
    let mut shape = Map::filled(w, h, 0.0)?;
    let mut lay = Surface::new(w, h)?;
    for y in 0..rh {
        for x in 0..rw {
            let p = &r.data[(y * rw + x) * 4..(y * rw + x) * 4 + 4];
            let i = (y + pad) * w + x + pad;
            let a = f32::from(p[3]) / 255.0;
            shape.v[i] = a;
            if a <= map::INSIDE_EPS {
                continue;
            }
            // Relative to the shape, the fill is whole; Fill Opacity is
            // all of its alpha.
            let k = (content_fill.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
            let d = &mut lay.data[i * 4..i * 4 + 4];
            for c in 0..3 {
                d[c] = ((u32::from(p[c]) * k + 127) / 255) as u8;
            }
            d[3] = k as u8;
        }
    }
    let frame = job_frame(&shape, dev, place);
    // Inside the shape, whole.
    let full = Map::collect(
        w,
        h,
        shape
            .v
            .iter()
            .map(|&a| if a > map::INSIDE_EPS { 1.0 } else { 0.0 }),
    )?;
    // Of each kind the first listed is on top, so it is laid last.
    let shown = || effects.iter().rev().filter(|e| e.shows());
    let strokes: Vec<(usize, &Stroke)> = effects
        .iter()
        .enumerate()
        .filter(|(_, e)| e.shows())
        .filter_map(|(i, e)| match e {
            Effect::Stroke(s) => Some((i, s)),
            _ => None,
        })
        .collect();
    let inside_parts = strokes.iter().any(|(_, s)| s.widths().0 > 0.0);
    let burst_strokes = strokes.iter().any(|(_, s)| is_burst(&s.paint));
    let burst_overlay =
        shown().any(|e| matches!(e, Effect::GradientOverlay(o) if is_burst(&o.paint)));
    // The depth in from the letters' edge, worked out once: a Shape Burst
    // overlay's run, the strokes' inside parts' bands, a Stroke Emboss's
    // band and a Shape Burst stroke's run.
    let din = if burst_overlay || inside_parts || burst_strokes {
        Some(map::chamfer_inside(&shape)?)
    } else {
        None
    };
    // A Shape Burst overlay's depth, worked out once for them all.
    let overlay_depth = match &din {
        Some(d) if burst_overlay => Some(depth_share(d)?),
        _ => None,
    };
    let overlay = |lay: &mut Surface, o: &PaintOverlay| -> Result<(), Error> {
        let depth = overlay_depth.as_ref().map(|d| d.as_slice());
        if let Some(br) = brush_in(&o.paint, frame, place, dev, w, depth) {
            lay_with(
                lay,
                &full,
                (0, 0),
                dev,
                &|x, y, _| br.at(x, y),
                o.opacity,
                o.blend,
                None,
                0,
            )?;
        }
        Ok(())
    };
    for e in shown() {
        if let Effect::PatternOverlay(o) = e {
            overlay(&mut lay, o)?;
        }
    }
    for e in shown() {
        if let Effect::GradientOverlay(o) = e {
            overlay(&mut lay, o)?;
        }
    }
    drop(overlay_depth);
    for e in shown() {
        if let Effect::ColorOverlay(o) = e {
            let c = flat(o.color);
            lay_with(
                &mut lay,
                &full,
                (0, 0),
                dev,
                &|_, _, _| c,
                o.opacity,
                o.blend,
                None,
                0,
            )?;
        }
    }
    drop(full);
    for e in shown() {
        if let Effect::Satin(st) = e {
            let (dx, dy) = satin_throw(st, &carried);
            let m = map::satin(
                &shape,
                dx as f32,
                dy as f32,
                (st.size * scale) as f32,
                st.invert,
                st.contour.as_ref(),
            )?;
            let m = map::relative_to(&m, &shape)?;
            let c = flat(st.color);
            lay_with(
                &mut lay,
                &m,
                (0, 0),
                dev,
                &|_, _, _| c,
                st.opacity,
                st.blend,
                None,
                0,
            )?;
        }
    }
    for e in shown() {
        if let Effect::InnerGlow(g) = e {
            let s = soft(
                g.size, g.spread, scale, g.range, g.noise, g.contour, g.seed, dev,
            );
            let m = map::glow(&shape, g.technique, true, g.center, &s)?;
            let m = map::relative_to(&m, &shape)?;
            lay_glow(&mut lay, &m, (0, 0), dev, g, None)?;
        }
    }
    // Grouped: Fill Opacity fades the fill and what is on it so far.
    if group {
        let k = (fill_opacity.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
        for v in lay.data.iter_mut() {
            *v = ((u32::from(*v) * k + 127) / 255) as u8;
        }
    }
    for e in shown() {
        if let Effect::InnerShadow(sh) = e {
            let (dx, dy) = whole_throw(sh.x, sh.y, &carried);
            let s = soft(
                sh.size, sh.choke, scale, 1.0, sh.noise, sh.contour, sh.seed, dev,
            );
            let m = map::inner_shadow(&shape, dx as f32, dy as f32, &s)?;
            let m = map::relative_to(&m, &shape)?;
            let c = flat(sh.color);
            lay_with(
                &mut lay,
                &m,
                (0, 0),
                dev,
                &|_, _, _| c,
                sh.opacity,
                sh.blend,
                None,
                sh.seed,
            )?;
        }
    }
    // The strokes: their inside parts over the letters, the bottom one first.
    let din = din.as_ref().map(|d| d.as_slice());
    let deepest = din.map_or(0.0, |d| d.iter().copied().fold(0.0f32, f32::max));
    // A Shape Burst stroke runs from its outer edge (0) to its inner one
    // (1): `inner` is its depth in from the letters' edge to that one.
    let burst_in = |st: &Stroke| {
        let (i, o) = st.widths();
        let o = (o * scale) as f32;
        (o, o + ((i * scale) as f32).min(deepest))
    };
    if let Some(din) = din.filter(|_| inside_parts) {
        for (_, st) in strokes.iter().rev() {
            let in_w = (st.widths().0 * scale) as f32;
            if in_w <= 0.0 {
                continue;
            }
            let depth = if is_burst(&st.paint) {
                let (out, total) = burst_in(st);
                Some(budget::exact(
                    n,
                    din.iter()
                        .map(|&d| ((out + d.max(0.0)) / total.max(1e-3)).clamp(0.0, 1.0)),
                )?)
            } else {
                None
            };
            let m = Map::collect(
                w,
                h,
                shape.v.iter().zip(din).map(|(a, d)| {
                    if *a > map::INSIDE_EPS {
                        (in_w + 0.5 - d).clamp(0.0, 1.0)
                    } else {
                        0.0
                    }
                }),
            )?;
            let sf = frame.map(|f| stroke_frame(f, st, place.px()));
            let depth = depth.as_ref().map(|d| d.as_slice());
            if let Some(br) = brush_in(&st.paint, sf, place, dev, w, depth) {
                lay_with(
                    &mut lay,
                    &m,
                    (0, 0),
                    dev,
                    &|x, y, _| br.at(x, y),
                    st.opacity,
                    st.blend,
                    None,
                    st.seed,
                )?;
            }
        }
    }
    // The bevels: an inner one the last of the interior effects, over the
    // strokes' inside parts (B9); the others kept for the box to lay. A
    // Stroke Emboss raises the strokes' band, and with no stroke there is
    // none (Photoshop shows nothing either).
    let mut bevels = Vec::new();
    let mut band: Option<Option<Map>> = None;
    for (k, e) in effects.iter().enumerate().rev().filter(|(_, e)| e.shows()) {
        let Effect::Bevel(b) = e else {
            continue;
        };
        if b.style == BevelStyle::StrokeEmboss {
            if band.is_none() {
                band = Some(stroke_band(&shape, &strokes, scale, din)?);
            }
            let Some(Some(band)) = &band else {
                continue;
            };
            let (hi, sh, _) = bevel_maps(band, b, scale, &carried, place, dev)?;
            bevels.push((k, true, hi, sh));
            continue;
        }
        let (hi, sh, reach) = bevel_maps(&shape, b, scale, &carried, place, dev)?;
        if reach != Reach::Inner {
            bevels.push((k, reach == Reach::Both, hi, sh));
            continue;
        }
        for (m, o) in [(&hi, &b.highlight), (&sh, &b.shadow)] {
            let m = map::relative_to(m, &shape)?;
            let c = flat(o.color);
            lay_with(
                &mut lay,
                &m,
                (0, 0),
                dev,
                &|_, _, _| c,
                o.opacity,
                o.blend,
                None,
                0,
            )?;
        }
    }
    drop(band);
    // The shape's own alpha, and back to straight colour.
    let mut data = budget::filled(n * 4, 0u8)?;
    let mut alpha = budget::filled(n, 0f32)?;
    for (i, (d, p)) in data
        .chunks_exact_mut(4)
        .zip(lay.data.chunks_exact(4))
        .enumerate()
    {
        let la = u32::from(p[3]);
        if la == 0 {
            continue;
        }
        let a = (f32::from(p[3]) * shape.v[i]).round().clamp(0.0, 255.0) as u8;
        for c in 0..3 {
            d[c] = ((u32::from(p[c]) * 255 + la / 2) / la).min(255) as u8;
        }
        d[3] = a;
        alpha[i] = f32::from(a) / 255.0;
    }
    drop(lay);
    // The outside parts: each stroke's share, the first listed first.
    let mut items = Vec::new();
    if strokes.iter().any(|(_, s)| s.widths().1 > 0.0) {
        let mut chamfer = None;
        let mut exact = None;
        let mut cover = budget::filled(n, 0.0f32)?;
        for (k, st) in &strokes {
            let out_w = (st.widths().1 * scale) as f32;
            if out_w <= 0.0 {
                continue;
            }
            let d = outside_dist(&shape, out_w, &mut chamfer, &mut exact)?;
            let mut share = budget::filled(n, 0.0f32)?;
            for (i, sh) in share.iter_mut().enumerate() {
                let band = (out_w + 0.5 - d[i]).clamp(0.0, 1.0);
                let k = if shape.v[i] > map::INSIDE_EPS {
                    band * outline_share(shape.v[i], alpha[i])
                } else {
                    band
                };
                let mut k = k * st.opacity as f32;
                if st.blend == Blend::Dissolve {
                    let (x, y) = (dev.0 + (i % w) as i32, dev.1 + (i / w) as i32);
                    k = if k > 0.0 && noise::unit(x, y, st.seed) < k {
                        1.0
                    } else {
                        0.0
                    };
                }
                *sh = k * (1.0 - cover[i]);
                cover[i] += *sh;
            }
            let depth = if is_burst(&st.paint) {
                let (out, total) = burst_in(st);
                Some(budget::exact(
                    n,
                    d.iter()
                        .map(|&d| ((out - d.max(-0.5)) / total.max(1e-3)).clamp(0.0, 1.0)),
                )?)
            } else {
                None
            };
            items.push((*k, share, depth));
        }
    }
    let outside = (!items.is_empty()).then_some(Outside {
        dev,
        w,
        h,
        frame,
        items,
    });
    let bevels = (!bevels.is_empty()).then_some(Bevels { dev, items: bevels });
    Ok((
        Raster {
            x: dev.0,
            y: dev.1,
            width: w as u32,
            height: h as u32,
            data: data.into_vec(),
        },
        outside,
        bevels,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED: Rgba = Rgba([255, 0, 0, 255]);
    const BLUE: Rgba = Rgba([0, 0, 255, 255]);

    /// A square of `RED` fill, `n` across, solid.
    fn square(n: u32) -> Raster {
        Raster {
            x: 10,
            y: 10,
            width: n,
            height: n,
            data: RED.0.repeat((n * n) as usize),
        }
    }

    fn place() -> Place<'static> {
        Place {
            transform: Affine::IDENTITY,
            tiles: &[],
        }
    }

    fn inside(r: &Raster, effects: &[Effect]) -> (Raster, Option<Outside>) {
        let (r, o, _) = interior(r, effects, 1.0, false, 1.0, |x, y| (x, y), &place()).unwrap();
        (r, o)
    }

    fn stroke(size: f64, position: Position, paint: Paint) -> Effect {
        Effect::Stroke(Stroke {
            size,
            position,
            opacity: 1.0,
            blend: Blend::Normal,
            paint,
            seed: 0,
        })
    }

    fn at(r: &Raster, x: i32, y: i32) -> [u8; 4] {
        let i = ((y - r.y) as usize * r.width as usize + (x - r.x) as usize) * 4;
        [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
    }

    fn satin(angle: f64, distance: f64, invert: bool) -> Satin {
        Satin {
            color: BLUE,
            opacity: 1.0,
            blend: Blend::Normal,
            angle,
            distance,
            size: 0.0,
            invert,
            contour: None,
        }
    }

    #[test]
    fn a_shadow_throw_is_rounded_in_job_units_then_in_device_pixels() {
        let same = |x: f64, y: f64| (x, y);
        assert_eq!(whole_throw(3.4, -2.6, same), (3.0, -3.0));
        // Halves go away from zero, as PhotoCraft's `round` takes them.
        assert_eq!(whole_throw(2.5, -2.5, same), (3.0, -3.0));
        assert_eq!(whole_throw(0.0, 0.4, same), (0.0, 0.0));
        // At twice the zoom the throw is the export's, doubled: 3.4 is 3
        // page px, so 6 device px, not 7.
        let twice = |x: f64, y: f64| (2.0 * x, 2.0 * y);
        assert_eq!(whole_throw(3.4, 0.0, twice), (6.0, 0.0));
        // A zoom that makes half pixels of it rounds again in device pixels.
        let half_more = |x: f64, y: f64| (1.5 * x, 1.5 * y);
        assert_eq!(whole_throw(3.0, -1.0, half_more), (5.0, -2.0));
        // A turned or mirrored box carries the rounded throw.
        let turn = |x: f64, y: f64| (-y, x);
        assert_eq!(whole_throw(3.4, 1.2, turn), (-1.0, 3.0));
        let tilt = |x: f64, y: f64| (0.6 * x - 0.8 * y, 0.8 * x + 0.6 * y);
        assert_eq!(whole_throw(5.0, 0.0, tilt), (3.0, 4.0));
    }

    #[test]
    fn a_satin_throw_is_whole_pixels_and_at_least_one() {
        let same = |x: f64, y: f64| (x, y);
        // Photoshop's offset: (-cos a, sin a) * distance, rounded.
        assert_eq!(satin_throw(&satin(0.0, 3.0, false), same), (-3.0, 0.0));
        assert_eq!(satin_throw(&satin(120.0, 10.0, false), same), (5.0, 9.0));
        // Distance 0 is drawn as 1 px, along the angle.
        assert_eq!(satin_throw(&satin(90.0, 0.0, false), same), (0.0, 1.0));
        assert_eq!(satin_throw(&satin(45.0, 0.0, false), same), (-1.0, 1.0));
        // A turned box carries the throw: a quarter turn makes across down.
        let turn = |x: f64, y: f64| (-y, x);
        assert_eq!(satin_throw(&satin(0.0, 3.0, false), turn), (0.0, -3.0));
        // A mirrored one flips it; twice the scale throws twice as far.
        let mirror = |x: f64, y: f64| (-x, y);
        assert_eq!(satin_throw(&satin(0.0, 3.0, false), mirror), (3.0, 0.0));
        let twice = |x: f64, y: f64| (2.0 * x, 2.0 * y);
        assert_eq!(satin_throw(&satin(0.0, 3.0, false), twice), (-6.0, 0.0));
        // Small on screen it is still a device pixel long.
        let small = |x: f64, y: f64| (0.25 * x, 0.25 * y);
        assert_eq!(satin_throw(&satin(0.0, 0.0, false), small), (-1.0, 0.0));
        assert_eq!(satin_throw(&satin(45.0, 1.0, false), small), (-1.0, 1.0));
    }

    /// Review F25: the default Satin (angle 19, distance 11) throws
    /// (-10.40, 3.58) job units. Rounded in job units first it is (-10, 4)
    /// in the export and (-20, 8) device px, the same, in the editor at 2;
    /// rounded only after the zoom it was (-21, 7), (-10.5, 3.5) job units.
    #[test]
    fn a_satin_throw_is_rounded_in_job_units_then_in_device_pixels() {
        let st = satin(19.0, 11.0, false);
        let same = |x: f64, y: f64| (x, y);
        let twice = |x: f64, y: f64| (2.0 * x, 2.0 * y);
        assert_eq!(satin_throw(&st, same), (-10.0, 4.0));
        assert_eq!(satin_throw(&st, twice), (-20.0, 8.0));
        // A zoom that makes half pixels of it rounds again in device pixels.
        let half_more = |x: f64, y: f64| (1.5 * x, 1.5 * y);
        assert_eq!(satin_throw(&st, half_more), (-15.0, 6.0));
    }

    /// Review F26: sin 30 is 0.49999999999999994 and -cos 120 x 11 is
    /// 5.499999999999998 in f64; snapped, the half pixel rounds away from
    /// zero as it does at every other angle.
    #[test]
    fn a_satins_half_pixel_leg_rounds_away_from_zero() {
        let same = |x: f64, y: f64| (x, y);
        assert_eq!(satin_throw(&satin(30.0, 1.0, false), same), (-1.0, 1.0));
        assert_eq!(satin_throw(&satin(120.0, 11.0, false), same), (6.0, 10.0));
        assert_eq!(satin_throw(&satin(150.0, 1.0, false), same), (1.0, 1.0));
        // -30 and 210: the same half, the other way.
        assert_eq!(satin_throw(&satin(-30.0, 1.0, false), same), (-1.0, -1.0));
        assert_eq!(satin_throw(&satin(210.0, 1.0, false), same), (1.0, -1.0));
        // A shadow thrown whole by a 30 degree turn has its half leg too.
        let (s30, c30) = 30f64.to_radians().sin_cos();
        assert!(s30 < 0.5);
        let turn = move |x: f64, y: f64| (c30 * x - s30 * y, s30 * x + c30 * y);
        assert_eq!(whole_throw(1.0, 0.0, turn), (1.0, 1.0));
    }

    #[test]
    fn a_satin_lays_the_gap_between_its_copies_inside_the_letters() {
        let _scope = budget::Scope::new();
        let r = square(20);
        let (out, _) = inside(&r, &[Effect::Satin(satin(0.0, 3.0, false))]);
        // Thrown 3 each way across: the side columns take it, the middle not.
        assert_eq!(at(&out, 10, 20), [0, 0, 255, 255]);
        assert_eq!(at(&out, 29, 20), [0, 0, 255, 255]);
        assert_eq!(at(&out, 20, 20), [255, 0, 0, 255]);
        // Never outside the letters.
        for (x, y) in [(9, 20), (30, 20), (20, 9), (20, 30)] {
            assert_eq!(at(&out, x, y)[3], 0, "({x}, {y})");
        }
        // Inverted, the other way round.
        let (out, _) = inside(&r, &[Effect::Satin(satin(0.0, 3.0, true))]);
        assert_eq!(at(&out, 10, 20), [255, 0, 0, 255]);
        assert_eq!(at(&out, 20, 20), [0, 0, 255, 255]);
        // Distance 0 is a 1 px throw, not two copies cancelling.
        let (zero, _) = inside(&r, &[Effect::Satin(satin(0.0, 0.0, false))]);
        let (one, _) = inside(&r, &[Effect::Satin(satin(0.0, 1.0, false))]);
        assert_eq!(zero.data, one.data);
        assert_eq!(at(&zero, 10, 20), [0, 0, 255, 255]);
    }

    #[test]
    fn a_colour_overlay_recolours_the_fill_and_keeps_its_alpha() {
        let _scope = budget::Scope::new();
        let o = Effect::ColorOverlay(Overlay {
            color: BLUE,
            opacity: 1.0,
            blend: Blend::Normal,
        });
        let (out, _) = inside(&square(8), std::slice::from_ref(&o));
        assert_eq!(at(&out, 13, 13), [0, 0, 255, 255]);
        // At Fill Opacity 0 the overlay still shows; nothing outside the fill.
        let (out, _, _) =
            interior(&square(8), &[o], 0.0, false, 1.0, |x, y| (x, y), &place()).unwrap();
        assert_eq!(at(&out, 13, 13), [0, 0, 255, 255]);
        assert_eq!(at(&out, 9, 9)[3], 0);
    }

    #[test]
    fn an_inner_shadow_darkens_the_side_it_is_thrown_from() {
        let _scope = budget::Scope::new();
        let s = Effect::InnerShadow(InnerShadow {
            color: Rgba([0, 0, 0, 255]),
            opacity: 1.0,
            blend: Blend::Normal,
            x: 3.0,
            y: 3.0,
            size: 0.0,
            choke: 0.0,
            noise: 0.0,
            contour: None,
            seed: 0,
        });
        let (out, _) = inside(&square(12), &[s]);
        // Top-left inside edge in shadow, bottom-right red.
        assert_eq!(at(&out, 10, 10), [0, 0, 0, 255]);
        assert_eq!(at(&out, 21, 21), [255, 0, 0, 255]);
    }

    #[test]
    fn an_inside_stroke_paints_inside_the_edge_and_leaves_the_middle() {
        let _scope = budget::Scope::new();
        let black = Paint::Color(Rgba([0, 0, 0, 255]));
        let (out, o) = inside(&square(12), &[stroke(2.0, Position::Inside, black)]);
        assert!(o.is_none());
        assert_eq!(at(&out, 10, 15), [0, 0, 0, 255]);
        assert_eq!(at(&out, 11, 15), [0, 0, 0, 255]);
        assert_eq!(at(&out, 15, 15), [255, 0, 0, 255]);
        assert_eq!(at(&out, 9, 15)[3], 0);
    }

    #[test]
    fn an_outside_stroke_slides_under_the_letters() {
        let _scope = budget::Scope::new();
        let black = Paint::Color(Rgba([0, 0, 0, 255]));
        let fx = [stroke(3.0, Position::Outside, black)];
        let (out, o) = inside(&square(12), &fx);
        let o = o.expect("an outside part");
        let mut s = Surface::new(40, 40).unwrap();
        lay_outside(&mut s, &o, &fx, &place(), None).unwrap();
        let px = |x: usize, y: usize| &s.data[(y * 40 + x) * 4..][..4];
        assert_eq!(px(8, 15), [0, 0, 0, 255]);
        assert_eq!(px(7, 15), [0, 0, 0, 255]);
        assert_eq!(px(5, 15)[3], 0);
        // Under the letters nothing: they cover it whole.
        assert_eq!(px(15, 15)[3], 0);
        // The letters themselves keep their fill.
        assert_eq!(at(&out, 15, 15), [255, 0, 0, 255]);
    }

    #[test]
    fn a_higher_outside_stroke_covers_a_wider_one_below() {
        let _scope = budget::Scope::new();
        let fx = [
            stroke(2.0, Position::Outside, Paint::Color(BLUE)),
            stroke(4.0, Position::Outside, Paint::Color(Rgba([0, 0, 0, 255]))),
        ];
        let (_, o) = inside(&square(12), &fx);
        let mut s = Surface::new(40, 40).unwrap();
        lay_outside(&mut s, &o.unwrap(), &fx, &place(), None).unwrap();
        let px = |x: usize, y: usize| &s.data[(y * 40 + x) * 4..][..4];
        assert_eq!(px(9, 15), [0, 0, 255, 255]);
        assert_eq!(px(6, 15), [0, 0, 0, 255]);
    }

    #[test]
    fn a_gradient_overlay_runs_across_the_letters() {
        let _scope = budget::Scope::new();
        let g = Gradient {
            stops: vec![(0.0, [0.0; 3]), (1.0, [1.0; 3])],
            opacity: Vec::new(),
            style: gradient::Style::Linear,
            angle: 0.0,
            scale: 1.0,
            reverse: false,
            offset: (0.0, 0.0),
            noise: None,
        };
        let o = Effect::GradientOverlay(PaintOverlay {
            opacity: 1.0,
            blend: Blend::Normal,
            paint: Paint::Gradient(g),
        });
        let (out, _) = inside(&square(20), &[o]);
        let (l, r) = (at(&out, 10, 20), at(&out, 29, 20));
        assert!(l[0] < 20 && r[0] > 235, "{l:?} {r:?}");
        assert_eq!(l[0], l[1]);
        assert_eq!(l[3], 255);
    }

    fn burst(reverse: bool) -> Gradient {
        Gradient {
            stops: vec![(0.0, [0.0; 3]), (1.0, [1.0; 3])],
            opacity: Vec::new(),
            style: gradient::Style::ShapeBurst,
            angle: 30.0,
            scale: 1.0,
            reverse,
            offset: (0.3, 0.0),
            noise: None,
        }
    }

    #[test]
    fn a_shape_burst_overlay_runs_from_the_edge_to_the_deepest_point() {
        let _scope = budget::Scope::new();
        for reverse in [false, true] {
            let o = Effect::GradientOverlay(PaintOverlay {
                opacity: 1.0,
                blend: Blend::Normal,
                paint: Paint::Gradient(burst(reverse)),
            });
            let (out, _) = inside(&square(20), &[o]);
            // Each edge the same (the angle and offset do not move it), and
            // the middle, ten pixels in, the deepest.
            let edges = [(10, 20), (29, 20), (20, 10), (20, 29)].map(|(x, y)| at(&out, x, y)[0]);
            let middle = at(&out, 19, 19)[0];
            assert!(edges.iter().all(|&e| e == edges[0]), "{edges:?}");
            if reverse {
                assert!(edges[0] > 235 && middle < 5, "{edges:?} {middle}");
            } else {
                assert!(edges[0] < 20 && middle > 250, "{edges:?} {middle}");
            }
            // Half way in, about half way along.
            let half = at(&out, 15, 19)[0];
            assert!((100..160).contains(&half), "{half}");
        }
    }

    /// Review F27: a Shape Burst overlay's depth is seeded by coverage. A
    /// 25 % edge column once read the same as a whole one, half a pixel in
    /// (51 on this 6 px stem); it takes the edge stop. The deepest pixel
    /// still takes the far stop.
    #[test]
    fn a_shape_burst_overlay_shows_the_edge_stop_on_thin_stems() {
        let _scope = budget::Scope::new();
        let o = || {
            Effect::GradientOverlay(PaintOverlay {
                opacity: 1.0,
                blend: Blend::Normal,
                paint: Paint::Gradient(burst(false)),
            })
        };
        let stem = |alphas: &[u8]| Raster {
            x: 10,
            y: 10,
            width: alphas.len() as u32,
            height: 20,
            data: (0..20)
                .flat_map(|_| alphas.iter().flat_map(|&a| [255, 0, 0, a]))
                .collect(),
        };
        // 1 px: all of it deepest, the far stop.
        let (out, _) = inside(&stem(&[255]), &[o()]);
        let mid = at(&out, 10, 20);
        assert_eq!((mid[0], mid[3]), (255, 255));
        // 25 %, four whole, 25 %: the edge column a quarter pixel in, so
        // nothing past the edge (the edge stop); the next 0.75 in and the
        // middle two 1.75, the deepest: 0.75 / 1.75 (109) and 255.
        let (out, _) = inside(&stem(&[64, 255, 255, 255, 255, 64]), &[o()]);
        let row: Vec<[u8; 4]> = (10..16).map(|x| at(&out, x, 20)).collect();
        assert!(row[0][0] < 5, "{row:?}");
        assert_eq!(row[0][3], 64);
        assert!((104..=114).contains(&row[1][0]), "{row:?}");
        assert!(row[2][0] > 250 && row[3][0] > 250, "{row:?}");
        assert_eq!((row[5][0], row[4][0]), (row[0][0], row[1][0]));
    }

    #[test]
    fn a_shape_burst_stroke_runs_across_its_band() {
        let _scope = budget::Scope::new();
        let g = || Paint::Gradient(burst(false));
        // Inside, 4 wide: dark at the letters' edge, light 4 in.
        let (out, _) = inside(&square(20), &[stroke(4.0, Position::Inside, g())]);
        let (e, d) = (at(&out, 10, 20)[0], at(&out, 13, 20)[0]);
        assert!(e < 50 && d > 180, "{e} {d}");
        // Outside, 4 wide: dark at its outer edge, light against the letters.
        let fx = [stroke(4.0, Position::Outside, g())];
        let (_, o) = inside(&square(20), &fx);
        let mut s = Surface::new(40, 40).unwrap();
        lay_outside(&mut s, &o.unwrap(), &fx, &place(), None).unwrap();
        let px = |x: usize, y: usize| s.data[(y * 40 + x) * 4];
        assert!(
            px(6, 20) < 50 && px(9, 20) > 180,
            "{} {}",
            px(6, 20),
            px(9, 20)
        );
    }

    #[test]
    fn a_noise_gradient_overlay_paints_its_ramp() {
        use super::super::noise_gradient::{Model, Noise, Ramp};
        let _scope = budget::Scope::new();
        let ramp = Ramp::new(Noise {
            seed: 4,
            roughness: 1.0,
            model: Model::Rgb,
            min: [0.0; 3],
            max: [1.0; 3],
            restrict: false,
            transparency: false,
        });
        let g = Gradient {
            style: gradient::Style::Linear,
            angle: 0.0,
            offset: (0.0, 0.0),
            noise: Some(ramp.clone()),
            ..burst(false)
        };
        let o = Effect::GradientOverlay(PaintOverlay {
            opacity: 1.0,
            blend: Blend::Normal,
            paint: Paint::Gradient(g.clone()),
        });
        let (out, _) = inside(&square(40), &[o]);
        for x in [12, 25, 37] {
            let t = g.t([10.0, 10.0, 50.0, 50.0], 1.0, x as f32 + 0.5, 30.5);
            let want = ramp.sample(t).map(|v| (v * 255.0).round() as i32);
            let got = at(&out, x, 30);
            for c in 0..3 {
                assert!(
                    (i32::from(got[c]) - want[c]).abs() <= 1,
                    "{x} {got:?} {want:?}"
                );
            }
        }
    }

    #[test]
    fn a_pattern_overlay_lays_its_fill() {
        let _scope = budget::Scope::new();
        let o = Effect::PatternOverlay(PaintOverlay {
            opacity: 0.5,
            blend: Blend::Normal,
            paint: Paint::Fill(Fill::Solid(BLUE)),
        });
        let (out, _) = inside(&square(8), &[o]);
        let p = at(&out, 13, 13);
        assert!(
            (126..=129).contains(&p[0]) && (126..=129).contains(&p[2]),
            "{p:?}"
        );
    }

    #[test]
    fn a_gradient_glow_takes_its_first_stop_at_the_edge() {
        let _scope = budget::Scope::new();
        let g = Glow {
            color: RED,
            gradient: Some(Gradient {
                stops: vec![(0.0, [0.0, 1.0, 0.0]), (1.0, [0.0, 0.0, 1.0])],
                opacity: Vec::new(),
                style: gradient::Style::Linear,
                angle: 0.0,
                scale: 1.0,
                reverse: false,
                offset: (0.0, 0.0),
                noise: None,
            }),
            opacity: 1.0,
            blend: Blend::Normal,
            technique: Technique::Precise,
            size: 6.0,
            spread: 0.0,
            range: 0.5,
            noise: 0.0,
            contour: None,
            center: false,
            jitter: 0.0,
            seed: 0,
        };
        let (out, _) = inside(&square(20), &[Effect::InnerGlow(g)]);
        let edge = at(&out, 10, 20);
        assert!(edge[1] > 200 && edge[2] < 60, "{edge:?}");
    }

    /// Review F6 and F65: each sample moves on by `n * jitter` and only one
    /// carried past 1 wraps round to the strong end; one that would go below
    /// 0 cannot (a solid band, `t` 0, keeps its place). Told from a clamp:
    /// a sample past 1 comes back at exactly `t + n * jitter - 1`, near 0,
    /// not at 1.
    #[test]
    fn jitter_moves_a_sample_on_by_its_share_and_wraps_past_the_end() {
        assert_eq!(jittered(0.3, 0.0, 4, 5, 9), 0.3);
        assert_eq!(jittered(0.3, f32::NAN, 4, 5, 9), 0.3);
        let mut moved = 0;
        let mut wrapped = 0;
        for i in 0..2000 {
            let (x, y) = (i % 50, i / 50);
            let n = noise::unit(x, y, 3 ^ JITTER_SALT);
            let t = jittered(0.5, 0.4, x, y, 3);
            assert!((0.5..0.9).contains(&t), "{t}");
            assert!((t - (0.5 + n * 0.4)).abs() < 1e-6);
            moved += usize::from(t - 0.5 > 0.05);
            // The same pixel and seed move the same way every time.
            assert_eq!(t, jittered(0.5, 0.4, x, y, 3));
            // Past the end it comes back in at the other: wrapped, not
            // clamped.
            let w = jittered(0.95, 0.5, x, y, 3);
            let past = 0.95 + n * 0.5;
            if past > 1.0 {
                assert!((w - (past - 1.0)).abs() < 1e-6, "{w} vs {past}");
                assert!(w < 0.45, "{w}");
                wrapped += 1;
            } else {
                assert!((w - past).abs() < 1e-6);
            }
            // A solid band at Jitter 1 % stays within 1 % of the strong end.
            let solid = jittered(0.0, 0.01, x, y, 3);
            assert!((0.0..0.01).contains(&solid), "{solid}");
        }
        assert!(moved > 1600, "{moved}");
        assert!((1700..1900).contains(&wrapped), "{wrapped}");
        // Its own numbers, not the grain's.
        let same = (0..200)
            .filter(|&i| {
                let n = noise::unit(i, 7, 3);
                (jittered(0.0, 1.0, i, 7, 3) - n).abs() < 1e-6
            })
            .count();
        assert!(same < 5, "{same}");
    }

    /// Review F6: an Outer Glow with a colour-to-clear gradient, Precise,
    /// Size 8, Spread 50 %, Jitter 1 %. Its solid band (4 px out) read
    /// alpha [254, 1, 1, 1, 0] along a row with the centred wrap; it stays
    /// solid, within the 1 % of the ramp Jitter moves it (253 to 255).
    #[test]
    fn jitter_keeps_a_solid_glow_band_solid() {
        let _scope = budget::Scope::new();
        let fade = Gradient {
            stops: vec![(0.0, [1.0, 1.0, 0.0]), (1.0, [1.0, 1.0, 0.0])],
            opacity: vec![(0.0, 1.0), (1.0, 0.0)],
            style: gradient::Style::Linear,
            angle: 0.0,
            scale: 1.0,
            reverse: false,
            offset: (0.0, 0.0),
            noise: None,
        };
        let n = 40usize;
        let mut shape = Map::new(n, n, 0.0);
        for y in 15..25 {
            for x in 15..25 {
                shape.v[y * n + x] = 1.0;
            }
        }
        for jitter in [0.0, 0.01, 0.2] {
            let g = Effect::OuterGlow(Glow {
                color: RED,
                gradient: Some(fade.clone()),
                opacity: 1.0,
                blend: Blend::Normal,
                technique: Technique::Precise,
                size: 8.0,
                spread: 0.5,
                range: 0.5,
                noise: 0.0,
                contour: None,
                center: false,
                jitter,
                seed: 11,
            });
            let mut dst = Surface::new(n, n).unwrap();
            let region = IBox {
                x0: 0,
                y0: 0,
                x1: n as i32,
                y1: n as i32,
            };
            lay_outer_glows(&mut dst, &[g], &shape, None, 1.0, region, 1.0, None).unwrap();
            // Along row 20, the four pixels left of the square, the band.
            let band: Vec<u8> = (11..15).map(|x| dst.data[(20 * n + x) * 4 + 3]).collect();
            if jitter == 0.0 {
                assert_eq!(band, vec![255; 4]);
            } else if jitter <= 0.01 {
                // Moved on by under 1 % of the ramp: within 1 % of solid.
                assert!(band.iter().all(|&a| a >= 252), "jitter {jitter}: {band:?}");
            } else {
                // A larger Jitter scatters it, but none of it is thrown to
                // the clear end.
                assert!(band.iter().all(|&a| a > 150), "jitter {jitter}: {band:?}");
            }
        }
    }

    #[test]
    fn jitter_scatters_a_gradient_glow_and_leaves_a_colour_glow_alone() {
        let _scope = budget::Scope::new();
        let glow = |gradient: Option<Gradient>, jitter: f64| Glow {
            color: RED,
            gradient,
            opacity: 1.0,
            blend: Blend::Normal,
            technique: Technique::Precise,
            size: 8.0,
            spread: 0.0,
            range: 1.0,
            noise: 0.0,
            contour: None,
            center: false,
            jitter,
            seed: 5,
        };
        let ramp = Gradient {
            stops: vec![(0.0, [0.0, 1.0, 0.0]), (1.0, [0.0, 0.0, 1.0])],
            opacity: Vec::new(),
            style: gradient::Style::Linear,
            angle: 0.0,
            scale: 1.0,
            reverse: false,
            offset: (0.0, 0.0),
            noise: None,
        };
        let paint = |g: Glow| inside(&square(30), &[Effect::InnerGlow(g)]).0;
        // A colour glow: Jitter changes nothing.
        assert_eq!(paint(glow(None, 0.0)).data, paint(glow(None, 0.8)).data);
        // A gradient glow: the same strength, the colours scattered. Along a
        // row a few pixels in, Jitter 0 is one colour; at 60 % neighbours
        // differ.
        let (calm, rough) = (
            paint(glow(Some(ramp.clone()), 0.0)),
            paint(glow(Some(ramp), 0.6)),
        );
        assert_ne!(calm.data, rough.data);
        let row = |r: &Raster| (14..26).map(|x| at(r, x, 13)).collect::<Vec<_>>();
        let (c, j) = (row(&calm), row(&rough));
        assert!(c.windows(2).all(|w| w[0] == w[1]), "{c:?}");
        let changes = j.windows(2).filter(|w| w[0] != w[1]).count();
        assert!(changes >= 6, "{j:?}");
        // Alpha is the shape's (inner glow over a whole fill): unchanged.
        let alpha = |r: &Raster| {
            r.data
                .iter()
                .skip(3)
                .step_by(4)
                .copied()
                .collect::<Vec<_>>()
        };
        assert_eq!(alpha(&calm), alpha(&rough));
    }

    fn inner_shadow(x: f64, y: f64, size: f64) -> Effect {
        Effect::InnerShadow(InnerShadow {
            color: BLUE,
            opacity: 1.0,
            blend: Blend::Normal,
            x,
            y,
            size,
            choke: 0.0,
            noise: 0.0,
            contour: None,
            seed: 1,
        })
    }

    fn inner_glow(technique: Technique, size: f64) -> Effect {
        Effect::InnerGlow(Glow {
            color: BLUE,
            gradient: None,
            opacity: 1.0,
            blend: Blend::Normal,
            technique,
            size,
            spread: 0.0,
            range: 0.5,
            noise: 0.0,
            contour: None,
            center: false,
            jitter: 0.0,
            seed: 1,
        })
    }

    /// The interior at `scale` (a zoom: the throw carried by it), and the
    /// most the budget held while it painted.
    fn zoomed(r: &Raster, effects: &[Effect], scale: f64, pad: Option<usize>) -> (Raster, usize) {
        let _scope = budget::Scope::new();
        let carried = |x: f64, y: f64| (x * scale, y * scale);
        let (r, _, _) = match pad {
            None => interior(r, effects, 1.0, false, scale, carried, &place()),
            Some(pad) => interior_at(r, effects, 1.0, false, scale, carried, &place(), pad),
        }
        .unwrap();
        (r, budget::peak_for_test())
    }

    /// `r`'s pixels over `to`'s bounds.
    fn crop(r: &Raster, to: &Raster) -> Vec<u8> {
        let mut out = Vec::new();
        for y in to.y..to.y + to.height as i32 {
            for x in to.x..to.x + to.width as i32 {
                out.extend_from_slice(&at(r, x, y));
            }
        }
        out
    }

    #[test]
    fn an_inner_shadow_thrown_far_paints_the_same_and_costs_no_more() {
        // An 8 px square at 200 %: a throw of 5 (10 px) already clears it,
        // so 2000 is the same shadow. Its Distance once padded the map, a
        // 64 Mpx frame and a GB of maps a paint; the pad is the Size now.
        let sq = square(8);
        let (near, near_peak) = zoomed(&sq, &[inner_shadow(0.0, 5.0, 0.0)], 2.0, None);
        let (far, far_peak) = zoomed(&sq, &[inner_shadow(0.0, 2000.0, 0.0)], 2.0, None);
        assert_eq!(near, far);
        assert_eq!((far.width, far.height), (12, 12));
        assert!(at(&far, 13, 13)[2] == 255 && at(&far, 13, 13)[3] == 255);
        assert_eq!(near_peak, far_peak);
        assert!(far_peak < 64 * 1024, "{far_peak} bytes");
    }

    #[test]
    fn a_throw_or_a_precise_size_needs_no_room_round_the_letters() {
        // The pixels are those of the map padded as it once was (by the
        // throw, or the Precise glow's Size), cut to the smaller map.
        let sq = square(20);
        let cases: [(Effect, usize); 5] = [
            (inner_shadow(30.0, -170.0, 3.0), 6 + 340 + 2),
            (inner_shadow(0.0, 4.0, 2.0), 4 + 8 + 2),
            (
                Effect::Satin(Satin {
                    size: 4.0,
                    ..satin(19.0, 150.0, false)
                }),
                8 + 300 + 2,
            ),
            (
                Effect::Satin(Satin {
                    size: 3.0,
                    ..satin(120.0, 6.0, true)
                }),
                6 + 12 + 2,
            ),
            (inner_glow(Technique::Precise, 50.0), 100 + 2),
        ];
        for (fx, old_pad) in cases {
            let fx = [fx];
            let (new, _) = zoomed(&sq, &fx, 2.0, None);
            let (old, _) = zoomed(&sq, &fx, 2.0, Some(old_pad));
            assert!(new.width < old.width, "{fx:?}");
            assert_eq!(crop(&old, &new), new.data, "{fx:?}");
        }
        assert_eq!(
            interior_pad(&[inner_glow(Technique::Precise, 250.0)], 4.0),
            2
        );
        assert_eq!(
            interior_pad(&[inner_glow(Technique::Softer, 250.0)], 4.0),
            1002
        );
        assert_eq!(interior_pad(&[inner_shadow(0.0, 30000.0, 5.0)], 2.0), 12);
        assert_eq!(
            interior_pad(&[Effect::Satin(satin(0.0, 30000.0, false))], 2.0),
            2
        );
    }

    #[test]
    fn effect_maps_are_charged_so_a_paint_past_the_budget_is_refused() {
        // A Softer Inner Glow of 100 round a 40 px square: a 244 px frame.
        // Its surface and the layer an effect is laid through are 8 bytes a
        // pixel; the shape and the glow's maps take it past 9, which the
        // budget once never saw.
        let fx = [inner_glow(Technique::Softer, 100.0)];
        let n = 244 * 244;
        {
            budget::limit_next_scope_for_test(9 * n);
            let _scope = budget::Scope::new();
            let got = interior(&square(40), &fx, 1.0, false, 1.0, |x, y| (x, y), &place());
            assert_eq!(got.err(), Some(Error::BadSpec));
        }
        let (r, peak) = zoomed(&square(40), &fx, 1.0, None);
        assert_eq!(r.width, 244);
        assert!(peak > 9 * n, "{peak}");
    }

    #[test]
    fn a_frame_past_the_largest_surface_is_refused_before_anything_is_held() {
        // A 5000 outside stroke pads 4096 each way: 8193 px square.
        let _scope = budget::Scope::new();
        let fx = [stroke(5000.0, Position::Outside, Paint::Color(BLUE))];
        let got = interior(&square(1), &fx, 1.0, false, 1.0, |x, y| (x, y), &place());
        assert_eq!(got.err(), Some(Error::BadSpec));
        assert_eq!(budget::peak_for_test(), 0);
    }

    #[test]
    fn shape_burst_depth_is_worked_out_once_a_paint() {
        let _scope = budget::Scope::new();
        let g = || Paint::Gradient(burst(false));
        let overlay = || {
            Effect::GradientOverlay(PaintOverlay {
                opacity: 1.0,
                blend: Blend::Normal,
                paint: g(),
            })
        };
        let fx = [
            stroke(3.0, Position::Inside, g()),
            stroke(4.0, Position::Center, g()),
            stroke(2.0, Position::Outside, g()),
            stroke(6.0, Position::Center, g()),
            overlay(),
            overlay(),
        ];
        map::INSIDE_DISTANCES.with(|c| c.set(0));
        let (out, o) = inside(&square(20), &fx);
        // One chamfer for the strokes and the overlays.
        assert_eq!(map::INSIDE_DISTANCES.with(|c| c.get()), 1);
        assert!(out.data.chunks_exact(4).any(|p| p[3] > 0));
        assert!(o.is_some());
    }
}
