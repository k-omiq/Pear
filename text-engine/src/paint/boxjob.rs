//! A box job: one box of the page, finished, in one call.
//!
//! A glyph job ([`paint_job`](super::paint_job)) paints a box's letters,
//! their bands and their fills. A box is more than that: its shadows lie
//! under the letters, a blur and a smear lie over the whole, and a mask cuts
//! what is shown. The canvas used to lay those over the engine's glyphs
//! (`paintShadows`, `applyTextFilters` and `drawClipShapes` in the app), a
//! pass each, in a different way in every browser. A box job states them
//! beside the glyph job and the engine does all of it:
//!
//! ```text
//! shadows   last in the style first: the job as a silhouette, blurred,
//!           moved, laid at its opacity
//! glyphs    the job itself, over them
//! blur      a gaussian over the whole
//! smear     a weighted sum of moved copies (the motion blur)
//! mask      shapes that keep, or cut, what they cover
//! ```
//!
//! Every length is in the job's own units and the job's transform carries
//! it to pixels: a shadow's throw through its linear part, a blur's radius
//! by the scale that keeps areas. So a box painted larger, turned or
//! mirrored is the same request with another transform, and its shadow
//! turns with it.
//!
//! [`decode_box`] reads the wire form `encodeBox` in
//! `text-engine/js/paint.mjs` writes.

use super::blur::{self, Moved, Surface};
use super::fx::blend::{self, Backdrop, Blend};
use super::fx::blending::{shadow_see_through, Blending};
use super::fx::contour::{self, Curve, Lut, Table};
use super::fx::effects::{
    self, Bevel, BevelStyle, BevelTechnique, BevelTexture, Effect, Glow, InnerShadow, Overlay,
    Paint, PaintOverlay, Place, Position, Satin, Stroke, Technique,
};
use super::fx::gradient::{Gradient, Style};
use super::fx::noise_gradient::{Model, Noise, Ramp};
use super::fx::{distance, noise, size_reach, spread_split};
use super::geom::{positive, Affine, IBox, Polys, Pt};
use super::job::{decode, read_fill, Fill, Request, Rgba};
use super::raster::{Part, Rasterizer};
use super::shade::Shader;
use super::sweep;
use super::{
    budget, finish, magnified, paint_job_with, plan, Exact, Planned, Raster, FLATTEN_TOLERANCE,
};
use super::{MAX_PIXELS, MAX_SIDE};
use crate::engine::Engine;
use crate::Error;

/// "MTPB", little-endian.
pub const BOX_MAGIC: u32 = 0x4250_544d;
pub const BOX_WIRE_VERSION: u32 = 9;

/// A guard, not a design limit: the app writes at most 129 taps. Shadows and
/// the mask's shapes and points have no count of their own: the app lets a
/// style have as many shadows as a person adds and a mask as many strokes,
/// as long, as a person draws, and the canvas paints every one, so a count
/// here would be a box the engine will not paint. What bounds them is what
/// bounds any record, the bytes they arrive in and the painter's budget, and
/// one layer serves every shadow (`paint_box_with`), so the 17th costs its
/// bytes and its time and no more memory than the first.
pub const MAX_TAPS: usize = 512;
/// Largest blur, and largest distance a shadow or a tap may state, in job
/// units.
pub const MAX_BLUR: f64 = 4096.0;
pub const MAX_THROW: f64 = 65536.0;
/// Most stops an effect gradient takes, of each kind.
pub const MAX_GRADIENT_STOPS: usize = 256;
/// Largest Scale an effect gradient takes (1 is 100 %).
pub const MAX_GRADIENT_SCALE: f64 = 10.0;
/// Largest bevel Depth and Texture Depth (1 is 100 %): Photoshop's 1000 %.
pub const MAX_BEVEL_DEPTH: f64 = 10.0;

/// One shadow of the box (`style.shadows`): Photoshop's Drop Shadow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub color: Rgba,
    pub opacity: f64,
    /// How far it is thrown, job units.
    pub x: f64,
    pub y: f64,
    /// Photoshop's Size, job units: how far the soft edge reaches
    /// ([`size_sigma`]). 0 is a hard edge.
    pub size: f64,
    /// The silhouette grown this much more, job units (times each run's
    /// pen): an SFX extrude's edge. 0 for a drop shadow.
    pub grow: f64,
    /// Photoshop's Spread, 0 to 1: the share of the size the matte is grown
    /// by before the rest of it is blurred.
    pub spread: f64,
    /// Photoshop's Noise, 0 to 1.
    pub noise: f64,
    pub blend: Blend,
    /// Layer Knocks Out Drop Shadow: no shadow shows through the letters.
    pub knockout: bool,
    /// The contour the matte is passed through; `None` is Linear.
    pub contour: Option<Lut>,
    /// The noise's and Dissolve's grain.
    pub seed: u32,
}

impl Default for Shadow {
    fn default() -> Self {
        Self {
            color: Rgba([0, 0, 0, 255]),
            opacity: 1.0,
            x: 0.0,
            y: 0.0,
            size: 0.0,
            grow: 0.0,
            spread: 0.0,
            noise: 0.0,
            blend: Blend::Normal,
            knockout: false,
            contour: None,
            seed: 0,
        }
    }
}

impl Shadow {
    /// The mode it is laid in, with the modes that are Normal for its colour
    /// made Normal: black multiplied is black laid over.
    fn mode(&self) -> Blend {
        match self.blend {
            Blend::Multiply if self.color.0[..3] == [0, 0, 0] => Blend::Normal,
            m => m,
        }
    }

    /// Whether it needs more than a moved, blurred silhouette: its matte is
    /// grown, curved or grained, it blends, or it is knocked out of letters
    /// that do not cover it (`see_through`).
    fn styled(&self, see_through: bool) -> bool {
        positive(self.spread)
            || self.contour.is_some()
            || positive(self.noise)
            || self.mode() != Blend::Normal
            || (self.knockout && see_through)
    }
}

/// One copy in the motion blur's sum (`motionBlurTaps`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tap {
    pub dx: f64,
    pub dy: f64,
    pub weight: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipMode {
    /// Only what the shapes cover is shown.
    Include,
    /// What the shapes cover is not.
    Exclude,
}

