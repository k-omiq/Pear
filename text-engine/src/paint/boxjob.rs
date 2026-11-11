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
//! fade      shapes that take some of the opacity, their edges soft
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
use super::fx::blending::{self, shadow_see_through, Blending, Range};
use super::fx::contour::{self, Curve, Lut, Table};
use super::fx::effects::{
    self, Bevel, BevelStyle, BevelTechnique, BevelTexture, Effect, Glow, InnerShadow, Overlay,
    Page, Paint, PaintOverlay, Place, Position, Satin, Stroke, Technique,
};
use super::fx::gradient::{Gradient, Style};
use super::fx::gradient_bake::Method;
use super::fx::noise_gradient::{Model, Noise, Ramp};
use super::fx::{distance, noise, size_reach, spread_split};
use super::geom::{positive, Affine, IBox, Polys, Pt};
use super::job::{decode, read_fill, Fill, Request, Rgba};
use super::kept::{self, Hasher};
use super::raster::{Part, Rasterizer};
use super::shade::Shader;
use super::sweep;
use super::{
    budget, finish, paint_job_with, plan, Exact, Planned, Raster, FLATTEN_TOLERANCE,
};
use super::{MAX_PIXELS, MAX_SIDE};
use crate::engine::Engine;
use crate::Error;

/// "MTPB", little-endian.
pub const BOX_MAGIC: u32 = 0x4250_544d;
/// The box wire's version, which `js/paint.mjs` writes and checks as its own
/// `BOX_WIRE_VERSION`. Rule: every new flag bit, field, record kind or
/// changed meaning bumps it, on both sides at once, and is noted in
/// [`decode_box`]'s docs; the loader compares only this number, so a wasm
/// and a loader that agree on it must read the same bytes. v11 broke this
/// once: 7858367 added shadow flag 4 (exact) with no bump, so a wasm from
/// before it reads v11 and refuses every SFX copy's shadow.
pub const BOX_WIRE_VERSION: u32 = 20;

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
/// Largest page side, and largest entry of the job-to-page matrix, a page
/// record (v16, Align with Layer off) may state, in page px: 2^20, 1048576.
/// A long-strip page is one image, and tall ones run past 65536 px (a
/// 200 x 70000 page is real), so `MAX_THROW` is too tight here. It is still
/// a safe bound: these numbers only place a gradient (`Page::frame`, the
/// ramp's `t`); nothing is allocated or looped over by them, and at 2^20 an
/// f32 page coordinate is still good to 1/16 px. The JS encoder checks the
/// same bound (`MAX_PAGE` in paint.mjs) and sends no page past it, so such a
/// box paints as Align on rather than being refused.
pub const MAX_PAGE: f64 = 1048576.0;
/// Most stops an effect gradient takes, of each kind.
pub const MAX_GRADIENT_STOPS: usize = 256;
/// Largest Scale an effect gradient takes (1 is 100 %).
pub const MAX_GRADIENT_SCALE: f64 = 10.0;
/// Largest bevel Depth and Texture Depth (1 is 100 %): Photoshop's 1000 %.
pub const MAX_BEVEL_DEPTH: f64 = 10.0;
/// Most bevels a box takes. A guard, not a design limit: Photoshop and the
/// app give a style one. Each bakes its two contours to [`Table::LEN`]
/// floats and paints over the whole frame.
pub const MAX_BEVELS: usize = 8;
/// Most noise gradients a box takes, over all its effects. A guard: each
/// bakes to a 1024-colour ramp (16 KiB), and the app's gradient overlays
/// are a list with no count of its own.
pub const MAX_NOISE_GRADIENTS: usize = 64;

/// One shadow of the box (`style.shadows`): Photoshop's Drop Shadow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub color: Rgba,
    pub opacity: f64,
    /// How far it is thrown, job units.
    pub x: f64,
    pub y: f64,
    /// Photoshop's Size, job units: how far the soft edge reaches
    /// ([`fx::size_reach`](crate::paint::fx::size_reach); the blur is the
    /// tent in [`fx::tent`](crate::paint::fx::tent)). 0 is a hard edge.
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
    /// Laid at its exact throw: an SFX copy (an extrude's step, a shake, a
    /// shade side), which must not step. A Photoshop Drop Shadow is not: its
    /// throw is rounded to whole pixels as Photoshop's is
    /// ([`effects::whole_throw`]).
    pub exact: bool,
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
            exact: false,
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

/// What one shape of the mask does (wire v19, per shape).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipMode {
    /// Keep: the letters show inside the union of the keep shapes, and
    /// nowhere else when there is one.
    Include,
    /// Hide: what the shape covers is not shown.
    Exclude,
}

/// One shape of the mask (`box.mask`, pinned to the page and taken into the
/// box's own frame by the app), in the box's own units from its top-left
/// corner.
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

/// One shape of the mask and what it does.
#[derive(Clone, Debug, PartialEq)]
pub struct ClipPart {
    pub mode: ClipMode,
    pub shape: ClipShape,
}

/// The mask: the letters show inside the union of the keep shapes
/// (everywhere, with none), less the union of the hide shapes. It is cut
/// from the finished surface, after the box's warp, so the mesh never bends
/// it (wire v19).
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    /// The box's corner in job space: the shapes are stated from it.
    pub origin: Pt,
    pub shapes: Vec<ClipPart>,
}

impl Clip {
    /// A mask whose every shape does the one thing.
    pub fn all(mode: ClipMode, origin: Pt, shapes: Vec<ClipShape>) -> Self {
        Self {
            origin,
            shapes: shapes
                .into_iter()
                .map(|shape| ClipPart { mode, shape })
                .collect(),
        }
    }
}

/// One shape of the fade: how much of the box's opacity it takes, and how
/// soft its edge is.
#[derive(Clone, Debug, PartialEq)]
pub struct FadePart {
    /// 0 to 1: the share of the opacity the box loses inside the shape.
    pub strength: f64,
    /// The edge's softness: a gaussian's sigma, job units. Zero is a hard
    /// edge.
    pub soft: f64,
    pub shape: ClipShape,
}

/// The fade: regional opacity, laid after the mask on the same finished
/// surface (wire v20). Shapes of one softness are rastered at their
/// strength and combined by the most, so two dabs at 40 % that overlap stay
/// at 40 %; each softness is blurred once; and the softnesses are combined
/// by the most again. The surface is multiplied by what is left. Softnesses
/// within a tenth of each other share one blur.
///
/// Known limit: the fade is cut from the surface after the mesh, so the warp
/// never bends it, but in the two cases where the box is painted with no mesh
/// and bent on the canvas afterwards (the warp gizmo's drag frames, and a
/// perspective corner pulled past the horizon) the fade bends with the
/// letters. Both are accepted.
#[derive(Clone, Debug, PartialEq)]
pub struct Fade {
    /// The box's corner in job space: the shapes are stated from it.
    pub origin: Pt,
    pub shapes: Vec<FadePart>,
}

