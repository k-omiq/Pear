//! The layer effects past the drop shadow: Outer Glow, Inner Glow, Inner
//! Shadow, Color Overlay, Gradient Overlay, Pattern Overlay and Stroke, and
//! how each is laid.
//!
//! The order is Photoshop's, as PhotoCraft composites it
//! (`crates/compose/src/effects/composite.rs`): behind the letters the drop
//! shadows, then the outer glows; on the letters their fill at Fill Opacity,
//! then the pattern, gradient and colour overlays, the inner glows, the inner
//! shadows and the inside of the strokes, laid inside the letters at full
//! strength and then cut to the letters' own alpha; the outside of the
//! strokes slid under the letters; then the outlines (`strokes`, the bands).
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
use super::blend::{self, Backdrop, Blend};
use super::contour::Lut;
use super::gradient::{self, Frame, Gradient};
pub use super::map::Technique;
use super::map::{self, Map, Soft};
use super::noise;
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
    Stroke(Stroke),
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
            Effect::Stroke(s) => s.opacity * f64::from(u8::from(s.size > 0.0)),
        }
    }

    /// Lays anything at all.
    pub fn shows(&self) -> bool {
        self.opacity() > 0.0
    }
}

fn soft(size: f64, spread: f64, range: f64, noise: f64, contour: Option<Lut>, seed: u32) -> Soft {
    Soft {
        size: size as f32,
        spread: spread as f32,
        contour,
        range: range as f32,
        noise: noise as f32,
        seed,
    }
}

/// An outer glow's map over the letters' outline `shape` (their whole
/// silhouette, bands included), `scale` device pixels to a job unit. Where
/// the fill is see-through the glow is kept from behind it: `fill` is the
/// fill's own matte, at `fill_opacity`.
pub(crate) fn outer_glow(
    shape: &Map,
    fill: Option<&Map>,
    fill_opacity: f64,
    g: &Glow,
    scale: f64,
) -> Map {
    let s = soft(
        g.size * scale,
        g.spread,
        g.range,
        g.noise,
        g.contour,
        g.seed,
    );
    let mut m = map::glow(shape, g.technique, false, false, &s);
    if let Some(fill) = fill {
        let see_through = (1.0 - fill_opacity.clamp(0.0, 1.0)) as f32;
        for (v, a) in m.v.iter_mut().zip(&fill.v) {
            *v *= 1.0 - a * see_through;
        }
    }
    m
}

/// Where a map has anything, or `None`, in the map's own pixels.
fn ink(m: &Map) -> Option<IBox> {
    let mut b: Option<IBox> = None;
    for y in 0..m.h {
        let row = &m.v[y * m.w..(y + 1) * m.w];
        let Some(x0) = row.iter().position(|v| *v > 0.0) else {
            continue;
        };
        let x1 = row.iter().rposition(|v| *v > 0.0).unwrap_or(x0) + 1;
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
pub(crate) fn alpha_map(r: &Raster, region: IBox) -> Map {
    let (w, h) = (region.width(), region.height());
    let mut m = Map::new(w, h, 0.0);
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
    m
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
        depth: Vec<f32>,
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

/// The brush for `paint`: a Shape Burst gradient run by `depth()` (each
/// pixel's depth, 0 to 1, over a grid `w` wide whose corner is device
/// `dev`), any other paint as [`brush`] has it over `frame`.
fn brush_in<'a>(
    paint: &'a Paint,
    frame: Option<Frame>,
    place: &Place<'a>,
    dev: (i32, i32),
    w: usize,
    depth: impl FnOnce() -> Vec<f32>,
) -> Option<Brush<'a>> {
    match paint {
        Paint::Gradient(g) if g.style == gradient::Style::ShapeBurst => Some(Brush::Burst {
            g,
            depth: depth(),
            dev,
            w,
        }),
        _ => brush(paint, frame?, place),
    }
}

/// Each pixel's depth in a shape from `dist`, its distance in from the
/// shape's edge (negative outside), as a share of the deepest one: Shape
/// Burst's run. The deepest counts as `cap` at most.
fn depth_share(dist: &[f32], cap: f32) -> Vec<f32> {
    let deepest = dist
        .iter()
        .copied()
        .fold(0.0f32, f32::max)
        .min(cap)
        .max(1e-3);
    dist.iter()
        .map(|&d| (d.max(0.0) / deepest).min(1.0))
        .collect()
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
    blend::lay(dst, &src, bx, opacity as f32, mode, page, seed);
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
            let strength = Map {
                w: m.w,
                h: m.h,
                v: m.v.iter().map(|v| (v * gain).min(1.0)).collect(),
            };
            let color = |_: i32, _: i32, i: usize| grad.sample(1.0 - m.v[i].clamp(0.0, 1.0));
            lay_with(
                dst, &strength, at, dev, &color, g.opacity, g.blend, page, g.seed,
            )
        }
    }
}

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
        let m = outer_glow(shape, fill, fill_opacity, g, scale);
        if let Some(b) = lay_glow(dst, &m, (region.x0, region.y0), (0, 0), g, page)? {
            laid = Some(laid.map_or(b, |l| l.union(&b)));
        }
    }
    Ok(laid)
}