/// One shape of the mask (`style.clip.shapes`), in the box's own units from
/// its top-left corner.
#[derive(Clone, Debug, PartialEq)]
pub enum ClipShape {
    Ellipse {
        centre: Pt,
        rx: f64,
        ry: f64,
    },
    /// Closed, filled by the non-zero rule.
    Polygon(Vec<Pt>),
    /// A line `size` wide with round caps and joins; one point is a dot.
    Stroke {
        size: f64,
        pts: Vec<Pt>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub mode: ClipMode,
    /// The box's corner in job space: the shapes are stated from it.
    pub origin: Pt,
    pub shapes: Vec<ClipShape>,
}

/// A decoded box job.
pub struct BoxRequest {
    /// The surface, device pixels. Its corner is device `(0, 0)`.
    pub width: u32,
    pub height: u32,
    /// First on top.
    pub shadows: Vec<Shadow>,
    /// The whole-box blur: a gaussian's sigma, job units. Zero for none.
    pub blur: f64,
    pub taps: Vec<Tap>,
    pub clip: Option<Clip>,
    /// The letters' own blend mode (Blending Options). It blends with the
    /// page only where a `backdrop` is given; with none it is Normal.
    pub blend: Blend,
    /// Photoshop's Fill Opacity, 0 to 1: the fill fades, the outlines and
    /// the shadows do not. Over a page, in one of the special eight modes
    /// (`Blend::fill_is_special`), it changes the blend instead.
    pub fill_opacity: f64,
    /// The Advanced Blending options.
    pub blending: Blending,
    /// The layer effects past the drop shadows: glows, inner shadows, colour
    /// overlays. Of a kind, first on top.
    pub effects: Vec<Effect>,
    /// The page under the surface, straight RGBA8 of the surface's size,
    /// read as opaque: what a blend mode blends with.
    pub backdrop: Option<Vec<u8>>,
    /// The glyph job, and the transform everything above is carried by.
    pub request: Request,
}

impl BoxRequest {
    /// A box job of these parts with every Blending Option at its default.
    pub fn new(width: u32, height: u32, request: Request) -> Self {
        Self {
            width,
            height,
            shadows: Vec::new(),
            blur: 0.0,
            taps: Vec::new(),
            clip: None,
            blend: Blend::Normal,
            fill_opacity: 1.0,
            blending: Blending::default(),
            effects: Vec::new(),
            backdrop: None,
            request,
        }
    }
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