/// A decoded box job.
pub struct BoxRequest {
    /// The surface, device pixels. Its corner is device `(0, 0)`.
    pub width: u32,
    pub height: u32,
    /// The surface's corner in device pixels anchored to the page (the
    /// page's corner times the device pixels to a page pixel): every grain
    /// the box paints (Noise, Dissolve, a glow's Jitter) is hashed from a
    /// surface pixel plus this, so the same page pixel keeps its grain
    /// however much room the surface takes round the box (wire v15).
    pub grain: (i32, i32),
    /// The page the box sits on, for the gradients laid with Align with
    /// Layer off (wire v16); None lays them as with it on.
    pub page: Option<Page>,
    /// First on top.
    pub shadows: Vec<Shadow>,
    /// The whole-box blur: a gaussian's sigma, job units. Zero for none.
    pub blur: f64,
    pub taps: Vec<Tap>,
    pub clip: Option<Clip>,
    pub fade: Option<Fade>,
    /// The letters' own blend mode (Blending Options). It blends with the
    /// page only where a `backdrop` is given; with none it is Normal.
    pub blend: Blend,
    /// Photoshop's Fill Opacity, 0 to 1: the fill fades, the outlines and
    /// the shadows do not. Over a page, in one of the special eight modes
    /// (`Blend::fill_is_special`), it changes the blend instead.
    pub fill_opacity: f64,
    /// The Advanced Blending options.
    pub blending: Blending,
    /// The layer effects past the drop shadows, the [`Effect`] kinds: Outer
    /// Glow, Inner Glow, Inner Shadow, Colour Overlay, Gradient Overlay,
    /// Pattern Overlay, Satin, Stroke and Bevel & Emboss (wire kinds 1 to 9).
    /// Of a kind, first on top.
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
            grain: (0, 0),
            page: None,
            shadows: Vec::new(),
            blur: 0.0,
            taps: Vec::new(),
            clip: None,
            fade: None,
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
    /// Bevels and noise gradients read so far, for their caps.
    bevels: usize,
    noises: usize,
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
        if flags & !7 != 0 {
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
            exact: flags & 4 != 0,
            contour,
            seed,
        })
    }

    fn rgba(&mut self) -> Result<Rgba, Error> {
        let b = self.take(4)?;
        Ok(Rgba([b[0], b[1], b[2], b[3]]))
    }

    /// A contour baked to floats (the bevel's), or `None` for Linear.
    /// The table is charged to the painter's budget.
    fn table(&mut self) -> Result<Option<Table>, Error> {
        match self.curve()? {
            Some(c) => Table::charged(&c),
            None => Ok(None),
        }
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
        self.bevels += 1;
        if self.bevels > MAX_BEVELS {
            return Err(Error::BadSpec);
        }
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
        // Ticked, the Contour is a table even when it is Linear: the height
        // still goes through it and is clamped to 0 to 1 (review F28).
        let (contour, range) = if flags & 4 != 0 {
            let curve = self.curve()?.unwrap_or(Curve::Preset(0));
            (Some(Table::charged_on(&curve)?), self.upto(1.0)?)
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
        let jitter = self.upto(1.0)?;
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
            jitter,
            seed,
        })
    }

    /// An effect gradient: style, angle, scale, reverse, offset, then the
    /// colour stops (position, RGBA) and the opacity stops (position,
    /// opacity), each in order, their midpoints, Dither, the Method and
    /// Smoothness (baked into the stops here, [`Gradient::interpolate`]).
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
        // v14: the midpoints, Dither, the Method and Smoothness.
        let mids = self.gradient_mids(n)?;
        let opacity_mids = self.gradient_mids(m)?;
        // v16: Dither is bit 1 of the flags, Align with Layer off bit 2.
        let flags = self.u32()?;
        if flags > 3 {
            return Err(Error::BadSpec);
        }
        let (dither, align) = (flags & 1 != 0, flags & 2 == 0);
        let method = Method::from_u32(self.u32()?).ok_or(Error::BadSpec)?;
        let smoothness = self.upto(1.0)? as f32;
        let noise = match self.u32()? {
            0 => None,
            1 => {
                self.noises += 1;
                if self.noises > MAX_NOISE_GRADIENTS {
                    return Err(Error::BadSpec);
                }
                Some(Ramp::charged(self.noise()?)?)
            }
            _ => return Err(Error::BadSpec),
        };
        let mut g = Gradient {
            stops,
            opacity,
            style,
            angle,
            scale,
            reverse,
            offset,
            noise,
            mids,
            opacity_mids,
            dither,
            align,
        };
        g.interpolate(method, smoothness)?;
        Ok(g)
    }

    /// A gradient's midpoints (v14): none (every one even), or one for each
    /// segment between its `stops` stops, each 0 to 1 (the painter keeps
    /// them to Photoshop's 5 to 95 %).
    fn gradient_mids(&mut self, stops: usize) -> Result<Vec<f32>, Error> {
        let k = self.count(MAX_GRADIENT_STOPS, 8)?;
        if k != 0 && k + 1 != stops {
            return Err(Error::BadSpec);
        }
        let mut mids = Vec::with_capacity(k);
        for _ in 0..k {
            mids.push(self.upto(1.0)? as f32);
        }
        Ok(mids)
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

    fn part(&mut self) -> Result<ClipPart, Error> {
        let kind = self.u32()?;
        let mode = match self.u32()? {
            1 => ClipMode::Include,
            2 => ClipMode::Exclude,
            _ => return Err(Error::BadSpec),
        };
        Ok(ClipPart {
            mode,
            shape: self.shape(kind)?,
        })
    }

    fn fade_part(&mut self) -> Result<FadePart, Error> {
        let kind = self.u32()?;
        let strength = self.upto(1.0)?;
        let soft = self.upto(MAX_BLUR)?;
        Ok(FadePart {
            strength,
            soft,
            shape: self.shape(kind)?,
        })
    }

    fn shape(&mut self, kind: u32) -> Result<ClipShape, Error> {
        Ok(match kind {
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
/// i32 x, i32 y (v15)           the surface's corner in device pixels anchored
///                              to the page: each grain is hashed from it on
/// u32 page (v16)              0 none; 1 then f64 a, b, c, d, e, f (job units
///                              onto the page, page px: the box's place, turn
///                              and mirror) and f64 w, h (the page, page px):
///                              what a gradient with Align with Layer off is
///                              laid over (none lays it as one with it on)
/// u32 shadow count, then per shadow, first in the style first:
///     rgba colour, f64 opacity, f64 x, y, f64 size, f64 grow,
///     f64 spread, f64 noise    0 to 1 each
///     u32 blend                a mode number (`Blend::from_u32`)
///     u32 flags                1 knockout, 2 contour anti-aliased, 4 exact
///                              (v11, added late without a bump: an early
///                              v11 wasm refuses it): laid at its exact
///                              throw (an SFX copy);
///                              without it the throw is rounded to whole
///                              pixels, in job units and then in device
///                              pixels, as Photoshop rounds a Drop Shadow's
///     u32 seed
///     u32 contour              0 to 11 a preset (Linear is 0), 255 points:
///       u32 n, then n points (f64 x, y from 0 to 255, u32 corner)
/// f64 blur                     the whole-box blur; 0 for none
/// u32 tap count, then per tap: f64 dx, dy, f64 weight
/// u32 mask (v19)              0 none; 1 then:
///     f64 ox, oy               the box's corner in job space
///     u32 shape count, then per shape: u32 kind, u32 op (1 keep, 2 hide),
///     then by kind
///       1 ellipse: f64 cx, cy, rx, ry
///       2 polygon: u32 n, then n points (f64 x, y)
///       3 stroke:  f64 size, u32 n, then n points; one point is a dot
///     The letters show inside the union of the keep shapes (everywhere,
///     with none) less the union of the hide shapes. Before v19 one mode
///     held for every shape and the box's mesh bent them.
/// u32 fade (v20)              0 none; 1 then:
///     f64 ox, oy               the box's corner in job space
///     u32 shape count, then per shape: u32 kind, f64 strength (0 to 1),
///     f64 soft (a gaussian's sigma, job units), then by kind as a mask
///     shape's
///     Laid after the mask: shapes of one soft are combined by the most and
///     blurred once, the softs combined by the most, and the surface
///     multiplied by one less that.
/// u32 blend                    the letters' mode
/// f64 fill opacity             0 to 1
/// u32 blending flags (v9)      1 Blend Interior Effects as Group,
///                              2 Transparency Shapes Layer off (v13)
/// u32 channels left out (v10)  bit 0 R, 1 G, 2 B (Channels unticked)
/// u32 blend if (v10)           0 none, or 1 and 8 ranges of 4 bytes:
///                              gray this, gray under, R this, R under,
///                              G this, G under, B this, B under; each
///                              black low, black high, white low, white
///                              high (PSD's order), 0 to 255
///     Channels and Blend If change the box's blend onto the page and are
///     painted only over a backdrop: with none (a PSD layer) Photoshop
///     applies them from the layer's own fields.
/// u32 effect count, then per effect, first of its kind on top, a u32 kind:
///   1 outer glow, 2 inner glow:
///     rgba colour, f64 opacity, u32 blend
///     u32 technique            0 Softer, 1 Precise
///     f64 size, f64 spread (or choke), f64 range, f64 noise   0 to 1 but size
///     u32 seed, u32 contour (as a shadow's)
///     u32 source               inner glow only: 0 edge, 1 center
///     u32 gradient             0 its colour, 1: a gradient record follows
///     f64 jitter (v11)         0 to 1, Quality > Jitter: moves each pixel's
///                              sample of the gradient; nothing on a colour
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
///                    carried, never applied); Linear too clamps the
///                    height to 0 to 1
///     if flags & 16: f64 texture depth (-10 to 10), a paint record that is
///                    a fill (kind 2): the pattern
///     The anti-aliased flags are carried, not painted.
/// u32 ink (v12)                0 none, or 1 and the box's brush ink:
///     f64 ox, oy               the box's corner in job units: the strokes
///                              are stated from it
///     u32 n tips, then per tip: u32 length, UTF-8 key (at most 4096 tips,
///                              keys of at most 1024 bytes): the tips the
///                              strokes stamp with, put in the engine's tip
///                              cache beforehand (`mt_ink_tip_put`); a key
///                              it does not hold paints round
///     u32 n strokes (at most 4096), then per stroke:
///       u32 flags              1 ribbon, 2 follow direction, 4 darken tips,
///                              8 Compare density, 16 watercolour edge,
///                              32 texture, 64 texture stress; bits 8-9
///                              anti-aliasing 0 to 3, 10-11 flip x and
///                              12-13 flip y (0 off, 1 on, 2 random), 14-15
///                              tip order (0 repeat, 1 reverse, 2 once, 3
///                              random); 16 taper in, 17 taper in in
///                              percent, 18 taper out, 19 taper out in
///                              percent
///       rgba colour            opaque
///       f64 opacity (0 to 1), size (0.5 to 2000), spacing (1 to 200),
///         hardness (0 to 100), angle (degrees), angle jitter (0 to 100),
///         flatness (0.01 to 1), corners (0 to 180 degrees)
///       f64 taper in length (0 to 500), ratio (0 to 100), taper out
///         length, ratio
///       f64 watercolour width (1 to 20), power, darkness (0 to 1 each),
///         blur (0 to 20)
///       f64 texture density (0 to 1), scale (10 to 1000)
///       f64 seed               as stored; cut to 32 bits as JS's `>>> 0`
///       u32 tip                an index into the tips, 0xffffffff round
///       u32 n, then n tip indices: the tip cycle (0xffffffff not in hand)
///       u32 n points (at least 1; at most 2^20 over every stroke),
///       u32 stride (3 or 5), then n * stride f64: x, y (within 65536),
///         the width, opacity and thickness factors (0 to 1 each)
///     The lengths are page px from the box's corner, which the job's
///     transform carries like everything else. The box's outlines go round
///     the ink and its shadows are thrown from the letters and the ink as
///     one shape. (v17, a changed meaning, no new byte:) the glyph job's
///     mesh and roughening bend and roughen the ink as they do the letters;
///     a wasm of v16 or older painted the ink of such a job unbent.
/// u32 backdrop                 0 none, 1: width * height * 4 bytes follow,
///                              straight RGBA8 read as opaque: the page art
///                              under each surface pixel
/// u32 job byte length, then a glyph job in its own wire form (v18: the
///                              glyph job's v11, with flag 32, Crisp)
///
/// paint record: u32 kind, then 0 rgba colour, 1 a gradient record, or 2 a
///   fill record as the glyph job writes one (its tile numbers are the job's)
/// gradient record: u32 style (0 Linear, 1 Radial, 2 Angle, 3 Reflected,
///   4 Diamond, 5 Shape Burst), f64 angle (degrees), f64 scale (1 is 100 %,
///   to 10), u32 reverse, f64 x, y (the centre moved, a share of the frame,
///   within 10), u32 n then n (f64 position, rgba colour), u32 m then m (f64
///   position, f64 opacity); at most 256 of each, positions 0 to 1 and in
///   order; then (v14) u32 k then k f64 colour midpoints and u32 j then j
///   f64 opacity midpoints (0, or one per segment: n - 1 and m - 1; each 0
///   to 1, painted kept to 5 to 95 %), u32 flags (v16; was dither, 0 or 1):
///   1 Dither, 2 Align with Layer off (laid over the page; a glow's and a
///   Shape Burst's gradient read it and ignore it), u32 method (0
///   Classic, 1 Perceptual, 2 Linear, 3 Smooth), f64 smoothness (0 to 1);
///   then u32 type, 0 solid (the stops), 1 noise (v6), whose record
///   follows in place of the stops' colours:
/// noise record: u32 seed, f64 roughness (0 to 1), u32 model (0 RGB, 1 HSB,
///   2 LAB), then per channel f64 min, f64 max (0 to 1, min <= max), u32
///   flags (1 restrict colours, 2 add transparency)
/// ```
///
/// Refused (`BadSpec`, or the painter's budget error):
/// - a surface with no size, past [`MAX_SIDE`] a side or [`MAX_PIXELS`] in all;
/// - a count the bytes cannot hold, or past its cap: more than `MAX_TAPS`
///   taps, `MAX_GRADIENT_STOPS` stops of a kind, [`contour::MAX_POINTS`]
///   custom contour points, more than `MAX_BEVELS` bevels or
///   `MAX_NOISE_GRADIENTS` noise gradients;
/// - a number that is not finite, or outside its range: an opacity, weight,
///   spread, choke, noise, jitter, Range, fill opacity, gradient stop
///   position, noise limit or roughness outside 0 to 1; a noise limit's min
///   above its max; a stop or contour x out of order; a size or blur outside
///   0 to `MAX_BLUR`; a throw, tap, point or the
///   centre of a gradient further than `MAX_THROW` from zero (a gradient
///   offset further than 10); a gradient angle past 36000 degrees or a scale
///   outside 0 to `MAX_GRADIENT_SCALE`; a bevel depth or texture depth
///   outside 0 to `MAX_BEVEL_DEPTH`; an altitude outside 0 to 90; a
///   contour point outside 0 to 255;
/// - a name that does not exist: a blend mode, a contour preset, a gradient
///   style, a glow technique, a stroke position, a bevel style or technique,
///   a noise colour model, a clip mode or shape, a paint kind (0 to 2), or an
///   effect kind (1 to 9); a gradient overlay that does not carry a gradient
///   paint, or a pattern overlay that does not carry a fill;
/// - a flag past its bits: the blending flags, a channel mask past 7, the
///   shadow flags past 7, the satin flags past 3, the bevel flags past 63
///   (a texture's Invert with no texture), the noise flags past 3, a glow's
///   Centre or gradient flag, a gradient's flags past 3 or its method, a
///   page record whose matrix does not invert, has an entry past
///   `MAX_PAGE` from zero, or whose size is not above 0 or is past
///   `MAX_PAGE`, a midpoint
///   count that is neither 0 nor one per segment, a contour corner flag, a backdrop flag, or a
///   Blend If flag past 1, or a Blend If range out of order (black low,
///   black high, white low, white high must not fall);
/// - a bevel texture whose paint is not a fill;
/// - bytes left over after the job's end;
/// - ink past its limits above (a stroke's number out of its range, a flag
///   that is not one, a tip index past the tips, a stride that is not 3 or 5);
/// - records the painter's budget cannot hold (the baked contour tables and
///   noise ramps count), and anything a glyph job is refused for.
pub fn decode_box(bytes: &[u8]) -> Result<BoxRequest, Error> {
    decode_box_kept(bytes).map(|(request, _)| request)
}

/// [`decode_box`], and the keys [`paint_box_kept`] keeps its pieces under:
/// the glyph job's, of its own bytes as they are written, and for a box with
/// a mask or a fade the premask's, of every byte but theirs.
pub fn decode_box_kept(bytes: &[u8]) -> Result<(BoxRequest, BoxKeys), Error> {
    let mut r = Reader {
        bytes,
        at: 0,
        bevels: 0,
        noises: 0,
    };
    if r.u32()? != BOX_MAGIC || r.u32()? != BOX_WIRE_VERSION {
        return Err(Error::BadSpec);
    }
    let (width, height) = (r.u32()?, r.u32()?);
    let grain = (r.u32()? as i32, r.u32()? as i32);
    let page = match r.u32()? {
        0 => None,
        1 => {
            let mut m = [0.0; 6];
            for v in m.iter_mut() {
                *v = r.within(MAX_PAGE)?;
            }
            let to_page = Affine(m);
            to_page.invert().ok_or(Error::BadSpec)?;
            let (w, h) = (r.upto(MAX_PAGE)?, r.upto(MAX_PAGE)?);
            if w <= 0.0 || h <= 0.0 {
                return Err(Error::BadSpec);
            }
            Some(Page { to_page, w, h })
        }
        _ => return Err(Error::BadSpec),
    };
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
    let mask_at = r.at;
    let clip = match r.u32()? {
        0 => None,
        1 => {
            let origin = r.pt()?;
            let n = r.count(usize::MAX, 8)?;
            Some(Clip {
                origin,
                shapes: budget::collect((0..n).map(|_| r.part()))?,
            })
        }
        _ => return Err(Error::BadSpec),
    };
    let fade = match r.u32()? {
        0 => None,
        1 => {
            let origin = r.pt()?;
            let n = r.count(usize::MAX, 24)?;
            Some(Fade {
                origin,
                shapes: budget::collect((0..n).map(|_| r.fade_part()))?,
            })
        }
        _ => return Err(Error::BadSpec),
    };
    // The mask and the fade: what a move of a box with either changes.
    let mask_end = r.at;
    let blend = Blend::from_u32(r.u32()?).ok_or(Error::BadSpec)?;
    let fill_opacity = r.upto(1.0)?;
    let mut blending = Blending::from_flags(r.u32()?).ok_or(Error::BadSpec)?;
    blending.channels_out = match r.u32()? {
        n @ 0..=7 => n as u8,
        _ => return Err(Error::BadSpec),
    };
    match r.u32()? {
        0 => {}
        1 => {
            for pair in blending.blend_if.ranges.iter_mut() {
                for range in pair.iter_mut() {
                    let b = r.take(4)?;
                    *range = Range::from_bytes([b[0], b[1], b[2], b[3]]).ok_or(Error::BadSpec)?;
                }
            }
        }
        _ => return Err(Error::BadSpec),
    }
    let n = r.count(usize::MAX, 20)?;
    let effects = budget::collect((0..n).map(|_| r.effect()))?;
    let ink = super::ink::read(bytes, &mut r.at)?;
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
    let job = r.take(len)?;
    let key = Hasher::new("job").bytes(job).finish().ok_or(Error::BadSpec)?;
    let mut request = decode(job)?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    request.ink = ink;
    let premask = match (&clip, &fade) {
        (None, None) => None,
        _ => Some(
            Hasher::new("box but its mask")
                .bytes(&bytes[..mask_at])
                .bytes(&bytes[mask_end..])
                .finish()
                .ok_or(Error::BadSpec)?,
        ),
    };
    let request = BoxRequest {
        width,
        height,
        grain,
        page,
        shadows,
        blend,
        fill_opacity,
        blending,
        effects,
        backdrop,
        blur,
        taps,
        clip,
        fade,
        request,
    };
    Ok((request, BoxKeys { job: key, premask }))
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
fn clip_parts<'a>(
    origin: Pt,
    shapes: impl Iterator<Item = &'a ClipShape>,
    tol: f64,
) -> Result<budget::Buffer<Polys>, Error> {
    let mut out = budget::Buffer::new();
    let at = |p: Pt| p.plus(origin);
    for shape in shapes {
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

/// The coverage of the mask's shapes of one `mode` over the surface:
/// straight RGBA8 whose alpha is the share of each pixel they cover, and the
/// box of pixels it is for. `None` when they cover nothing of the surface.
/// The shapes are cut from the finished surface, after the box's warp: the
/// app has taken them from the page into the box's frame, so the mesh does
/// not bend them.
fn clip_mask(
    clip: &Clip,
    mode: ClipMode,
    request: &Request,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<(Vec<u8>, IBox)>, Error> {
    let shapes = clip
        .shapes
        .iter()
        .filter(|p| p.mode == mode)
        .map(|p| &p.shape);
    shapes_mask(clip.origin, shapes, &request.transform, surface, rasterizer)
}

/// The coverage of the union of `shapes`, stated from `origin`, over the
/// surface: [`clip_mask`]'s raster, for any shapes.
fn shapes_mask<'a>(
    origin: Pt,
    shapes: impl Iterator<Item = &'a ClipShape>,
    transform: &Affine,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<(Vec<u8>, IBox)>, Error> {
    let tol = FLATTEN_TOLERANCE / transform.max_scale();
    let mut parts = budget::Buffer::new();
    for polys in clip_parts(origin, shapes, tol)?.iter() {
        let placed = polys.map(transform);
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

/// A fade shape's softness in surface pixels, snapped to steps of a tenth
/// (1.1 to the power of a whole number), so shapes of near sizes share one
/// blur; under half a pixel it is a hard edge. The power is taken by
/// multiplying, so the engine's builds agree on it to the bit.
fn fade_sigma(soft: f64, scale: f64) -> f64 {
    let s = soft * scale;
    if !(s >= 0.5) || !s.is_finite() {
        return 0.0;
    }
    let i = (s.ln() / 1.1f64.ln()).round() as i32;
    let mut v = 1.0;
    for _ in 0..i.unsigned_abs().min(400) {
        v *= 1.1;
    }
    if i < 0 {
        1.0 / v
    } else {
        v
    }
}

/// The surface multiplied by one less the fade (see [`Fade`]): at each pixel
/// with ink, the most any softness takes there. `scale` carries a softness
/// from job units to pixels, as it carries the whole-box blur; `grain` is the
/// surface's corner anchored to the page.
///
/// A softness is rastered and blurred at a fraction of the surface's
/// resolution, chosen so its blur is still two pixels or more there: the blur
/// takes out every detail the smaller raster loses. That raster's grid is
/// anchored to the page, not to the surface, and reaches past the surface by
/// the blur's own reach, so what a shape does to a letter does not depend on
/// how much room the surface takes round the box (a shadow's, say) or on
/// where its edge falls. Each softness is read back by bilinear sampling at
/// the pixels with ink only, folded into one map by the most, and let go
/// before the next is made.
fn lay_fade(
    s: &mut Surface,
    fade: &Fade,
    request: &Request,
    scale: f64,
    grain: (i32, i32),
    rasterizer: &dyn Rasterizer,
) -> Result<(), Error> {
    let (w, h) = (s.width as i32, s.height as i32);
    let (gx, gy) = grain;
    // The softnesses, each once, in the order they first come.
    let mut sigmas: Vec<u64> = Vec::new();
    for p in &fade.shapes {
        let key = fade_sigma(p.soft, scale).to_bits();
        if positive(p.strength) && !sigmas.contains(&key) {
            sigmas.push(key);
        }
    }
    let mut map: Option<budget::Buffer<u8>> = None;
    let mut cover: Option<IBox> = None;
    for key in sigmas {
        let sigma = f64::from_bits(key);
        // Surface pixels to one of the small raster's.
        let k = (sigma / 2.0).floor().clamp(1.0, 16.0) as i32;
        let kf = f64::from(k);
        let pad = blur::blur_reach(sigma / kf) + 1;
        // The small raster's corner, in page-anchored cells of `k` pixels.
        let (lx, ly) = (gx.div_euclid(k) - pad, gy.div_euclid(k) - pad);
        let lw = ((gx + w - 1).div_euclid(k) - lx + 1 + pad) as usize;
        let lh = ((gy + h - 1).div_euclid(k) - ly + 1 + pad) as usize;
        let low_box = IBox {
            x0: 0,
            y0: 0,
            x1: lw as i32,
            y1: lh as i32,
        };
        let transform = Affine::translate(-f64::from(lx), -f64::from(ly)).after(
            &Affine::scale(1.0 / kf, 1.0 / kf)
                .after(&Affine::translate(f64::from(gx), f64::from(gy)).after(&request.transform)),
        );
        // Each shape's coverage on the small grid.
        let mut covs = budget::Buffer::new();
        for p in fade
            .shapes
            .iter()
            .filter(|p| fade_sigma(p.soft, scale).to_bits() == key && positive(p.strength))
        {
            if let Some((cov, bx)) = shapes_mask(
                fade.origin,
                core::iter::once(&p.shape),
                &transform,
                low_box,
                rasterizer,
            )? {
                budget::push(&mut covs, (cov, bx, p.strength))?;
            }
            budget::check()?;
        }
        // Shapes far enough apart that their blurs cannot meet are rastered,
        // blurred and read back apart: each piece is then only its shapes'
        // box grown by the blur's reach, so a few small dabs across the box
        // cost a few small pieces, not the surface. Apart, what each blur
        // leaves is nothing where another's is anything, so the most of them
        // is what one blur of them all would leave.
        let grown = |bx: &IBox| IBox {
            x0: (bx.x0 - pad).max(0),
            y0: (bx.y0 - pad).max(0),
            x1: (bx.x1 + pad).min(low_box.x1),
            y1: (bx.y1 + pad).min(low_box.y1),
        };
        let mut clusters: Vec<(IBox, Vec<usize>)> = Vec::new();
        for (i, (_, bx, _)) in covs.iter().enumerate() {
            let mut g = grown(bx);
            let mut members = vec![i];
            // Join every cluster this one meets, until none is left to join.
            loop {
                let Some(j) = clusters.iter().position(|(c, _)| !c.intersect(&g).is_empty()) else {
                    break;
                };
                let (c, m) = clusters.swap_remove(j);
                g = g.union(&c);
                members.extend(m);
            }
            clusters.push((g, members));
        }
        let (lx0, ly0) = (lx, ly);
        for (g, members) in clusters {
            let gw = g.width();
            let mut low = Surface::new(gw, g.height())?;
            for &i in members.iter() {
                let (cov, bx, strength) = &covs[i];
                // Laid by the most: the raster is white, premultiplied, its
                // alpha the strongest shape over each pixel.
                let bw = bx.width();
                for y in bx.y0..bx.y1 {
                    let from = (y - bx.y0) as usize * bw * 4;
                    let to = ((y - g.y0) as usize * gw + (bx.x0 - g.x0) as usize) * 4;
                    for i in 0..bw {
                        let a = (f64::from(cov[from + i * 4 + 3]) * strength).round() as u8;
                        let q = &mut low.data[to + i * 4..to + i * 4 + 4];
                        if a > q[3] {
                            q.fill(a);
                        }
                    }
                }
            }
            blur::gaussian(&mut low, sigma / kf)?;
            let Some(ink) = low.ink() else {
                continue;
            };
            // The small raster's corner on the page-anchored grid.
            let (lx, ly) = (lx0 + g.x0, ly0 + g.y0);
            // The surface pixels this softness reaches, a cell wider each side
            // for the sampling.
            let reach = IBox {
                x0: ((lx + ink.x0 - 1) * k - gx).max(0),
                y0: ((ly + ink.y0 - 1) * k - gy).max(0),
                x1: ((lx + ink.x1 + 1) * k - gx).min(w),
                y1: ((ly + ink.y1 + 1) * k - gy).min(h),
            };
            if reach.is_empty() {
                continue;
            }
            let m = match map.as_mut() {
                Some(m) => m,
                None => map.insert(budget::filled(s.width * s.height, 0u8)?),
            };
            cover = Some(cover.map_or(reach, |c| c.union(&reach)));
            // Per surface column: the small raster's column left of the sample
            // and the weight of the one right of it, in 256ths.
            let mut cols = budget::Buffer::new();
            for x in reach.x0..reach.x1 {
                let sx = (f64::from(x + gx) + 0.5) / kf - 0.5 - f64::from(lx);
                let x0 = sx.floor();
                budget::push(&mut cols, (x0 as isize, ((sx - x0) * 256.0).round() as u32))?;
            }
            let (lw, lh) = (gw as isize, g.height() as isize);
            // Outside the small raster the blur has nothing: it reaches past
            // every shape by the blur's reach.
            let at = |r: isize, c: isize| {
                if r < 0 || c < 0 || r >= lh || c >= lw {
                    0
                } else {
                    u32::from(low.data[(r * lw + c) as usize * 4 + 3])
                }
            };
            for y in reach.y0..reach.y1 {
                let sy = (f64::from(y + gy) + 0.5) / kf - 0.5 - f64::from(ly);
                let r0 = sy.floor() as isize;
                let fy = ((sy - sy.floor()) * 256.0).round() as u32;
                let row = y as usize * s.width;
                for x in reach.x0..reach.x1 {
                    if s.data[(row + x as usize) * 4 + 3] == 0 {
                        continue;
                    }
                    let (c0, fx) = cols[(x - reach.x0) as usize];
                    let top = at(r0, c0) * (256 - fx) + at(r0, c0 + 1) * fx;
                    let bottom = at(r0 + 1, c0) * (256 - fx) + at(r0 + 1, c0 + 1) * fx;
                    let v = ((top * (256 - fy) + bottom * fy + 32768) >> 16).min(255) as u8;
                    let q = &mut m[row + x as usize];
                    if v > *q {
                        *q = v;
                    }
                }
            }
            budget::check()?;
        }
    }
    let (Some(m), Some(cover)) = (map, cover) else {
        return Ok(());
    };
    for y in cover.y0 as usize..cover.y1 as usize {
        for x in cover.x0 as usize..cover.x1 as usize {
            let f = u32::from(m[y * s.width + x]);
            if f == 0 {
                continue;
            }
            let k = 255 - f;
            for c in &mut s.data[(y * s.width + x) * 4..(y * s.width + x) * 4 + 4] {
                *c = ((u32::from(*c) * k + 127) / 255) as u8;
            }
        }
    }
    Ok(())
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
    paint(engine, request, rasterizer, true, Keep(None, None))
}

/// What [`paint_box_kept`] keeps a box's pieces under, as
/// [`decode_box_kept`] gives them from its bytes.
#[derive(Clone, Copy, Debug)]
pub struct BoxKeys {
    /// The glyph job in the request: everything of `request.request` but
    /// its ink.
    pub job: kept::Key,
    /// Everything of the box but its mask and its fade, for a box with
    /// either: the surface before them is kept under it. None with neither.
    pub premask: Option<kept::Key>,
}

/// [`paint_box`], with what it works out kept for the next paint and what
/// the paints before it kept read back (`super::kept`): the same pixels, to
/// the byte, sooner. `keys` are the request's own, as [`decode_box_kept`]
/// gives them. A box with brush ink keeps nothing (its tips are the
/// engine's, and can change under a key).
pub fn paint_box_kept(
    engine: &mut Engine,
    request: &mut BoxRequest,
    keys: BoxKeys,
) -> Result<Option<Raster>, Error> {
    let keep = if request.request.ink.is_some() {
        None
    } else {
        Hasher::new("box")
            .key(keys.job)
            .u64(engine.stamp.0)
            .debug(&engine.rules)
            .finish()
    };
    // The engine's fonts and rules are in the premask's key as in every
    // other piece's.
    let premask = keep.and(keys.premask).and_then(|k| {
        Hasher::new("premask")
            .key(k)
            .u64(engine.stamp.0)
            .debug(&engine.rules)
            .finish()
    });
    paint(engine, request, &Exact, true, Keep(keep, premask))
}

/// What a paint's pieces are kept under for the next one (`super::kept`):
/// the key of the glyph job, the engine's fonts and its rules; and for a box
/// with a mask, the key of everything but the mask, which the surface before
/// the mask is kept under. None for a paint that keeps nothing and reads
/// nothing back.
#[derive(Clone, Copy)]
struct Keep(Option<kept::Key>, Option<kept::Key>);

impl Keep {
    /// The key of what `paint_job_with` paints of `request` as it stands.
    /// The passes of a box change a job's silhouette, grow, outlines,
    /// negative, fill and runs (to all of them, the afterimages or the
    /// rest) and nothing else of it: a pass that changes another field
    /// must put it in this key.
    fn raster(self, request: &Request) -> Option<kept::Key> {
        if request.ink.is_some() {
            return None;
        }
        let job = &request.job;
        let ghosts = job.runs.iter().filter(|r| r.ghost).count();
        Hasher::new("raster")
            .maybe(self.0)
            .debug(&job.silhouette.map(|c| c.0))
            .f64(job.effects.grow)
            .u64(job.bands.len() as u64)
            .u64(u64::from(job.effects.negative.is_some()))
            .u64(u64::from(job.no_fill))
            .u64(ghosts as u64)
            .u64(job.runs.len() as u64)
            .finish()
    }

    /// The key of the surface with the shadows (`order`, as they are laid)
    /// on it and nothing else yet; none with no shadow. `page`: the key of
    /// the page under the box, if there is one.
    fn shadows(
        self,
        request: &BoxRequest,
        order: &[Shadow],
        see_through: f32,
        page: Option<kept::Key>,
    ) -> Option<kept::Key> {
        if order.is_empty() {
            return None;
        }
        let mut h = Hasher::new("shadows")
            .maybe(self.0)
            .u64(u64::from(request.width))
            .u64(u64::from(request.height))
            .i32(request.grain.0)
            .i32(request.grain.1)
            .debug(&see_through)
            .f64(request.fill_opacity)
            .debug(&order);
        if request.backdrop.is_some() {
            h = h.maybe(page);
        }
        h.finish()
    }

    /// The key of the surface with the shadows (whose key is `shadows`) and
    /// then the outer glows on it; none with no glow.
    fn glows(
        self,
        request: &BoxRequest,
        shadows: Option<kept::Key>,
        glows: bool,
        scale: f64,
        page: Option<kept::Key>,
    ) -> Option<kept::Key> {
        if !glows {
            return None;
        }
        let mut h = Hasher::new("glows")
            .maybe(self.0)
            .u64(u64::from(request.width))
            .u64(u64::from(request.height))
            .i32(request.grain.0)
            .i32(request.grain.1)
            .f64(request.fill_opacity)
            // The glows' map is as wide as the widest of the outer effects.
            .i32(effects::outer_reach(&request.effects, scale));
        h = match shadows {
            Some(k) => h.u64(1).key(k),
            None => h.u64(0),
        };
        for e in &request.effects {
            if let Effect::OuterGlow(_) = e {
                h = h.debug(e);
            }
        }
        if request.backdrop.is_some() {
            h = h.maybe(page);
        }
        h.finish()
    }

    /// The key of a shadow's layer: the silhouette `request` paints as it
    /// stands, blurred by a shadow of this `size`, on a surface this big.
    fn layer(self, request: &Request, size: f64, width: usize, height: usize) -> Option<kept::Key> {
        Hasher::new("shadow layer")
            .maybe(self.raster(request))
            .f64(size)
            .u64(width as u64)
            .u64(height as u64)
            .finish()
    }

    /// The key of the letters' fill as `paint_glyphs` hands it to the
    /// interior effects, with the place's transform and tiles.
    fn fill(self, hollow: bool, ghostly: bool) -> Option<kept::Key> {
        Hasher::new("fill")
            .maybe(self.0)
            .u64(u64::from(hollow))
            .u64(u64::from(ghostly))
            .finish()
    }
}

/// `paint_job_with`, or what it painted of this job the last time.
fn job_raster(
    engine: &mut Engine,
    request: &Request,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
) -> Result<Option<Raster>, Error> {
    let Some(key) = keep.raster(request) else {
        return paint_job_with(engine, request, rasterizer);
    };
    if let Some(hit) = kept::get::<Option<Raster>>(key) {
        return match &*hit {
            None => Ok(None),
            Some(r) => {
                let mut data = budget::filled(r.data.len(), 0u8)?;
                data.copy_from_slice(&r.data);
                Ok(Some(Raster {
                    data: data.into_vec(),
                    ..*r
                }))
            }
        };
    }
    let painted = paint_job_with(engine, request, rasterizer)?;
    match &painted {
        None => kept::put(key, None::<Raster>, 0),
        Some(r) => {
            if let Some(data) = kept::copy(&r.data) {
                kept::put(key, Some(Raster { data, ..*r }), r.data.len());
            }
        }
    }
    Ok(painted)
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
    paint(engine, request, rasterizer, false, Keep(None, None))
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
    for (p, &a) in layer.data.as_chunks_mut::<4>().0.iter_mut().zip(alpha) {
        let k = u32::from(a);
        for c in 0..3 {
            p[c] = ((u32::from(rgb[c]) * k + 127) / 255) as u8;
        }
        p[3] = a;
    }
}

/// The letters' fill as a matte the surface's size: the shape they would
/// fill, with no fill painted solid, without the outlines (bands) or a
/// negative's blob, as `lay_glows` keeps a glow from behind the fill. What a
/// knocked-out drop shadow is cut by: PhotoCraft's `knock_out_exterior`
/// multiplies by the content's shape, with no strokes.
fn fill_matte(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
    width: usize,
    height: usize,
) -> Result<Option<budget::Buffer<u8>>, Error> {
    let job = &mut request.request.job;
    let bands = core::mem::take(&mut job.bands);
    let negative = job.effects.negative.take();
    let silhouette = job.silhouette.replace(Rgba([0, 0, 0, 255]));
    let no_fill = core::mem::replace(&mut job.no_fill, false);
    let painted = job_raster(engine, &request.request, rasterizer, keep);
    let job = &mut request.request.job;
    job.bands = bands;
    job.effects.negative = negative;
    job.silhouette = silhouette;
    job.no_fill = no_fill;
    let Some(r) = painted? else {
        return Ok(None);
    };
    let mut layer = Surface::new(width, height)?;
    layer.draw(&r.data, r.width as usize, r.x, r.y);
    drop(r);
    alpha_of(&layer).map(Some)
}

fn alpha_of(layer: &Surface) -> Result<budget::Buffer<u8>, Error> {
    let mut out = budget::filled(layer.width * layer.height, 0u8)?;
    for (a, p) in out.iter_mut().zip(layer.data.as_chunks::<4>().0.iter()) {
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
    keep: Keep,
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
    let painted = job_raster(engine, &request.request, rasterizer, keep);
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
        fill_matte(engine, request, rasterizer, keep, width, height)?
    } else {
        None
    };
    let (grow, rest) = spread_split(sh.size, sh.spread);
    if positive(grow * scale) {
        distance::dilate(&mut matte, width, height, grow * scale)?;
        set_flat(&mut layer, rgb, &matte);
    }
    // The tent's width for the zoom, so the edge lays as at zoom 1.
    let tent = super::fx::tent_width(rest, scale);
    blur::tent_flat(&mut layer, tent, rgb)?;
    let reach = (size_reach(sh.size) * scale)
        .max(grow * scale + f64::from(super::fx::tent::reach(tent)))
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
        // The edge hidden, so a contour that does not start at 0 (Cone -
        // Inverted, Cove - Deep) keeps to the shadow and does not fill its
        // whole rectangle (review F7).
        if let Some(lut) = &sh.contour {
            for a in matte.iter_mut() {
                *a = lut.apply_hidden(*a);
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
                request.grain,
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
        for (p, &a) in thrown.data.as_chunks_mut::<4>().0.iter_mut().zip(letters.iter()) {
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
    blend::lay_from(
        s,
        &thrown,
        landed_at,
        sh.opacity as f32,
        sh.mode(),
        page.as_ref(),
        sh.seed,
        request.grain,
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
///
/// A box with no fill is Photoshop's layer at Fill 0 %: its interior
/// effects (overlays, Satin, glows, inner shadows, the Photoshop strokes, an
/// Inner Bevel, and the outer bevels after them) are laid from the letters'
/// shape as they would have been filled, and the fill itself is not seen.
/// Its outlines are cut to their outer halves, as without effects. Its
/// afterimages keep their own fill: they are left out of that shape and
/// painted alone, under the rest.
///
/// `this`, when Blend If's This Layer needs it, is given the box's own
/// content, before any effect (PhotoCraft's `render_content`): the fill at
/// its whole Fill, the afterimages, the ink and the outlines. A box with no
/// fill gives the same content as at Fill 0 % ([`own_content`]).
#[allow(clippy::too_many_arguments)]
fn paint_glyphs(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
    carried: impl Fn(f64, f64) -> (f64, f64),
    scale: f64,
    special: bool,
    this: &mut Option<Content>,
) -> Result<Glyphs, Error> {
    let job = &request.request.job;
    let hollow = job.no_fill;
    let fade = if hollow { 0.0 } else { request.fill_opacity };
    let inside =
        job.silhouette.is_none() && request.effects.iter().any(|e| e.interior() && e.shows());
    let silhouette = job.silhouette.is_some();
    // No Fill reads as Fill 0 % for This Layer: its content is painted on
    // its own, and nothing below draws into it.
    let mut this = this.as_mut();
    if hollow && !silhouette {
        if let Some(t) = this.take() {
            own_content(engine, request, rasterizer, keep, t)?;
        }
    }
    // A special-eight fill is handed back whole even at a whole Fill when
    // Transparency Shapes Layer is off: its own alpha is in the blend.
    if silhouette || (!inside && (hollow || (fade >= 1.0 && !special))) {
        let rasters: Vec<Raster> = job_raster(engine, &request.request, rasterizer, keep)?
            .into_iter()
            .collect();
        if let Some(t) = this {
            rasters.iter().for_each(|r| t.draw(r));
        }
        return Ok(Glyphs {
            rasters,
            ..Glyphs::default()
        });
    }
    let mut out = Vec::new();
    let mut outside = None;
    let mut bevels = None;
    let mut whole_fill = None;
    // With no fill, the afterimages in their own fill, under everything.
    let ghostly = hollow && inside && request.request.job.runs.iter().any(|r| r.ghost);
    if ghostly {
        if let Some(g) = paint_ghosts(engine, request, rasterizer, keep)? {
            out.push(g);
        }
    }
    // The fill alone, faded, with the effects on it. With no fill, the
    // letters' shape as they would have been filled: their solid
    // silhouette, at Fill 0, without the afterimages.
    let fill = if hollow {
        let bands = core::mem::take(&mut request.request.job.bands);
        let negative = request.request.job.effects.negative.take();
        let runs = if ghostly {
            let runs = core::mem::take(&mut request.request.job.runs);
            request.request.job.runs = runs.iter().filter(|r| !r.ghost).cloned().collect();
            Some(runs)
        } else {
            None
        };
        request.request.job.no_fill = false;
        request.request.job.silhouette = Some(Rgba([0, 0, 0, 255]));
        let fill = job_raster(engine, &request.request, rasterizer, keep);
        request.request.job.no_fill = hollow;
        request.request.job.silhouette = None;
        request.request.job.bands = bands;
        request.request.job.effects.negative = negative;
        if let Some(runs) = runs {
            request.request.job.runs = runs;
        }
        fill
    } else {
        paint_fill(engine, request, rasterizer, keep)
    };
    // Where the fill's piece lands in `out`, when it is laid as a piece.
    let mut fill_piece = None;
    if let Some(mut r) = fill? {
        if inside {
            let place = Place {
                transform: request.request.transform,
                tiles: &request.request.tiles,
                grain: request.grain,
                page: request.page,
            };
            let (laid, o, b) = effects::interior_kept(
                &r,
                &request.effects,
                fade,
                request.blending.interior,
                scale,
                carried,
                &place,
                keep.fill(hollow, ghostly),
            )?;
            (outside, bevels) = (o, b);
            // No fill hides the letters' fill and not the ink: it stays
            // drawn, under the effects laid on it.
            if hollow {
                if let Some(c) = request.request.ink.as_ref().and_then(|i| i.content()) {
                    out.push(c);
                }
            } else if let Some(t) = this.as_mut() {
                t.draw(&r);
            }
            drop(r);
            fill_piece = Some(out.len());
            out.push(laid);
        } else if special {
            if let Some(t) = this.as_mut() {
                t.draw(&r);
            }
            whole_fill = Some(r);
        } else {
            if let Some(t) = this.as_mut() {
                t.draw(&r);
            }
            for p in r.data.as_chunks_mut::<4>().0 {
                p[3] = (f64::from(p[3]) * fade + 0.5) as u8;
            }
            fill_piece = Some(out.len());
            out.push(r);
        }
    }
    // The outlines, outside the letters: with the fill's piece they make one
    // (`add_pieces`).
    if let Some(r) = paint_rims(engine, request, rasterizer, keep)? {
        if let Some(t) = this.as_mut() {
            t.draw(&r);
        }
        match fill_piece {
            Some(i) if i + 1 == out.len() => {
                let f = out.pop().ok_or(Error::BadSpec)?;
                out.push(add_pieces(f, r)?);
            }
            _ => out.push(r),
        }
    }
    Ok(Glyphs {
        rasters: out,
        whole_fill,
        outside,
        bevels,
    })
}

/// The letters' fill and their outlines cut to outside it (`paint_rims`)
/// share no coverage: on the letters' edge a pixel is part one and part the
/// other. Laid one over the other, that pixel would let the page through (a
/// fill at alpha `a` under outlines at `1 - a` covers `1 - a + a * a`, three
/// quarters at a half), a seam round every letter that the box painted in
/// one job, fill over whole outlines, never had. So they are one piece:
/// their premultiplied colours added, as one shape of two colours is. A
/// pixel only one of them covers keeps its bytes.
fn add_pieces(a: Raster, b: Raster) -> Result<Raster, Error> {
    let bound = |r: &Raster| IBox {
        x0: r.x,
        y0: r.y,
        x1: r.x + r.width as i32,
        y1: r.y + r.height as i32,
    };
    let (ba, bb) = (bound(&a), bound(&b));
    if bb.is_empty() {
        return Ok(a);
    }
    if ba.is_empty() {
        return Ok(b);
    }
    let u = ba.union(&bb);
    let (w, h) = (u.width(), u.height());
    let n = w.checked_mul(h).ok_or(Error::BadSpec)?;
    if n > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let mut data = Vec::new();
    super::budget::reserve_raw(&mut data, n * 4)?;
    data.resize(n * 4, 0u8);
    let copy = |data: &mut [u8], r: &Raster, add: bool| {
        let rw = r.width as usize;
        for y in 0..r.height as usize {
            let row = (r.y - u.y0) as usize + y;
            for x in 0..rw {
                let s = &r.data[(y * rw + x) * 4..(y * rw + x) * 4 + 4];
                if s[3] == 0 {
                    continue;
                }
                let i = (row * w + (r.x - u.x0) as usize + x) * 4;
                let d = &mut data[i..i + 4];
                if !add || d[3] == 0 {
                    d.copy_from_slice(s);
                    continue;
                }
                let (da, sa) = (f32::from(d[3]) / 255.0, f32::from(s[3]) / 255.0);
                let alpha = (da + sa).min(1.0);
                for c in 0..3 {
                    let v = (f32::from(d[c]) * da + f32::from(s[c]) * sa) / (da + sa);
                    d[c] = (v + 0.5).clamp(0.0, 255.0) as u8;
                }
                d[3] = (alpha * 255.0 + 0.5) as u8;
            }
        }
    };
    copy(&mut data, &a, false);
    copy(&mut data, &b, true);
    Ok(Raster {
        x: u.x0,
        y: u.y0,
        width: w as u32,
        height: h as u32,
        data,
    })
}

/// The fill pass of a box with a fill: the afterimages, the letters' fill
/// at Fill 100 % and the ink, without the outlines or a negative's blob.
/// With no fill, the fill it hides, all the same.
fn paint_fill(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
) -> Result<Option<Raster>, Error> {
    let job = &mut request.request.job;
    let bands = core::mem::take(&mut job.bands);
    let negative = job.effects.negative.take();
    let no_fill = core::mem::replace(&mut job.no_fill, false);
    let painted = job_raster(engine, &request.request, rasterizer, keep);
    let job = &mut request.request.job;
    job.bands = bands;
    job.effects.negative = negative;
    job.no_fill = no_fill;
    painted
}

/// The rim pass: the outlines outside the letters, and round the ink with
/// the ink cut out of them (the fill pass laid it). `None` with no outline
/// and no negative.
fn paint_rims(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
) -> Result<Option<Raster>, Error> {
    let job = &request.request.job;
    if job.bands.is_empty() && job.effects.negative.is_none() {
        return Ok(None);
    }
    let rims_of = |request: &mut BoxRequest, on: bool| {
        if let Some(ink) = request.request.ink.as_mut() {
            ink.rims = on;
        }
    };
    let no_fill = core::mem::replace(&mut request.request.job.no_fill, true);
    rims_of(request, true);
    let rims = job_raster(engine, &request.request, rasterizer, keep);
    rims_of(request, false);
    request.request.job.no_fill = no_fill;
    rims
}

/// The box's own content for This Layer, the fill pass and then the rim
/// pass, as a box with a fill gives them at Fill under 100 %. A box with no
/// fill goes through here too: user decision 2026-11-09, No Fill reads as
/// Fill 0 %. Photoshop judges a layer's pixels before Fill Opacity, so This
/// Layer sees the fill No Fill hides, whole, with the outlines, ink and
/// afterimages; what is painted does not change.
fn own_content(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
    t: &mut Content,
) -> Result<(), Error> {
    if let Some(r) = paint_fill(engine, request, rasterizer, keep)? {
        t.draw(&r);
    }
    if let Some(r) = paint_rims(engine, request, rasterizer, keep)? {
        t.draw(&r);
    }
    Ok(())
}

/// The afterimages alone, each in its own fill: no letters, no outlines, no
/// ink (`job.rs`: an afterimage is painted with its fill alone).
fn paint_ghosts(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
) -> Result<Option<Raster>, Error> {
    let job = &mut request.request.job;
    let runs = core::mem::take(&mut job.runs);
    job.runs = runs.iter().filter(|r| r.ghost).cloned().collect();
    let bands = core::mem::take(&mut job.bands);
    let negative = job.effects.negative.take();
    let silhouette = job.silhouette.take();
    let no_fill = core::mem::replace(&mut job.no_fill, false);
    let ink = request.request.ink.take();
    let painted = job_raster(engine, &request.request, rasterizer, keep);
    request.request.ink = ink;
    let job = &mut request.request.job;
    job.runs = runs;
    job.bands = bands;
    job.effects.negative = negative;
    job.silhouette = silhouette;
    job.no_fill = no_fill;
    painted
}

/// The box's own content for Blend If's This Layer, straight RGBA8 the
/// surface's size: each raster laid source-over in straight colour, so a
/// faint pixel keeps its colour whole, where premultiplied 8-bit would
/// round it away (130 at alpha 28 is stored as 14 and read back as 127.5).
struct Content {
    width: usize,
    height: usize,
    data: budget::Buffer<u8>,
}

impl Content {
    fn new(width: usize, height: usize) -> Result<Self, Error> {
        Ok(Self {
            width,
            height,
            data: budget::filled(width * height * 4, 0u8)?,
        })
    }

    /// Straight RGBA8 `r` laid source-over, cut to the surface.
    fn draw(&mut self, r: &Raster) {
        let rw = r.width as usize;
        for ry in 0..r.height as usize {
            let y = r.y.saturating_add(ry as i32);
            if y < 0 || y as usize >= self.height {
                continue;
            }
            for rx in 0..rw {
                let x = r.x.saturating_add(rx as i32);
                if x < 0 || x as usize >= self.width {
                    continue;
                }
                let sp = &r.data[(ry * rw + rx) * 4..][..4];
                if sp[3] == 0 {
                    continue;
                }
                let dp = &mut self.data[(y as usize * self.width + x as usize) * 4..][..4];
                if dp[3] == 0 || sp[3] == 255 {
                    dp.copy_from_slice(sp);
                    continue;
                }
                let sa = f32::from(sp[3]) / 255.0;
                let da = f32::from(dp[3]) / 255.0;
                let a = sa + da * (1.0 - sa);
                for c in 0..3 {
                    let v = (f32::from(sp[c]) * sa + f32::from(dp[c]) * da * (1.0 - sa)) / a;
                    dp[c] = (v + 0.5).min(255.0) as u8;
                }
                dp[3] = (a * 255.0 + 0.5).min(255.0) as u8;
            }
        }
    }
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
///
/// `painted` is that silhouette when a shadow has painted it already (not
/// grown, in an opaque colour): only its alpha is read, which is the same in
/// any opaque colour.
fn lay_glows(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    keep: Keep,
    s: &mut Surface,
    scale: f64,
    painted: Option<Raster>,
) -> Result<Option<IBox>, Error> {
    let black = Some(Rgba([0, 0, 0, 255]));
    let job_silhouette = request.request.job.silhouette;
    let outline = match painted {
        Some(r) => Some(r),
        None => {
            request.request.job.silhouette = black;
            let outline = job_raster(engine, &request.request, rasterizer, keep);
            request.request.job.silhouette = job_silhouette;
            outline?
        }
    };
    let Some(outline) = outline else {
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
    let shape = effects::alpha_map(&outline, region)?;
    drop(outline);
    let job = &request.request.job;
    let fill = if request.fill_opacity < 1.0 && !job.no_fill {
        let bands = core::mem::take(&mut request.request.job.bands);
        let negative = request.request.job.effects.negative.take();
        request.request.job.silhouette = black;
        let fill = job_raster(engine, &request.request, rasterizer, keep);
        request.request.job.silhouette = job_silhouette;
        request.request.job.bands = bands;
        request.request.job.effects.negative = negative;
        fill?.map(|r| effects::alpha_map(&r, region)).transpose()?
    } else {
        None
    };
    let page = request
        .backdrop
        .as_deref()
        .map(|pixels| Backdrop { pixels });
    // The silhouette and the fill are the job's; the region is theirs and
    // the reach of the outer effects, on this surface.
    let source = Hasher::new("glow shape")
        .maybe(keep.0)
        .debug(&region)
        .u64(u64::from(fill.is_some()))
        .finish();
    effects::lay_outer_glows_kept(
        s,
        &request.effects,
        &shape,
        fill.as_ref(),
        request.fill_opacity,
        region,
        scale,
        page.as_ref(),
        request.grain,
        source,
    )
}

fn paint(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
    sweeps: bool,
    keep: Keep,
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
    // The brush ink, laid once for every pass below, with room round it for
    // the widest outline and the most a shadow grows it.
    if request.request.ink.is_some() {
        let outer = request
            .request
            .job
            .bands
            .first()
            .map_or(0.0, |b| (b.line / 2.0).max(0.0));
        let grow = request.shadows.iter().map(|s| s.grow).fold(0.0, f64::max);
        // Bent and roughened by the job's mesh and field, as the letters.
        let req = &mut request.request;
        if let Some(ink) = req.ink.as_mut() {
            ink.prepare(&transform, &req.job, surface, outer + grow, rasterizer)?;
        }
    }
    // Lengths are carried by the scale that keeps areas, vectors by the
    // transform's linear part.
    let scale = transform.det().abs().sqrt();
    let carried = |x: f64, y: f64| {
        let m = &transform.0;
        (m[0] * x + m[2] * y, m[1] * x + m[3] * y)
    };
    // Where a shadow lands, device pixels: whole pixels for a Photoshop Drop
    // Shadow, the exact throw for an SFX copy.
    let thrown = |sh: &Shadow| {
        if sh.exact {
            carried(sh.x, sh.y)
        } else {
            effects::whole_throw(sh.x, sh.y, carried)
        }
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
    // Channels and Blend If, over a page only (`Blending::restricts`).
    let restricts = request.blending.restricts() && request.backdrop.is_some();
    if shadows.clone().next().is_none()
        && !positive(blur_sigma)
        && taps.is_empty()
        && request.clip.is_none()
        && request.fade.is_none()
        && request.fill_opacity >= 1.0
        && !blends
        && !restricts
        && !request.effects.iter().any(Effect::shows)
    {
        // Nothing but glyphs: the glyph job, and its own raster.
        return match job_raster(engine, &request.request, rasterizer, keep)? {
            Some(r) => cut(r, surface),
            None => Ok(None),
        };
    }
    if !scale.is_finite() || !positive(scale) {
        return Ok(None);
    }

    // The surface before the mask, as the last paint of everything but the
    // mask left it (`Keep`'s second key): a box with a mask kept to the
    // page repaints as it is moved, and a move changes only where the mask
    // falls, so a hit costs one shape raster and one multiply.
    type Premask = (Vec<u8>, Option<IBox>);
    let premask_kept = keep
        .1
        .and_then(kept::get::<Premask>)
        .filter(|u| u.0.len() == width * height * 4);
    let (mut s, laid) = if let Some(u) = premask_kept {
        let mut s = Surface::new(width, height)?;
        s.data.copy_from_slice(&u.0);
        (s, u.1)
    } else {
        let mut s = Surface::new(width, height)?;
        // Where anything has been laid on the surface, so that finding what of
        // it has ink reads only that.
        let mut laid: Option<IBox> = None;
        let join = |laid: &mut Option<IBox>, b: IBox| *laid = Some(laid.map_or(b, |l| l.union(&b)));
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
        // The letters' silhouette as a shadow painted it, kept for the outer
        // glows when it is theirs too: not grown, and in an opaque colour, whose
        // alpha is what black's would be. `Some(None)`: painted, and nothing.
        let glows = request
            .effects
            .iter()
            .any(|e| matches!(e, Effect::OuterGlow(_)) && e.shows());
        let mut silhouette: Option<Option<Raster>> = None;
        // The surface with the shadows and the glows on it, as the last paint
        // of the same ones left it (`super::kept`).
        type Under = (Vec<u8>, Option<IBox>);
        let page_key = match (&request.backdrop, keep.0) {
            (Some(page), Some(_)) if !order.is_empty() || glows => {
                Hasher::new("page").bytes(page).finish()
            }
            _ => None,
        };
        // With the shadows on it, and with the glows on it too. With no glow the
        // first is all of it, and with no shadow the second is.
        let shadows_key = keep.shadows(request, &order, see_through, page_key);
        let glows_key = keep.glows(request, shadows_key, glows, scale, page_key);
        let fits = |u: &std::rc::Rc<Under>| u.0.len() == width * height * 4;
        let under_kept = glows_key.or(shadows_key).and_then(kept::get::<Under>).filter(fits);
        // Short of that, with the shadows alone: the glows are laid again.
        let shadows_kept = match (&under_kept, glows) {
            (None, true) => shadows_key.and_then(kept::get::<Under>).filter(fits),
            _ => None,
        };
        if let Some(u) = under_kept.as_ref().or(shadows_kept.as_ref()) {
            s.data.copy_from_slice(&u.0);
            laid = u.1;
        }
        let shadows_laid = under_kept.is_some() || shadows_kept.is_some();
        let mut i = if shadows_laid { order.len() } else { 0 };
        while let Some(sh) = order.get(i).copied() {
            if sh.styled(see_through > 0.0) {
                let knock = if sh.knockout { see_through } else { 0.0 };
                if let Some(b) = lay_styled(
                    engine,
                    request,
                    rasterizer,
                    keep,
                    &sh,
                    &mut s,
                    scale,
                    thrown(&sh),
                    knock,
                    &mut acc,
                )? {
                    join(&mut laid, b);
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
                let kept_as = keep.layer(&request.request, sh.size, width, height);
                // The layer as a paint before this one blurred it, and where
                // the silhouette it was blurred from stood.
                type Layer = (Vec<u8>, Option<IBox>);
                let layer_kept = kept_as
                    .and_then(kept::get::<Layer>)
                    .filter(|l| l.0.len() == width * height * 4);
                let painted = match &layer_kept {
                    Some(_) => Ok(None),
                    None => job_raster(engine, &request.request, rasterizer, keep),
                };
                request.request.job.silhouette = job_silhouette;
                request.request.job.effects.grow = job_grow;
                let layer = match &mut layer {
                    Some(l) => {
                        l.clear();
                        l
                    }
                    none => none.insert(Surface::new(width, height)?),
                };
                if let Some(kept_layer) = &layer_kept {
                    layer.data.copy_from_slice(&kept_layer.0);
                    if let Some(at) = kept_layer.1 {
                        let reach = super::fx::tent::reach(super::fx::tent_width(sh.size, scale));
                        let drawn = IBox {
                            x0: at.x0.saturating_sub(reach),
                            y0: at.y0.saturating_sub(reach),
                            x1: at.x1.saturating_add(reach),
                            y1: at.y1.saturating_add(reach),
                        };
                        ink = layer.ink_in(drawn);
                        let again = order.get(i + 1).is_some_and(|n| layer_key(n) == key);
                        if let (Some(ink), true) = (ink, sweeps && again) {
                            runs = Some(sweep::Runs::new(layer, ink)?);
                        }
                    }
                }
                let painted = painted?;
                let shared = glows
                    && silhouette.is_none()
                    && sh.color.0[3] == 255
                    && sh.grow.to_bits() == job_grow.to_bits();
                if shared && painted.is_none() && layer_kept.is_none() {
                    silhouette = Some(None);
                }
                if let Some(r) = painted {
                    layer.draw(&r.data, r.width as usize, r.x, r.y);
                    // A silhouette is one colour, so only its alpha needs the blur.
                    let [red, green, blue, _] = sh.color.0;
                    let width = super::fx::tent_width(sh.size, scale);
                    blur::tent_flat(layer, width, [red, green, blue])?;
                    if let (Some(key), Some(data)) = (kept_as, kept::copy(&layer.data)) {
                        let at = IBox {
                            x0: r.x,
                            y0: r.y,
                            x1: r.x.saturating_add(r.width as i32),
                            y1: r.y.saturating_add(r.height as i32),
                        };
                        kept::put(key, (data, Some(at)), layer.data.len());
                    }
                    // The ink is the raster's, and as far round it as the blur
                    // spread it.
                    let reach = super::fx::tent::reach(width);
                    let drawn = IBox {
                        x0: r.x.saturating_sub(reach),
                        y0: r.y.saturating_sub(reach),
                        x1: r.x.saturating_add(r.width as i32).saturating_add(reach),
                        y1: r.y.saturating_add(r.height as i32).saturating_add(reach),
                    };
                    if shared {
                        silhouette = Some(Some(r));
                    } else {
                        drop(r);
                    }
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
                join(&mut laid, landed(ink, thrown(n)));
            }
            match &runs {
                Some(runs) if end - i >= 2 => {
                    moves.clear();
                    for n in &order[i..end] {
                        budget::push(&mut moves, thrown(n))?;
                    }
                    sweep::over_swept(&mut s, layer, ink, runs, &moves)?;
                }
                // A faded copy, as a shake's are: along the rows' runs.
                Some(runs) => {
                    sweep::over_runs(&mut s, layer, ink, runs, thrown(&sh), sh.opacity, &mut acc);
                }
                None => blur::over_moved_in(&mut s, layer, ink, thrown(&sh), sh.opacity, &mut acc),
            }
            i = end;
        }
        drop(layer);
        let keep_under = |key: Option<kept::Key>, s: &Surface, laid: Option<IBox>| {
            if let Some(key) = key {
                if let Some(data) = kept::copy(&s.data) {
                    kept::put(key, (data, laid), s.data.len());
                }
            }
        };
        if !shadows_laid {
            keep_under(shadows_key, &s, laid);
        }
        drop(shadows_kept);
        if glows && under_kept.is_none() {
            let glow = match silhouette {
                // A shadow painted it and it was nothing: no glow either.
                Some(None) => None,
                Some(painted) => lay_glows(engine, request, rasterizer, keep, &mut s, scale, painted)?,
                None => lay_glows(engine, request, rasterizer, keep, &mut s, scale, None)?,
            };
            if let Some(b) = glow {
                join(&mut laid, b);
            }
        }
        if under_kept.is_none() {
            keep_under(glows_key, &s, laid);
        }
        drop(under_kept);

        // Over a page, one of the special eight takes Fill into its blend, and
        // with Transparency Shapes Layer off the letters' own transparency too
        // (`blend::lay_fill_shapeless`): their anti-aliased edges and any
        // see-through colour, also at a whole Fill.
        let special = blends
            && request.backdrop.is_some()
            && request.blend.fill_is_special()
            && (request.fill_opacity < 1.0 || request.blending.shapeless);
        // The box's own content alone, for Blend If's This Layer: its fill and
        // outlines before any effect, not the shadows, glows or strokes round
        // it (PhotoCraft judges a layer by its own content, `render_content`).
        // The fill is there at its whole Fill, and a No Fill box's hidden fill
        // is there too, whole (user decision 2026-11-09, No Fill reads as Fill
        // 0 %): Photoshop judges a layer's pixels before Fill Opacity.
        let mut this = if restricts && !request.blending.blend_if.this_is_full() {
            Some(Content::new(width, height)?)
        } else {
            None
        };
        let Glyphs {
            rasters: glyphs,
            whole_fill,
            outside,
            bevels,
        } = paint_glyphs(
            engine, request, rasterizer, keep, carried, scale, special, &mut this,
        )?;
        let page = request
            .backdrop
            .as_deref()
            .map(|pixels| Backdrop { pixels });
        // The strokes' outside parts, then an Outer Bevel, under the letters:
        // each in its own mode over what is under the box, the page too.
        // PhotoCraft (`composite_with_effects_prepared`) paints them on the
        // backdrop before the layer goes on; only the letters take the box's
        // mode.
        if let Some(o) = outside {
            let place = Place {
                transform,
                tiles: &request.request.tiles,
                grain: request.grain,
                page: request.page,
            };
            effects::lay_outside(&mut s, &o, &request.effects, &place, page.as_ref())?;
            let b = o.bounds().intersect(&surface);
            if !b.is_empty() {
                join(&mut laid, b);
            }
        }
        if let Some(bv) = &bevels {
            if let Some(b) = effects::lay_bevels(&mut s, bv, &request.effects, false, page.as_ref())? {
                join(&mut laid, b);
            }
        }
        let mut own = if blends {
            Some(Surface::new(width, height)?)
        } else {
            None
        };
        // A special-eight fill: at its whole Fill in its mode, with Fill in the
        // blend; the outlines go over it below, at Fill 1.
        if let (Some(fill), Some(own)) = (&whole_fill, own.as_mut()) {
            own.draw(&fill.data, fill.width as usize, fill.x, fill.y);
            let bx = IBox {
                x0: fill.x,
                y0: fill.y,
                x1: fill.x.saturating_add(fill.width as i32),
                y1: fill.y.saturating_add(fill.height as i32),
            };
            let lay_fill = if request.blending.shapeless {
                blend::lay_fill_shapeless
            } else {
                blend::lay_fill_from
            };
            lay_fill(
                &mut s,
                own,
                bx,
                1.0,
                request.blend,
                page.as_ref(),
                0,
                request.fill_opacity as f32,
                request.grain,
            );
            own.clear();
            join(&mut laid, bx);
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
            join(&mut laid, bx);
        }
        drop(glyphs);
        if let (Some(own), Some(bx)) = (&own, laid) {
            blend::lay_from(
                &mut s,
                own,
                bx,
                1.0,
                request.blend,
                page.as_ref(),
                0,
                request.grain,
            );
        }
        drop(own);
        // An Emboss, a Pillow Emboss or a Stroke Emboss, over the finished
        // letters: PhotoCraft shades the composited layer with them.
        if let Some(bv) = &bevels {
            if let Some(b) = effects::lay_bevels(&mut s, bv, &request.effects, true, page.as_ref())? {
                laid = Some(laid.map_or(b, |l| l.union(&b)));
            }
        }
        drop(bevels);
        // Channels, then Blend If, on the whole box, effects and all, at its
        // blend onto the page: before the whole-box blur, the smear and the
        // mask, which Photoshop would do to the layer's pixels (a filter, a
        // mask) and not to its blend.
        if let (true, Some(page), Some(bx)) = (restricts, request.backdrop.as_deref(), laid) {
            let this = this.as_ref().map(|t| t.data.as_slice());
            blending::restrict(&mut s, bx, &request.blending, page, this);
        }
        drop(this);
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
        if let Some(k) = keep.1 {
            if let Some(data) = kept::copy(&s.data) {
                let n = data.len();
                kept::put(k, (data, laid), n);
            }
        }
        (s, laid)
    };
    if let Some(clip) = &request.clip {
        // Inside the keep shapes, when there are any: shapes that cover
        // nothing of the surface keep nothing.
        if clip.shapes.iter().any(|p| p.mode == ClipMode::Include) {
            let keep = clip_mask(clip, ClipMode::Include, &request.request, surface, rasterizer)?;
            match keep {
                Some((mask, bx)) => blur::mask(&mut s, &mask, bx, false),
                None => s.clear(),
            }
        }
        // Less the hide shapes.
        let hide = clip_mask(clip, ClipMode::Exclude, &request.request, surface, rasterizer)?;
        if let Some((mask, bx)) = hide {
            blur::mask(&mut s, &mask, bx, true);
        }
    }
    // Then the fade, from the same surface: shadows and glows fade with the
    // letters, as they are laid on them by now.
    if let Some(fade) = &request.fade {
        lay_fade(&mut s, fade, &request.request, scale, request.grain, rasterizer)?;
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