/// How far past the letters the outer glows and the strokes reach, device
/// pixels: a Size moves the edge `size + 1` at most (Precise), with a pixel
/// spare.
pub(crate) fn outer_reach(effects: &[Effect], scale: f64) -> i32 {
    let size = effects
        .iter()
        .filter(|e| e.shows())
        .filter_map(|e| match e {
            Effect::OuterGlow(g) => Some(g.size * scale),
            Effect::Stroke(s) => Some(s.widths().1 * scale),
            _ => None,
        })
        .fold(0.0, f64::max);
    (size.min(4096.0).ceil() as i32) + 3
}

/// The frame of `shape` (pixels from device `dev`) in job units: every
/// covered pixel's corners carried back.
fn job_frame(shape: &Map, dev: (i32, i32), place: &Place<'_>) -> Option<Frame> {
    let to_job = place.transform.invert()?;
    let b = ink(&Map {
        w: shape.w,
        h: shape.h,
        v: shape
            .v
            .iter()
            .map(|&a| f32::from(u8::from(a > map::INSIDE_EPS)))
            .collect(),
    })?;
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
    items: Vec<(usize, Vec<f32>, Option<Vec<f32>>)>,
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
pub(crate) fn lay_outside(
    dst: &mut Surface,
    o: &Outside,
    effects: &[Effect],
    place: &Place<'_>,
) -> Result<(), Error> {
    let (w, h) = (o.w, o.h);
    let mut acc = vec![[0.0f32; 4]; w * h];
    let mut cover = vec![0.0f32; w * h];
    let px = place.px();
    for (k, share, depth) in &o.items {
        let Some(Effect::Stroke(st)) = effects.get(*k) else {
            continue;
        };
        let frame = o.frame.map(|f| stroke_frame(f, st, px));
        let Some(br) = brush_in(&st.paint, frame, place, o.dev, w, || {
            depth.clone().unwrap_or_default()
        }) else {
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
                let base = straight(&dst.data[(dy as usize * dst.width + dx as usize) * 4..][..4]);
                let b = over(mode, base, br.at(dx, dy));
                for c in 0..3 {
                    acc[i][c] += s * b[c] * b[3];
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
            let p = &mut dst.data[(dy as usize * dst.width + dx as usize) * 4..][..4];
            let keep = 1.0 - cover[i].min(1.0);
            for c in 0..3 {
                let v = f32::from(p[c]) / 255.0 * keep + acc[i][c];
                p[c] = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            let a = f32::from(p[3]) / 255.0 * keep + acc[i][3];
            p[3] = (a.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
    }
    Ok(())
}

/// The fill raster `r` with the interior effects laid on it at Fill Opacity
/// `fill_opacity`, and the outside parts of its strokes. `carried` turns a
/// job-unit throw into device pixels; `scale` is device pixels to a job unit.
pub(crate) fn interior(
    r: &Raster,
    effects: &[Effect],
    fill_opacity: f64,
    scale: f64,
    carried: impl Fn(f64, f64) -> (f64, f64),
    place: &Place<'_>,
) -> Result<(Raster, Option<Outside>), Error> {
    // Room round the letters for a soft edge to come in from outside them,
    // and for the strokes outside them.
    let mut pad = 2.0f64;
    for e in effects.iter().filter(|e| e.shows()) {
        pad = pad.max(match e {
            Effect::InnerGlow(g) => g.size * scale + 2.0,
            Effect::InnerShadow(s) => {
                let (dx, dy) = carried(s.x, s.y);
                s.size * scale + dx.abs().max(dy.abs()) + 2.0
            }
            Effect::Stroke(s) => s.widths().1 * scale + 2.0,
            _ => 0.0,
        });
    }
    let pad = pad.ceil().min(4096.0) as usize;
    let (rw, rh) = (r.width as usize, r.height as usize);
    let (w, h) = (rw + 2 * pad, rh + 2 * pad);
    let dev = (r.x - pad as i32, r.y - pad as i32);
    // The fill, straight, as a surface at its own alpha, and its shape.
    let mut shape = Map::new(w, h, 0.0);
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
            let k = (fill_opacity.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
            let d = &mut lay.data[i * 4..i * 4 + 4];
            for c in 0..3 {
                d[c] = ((u32::from(p[c]) * k + 127) / 255) as u8;
            }
            d[3] = k as u8;
        }
    }
    let frame = job_frame(&shape, dev, place);
    // Inside the shape, whole.
    let full = Map {
        w,
        h,
        v: shape
            .v
            .iter()
            .map(|&a| if a > map::INSIDE_EPS { 1.0 } else { 0.0 })
            .collect(),
    };
    // Of each kind the first listed is on top, so it is laid last.
    let shown = || effects.iter().rev().filter(|e| e.shows());
    let overlay = |lay: &mut Surface, o: &PaintOverlay| -> Result<(), Error> {
        let depth = || depth_share(&map::dist_inside(&shape), f32::INFINITY);
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
    for e in shown() {
        if let Effect::InnerGlow(g) = e {
            let s = soft(
                g.size * scale,
                g.spread,
                g.range,
                g.noise,
                g.contour,
                g.seed,
            );
            let m = map::glow(&shape, g.technique, true, g.center, &s);
            let m = map::relative_to(&m, &shape);
            lay_glow(&mut lay, &m, (0, 0), dev, g, None)?;
        }
    }
    for e in shown() {
        if let Effect::InnerShadow(sh) = e {
            let (dx, dy) = carried(sh.x, sh.y);
            let s = soft(
                sh.size * scale,
                sh.choke,
                1.0,
                sh.noise,
                sh.contour,
                sh.seed,
            );
            let m = map::inner_shadow(&shape, dx as f32, dy as f32, &s);
            let m = map::relative_to(&m, &shape);
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
    let strokes: Vec<(usize, &Stroke)> = effects
        .iter()
        .enumerate()
        .filter(|(_, e)| e.shows())
        .filter_map(|(i, e)| match e {
            Effect::Stroke(s) => Some((i, s)),
            _ => None,
        })
        .collect();
    let deepest = || {
        map::chamfer_inside(&shape)
            .iter()
            .copied()
            .fold(0.0f32, f32::max)
    };
    // A Shape Burst stroke runs from its outer edge (0) to its inner one
    // (1): `inner` is its depth in from the letters' edge to that one.
    let burst_in = |st: &Stroke| {
        let (i, o) = st.widths();
        let o = (o * scale) as f32;
        (o, o + ((i * scale) as f32).min(deepest()))
    };
    if strokes.iter().any(|(_, s)| s.widths().0 > 0.0) {
        let din = map::chamfer_inside(&shape);
        for (_, st) in strokes.iter().rev() {
            let in_w = (st.widths().0 * scale) as f32;
            if in_w <= 0.0 {
                continue;
            }
            let depth = || {
                let (out, total) = burst_in(st);
                din.iter()
                    .map(|&d| ((out + d.max(0.0)) / total.max(1e-3)).clamp(0.0, 1.0))
                    .collect()
            };
            let m = Map {
                w,
                h,
                v: shape
                    .v
                    .iter()
                    .zip(&din)
                    .map(|(a, d)| {
                        if *a > map::INSIDE_EPS {
                            (in_w + 0.5 - d).clamp(0.0, 1.0)
                        } else {
                            0.0
                        }
                    })
                    .collect(),
            };
            let sf = frame.map(|f| stroke_frame(f, st, place.px()));
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
    // The shape's own alpha, and back to straight colour.
    let mut data = vec![0u8; w * h * 4];
    let mut alpha = vec![0f32; w * h];
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
    // The outside parts: each stroke's share, the first listed first.
    let mut items = Vec::new();
    if strokes.iter().any(|(_, s)| s.widths().1 > 0.0) {
        let mut chamfer: Option<Vec<f32>> = None;
        let mut exact: Option<Vec<f32>> = None;
        let mut cover = vec![0.0f32; w * h];
        for (k, st) in &strokes {
            let out_w = (st.widths().1 * scale) as f32;
            if out_w <= 0.0 {
                continue;
            }
            let d = if out_w < map::STROKE_CHAMFER_MAX {
                &*chamfer.get_or_insert_with(|| map::chamfer_outside(&shape))
            } else {
                &*exact.get_or_insert_with(|| map::dist_outside(&shape))
            };
            let mut share = vec![0.0f32; w * h];
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
            let burst =
                matches!(&st.paint, Paint::Gradient(g) if g.style == gradient::Style::ShapeBurst);
            let depth = burst.then(|| {
                let (out, total) = burst_in(st);
                d.iter()
                    .map(|&d| ((out - d.max(-0.5)) / total.max(1e-3)).clamp(0.0, 1.0))
                    .collect()
            });
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
    Ok((
        Raster {
            x: dev.0,
            y: dev.1,
            width: w as u32,
            height: h as u32,
            data,
        },
        outside,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::budget;

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
        interior(r, effects, 1.0, 1.0, |x, y| (x, y), &place()).unwrap()
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
        let (out, _) = interior(&square(8), &[o], 0.0, 1.0, |x, y| (x, y), &place()).unwrap();
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
        lay_outside(&mut s, &o, &fx, &place()).unwrap();
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
        lay_outside(&mut s, &o.unwrap(), &fx, &place()).unwrap();
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
        lay_outside(&mut s, &o.unwrap(), &fx, &place()).unwrap();
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
            seed: 0,
        };
        let (out, _) = inside(&square(20), &[Effect::InnerGlow(g)]);
        let edge = at(&out, 10, 20);
        assert!(edge[1] > 200 && edge[2] < 60, "{edge:?}");
    }
}