    /// A finite number, as in a glyph job.
    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A number within `max` of zero.
    fn within(&mut self, max: f64) -> Result<f64, Error> {
        let v = self.f64()?;
        if v.abs() <= max {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A number from 0 to `max`.
    fn upto(&mut self, max: f64) -> Result<f64, Error> {
        let v = self.f64()?;
        if (0.0..=max).contains(&v) {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    fn pt(&mut self) -> Result<Pt, Error> {
        Ok(Pt::new(self.within(MAX_THROW)?, self.within(MAX_THROW)?))
    }

    /// A count of at most `max` records of at least `min_size` bytes each,
    /// checked against what is left before anything is allocated.
    fn count(&mut self, max: usize, min_size: usize) -> Result<usize, Error> {
        let n = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        if n > max || n.checked_mul(min_size).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        Ok(n)
    }

    fn pts(&mut self) -> Result<Vec<Pt>, Error> {
        let n = self.count(usize::MAX, 16)?;
        budget::collect((0..n).map(|_| self.pt()))
    }

    fn shadow(&mut self) -> Result<Shadow, Error> {
        let b = self.take(4)?;
        let color = Rgba([b[0], b[1], b[2], b[3]]);
        let opacity = self.upto(1.0)?;
        let x = self.within(MAX_THROW)?;
        let y = self.within(MAX_THROW)?;
        let size = self.upto(MAX_BLUR)?;
        let grow = self.upto(MAX_BLUR)?;
        let spread = self.upto(1.0)?;
        let noise = self.upto(1.0)?;
        let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let flags = self.u32()?;
        if flags & !3 != 0 {
            return Err(Error::BadSpec);
        }
        let seed = self.u32()?;
        let contour = self.contour()?;
        Ok(Shadow {
            color,
            opacity,
            x,
            y,
            size,
            grow,
            spread,
            noise,
            blend,
            knockout: flags & 1 != 0,
            contour,
            seed,
        })
    }

    fn rgba(&mut self) -> Result<Rgba, Error> {
        let b = self.take(4)?;
        Ok(Rgba([b[0], b[1], b[2], b[3]]))
    }

    /// A contour baked to floats (the bevel's), or `None` for Linear.
    fn table(&mut self) -> Result<Option<Table>, Error> {
        Ok(self.curve()?.and_then(|c| Table::new(&c)))
    }

    /// A bevel's highlight or shadow: colour, opacity, mode.
    fn shade(&mut self) -> Result<Overlay, Error> {
        Ok(Overlay {
            color: self.rgba()?,
            opacity: self.upto(1.0)?,
            blend: Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?,
        })
    }

    fn bevel(&mut self) -> Result<Bevel, Error> {
        let style = BevelStyle::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let technique = BevelTechnique::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let depth = self.upto(MAX_BEVEL_DEPTH)?;
        let size = self.upto(MAX_BLUR)?;
        let soften = self.upto(MAX_BLUR)?;
        let angle = self.within(MAX_THROW)?;
        let altitude = self.upto(90.0)?;
        let highlight = self.shade()?;
        let shadow = self.shade()?;
        let flags = self.u32()?;
        // A texture's Invert with no texture is not a bevel anyone wrote.
        if flags & !63 != 0 || (flags & 32 != 0 && flags & 16 == 0) {
            return Err(Error::BadSpec);
        }
        let gloss = self.table()?;
        let (contour, range) = if flags & 4 != 0 {
            (self.table()?, self.upto(1.0)?)
        } else {
            (None, 0.5)
        };
        let texture = if flags & 16 != 0 {
            let depth = self.within(MAX_BEVEL_DEPTH)?;
            match self.paint()? {
                Paint::Fill(fill) => Some(BevelTexture {
                    depth,
                    invert: flags & 32 != 0,
                    fill,
                }),
                _ => return Err(Error::BadSpec),
            }
        } else {
            None
        };
        Ok(Bevel {
            style,
            technique,
            depth,
            up: flags & 1 != 0,
            size,
            soften,
            angle,
            altitude,
            highlight,
            shadow,
            gloss,
            gloss_aa: flags & 2 != 0,
            contour,
            range,
            contour_aa: flags & 8 != 0,
            texture,
        })
    }

    fn contour(&mut self) -> Result<Option<Lut>, Error> {
        Ok(self
            .curve()?
            .map(|c| Lut::new(&c))
            .filter(|l| !l.is_identity()))
    }

    fn glow(&mut self, inner: bool) -> Result<Glow, Error> {
        let color = self.rgba()?;
        let opacity = self.upto(1.0)?;
        let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let technique = match self.u32()? {
            0 => Technique::Softer,
            1 => Technique::Precise,
            _ => return Err(Error::BadSpec),
        };
        let size = self.upto(MAX_BLUR)?;
        let spread = self.upto(1.0)?;
        let range = self.upto(1.0)?;
        let noise = self.upto(1.0)?;
        let seed = self.u32()?;
        let contour = self.contour()?;
        let center = if inner {
            match self.u32()? {
                0 => false,
                1 => true,
                _ => return Err(Error::BadSpec),
            }
        } else {
            false
        };
        let gradient = match self.u32()? {
            0 => None,
            1 => Some(self.gradient()?),
            _ => return Err(Error::BadSpec),
        };
        Ok(Glow {
            color,
            gradient,
            opacity,
            blend,
            technique,
            size,
            spread,
            range,
            noise,
            contour,
            center,
            seed,
        })
    }

    /// An effect gradient: style, angle, scale, reverse, offset, then the
    /// colour stops (position, RGBA) and the opacity stops (position,
    /// opacity), each in order.
    fn gradient(&mut self) -> Result<Gradient, Error> {
        let style = Style::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let angle = self.within(36_000.0)? as f32;
        let scale = self.upto(MAX_GRADIENT_SCALE)? as f32;
        let reverse = match self.u32()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadSpec),
        };
        let offset = (self.within(10.0)? as f32, self.within(10.0)? as f32);
        let n = self.count(MAX_GRADIENT_STOPS, 12)?;
        let mut stops = Vec::with_capacity(n);
        for _ in 0..n {
            let at = self.upto(1.0)? as f32;
            let [r, g, b, _] = self.rgba()?.0;
            stops.push((at, [r, g, b].map(|c| f32::from(c) / 255.0)));
        }
        let m = self.count(MAX_GRADIENT_STOPS, 16)?;
        let mut opacity = Vec::with_capacity(m);
        for _ in 0..m {
            opacity.push((self.upto(1.0)? as f32, self.upto(1.0)? as f32));
        }
        if !stops.windows(2).all(|w| w[0].0 <= w[1].0)
            || !opacity.windows(2).all(|w| w[0].0 <= w[1].0)
        {
            return Err(Error::BadSpec);
        }
        let noise = match self.u32()? {
            0 => None,
            1 => Some(Ramp::new(self.noise()?)),
            _ => return Err(Error::BadSpec),
        };
        Ok(Gradient {
            stops,
            opacity,
            style,
            angle,
            scale,
            reverse,
            offset,
            noise,
        })
    }

    /// A noise gradient: seed, Roughness, colour model, each channel's
    /// Limits, then its flags.
    fn noise(&mut self) -> Result<Noise, Error> {
        let seed = self.u32()?;
        let roughness = self.upto(1.0)? as f32;
        let model = Model::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let mut min = [0.0f32; 3];
        let mut max = [1.0f32; 3];
        for i in 0..3 {
            min[i] = self.upto(1.0)? as f32;
            max[i] = self.upto(1.0)? as f32;
            if min[i] > max[i] {
                return Err(Error::BadSpec);
            }
        }
        let flags = self.u32()?;
        if flags > 3 {
            return Err(Error::BadSpec);
        }
        Ok(Noise {
            seed,
            roughness,
            model,
            min,
            max,
            restrict: flags & 1 != 0,
            transparency: flags & 2 != 0,
        })
    }

    /// What an effect paints with: 0 a colour, 1 a gradient, 2 a glyph job's
    /// fill record (a pattern).
    fn paint(&mut self) -> Result<Paint, Error> {
        Ok(match self.u32()? {
            0 => Paint::Color(self.rgba()?),
            1 => Paint::Gradient(self.gradient()?),
            2 => {
                let (fill, n) = read_fill(&self.bytes[self.at..])?;
                self.at += n;
                Paint::Fill(fill.ok_or(Error::BadSpec)?)
            }
            _ => return Err(Error::BadSpec),
        })
    }

    fn effect(&mut self) -> Result<Effect, Error> {
        let kind = self.u32()?;
        Ok(match kind {
            1 => Effect::OuterGlow(self.glow(false)?),
            2 => Effect::InnerGlow(self.glow(true)?),
            3 => {
                let color = self.rgba()?;
                let opacity = self.upto(1.0)?;
                let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
                let x = self.within(MAX_THROW)?;
                let y = self.within(MAX_THROW)?;
                let size = self.upto(MAX_BLUR)?;
                let choke = self.upto(1.0)?;
                let noise = self.upto(1.0)?;
                let seed = self.u32()?;
                let contour = self.contour()?;
                Effect::InnerShadow(InnerShadow {
                    color,
                    opacity,
                    blend,
                    x,
                    y,
                    size,
                    choke,
                    noise,
                    contour,
                    seed,
                })
            }
            4 => Effect::ColorOverlay(Overlay {
                color: self.rgba()?,
                opacity: self.upto(1.0)?,
                blend: Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?,
            }),
            5 => {
                let size = self.upto(MAX_BLUR)?;
                let position = match self.u32()? {
                    0 => Position::Outside,
                    1 => Position::Inside,
                    2 => Position::Center,
                    _ => return Err(Error::BadSpec),
                };
                let opacity = self.upto(1.0)?;
                let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
                let seed = self.u32()?;
                Effect::Stroke(Stroke {
                    size,
                    position,
                    opacity,
                    blend,
                    paint: self.paint()?,
                    seed,
                })
            }
            6 | 7 => {
                let opacity = self.upto(1.0)?;
                let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
                let paint = self.paint()?;
                let o = PaintOverlay {
                    opacity,
                    blend,
                    paint,
                };
                match (kind, &o.paint) {
                    (6, Paint::Gradient(_)) => Effect::GradientOverlay(o),
                    (7, Paint::Fill(_)) => Effect::PatternOverlay(o),
                    _ => return Err(Error::BadSpec),
                }
            }
            8 => {
                let color = self.rgba()?;
                let opacity = self.upto(1.0)?;
                let blend = Blend::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
                let angle = self.within(MAX_THROW)?;
                let distance = self.upto(MAX_THROW)?;
                let size = self.upto(MAX_BLUR)?;
                let flags = self.u32()?;
                if flags & !3 != 0 {
                    return Err(Error::BadSpec);
                }
                // Anti-aliased (2) is only carried: PhotoCraft paints none
                // and matches Photoshop without it (`contour.rs`).
                let contour = self.contour()?;
                Effect::Satin(Satin {
                    color,
                    opacity,
                    blend,
                    angle,
                    distance,
                    size,
                    invert: flags & 1 != 0,
                    contour,
                })
            }
            9 => Effect::Bevel(self.bevel()?),
            _ => return Err(Error::BadSpec),
        })
    }

    /// A contour, or `None` for Linear.
    fn curve(&mut self) -> Result<Option<Curve>, Error> {
        match self.u32()? {
            0 => Ok(None),
            n if (n as usize) < contour::PRESETS.len() => Ok(Some(Curve::Preset(n))),
            255 => {
                let n = self.count(contour::MAX_POINTS, 20)?;
                let mut pts = Vec::with_capacity(n);
                let mut last = -1.0;
                for _ in 0..n {
                    let x = self.upto(255.0)?;
                    let y = self.upto(255.0)?;
                    let corner = match self.u32()? {
                        0 => false,
                        1 => true,
                        _ => return Err(Error::BadSpec),
                    };
                    if x < last {
                        return Err(Error::BadSpec);
                    }
                    last = x;
                    pts.push(contour::Point { x, y, corner });
                }
                Ok(Some(Curve::Points(pts)))
            }
            _ => Err(Error::BadSpec),
        }
    }

    fn shape(&mut self) -> Result<ClipShape, Error> {
        Ok(match self.u32()? {
            1 => ClipShape::Ellipse {
                centre: self.pt()?,
                rx: self.within(MAX_THROW)?,
                ry: self.within(MAX_THROW)?,
            },
            2 => ClipShape::Polygon(self.pts()?),
            3 => ClipShape::Stroke {
                size: self.upto(MAX_THROW)?,
                pts: self.pts()?,
            },
            _ => return Err(Error::BadSpec),
        })
    }
}

/// Reads one box job from its wire form.
///
/// ```text
/// u32 magic, u32 version
/// u32 width, u32 height        the surface, device pixels; its corner is (0, 0)
/// u32 shadow count, then per shadow, first in the style first:
///     rgba colour, f64 opacity, f64 x, y, f64 size, f64 grow,
///     f64 spread, f64 noise    0 to 1 each
///     u32 blend                a mode number (`Blend::from_u32`)
///     u32 flags                1 knockout, 2 contour anti-aliased
///     u32 seed
///     u32 contour              0 to 11 a preset (Linear is 0), 255 points:
///       u32 n, then n points (f64 x, y from 0 to 255, u32 corner)
/// f64 blur                     the whole-box blur; 0 for none
/// u32 tap count, then per tap: f64 dx, dy, f64 weight
/// u32 clip mode                0 none, 1 include, 2 exclude; when not 0:
///     f64 ox, oy               the box's corner in job space
///     u32 shape count, then per shape: u32 kind, then
///       1 ellipse: f64 cx, cy, rx, ry
///       2 polygon: u32 n, then n points (f64 x, y)
///       3 stroke:  f64 size, u32 n, then n points; one point is a dot
/// u32 blend                    the letters' mode
/// f64 fill opacity             0 to 1
/// u32 blending flags (v9)      1 Blend Interior Effects as Group
/// u32 effect count, then per effect, first of its kind on top, a u32 kind:
///   1 outer glow, 2 inner glow:
///     rgba colour, f64 opacity, u32 blend
///     u32 technique            0 Softer, 1 Precise
///     f64 size, f64 spread (or choke), f64 range, f64 noise   0 to 1 but size
///     u32 seed, u32 contour (as a shadow's)
///     u32 source               inner glow only: 0 edge, 1 center
///     u32 gradient             0 its colour, 1: a gradient record follows
///   3 inner shadow:
///     rgba colour, f64 opacity, u32 blend, f64 x, y, f64 size,
///     f64 choke, f64 noise, u32 seed, u32 contour
///   4 colour overlay: rgba colour, f64 opacity, u32 blend
///   5 stroke: f64 size, u32 position (0 outside, 1 inside, 2 center),
///     f64 opacity, u32 blend, u32 seed, a paint record
///   6 gradient overlay: f64 opacity, u32 blend, a paint record (a gradient)
///   7 pattern overlay: f64 opacity, u32 blend, a paint record (a fill)
///   8 satin (v7): rgba colour, f64 opacity, u32 blend, f64 angle (degrees,
///     the box's own), f64 distance, f64 size, u32 flags (1 invert, 2
///     contour anti-aliased), u32 contour (as a shadow's)
///   9 bevel & emboss (v8):
///     u32 style                0 inner, 1 outer, 2 emboss, 3 pillow emboss,
///                              4 stroke emboss
///     u32 technique            0 smooth, 1 chisel hard, 2 chisel soft
///     f64 depth                0 to 10 (1 is 100 %)
///     f64 size, f64 soften     job units, 0 to 4096 each
///     f64 angle, f64 altitude  degrees (altitude 0 to 90), Use Global Light
///                              already resolved
///     rgba highlight, f64 opacity, u32 blend
///     rgba shadow, f64 opacity, u32 blend
///     u32 flags                1 up, 2 gloss anti-aliased, 4 contour on,
///                              8 contour anti-aliased, 16 texture on,
///                              32 texture invert (only with 16)
///     u32 gloss contour        as a shadow's
///     if flags & 4:  u32 contour (as a shadow's), f64 range (0 to 1;
///                    carried, never applied)
///     if flags & 16: f64 texture depth (-10 to 10), a paint record that is
///                    a fill (kind 2): the pattern
///     The anti-aliased flags are carried, not painted.
/// u32 backdrop                 0 none, 1: width * height * 4 bytes follow,
///                              straight RGBA8 read as opaque: the page art
///                              under each surface pixel
/// u32 job byte length, then a glyph job in its own wire form
///
/// paint record: u32 kind, then 0 rgba colour, 1 a gradient record, or 2 a
///   fill record as the glyph job writes one (its tile numbers are the job's)
/// gradient record: u32 style (0 Linear, 1 Radial, 2 Angle, 3 Reflected,
///   4 Diamond, 5 Shape Burst), f64 angle (degrees), f64 scale (1 is 100 %,
///   to 10), u32 reverse, f64 x, y (the centre moved, a share of the frame,
///   within 10), u32 n then n (f64 position, rgba colour), u32 m then m (f64
///   position, f64 opacity); at most 256 of each, positions 0 to 1 and in
///   order; then u32 type, 0 solid (the stops), 1 noise (v6), whose record
///   follows in place of the stops' colours:
/// noise record: u32 seed, f64 roughness (0 to 1), u32 model (0 RGB, 1 HSB,
///   2 LAB), then per channel f64 min, f64 max (0 to 1, min <= max), u32
///   flags (1 restrict colours, 2 add transparency)
/// ```
///
/// Refused: a surface with no size or past the painter's guards, more than
/// 512 taps, a count the bytes cannot hold, an opacity, a weight, a spread, a
/// noise or a fill opacity outside 0 to 1, a size or a blur outside 0 to
/// 4096, a throw, a tap or a point further than 65536 from zero, a mode or a
/// contour that does not exist, a contour point outside 0 to 255 or out of
/// order, a bevel style or technique that does not exist, a bevel depth
/// outside 0 to 10, an altitude outside 0 to 90, a bevel texture that is not
/// a fill, blending flags past 1, and anything a glyph job is refused for.
pub fn decode_box(bytes: &[u8]) -> Result<BoxRequest, Error> {
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != BOX_MAGIC || r.u32()? != BOX_WIRE_VERSION {
        return Err(Error::BadSpec);
    }
    let (width, height) = (r.u32()?, r.u32()?);
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || width as usize * height as usize > MAX_PIXELS
    {
        return Err(Error::BadSpec);
    }
    let n = r.count(usize::MAX, 76)?;
    let shadows = budget::collect((0..n).map(|_| r.shadow()))?;
    let blur = r.upto(MAX_BLUR)?;
    let n = r.count(MAX_TAPS, 24)?;
    let taps = budget::collect((0..n).map(|_| {
        Ok(Tap {
            dx: r.within(MAX_THROW)?,
            dy: r.within(MAX_THROW)?,
            weight: r.upto(1.0)?,
        })
    }))?;
    let clip = match r.u32()? {
        0 => None,
        mode @ (1 | 2) => {
            let origin = r.pt()?;
            let n = r.count(usize::MAX, 4)?;
            Some(Clip {
                mode: if mode == 1 {
                    ClipMode::Include
                } else {
                    ClipMode::Exclude
                },
                origin,
                shapes: budget::collect((0..n).map(|_| r.shape()))?,
            })
        }
        _ => return Err(Error::BadSpec),
    };
    let blend = Blend::from_u32(r.u32()?).ok_or(Error::BadSpec)?;
    let fill_opacity = r.upto(1.0)?;
    let blending = Blending::from_flags(r.u32()?).ok_or(Error::BadSpec)?;
    let n = r.count(usize::MAX, 20)?;
    let effects = budget::collect((0..n).map(|_| r.effect()))?;
    let backdrop = match r.u32()? {
        0 => None,
        1 => {
            let n = width as usize * height as usize * 4;
            let bytes = r.take(n)?;
            let mut out = budget::filled(n, 0u8)?;
            out.copy_from_slice(bytes);
            Some(out.into_vec())
        }
        _ => return Err(Error::BadSpec),
    };
    let len = r.u32()? as usize;
    let request = decode(r.take(len)?)?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    Ok(BoxRequest {
        width,
        height,
        shadows,
        blend,
        fill_opacity,
        blending,
        effects,
        backdrop,
        blur,
        taps,
        clip,
        request,
    })
}

/// A circle of radius `r` about `c` as a closed polygon that stays within
/// `tol` of it.
fn disc(out: &mut Polys, c: Pt, rx: f64, ry: f64, tol: f64) {
    let r = rx.abs().max(ry.abs());
    if !positive(r) {
        return;
    }
    // A chord across an angle `t` leaves the arc by `r (1 - cos(t / 2))`.
    let step = if tol < r {
        2.0 * (1.0 - tol / r).acos()
    } else {
        core::f64::consts::FRAC_PI_2
    };
    let n = (core::f64::consts::TAU / step).ceil().clamp(8.0, 4096.0) as usize;
    for i in 0..n {
        let (sin, cos) = (core::f64::consts::TAU * i as f64 / n as f64).sin_cos();
        out.push(Pt::new(c.x + rx * cos, c.y + ry * sin));
    }
    out.close();
}

/// The mask's shapes as parts in job space, one part to a piece: a part
/// fills what its own contours wind round whichever way they run, and parts
/// are united, so a stroke's segments and the discs at its joints make one
/// line and not a darker patch where they overlap.
fn clip_parts(clip: &Clip, tol: f64) -> Result<budget::Buffer<Polys>, Error> {
    let mut out = budget::Buffer::new();
    let at = |p: Pt| p.plus(clip.origin);
    for shape in &clip.shapes {
        match shape {
            ClipShape::Ellipse { centre, rx, ry } => {
                let mut polys = Polys::default();
                disc(&mut polys, at(*centre), *rx, *ry, tol);
                budget::push(&mut out, polys)?;
            }
            ClipShape::Polygon(pts) => {
                let mut polys = Polys::default();
                for p in pts {
                    polys.push(at(*p));
                }
                polys.close();
                budget::push(&mut out, polys)?;
            }
            ClipShape::Stroke { size, pts } => {
                let r = size / 2.0;
                if !positive(r) {
                    continue;
                }
                for (i, p) in pts.iter().enumerate() {
                    let mut polys = Polys::default();
                    disc(&mut polys, at(*p), r, r, tol);
                    budget::push(&mut out, polys)?;
                    let Some(q) = pts.get(i + 1) else {
                        continue;
                    };
                    let d = q.minus(*p);
                    let len = d.len();
                    if !positive(len) {
                        continue;
                    }
                    let n = Pt::new(-d.y, d.x).scale(r / len);
                    let mut polys = Polys::default();
                    for corner in [p.plus(n), q.plus(n), q.minus(n), p.minus(n)] {
                        polys.push(at(corner));
                    }
                    polys.close();
                    budget::push(&mut out, polys)?;
                }
            }
        }
        budget::check()?;
    }
    Ok(out)
}

/// The mask's coverage over the surface: straight RGBA8 whose alpha is the
/// share of each pixel the shapes cover, and the box of pixels it is for.
/// `None` when the shapes cover nothing of the surface.
fn clip_mask(
    clip: &Clip,
    request: &Request,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<(Vec<u8>, IBox)>, Error> {
    let transform = &request.transform;
    // The shapes are the box's, so the box's mesh bends them with its
    // letters, and enlarges them as it does the letters (`magnified`).
    let mesh = match &request.job.mesh {
        Some(m) => m.map()?,
        None => None,
    };
    let tol = FLATTEN_TOLERANCE / (transform.max_scale() * magnified(mesh.as_ref()));
    let mut parts = budget::Buffer::new();
    for polys in clip_parts(clip, tol)?.iter() {
        let placed = match (&mesh, polys.bounds()) {
            (Some(m), Some(bounds)) => {
                super::warp::bend(polys, |p| m.at(p), m.cut(bounds, tol), tol)?.map(transform)
            }
            _ => polys.map(transform),
        };
        if !placed.is_empty() {
            budget::push(&mut parts, Part::plain(placed))?;
        }
    }
    const OPAQUE: Fill = Fill::Solid(Rgba([255, 255, 255, 255]));
    let Some(planned) =
        Shader::new(&OPAQUE, &Affine::IDENTITY, &[]).and_then(|s| plan(parts, s, 1.0))
    else {
        return Ok(None);
    };
    let bx = planned.bx.intersect(&surface);
    if bx.is_empty() {
        return Ok(None);
    }
    let mut layers: budget::Buffer<Planned<'_>> = budget::Buffer::new();
    budget::push(&mut layers, planned)?;
    Ok(Some((finish(layers, bx, rasterizer)?, bx)))
}

/// A raster cut to `surface`, or `None` when nothing of it is inside.
fn cut(r: Raster, surface: IBox) -> Result<Option<Raster>, Error> {
    let have = IBox {
        x0: r.x,
        y0: r.y,
        x1: r.x.saturating_add(r.width as i32),
        y1: r.y.saturating_add(r.height as i32),
    };
    let bx = have.intersect(&surface);
    if bx.is_empty() {
        return Ok(None);
    }
    if bx == have {
        return Ok(Some(r));
    }
    let mut data = budget::filled(bx.width() * bx.height() * 4, 0u8)?;
    let n = bx.width() * 4;
    for (row, y) in (bx.y0..bx.y1).enumerate() {
        let from = ((y - r.y) as usize * r.width as usize + (bx.x0 - r.x) as usize) * 4;
        data[row * n..(row + 1) * n].copy_from_slice(&r.data[from..from + n]);
    }
    Ok(Some(Raster {
        x: bx.x0,
        y: bx.y0,
        width: bx.width() as u32,
        height: bx.height() as u32,
        data: data.into_vec(),
    }))
}

/// Paints one box job with the exact-area rasteriser.
///
/// Returns the pixels and where they go: the smallest raster that holds
/// every pixel with any alpha, cut to the surface, or `None` when the box
/// draws nothing. The request is handed back as it came.
pub fn paint_box(engine: &mut Engine, request: &mut BoxRequest) -> Result<Option<Raster>, Error> {
    paint_box_with(engine, request, &Exact)
}

/// [`paint_box`] with a rasteriser of the caller's choice.
pub fn paint_box_with(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    paint(engine, request, rasterizer, true)
}

/// [`paint_box_with`] with every shadow laid a copy at a time, as the box job
/// once laid them: what the one pass an extrude's steps take is measured
/// against. For tests and benchmarks; the picture is the same within a level.
#[doc(hidden)]
pub fn paint_box_copy_by_copy(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    paint(engine, request, rasterizer, false)
}

/// Where a layer whose ink is `ink`, moved by `(dx, dy)` pixels, can leave
/// ink: a move by a share of a pixel reaches one pixel further.
fn landed(ink: IBox, (dx, dy): (f64, f64)) -> IBox {
    let at = |v: i32, d: f64| (f64::from(v) + d).clamp(-1e9, 1e9) as i32;
    IBox {
        x0: at(ink.x0, dx.floor() - 1.0),
        y0: at(ink.y0, dy.floor() - 1.0),
        x1: at(ink.x1, dx.ceil() + 1.0),
        y1: at(ink.y1, dy.ceil() + 1.0),
    }
}

/// What a shadow's layer is painted from: shadows alike in these are one
/// layer, moved.
fn layer_key(sh: &Shadow) -> (Rgba, f64, f64) {
    (sh.color, sh.grow, sh.size)
}

/// A matte's levels written into `layer` as one flat colour.
fn set_flat(layer: &mut Surface, rgb: [u8; 3], alpha: &[u8]) {
    for (p, &a) in layer.data.chunks_exact_mut(4).zip(alpha) {
        let k = u32::from(a);
        for c in 0..3 {
            p[c] = ((u32::from(rgb[c]) * k + 127) / 255) as u8;
        }
        p[3] = a;
    }
}

fn alpha_of(layer: &Surface) -> Result<budget::Buffer<u8>, Error> {
    let mut out = budget::filled(layer.width * layer.height, 0u8)?;
    for (a, p) in out.iter_mut().zip(layer.data.chunks_exact(4)) {
        *a = p[3];
    }
    Ok(out)
}

/// What one Drop Shadow lays under the letters when it is more than a moved,
/// blurred silhouette (`Shadow::styled`), in Photoshop's order: the
/// silhouette's matte grown by the spread, blurred by the rest of the size,
/// passed through the contour, grained by the noise, moved, cut by `knock`
/// (0 to 1, `shadow_see_through`) where the letters stand when they knock it
/// out, and laid in its mode at its opacity. Hands back where it can have
/// laid ink.
#[allow(clippy::too_many_arguments)]
fn lay_styled(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    sh: &Shadow,
    s: &mut Surface,
    scale: f64,
    moved: (f64, f64),
    knock: f32,
    acc: &mut budget::Buffer<f32>,
) -> Result<Option<IBox>, Error> {
    let (width, height) = (s.width, s.height);
    let job_silhouette = request.request.job.silhouette;
    let job_grow = request.request.job.effects.grow;
    request.request.job.silhouette = Some(sh.color);
    request.request.job.effects.grow = sh.grow;
    let painted = paint_job_with(engine, &request.request, rasterizer);
    request.request.job.silhouette = job_silhouette;
    request.request.job.effects.grow = job_grow;
    let Some(r) = painted? else {
        return Ok(None);
    };
    let mut layer = Surface::new(width, height)?;
    layer.draw(&r.data, r.width as usize, r.x, r.y);
    let [red, green, blue, _] = sh.color.0;
    let rgb = [red, green, blue];
    let mut matte = alpha_of(&layer)?;
    // The letters as they stand, unmoved: what a knockout cuts away.
    let letters = if knock > 0.0 {
        Some(alpha_of(&layer)?)
    } else {
        None
    };
    let (grow, rest) = spread_split(sh.size, sh.spread);
    if positive(grow * scale) {
        distance::dilate(&mut matte, width, height, grow * scale)?;
        set_flat(&mut layer, rgb, &matte);
    }
    blur::tent_flat(&mut layer, rest * scale, rgb)?;
    let reach = (size_reach(sh.size) * scale)
        .ceil()
        .min(f64::from(i32::MAX)) as i32
        + 1;
    let drawn = IBox {
        x0: r.x.saturating_sub(reach),
        y0: r.y.saturating_sub(reach),
        x1: r.x.saturating_add(r.width as i32).saturating_add(reach),
        y1: r.y.saturating_add(r.height as i32).saturating_add(reach),
    };
    drop(r);
    let Some(mut ink) = layer.ink_in(drawn) else {
        return Ok(None);
    };
    if sh.contour.is_some() || positive(sh.noise) {
        let mut matte = alpha_of(&layer)?;
        if let Some(lut) = &sh.contour {
            for a in matte.iter_mut() {
                *a = lut.apply(*a);
            }
        }
        if positive(sh.noise) {
            noise::grain(
                &mut matte,
                width,
                height,
                (ink.x0, ink.y0, ink.x1, ink.y1),
                sh.noise as f32,
                sh.seed,
            );
        }
        set_flat(&mut layer, rgb, &matte);
        let Some(found) = layer.ink_in(ink) else {
            return Ok(None);
        };
        ink = found;
    }
    let mut thrown = Surface::new(width, height)?;
    blur::over_moved_in(&mut thrown, &layer, ink, moved, 1.0, acc);
    drop(layer);
    let landed_at = landed(ink, moved);
    if let Some(letters) = &letters {
        // PhotoCraft's `knock_out_exterior`: the map times 1 - alpha * knock.
        let knock = (knock.min(1.0) * 255.0 + 0.5) as u32;
        for (p, &a) in thrown.data.chunks_exact_mut(4).zip(letters.iter()) {
            if a == 0 {
                continue;
            }
            let keep = 255 - (u32::from(a) * knock + 127) / 255;
            for v in p.iter_mut() {
                *v = ((u32::from(*v) * keep + 127) / 255) as u8;
            }
        }
    }
    let page = request
        .backdrop
        .as_deref()
        .map(|pixels| Backdrop { pixels });
    blend::lay(
        s,
        &thrown,
        landed_at,
        sh.opacity as f32,
        sh.mode(),
        page.as_ref(),
        sh.seed,
    );
    Ok(Some(landed_at))
}

/// The letters, their outlines and their fill, with the fill at the box's
/// Fill Opacity and the interior effects laid on it. A faded fill is laid
/// under its outlines cut to their outer halves, as Photoshop's Stroke lies
/// outside a faded layer: the half of an outline the fill covered must not
/// show through it. The interior effects are the fill's, under the outlines.
///
/// `special`: the box lays its fill in one of the special eight modes over a
/// page (`Blend::fill_is_special`), where Fill is part of the blend and not
/// coverage. A plain fill (no interior effects on it) is then handed back
/// whole, apart from the rest, for `blend::lay_fill`.
fn paint_glyphs(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    carried: impl Fn(f64, f64) -> (f64, f64),
    scale: f64,
    special: bool,
) -> Result<Glyphs, Error> {
    let job = &request.request.job;
    let fade = request.fill_opacity;
    let inside = !job.no_fill
        && job.silhouette.is_none()
        && request.effects.iter().any(|e| e.interior() && e.shows());
    if (fade >= 1.0 && !inside) || job.no_fill || job.silhouette.is_some() {
        return Ok(Glyphs {
            rasters: paint_job_with(engine, &request.request, rasterizer)?
                .into_iter()
                .collect(),
            ..Glyphs::default()
        });
    }
    let mut out = Vec::new();
    let mut outside = None;
    let mut bevels = None;
    let mut whole_fill = None;
    // The fill alone, faded, with the effects on it.
    let bands = core::mem::take(&mut request.request.job.bands);
    let negative = request.request.job.effects.negative.take();
    let fill = paint_job_with(engine, &request.request, rasterizer);
    request.request.job.bands = bands;
    request.request.job.effects.negative = negative;
    if let Some(mut r) = fill? {
        if inside {
            let place = Place {
                transform: request.request.transform,
                tiles: &request.request.tiles,
            };
            (r, outside, bevels) = effects::interior(
                &r,
                &request.effects,
                fade,
                request.blending.interior,
                scale,
                carried,
                &place,
            )?;
            out.push(r);
        } else if special {
            whole_fill = Some(r);
        } else {
            for p in r.data.chunks_exact_mut(4) {
                p[3] = (f64::from(p[3]) * fade + 0.5) as u8;
            }
            out.push(r);
        }
    }
    // The outlines, outside the letters.
    if !request.request.job.bands.is_empty() || request.request.job.effects.negative.is_some() {
        request.request.job.no_fill = true;
        let rims = paint_job_with(engine, &request.request, rasterizer);
        request.request.job.no_fill = false;
        if let Some(r) = rims? {
            out.push(r);
        }
    }
    Ok(Glyphs {
        rasters: out,
        whole_fill,
        outside,
        bevels,
    })
}

/// What `paint_glyphs` paints of the letters.
#[derive(Default)]
struct Glyphs {
    /// The letters' rasters, laid as they are.
    rasters: Vec<Raster>,
    /// A special-eight fill at its whole Fill, laid by `blend::lay_fill`
    /// under `rasters`.
    whole_fill: Option<Raster>,
    /// The outside parts of the strokes.
    outside: Option<effects::Outside>,
    /// The bevels laid round them.
    bevels: Option<effects::Bevels>,
}

/// The outer glows behind the letters, on `s`. Their shape is the letters'
/// whole silhouette, outlines included, as a drop shadow's is; where the fill
/// is see-through each glow is kept from behind the fill.
fn lay_glows(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    s: &mut Surface,
    scale: f64,
) -> Result<Option<IBox>, Error> {
    let black = Some(Rgba([0, 0, 0, 255]));
    let job_silhouette = request.request.job.silhouette;
    request.request.job.silhouette = black;
    let outline = paint_job_with(engine, &request.request, rasterizer);
    request.request.job.silhouette = job_silhouette;
    let Some(outline) = outline? else {
        return Ok(None);
    };
    let reach = effects::outer_reach(&request.effects, scale);
    let region = IBox {
        x0: outline.x.saturating_sub(reach),
        y0: outline.y.saturating_sub(reach),
        x1: outline
            .x
            .saturating_add(outline.width as i32)
            .saturating_add(reach),
        y1: outline
            .y
            .saturating_add(outline.height as i32)
            .saturating_add(reach),
    }
    .intersect(&IBox {
        x0: 0,
        y0: 0,
        x1: s.width as i32,
        y1: s.height as i32,
    });
    if region.is_empty() {
        return Ok(None);
    }
    let shape = effects::alpha_map(&outline, region);
    drop(outline);
    let job = &request.request.job;
    let fill = if request.fill_opacity < 1.0 && !job.no_fill {
        let bands = core::mem::take(&mut request.request.job.bands);
        let negative = request.request.job.effects.negative.take();
        request.request.job.silhouette = black;
        let fill = paint_job_with(engine, &request.request, rasterizer);
        request.request.job.silhouette = job_silhouette;
        request.request.job.bands = bands;
        request.request.job.effects.negative = negative;
        fill?.map(|r| effects::alpha_map(&r, region))
    } else {
        None
    };
    let page = request
        .backdrop
        .as_deref()
        .map(|pixels| Backdrop { pixels });
    effects::lay_outer_glows(
        s,
        &request.effects,
        &shape,
        fill.as_ref(),
        request.fill_opacity,
        region,
        scale,
        page.as_ref(),
    )
}

fn paint(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    sweeps: bool,
) -> Result<Option<Raster>, Error> {
    let _budget = budget::Scope::new();
    let (width, height) = (request.width as usize, request.height as usize);
    if width == 0
        || height == 0
        || width > MAX_SIDE as usize
        || height > MAX_SIDE as usize
        || width * height > MAX_PIXELS
    {
        return Err(Error::BadSpec);
    }
    let surface = IBox {
        x0: 0,
        y0: 0,
        x1: width as i32,
        y1: height as i32,
    };
    let transform = request.request.transform;
    // Lengths are carried by the scale that keeps areas, vectors by the
    // transform's linear part.
    let scale = transform.det().abs().sqrt();
    let carried = |x: f64, y: f64| {
        let m = &transform.0;
        (m[0] * x + m[2] * y, m[1] * x + m[3] * y)
    };
    let shadows = request.shadows.iter().filter(|s| positive(s.opacity));
    let taps: Vec<Tap> = request
        .taps
        .iter()
        .copied()
        .filter(|t| positive(t.weight))
        .collect();
    let blur_sigma = request.blur * scale;
    // The letters blend with the page only where there is a page to blend
    // with, or where the mode is Dissolve, which needs none.
    let blends = request.blend == Blend::Dissolve
        || (request.blend != Blend::Normal && request.backdrop.is_some());
    // How much of what a knockout cuts shows: the share of their shadow the
    // letters do not cover.
    let see_through = shadow_see_through(
        request.blend,
        blends,
        request.fill_opacity,
        request.request.job.no_fill,
    );
    if shadows.clone().next().is_none()
        && !positive(blur_sigma)
        && taps.is_empty()
        && request.clip.is_none()
        && request.fill_opacity >= 1.0
        && !blends
        && !request.effects.iter().any(Effect::shows)
    {
        // Nothing but glyphs: the glyph job, and its own raster.
        return match paint_job_with(engine, &request.request, rasterizer)? {
            Some(r) => cut(r, surface),
            None => Ok(None),
        };
    }
    if !scale.is_finite() || !positive(scale) {
        return Ok(None);
    }

    let mut s = Surface::new(width, height)?;
    // Where anything has been laid on the surface, so that finding what of
    // it has ink reads only that.
    let mut laid: Option<IBox> = None;
    let mut lay = |b: IBox| laid = Some(laid.map_or(b, |l| l.union(&b)));
    // Shadows, the last first, so the first is on top of the rest. One
    // layer serves them all, and a shadow like the one before it (an
    // extrude's steps, a shake's copies) is the same layer moved again.
    let mut order = budget::Buffer::new();
    for sh in request.shadows.iter().rev().filter(|s| positive(s.opacity)) {
        budget::push(&mut order, *sh)?;
    }
    let mut layer: Option<Surface> = None;
    // Where the layer has ink, found once for every copy of it.
    let mut ink: Option<IBox> = None;
    // Where its rows have ink, for a layer laid more than once.
    let mut runs: Option<sweep::Runs> = None;
    let mut acc = budget::Buffer::new();
    if !order.is_empty() {
        acc = budget::filled(width * 4, 0.0f32)?;
    }
    let mut moves = budget::Buffer::new();
    let mut painted_as: Option<(Rgba, f64, f64)> = None;
    let job_silhouette = request.request.job.silhouette;
    let job_grow = request.request.job.effects.grow;
    let mut i = 0;
    while let Some(sh) = order.get(i).copied() {
        if sh.styled(see_through > 0.0) {
            let knock = if sh.knockout { see_through } else { 0.0 };
            if let Some(b) = lay_styled(
                engine,
                request,
                rasterizer,
                &sh,
                &mut s,
                scale,
                carried(sh.x, sh.y),
                knock,
                &mut acc,
            )? {
                lay(b);
            }
            i += 1;
            continue;
        }
        let key = layer_key(&sh);
        if painted_as != Some(key) {
            painted_as = Some(key);
            ink = None;
            runs = None;
            request.request.job.silhouette = Some(sh.color);
            request.request.job.effects.grow = sh.grow;
            let painted = paint_job_with(engine, &request.request, rasterizer);
            request.request.job.silhouette = job_silhouette;
            request.request.job.effects.grow = job_grow;
            let layer = match &mut layer {
                Some(l) => {
                    l.clear();
                    l
                }
                none => none.insert(Surface::new(width, height)?),
            };
            if let Some(r) = painted? {
                layer.draw(&r.data, r.width as usize, r.x, r.y);
                // A silhouette is one colour, so only its alpha needs the blur.
                let [red, green, blue, _] = sh.color.0;
                let width = sh.size * scale;
                blur::tent_flat(layer, width, [red, green, blue])?;
                // The ink is the raster's, and as far round it as the blur
                // spread it.
                let reach = super::fx::tent::reach(width);
                let drawn = IBox {
                    x0: r.x.saturating_sub(reach),
                    y0: r.y.saturating_sub(reach),
                    x1: r.x.saturating_add(r.width as i32).saturating_add(reach),
                    y1: r.y.saturating_add(r.height as i32).saturating_add(reach),
                };
                drop(r);
                ink = layer.ink_in(drawn);
                // Finding the runs costs about what laying a copy along them
                // saves, so only a layer laid again finds them.
                let again = order.get(i + 1).is_some_and(|n| layer_key(n) == key);
                if let (Some(ink), true) = (ink, sweeps && again) {
                    runs = Some(sweep::Runs::new(layer, ink)?);
                }
            }
        }
        // The shadows after it laid from the same layer, opaque like it: an
        // extrude's steps, laid in one pass when there are two or more.
        let mut end = i + 1;
        if sweeps && sh.opacity >= 1.0 {
            while order
                .get(end)
                .is_some_and(|n| layer_key(n) == key && n.opacity >= 1.0)
            {
                end += 1;
            }
        }
        let (Some(layer), Some(ink)) = (&layer, ink) else {
            i = end;
            continue;
        };
        for n in &order[i..end] {
            lay(landed(ink, carried(n.x, n.y)));
        }
        match &runs {
            Some(runs) if end - i >= 2 => {
                moves.clear();
                for n in &order[i..end] {
                    budget::push(&mut moves, carried(n.x, n.y))?;
                }
                sweep::over_swept(&mut s, layer, ink, runs, &moves)?;
            }
            // A faded copy, as a shake's are: along the rows' runs.
            Some(runs) => {
                sweep::over_runs(
                    &mut s,
                    layer,
                    ink,
                    runs,
                    carried(sh.x, sh.y),
                    sh.opacity,
                    &mut acc,
                );
            }
            None => blur::over_moved_in(
                &mut s,
                layer,
                ink,
                carried(sh.x, sh.y),
                sh.opacity,
                &mut acc,
            ),
        }
        i = end;
    }
    drop(layer);
    if request
        .effects
        .iter()
        .any(|e| matches!(e, Effect::OuterGlow(_)) && e.shows())
    {
        if let Some(b) = lay_glows(engine, request, rasterizer, &mut s, scale)? {
            lay(b);
        }
    }

    // Over a page, one of the special eight takes Fill into its blend.
    let special = blends
        && request.backdrop.is_some()
        && request.blend.fill_is_special()
        && request.fill_opacity < 1.0;
    let Glyphs {
        rasters: glyphs,
        whole_fill,
        outside,
        bevels,
    } = paint_glyphs(engine, request, rasterizer, carried, scale, special)?;
    let mut own = if blends {
        Some(Surface::new(width, height)?)
    } else {
        None
    };
    // What is drawn on `own` so far, for a special fill laid between.
    let mut own_drawn: Option<IBox> = None;
    // The strokes' outside parts, slid under the letters.
    if let Some(o) = outside {
        let place = Place {
            transform,
            tiles: &request.request.tiles,
        };
        effects::lay_outside(own.as_mut().unwrap_or(&mut s), &o, &request.effects, &place)?;
        let b = o.bounds().intersect(&surface);
        if !b.is_empty() {
            lay(b);
            own_drawn = Some(b);
        }
    }
    // An Outer Bevel, under the letters with the strokes' outside parts.
    if let Some(bv) = &bevels {
        let page = request
            .backdrop
            .as_deref()
            .map(|pixels| Backdrop { pixels });
        let (dst, page) = match own.as_mut() {
            Some(own) => (own, None),
            None => (&mut s, page.as_ref()),
        };
        if let Some(b) = effects::lay_bevels(dst, bv, &request.effects, false, page)? {
            lay(b);
            own_drawn = Some(own_drawn.map_or(b, |l| l.union(&b)));
        }
    }
    // A special-eight fill: what is under it laid first, then the fill at
    // its whole Fill in its mode, with Fill in the blend; the outlines go
    // over it below, at Fill 1.
    if let (Some(fill), Some(own)) = (&whole_fill, own.as_mut()) {
        let page = request
            .backdrop
            .as_deref()
            .map(|pixels| Backdrop { pixels });
        if let Some(bx) = own_drawn {
            blend::lay(&mut s, own, bx, 1.0, request.blend, page.as_ref(), 0);
            own.clear();
        }
        own.draw(&fill.data, fill.width as usize, fill.x, fill.y);
        let bx = IBox {
            x0: fill.x,
            y0: fill.y,
            x1: fill.x.saturating_add(fill.width as i32),
            y1: fill.y.saturating_add(fill.height as i32),
        };
        blend::lay_fill(
            &mut s,
            own,
            bx,
            1.0,
            request.blend,
            page.as_ref(),
            0,
            request.fill_opacity as f32,
        );
        own.clear();
        lay(bx);
    }
    drop(whole_fill);
    for r in &glyphs {
        let bx = IBox {
            x0: r.x,
            y0: r.y,
            x1: r.x.saturating_add(r.width as i32),
            y1: r.y.saturating_add(r.height as i32),
        };
        match &mut own {
            Some(own) => own.draw(&r.data, r.width as usize, r.x, r.y),
            None => s.draw(&r.data, r.width as usize, r.x, r.y),
        }
        lay(bx);
    }
    drop(glyphs);
    if let (Some(own), Some(bx)) = (&own, laid) {
        let page = request
            .backdrop
            .as_deref()
            .map(|pixels| Backdrop { pixels });
        blend::lay(&mut s, own, bx, 1.0, request.blend, page.as_ref(), 0);
    }
    drop(own);
    // An Emboss, a Pillow Emboss or a Stroke Emboss, over the finished
    // letters: PhotoCraft shades the composited layer with them.
    if let Some(bv) = &bevels {
        let page = request
            .backdrop
            .as_deref()
            .map(|pixels| Backdrop { pixels });
        if let Some(b) = effects::lay_bevels(&mut s, bv, &request.effects, true, page.as_ref())? {
            laid = Some(laid.map_or(b, |l| l.union(&b)));
        }
    }
    drop(bevels);
    blur::gaussian(&mut s, blur_sigma)?;
    if !taps.is_empty() {
        let mut moves = budget::Buffer::new();
        for t in &taps {
            let (dx, dy) = carried(t.dx, t.dy);
            budget::push(
                &mut moves,
                Moved {
                    dx,
                    dy,
                    weight: t.weight,
                },
            )?;
        }
        blur::sum_moved(&mut s, &moves)?;
    }
    if let Some(clip) = &request.clip {
        let keep_outside = clip.mode == ClipMode::Exclude;
        match clip_mask(clip, &request.request, surface, rasterizer)? {
            Some((mask, bx)) => blur::mask(&mut s, &mask, bx, keep_outside),
            // Shapes that cover nothing keep nothing, or cut nothing.
            None if keep_outside => {}
            None => s.clear(),
        }
    }

    // A blur and a smear carry ink past where it was laid; a mask only
    // takes it away.
    let ink = if positive(blur_sigma) || request.taps.iter().any(|t| positive(t.weight)) {
        s.ink()
    } else {
        laid.and_then(|b| s.ink_in(b))
    };
    let Some(ink) = ink else {
        return Ok(None);
    };
    Ok(Some(Raster {
        x: ink.x0,
        y: ink.y0,
        width: ink.width() as u32,
        height: ink.height() as u32,
        data: s.straight(ink)?,
    }))
}
