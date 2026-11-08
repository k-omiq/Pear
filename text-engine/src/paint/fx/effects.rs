//! The layer effects past the drop shadow: Outer Glow, Inner Glow, Inner
//! Shadow and Color Overlay, and how each is laid.
//!
//! The order is Photoshop's, as PhotoCraft composites it
//! (`crates/compose/src/effects/composite.rs`): behind the letters the drop
//! shadows, then the outer glows; on the letters their fill at Fill Opacity,
//! then the colour overlays, the inner glows and the inner shadows, laid
//! inside the letters at full strength and then cut to the letters' own
//! alpha; then the outlines.
//!
//! An interior effect is painted relative to the letters' shape: it is laid
//! over the fill as if every covered pixel were whole, and the pixel's
//! coverage applies after, so an overlay at 100 % recolours a half-covered
//! edge without adding to it. At Fill Opacity 0 the effects still show.
//!
//! Copyright (c) 2026 ArtCraft Team and the PhotoCraft contributors for the
//! order and the compositing it follows, MIT licence (see `THIRD_PARTY.md`).

use super::super::blur::Surface;
use super::super::geom::IBox;
use super::super::job::Rgba;
use super::super::Raster;
use super::blend::{self, Backdrop, Blend};
use super::contour::Lut;
pub use super::map::Technique;
use super::map::{self, Map, Soft};
use crate::Error;

/// Outer Glow or Inner Glow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glow {
    pub color: Rgba,
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

/// One layer effect of a box past its drop shadows. Each kind may come more
/// than once; of a kind, the first listed is on top.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Effect {
    OuterGlow(Glow),
    InnerGlow(Glow),
    InnerShadow(InnerShadow),
    ColorOverlay(Overlay),
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

/// Lays `color` through map `m`, whose corner is `at` on `dst`, at
/// `opacity` in `mode`. Hands back where it can have laid ink.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lay_map(
    dst: &mut Surface,
    m: &Map,
    at: (i32, i32),
    color: Rgba,
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
    // The colour through the map, premultiplied, on a surface of `dst`'s
    // size: only `bx` is written or read.
    let mut src = Surface::new(dst.width, dst.height)?;
    for y in bx.y0..bx.y1 {
        for x in bx.x0..bx.x1 {
            let v = m.v[(y - at.1) as usize * m.w + (x - at.0) as usize];
            let a = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
            let p = &mut src.data[(y as usize * dst.width + x as usize) * 4..][..4];
            for c in 0..3 {
                p[c] = ((u32::from(color.0[c]) * a + 127) / 255) as u8;
            }
            p[3] = a as u8;
        }
    }
    blend::lay(dst, &src, bx, opacity as f32, mode, page, seed);
    Ok(Some(bx))
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
        if let Some(b) = lay_map(
            dst,
            &m,
            (region.x0, region.y0),
            g.color,
            g.opacity,
            g.blend,
            page,
            g.seed,
        )? {
            laid = Some(laid.map_or(b, |l| l.union(&b)));
        }
    }
    Ok(laid)
}

/// How far past the letters the outer glows reach, device pixels: a Size
/// moves the edge `size + 1` at most (Precise), with a pixel spare.
pub(crate) fn outer_reach(effects: &[Effect], scale: f64) -> i32 {
    let size = effects
        .iter()
        .filter_map(|e| match e {
            Effect::OuterGlow(g) if e.shows() => Some(g.size * scale),
            _ => None,
        })
        .fold(0.0, f64::max);
    (size.min(4096.0).ceil() as i32) + 3
}

/// The fill raster `r` with the interior effects laid on it at Fill Opacity
/// `fill_opacity`. `carried` turns a job-unit throw into device pixels;
/// `scale` is device pixels to a job unit.
pub(crate) fn interior(
    r: &Raster,
    effects: &[Effect],
    fill_opacity: f64,
    scale: f64,
    carried: impl Fn(f64, f64) -> (f64, f64),
) -> Result<Raster, Error> {
    // Room round the letters for a soft edge to come in from outside them.
    let mut pad = 2.0f64;
    for e in effects {
        pad = pad.max(match e {
            Effect::InnerGlow(g) => g.size * scale + 2.0,
            Effect::InnerShadow(s) => {
                let (dx, dy) = carried(s.x, s.y);
                s.size * scale + dx.abs().max(dy.abs()) + 2.0
            }
            _ => 0.0,
        });
    }
    let pad = pad.ceil().min(4096.0) as usize;
    let (rw, rh) = (r.width as usize, r.height as usize);
    let (w, h) = (rw + 2 * pad, rh + 2 * pad);
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
    for e in shown() {
        if let Effect::ColorOverlay(o) = e {
            lay_map(
                &mut lay,
                &full,
                (0, 0),
                o.color,
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
            lay_map(
                &mut lay,
                &m,
                (0, 0),
                g.color,
                g.opacity,
                g.blend,
                None,
                g.seed,
            )?;
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
            lay_map(
                &mut lay,
                &m,
                (0, 0),
                sh.color,
                sh.opacity,
                sh.blend,
                None,
                sh.seed,
            )?;
        }
    }
    // The shape's own alpha, and back to straight colour.
    let mut data = vec![0u8; w * h * 4];
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
    }
    Ok(Raster {
        x: r.x - pad as i32,
        y: r.y - pad as i32,
        width: w as u32,
        height: h as u32,
        data,
    })
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
        let out = interior(&square(8), &[o], 1.0, 1.0, |x, y| (x, y)).unwrap();
        assert_eq!(at(&out, 13, 13), [0, 0, 255, 255]);
        // At Fill Opacity 0 the overlay still shows; nothing outside the fill.
        let out = interior(&square(8), &[o], 0.0, 1.0, |x, y| (x, y)).unwrap();
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
        let out = interior(&square(12), &[s], 1.0, 1.0, |x, y| (x, y)).unwrap();
        // Top-left inside edge in shadow, bottom-right red.
        assert_eq!(at(&out, 10, 10), [0, 0, 0, 255]);
        assert_eq!(at(&out, 21, 21), [255, 0, 0, 255]);
    }
}
