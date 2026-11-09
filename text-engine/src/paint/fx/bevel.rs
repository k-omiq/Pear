//! Bevel & Emboss: a height map raised from the letters' shape, lit from
//! the Angle and Altitude, split into a highlight and a shadow.
//!
//! ```text
//! height   Smooth: the shape through a tent of the bevel's width.
//!          Chisel: straight ramps of the distance to the edge, the edge
//!          placed by its anti-aliased pixels (`edges.rs`).
//!          Then the Contour (a float table), the Texture, and Soften.
//! shading  the height's slope, times depth, as a normal; n . light, through
//!          the Gloss Contour, above a flat face's sin(altitude) is the
//!          highlight, below it the shadow.
//! where    Inner: inside the shape. Outer: outside it. Emboss and Pillow:
//!          both, half the size each side (Pillow's outside faces the other
//!          way). Stroke Emboss: the Photoshop Stroke's band (`effects.rs`).
//! ```
//!
//! Ported from PhotoCraft, `crates/compose/src/effects/bevel.rs`
//! (`BevelPaint`, `BEVEL_H_EPS`, `BevelGeom`, `bevel_geom`, `bevel_height`,
//! `bevel_chisel_h`, `bevel_maps`) and `effects/paint.rs`
//! (`bevel_contour_lut`, `lut_at`), Copyright (c) 2026 ArtCraft Team and the
//! PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`). PhotoCraft
//! measured them against Photoshop 27.11 renders; the measurements are kept
//! in the comments. Changed: one thread; lengths in device pixels; the light
//! handed in already turned with the box; the texture sampled through the
//! box's own pattern fill; an outer or emboss texture kept to the bevel's
//! own extent.

use super::contour::Table;
use super::edges::bevel_dists;
use super::map::{blur, Map, INSIDE_EPS};
use crate::Error;

/// Photoshop's bevel Style.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BevelStyle {
    Inner,
    Outer,
    Emboss,
    Pillow,
    /// Embosses the Photoshop Stroke effect's band (ours; PhotoCraft has
    /// none, see `effects.rs`).
    StrokeEmboss,
}

impl BevelStyle {
    pub fn from_u32(n: u32) -> Option<Self> {
        use BevelStyle::*;
        [Inner, Outer, Emboss, Pillow, StrokeEmboss]
            .get(n as usize)
            .copied()
    }

    /// Emboss or Pillow: half the size each side of the edge.
    pub fn emboss(self) -> bool {
        matches!(self, BevelStyle::Emboss | BevelStyle::Pillow)
    }
}

/// Photoshop's bevel Technique.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BevelTechnique {
    Smooth,
    ChiselHard,
    ChiselSoft,
}

impl BevelTechnique {
    pub fn from_u32(n: u32) -> Option<Self> {
        use BevelTechnique::*;
        [Smooth, ChiselHard, ChiselSoft].get(n as usize).copied()
    }
}

/// Where a bevel's maps paint: inside the shape (with the letters), outside
/// it (under them), or both (emboss styles, over the finished letters).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    Inner,
    Outer,
    Both,
}

/// Height below which an outer bevel pixel counts as off the bevel (beyond
/// the blur's reach): above float noise of the running-sum blur (~3e-7),
/// far below anything that shades.
pub(crate) const BEVEL_H_EPS: f32 = 1e-5;

/// Bevel geometry (PhotoCraft `BevelGeom`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Geom {
    pub paint: Reach,
    /// Box width of the smooth height blur (size; half the size, rounded up,
    /// for emboss styles), device pixels.
    pub width: f32,
    /// Height-map gradient scale: depth x width (smooth) or depth x size / 2
    /// (chisel), signed by direction.
    pub depth: f32,
    /// Pillow emboss: the outside slopes face the other way.
    pub pillow: bool,
    /// Chisel Soft: extra tent width over the chiselled height map.
    pub chisel_soft: f32,
}

/// The geometry of a bevel of `size` device pixels (PhotoCraft
/// `bevel_geom`). Size 0 is drawn as 1, as PhotoCraft does.
pub(crate) fn geom(
    style: BevelStyle,
    technique: BevelTechnique,
    depth: f32,
    up: bool,
    size: f32,
) -> Geom {
    let size = if size.is_nan() { 1.0 } else { size.max(1.0) };
    let emboss = style.emboss();
    let paint = match style {
        BevelStyle::Outer => Reach::Outer,
        BevelStyle::Emboss | BevelStyle::Pillow => Reach::Both,
        BevelStyle::Inner | BevelStyle::StrokeEmboss => Reach::Inner,
    };
    // Emboss styles straddle the edge with half the size, rounded up to
    // whole pixels: a 41 px emboss blurs over 21 (psd-tools layer_effects:
    // 20.5 left narrow letter parts up to 5.7/255 dark, 21 is within 2.2).
    let width = if emboss { (size / 2.0).ceil() } else { size };
    let smooth = technique == BevelTechnique::Smooth;
    let sign = if up { 1.0 } else { -1.0 };
    Geom {
        paint,
        width,
        // A bevel rises `depth x width / 2` px: Smooth with a slope falling
        // from `depth` at the edge (the tent), a chisel with the constant
        // slope of its ramp (see `chisel_h`).
        depth: depth * if smooth { width } else { size / 2.0 } * sign,
        pillow: style == BevelStyle::Pillow,
        chisel_soft: if technique == BevelTechnique::ChiselSoft {
            (size / 4.0).max(1.0)
        } else {
            0.0
        },
    }
}

/// The bevel's Texture: a pattern's luminance as extra height.
pub(crate) struct Texture<'a> {
    /// Texture Depth, -10 to 10 (1 is 100 %; negative carves).
    pub depth: f32,
    pub invert: bool,
    /// The pattern's luminance times its alpha at map pixel `(x, y)`, 0 to 1:
    /// `(0.299 r + 0.587 g + 0.114 b) a` at the pixel's centre.
    pub lum: &'a dyn Fn(usize, usize) -> f32,
}

/// One bevel, in device pixels, as the maps need it.
pub(crate) struct Shading<'a> {
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    /// Depth, 1 is 100 %.
    pub depth: f32,
    pub up: bool,
    /// Size and Soften, device pixels.
    pub size: f32,
    pub soften: f32,
    /// The unit vector towards the light, y down: `(cos a cos e, -sin a cos
    /// e, sin e)` for Angle `a` and Altitude `e`, its flat part turned with
    /// the box.
    pub light: [f32; 3],
    /// Gloss Contour; `None` is Linear.
    pub gloss: Option<&'a Table>,
    /// The Contour element on the height; `None` is off. Ticked, Linear is
    /// a table too, which clamps the height to 0 to 1 (PhotoCraft
    /// `bevel_contour_lut` bakes the identity and `lut_at` clamps). Its Range
    /// is not applied (PhotoCraft `bevel_contour_lut`: a `v / range` stretch
    /// halved a real Linear bevel, and what Range does is still open).
    pub contour: Option<&'a Table>,
    pub texture: Option<Texture<'a>>,
    /// Device pixels to a job unit: the texture's slope is measured per job
    /// unit, so its relief is the same at every zoom (review F23).
    pub scale: f32,
}

/// Chiselled height from the inside / outside distances (PhotoCraft
/// `bevel_chisel_h`).
///
/// Photoshop 27.11, measured across straight edges (sizes 10 and 20, depth
/// 100 and 300): a chisel facet has the constant slope `depth x size / (2
/// (size + 1))`, i.e. one height step of `1 / (size + 1)` per pixel at the
/// `depth x size / 2` scale of [`geom`]. Inner Hard's ramp runs from half a
/// pixel beyond the edge to `size + 1/2` (the facet is flat right up to the
/// edge pixel); Inner Soft starts a pixel further out, so its edge pixel is
/// steeper; Outer Hard ends a pixel further out. All within 1 level of
/// Photoshop on those profiles.
pub(crate) fn chisel_h(paint: Reach, size: f32, din: f32, dout: f32, soft: bool) -> f32 {
    let ramp = size + 1.0;
    match paint {
        Reach::Outer if !soft => {
            let top = (size + 2.0) / ramp;
            if dout > 0.0 {
                ((size + 1.5 - dout) / ramp).clamp(0.0, top)
            } else {
                top
            }
        }
        // Outer Soft: Outer Hard's ramp a pixel shorter, with a steeper edge
        // pixel.
        Reach::Outer => {
            if dout > 0.0 {
                1.0 - ((dout + 0.5) / ramp).clamp(0.0, 1.0)
            } else {
                (size + 2.0) / ramp
            }
        }
        Reach::Both => {
            let half = size / 2.0 + 0.5;
            if din > 0.0 {
                0.5 + 0.5 * (din / half).clamp(0.0, 1.0)
            } else {
                0.5 - 0.5 * (dout / half).clamp(0.0, 1.0)
            }
        }
        Reach::Inner if soft => {
            if din > 0.0 {
                ((din + 1.5) / ramp).clamp(0.0, (size + 2.0) / ramp)
            } else {
                0.0
            }
        }
        Reach::Inner => {
            if din > 0.0 {
                ((din + 0.5) / ramp).clamp(0.0, 1.0)
            } else {
                0.0
            }
        }
    }
}

/// The bevel height map in `0..=1` (PhotoCraft `bevel_height`), and, when a
/// contour or a texture reshapes it, the height before either (softened
/// alike): the bevel's own extent, which keeps an outer or emboss bevel
/// from shading every pixel of the map. A texture raises the height
/// everywhere, and a contour that does not start at 0 (Cone - Inverted,
/// Cove - Deep) lifts the flat ground round the bevel, whose step down to
/// the 0 read off the map's edge once shaded as a 1 px frame there (review
/// F8). Smooth: the shape blurred by two box passes of the bevel width.
/// Chisel: linear ramps of the distance to the edge (size wide; emboss
/// styles straddle the edge), slightly blurred for Chisel Soft emboss. Then
/// the Contour, the Texture, and Soften over both.
fn height(shape: &Map, s: &Shading<'_>, g: &Geom) -> Result<(Map, Option<Map>), Error> {
    let size = if s.size.is_nan() {
        1.0
    } else {
        s.size.max(1.0)
    };
    let mut h = if s.technique == BevelTechnique::Smooth {
        let mut h = shape.try_clone()?;
        blur(&mut h, g.width)?;
        h
    } else {
        let [din, dout] = bevel_dists(shape, size);
        let soft = g.chisel_soft > 0.0;
        let v = din
            .iter()
            .zip(&dout)
            .map(|(&i, &o)| chisel_h(g.paint, size, i, o, soft));
        let mut h = Map::collect(shape.w, shape.h, v)?;
        // Inner and outer Chisel Soft are not blurred in Photoshop (their
        // facets equal Chisel Hard's across a straight edge); emboss styles
        // keep the blur until measured.
        if soft && g.paint == Reach::Both {
            blur(&mut h, g.chisel_soft)?;
        }
        h
    };
    // An inner bevel is kept to the shape: it needs no extent.
    let mut own = if g.paint != Reach::Inner && (s.contour.is_some() || s.texture.is_some()) {
        Some(h.try_clone()?)
    } else {
        None
    };
    // Contour element: the height profile through the contour.
    if let Some(t) = s.contour {
        h = h.map(|v| t.at(v));
    }
    // Texture element: the pattern's luminance as extra height, scaled so a
    // full-contrast step at 100 % depth slopes like the bevel at its depth
    // (unmeasured by PhotoCraft). The pattern is laid in job units, so a
    // step of it spans `scale` device pixels: its slope is taken per job
    // unit, or a zoom of 2 would halve the relief (review F23).
    if let Some(t) = &s.texture {
        let unit = if s.depth.abs() > 1e-6 {
            (g.depth / s.depth).abs().max(1e-3)
        } else {
            g.width.max(1.0)
        };
        let per_unit = if s.scale.is_finite() && s.scale > 0.0 {
            s.scale
        } else {
            1.0
        };
        let k = t.depth * per_unit / unit;
        for y in 0..h.h {
            for x in 0..h.w {
                let l = (t.lum)(x, y);
                h.v[y * h.w + x] += k * if t.invert { 1.0 - l } else { l };
            }
        }
    }
    if s.soften >= 1.0 {
        blur(&mut h, s.soften)?;
        if let Some(o) = &mut own {
            blur(o, s.soften)?;
        }
    }
    Ok((h, own))
}

/// A bevel's highlight and shadow maps over `shape`, and where they paint
/// (PhotoCraft `bevel_maps`). Inner maps are the shape's coverage times the
/// light (read them relative to the shape to lay them inside it); outer and
/// emboss maps are laid as they are.
pub(crate) fn try_maps(shape: &Map, s: &Shading<'_>) -> Result<(Map, Map, Reach), Error> {
    let g = geom(s.style, s.technique, s.depth, s.up, s.size);
    let (hmap, own) = height(shape, s, &g)?;
    let bevel = own.as_ref().unwrap_or(&hmap);
    let light = s.light;
    let se = light[2];
    // A pixel is on the bevel where its height is raised. Emboss styles also
    // shade the last pixel past the blur's reach (a raised 4-neighbour: it
    // still slopes; psd-tools layer_effects' emboss shadow runs one row past
    // it), outer bevels don't (Photoshop oracle bevel-outer-smooth). Outer
    // chisel bevels too: the pixel where their ramp reaches zero still
    // slopes (Photoshop 27.11 shades it, half strength, at `size + 1 1/2` px
    // out).
    let reach_past = g.paint == Reach::Both
        || (g.paint == Reach::Outer && s.technique != BevelTechnique::Smooth);
    let on_bevel = |x: i64, y: i64| {
        bevel.get(x, y) > BEVEL_H_EPS
            || (reach_past
                && [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .iter()
                    .any(|(dx, dy)| bevel.get(x + dx, y + dy) > BEVEL_H_EPS))
    };
    // The gloss contour remaps the shading `n . light` before it splits into
    // highlight (above what it maps a flat face's `sin(altitude)` to) and
    // shadow. Applied to the highlight and shadow amounts instead, a contour
    // that starts high (Rolling Slope - Descending) lit every pixel the light
    // missed, so a bevelled glyph's flat face took the full highlight
    // (PhotoCraft #7360) where Photoshop leaves it at the layer's colour. The
    // Linear contour changes nothing either way.
    let gloss = s.gloss;
    let flat = gloss.map_or(se, |l| l.at(se));
    let (hi_scale, sh_scale) = ((1.0 - se).max(1e-3), se.max(1e-3));
    // Region: inside (times the shape's alpha), or under the layer's edge
    // and outside.
    let shade_into = |depth: f32, outside: bool| -> Result<(Map, Map), Error> {
        let (w, h) = (shape.w, shape.h);
        let (mut hi, mut sh) = (Map::filled(w, h, 0.0)?, Map::filled(w, h, 0.0)?);
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                let i = y as usize * w + x as usize;
                let region = if outside {
                    if shape.v[i] < 1.0 - INSIDE_EPS && on_bevel(x, y) {
                        1.0
                    } else {
                        0.0
                    }
                } else {
                    shape.v[i]
                };
                // Nothing to shade (a NaN coverage shades nothing either).
                if region.is_nan() || region <= 0.0 {
                    continue;
                }
                let gx = (hmap.get(x + 1, y) - hmap.get(x - 1, y)) * 0.5 * depth;
                let gy = (hmap.get(x, y + 1) - hmap.get(x, y - 1)) * 0.5 * depth;
                let len = (gx * gx + gy * gy + 1.0).sqrt();
                let shade = (-gx * light[0] - gy * light[1] + light[2]) / len;
                let k = gloss.map_or(shade - se, |l| l.at(shade) - flat);
                if k > 0.0 {
                    hi.v[i] = (k / hi_scale).clamp(0.0, 1.0) * region;
                } else {
                    sh.v[i] = (-k / sh_scale).clamp(0.0, 1.0) * region;
                }
            }
        }
        Ok((hi, sh))
    };
    let (hi, sh) = match g.paint {
        Reach::Inner | Reach::Outer => shade_into(g.depth, g.paint == Reach::Outer)?,
        Reach::Both => {
            // One map per colour over the whole bevel: the inside half where
            // the shape is (times its alpha), the outside half (pillow:
            // facing the other way) for the rest of each pixel. A 1 % edge
            // pixel of a pillow emboss takes the outside shading (Photoshop
            // oracle bevel-pillow-smooth), a 75 % one of an emboss mostly the
            // inside (layer_effects).
            let (hi, sh) = shade_into(g.depth, false)?;
            let (ho, so) = shade_into(if g.pillow { -g.depth } else { g.depth }, true)?;
            // Into the inside map: each value is read once, then written.
            let mix = |mut a: Map, b: Map| -> Map {
                for ((x, &y), &s) in a.v.iter_mut().zip(b.v.iter()).zip(shape.v.iter()) {
                    *x = (if s > INSIDE_EPS { *x } else { 0.0 }) + y * (1.0 - s.min(1.0));
                }
                a
            };
            (mix(hi, ho), mix(sh, so))
        }
    };
    Ok((hi, sh, g.paint))
}

/// [`try_maps`], for the tests.
#[cfg(test)]
pub(crate) fn maps(shape: &Map, s: &Shading<'_>) -> (Map, Map, Reach) {
    try_maps(shape, s).unwrap()
}

/// How far past the shape a bevel's maps can reach, device pixels: an
/// outer bevel its size (the tent or the chisel ramp's `size + 1 1/2`), an
/// emboss half of it rounded up (and Chisel Soft's extra tent), each one
/// more pixel past the ramp (`reach_past`) and Soften's tent, with room to
/// spare. Inner bevels and Stroke Emboss stay inside their shape.
pub(crate) fn outward(style: BevelStyle, technique: BevelTechnique, size: f32, soften: f32) -> f32 {
    let size = if size.is_nan() { 1.0 } else { size.max(1.0) };
    let soften = if soften >= 1.0 { soften } else { 0.0 };
    match style {
        BevelStyle::Outer => size + soften + 4.0,
        BevelStyle::Emboss | BevelStyle::Pillow => {
            let soft = if technique == BevelTechnique::ChiselSoft {
                (size / 4.0).max(1.0) + 1.0
            } else {
                0.0
            };
            (size / 2.0).ceil() + soft + soften + 4.0
        }
        BevelStyle::Inner | BevelStyle::StrokeEmboss => 0.0,
    }
}

#[cfg(test)]
mod tests {
    //! PhotoCraft's bevel tests (`crates/compose/src/effects/tests.rs`), on
    //! one thread, with the light as angle and altitude.
    use super::super::contour::{Curve, Point};
    use super::super::edges::tests::aa_bar;
    use super::super::tent;
    use super::*;

    /// A square map of `n` covered from `x0` to `x1` both ways.
    fn square(n: usize, x0: usize, x1: usize) -> Map {
        let mut m = Map::new(n, n, 0.0);
        for y in x0..x1 {
            for x in x0..x1 {
                m.v[y * n + x] = 1.0;
            }
        }
        m
    }

    fn light(angle: f32, altitude: f32) -> [f32; 3] {
        let (sa, ca) = angle.to_radians().sin_cos();
        let (se, ce) = altitude.to_radians().sin_cos();
        [ca * ce, -sa * ce, se]
    }

    /// PhotoCraft's `bevel_of`: size 5, depth 100 %, up, light from the top
    /// at 30 degrees, Linear gloss.
    fn bevel_of(style: BevelStyle, technique: BevelTechnique) -> Shading<'static> {
        Shading {
            style,
            technique,
            depth: 1.0,
            up: true,
            size: 5.0,
            soften: 0.0,
            light: light(90.0, 30.0),
            gloss: None,
            contour: None,
            texture: None,
            scale: 1.0,
        }
    }

    #[test]
    fn smooth_inner_bevel_lights_the_top_edge_inside_only() {
        let shape = square(40, 10, 30);
        let (hi, sh, paint) = maps(&shape, &bevel_of(BevelStyle::Inner, BevelTechnique::Smooth));
        assert_eq!(paint, Reach::Inner);
        let at = |m: &Map, x: usize, y: usize| m.v[y * 40 + x];
        // Light from the top: highlight along the top edge, shadow along the
        // bottom, flat middle.
        assert!(at(&hi, 20, 10) > 0.5 && at(&sh, 20, 10) == 0.0);
        assert!(at(&sh, 20, 29) > 0.5);
        assert!(at(&hi, 20, 20) < 1e-3 && at(&sh, 20, 20) < 1e-3);
        // Nothing outside the shape; the ramp reaches about `size` inside.
        assert_eq!(at(&hi, 20, 8), 0.0);
        assert!(at(&hi, 20, 15) < 0.05);
    }

    /// Photoshop 27.11, measured across a straight edge (size 10, depth 100
    /// %, light from the top at 30 degrees): a chisel facet has the slope
    /// `depth x size / (2 (size + 1))`, flat right up to the edge pixel for
    /// Inner Hard; Inner Soft's edge pixel is half as steep again; Outer Hard
    /// still shades, partly, the pixel where its ramp reaches zero `size + 1
    /// 1/2` px out.
    #[test]
    fn chisel_facets_match_photoshop() {
        let amount = |g: f32| {
            let (se, ce) = 30f32.to_radians().sin_cos();
            ((g * ce + se) / (1.0 + g * g).sqrt() - se) / (1.0 - se)
        };
        let n = 80;
        let shape = square(n, 20, 60);
        let maps = |style, technique| {
            let mut b = bevel_of(style, technique);
            b.size = 10.0;
            let (hi, sh, _) = maps(&shape, &b);
            [hi, sh]
        };
        let at = |m: &Map, y: usize| m.v[y * n + 40];
        let facet = amount(10.0 / 22.0);
        let hard = maps(BevelStyle::Inner, BevelTechnique::ChiselHard);
        for y in 20..30 {
            assert!(
                (at(&hard[0], y) - facet).abs() < 0.01,
                "inner hard facet at row {y}: {} vs {facet}",
                at(&hard[0], y)
            );
        }
        assert!(
            at(&hard[0], 30) > 0.05 && at(&hard[0], 30) < facet,
            "one partial pixel at the end"
        );
        let soft = maps(BevelStyle::Inner, BevelTechnique::ChiselSoft);
        assert!(
            (at(&soft[0], 20) - amount(1.5 * 10.0 / 22.0)).abs() < 0.01,
            "steeper edge pixel: {}",
            at(&soft[0], 20)
        );
        assert!(
            (at(&soft[0], 24) - facet).abs() < 0.01,
            "then Chisel Hard's facet"
        );
        let outer = maps(BevelStyle::Outer, BevelTechnique::ChiselHard);
        // Below the shape (rows 60..): shadow facet through 10 1/2 px,
        // partial at 11 1/2.
        assert!((at(&outer[1], 70) - at(&outer[1], 61)).abs() < 1e-4);
        assert!(at(&outer[1], 71) > 0.05 && at(&outer[1], 71) < at(&outer[1], 70));
        assert_eq!(at(&outer[1], 72), 0.0);
    }

    #[test]
    fn emboss_paints_both_sides_and_pillow_flips_the_outside() {
        let shape = square(40, 10, 30);
        let (hi, _, paint) = maps(
            &shape,
            &bevel_of(BevelStyle::Emboss, BevelTechnique::Smooth),
        );
        assert_eq!(paint, Reach::Both);
        let at = |m: &Map, x: usize, y: usize| m.v[y * 40 + x];
        // Emboss: the slope across the top edge faces the light on both
        // sides.
        assert!(at(&hi, 20, 10) > 0.3 && at(&hi, 20, 9) > 0.3);
        let (phi, psh, _) = maps(
            &shape,
            &bevel_of(BevelStyle::Pillow, BevelTechnique::Smooth),
        );
        assert!(
            at(&phi, 20, 10) > 0.3 && at(&psh, 20, 9) > 0.3,
            "pillow: outside top edge in shadow"
        );
    }

    #[test]
    fn emboss_width_rounds_up_and_shades_past_the_blur() {
        let g = geom(BevelStyle::Emboss, BevelTechnique::Smooth, 1.0, true, 41.0);
        assert_eq!((g.width, g.depth), (21.0, 21.0));
        assert_eq!(
            geom(BevelStyle::Emboss, BevelTechnique::Smooth, 1.0, true, 5.0).width,
            3.0
        );
        // The first row past the height blur's reach still slopes (its upper
        // neighbour is raised), so it shades; the row after it does not.
        let shape = square(60, 20, 40);
        let mut b = bevel_of(BevelStyle::Emboss, BevelTechnique::Smooth);
        b.size = 9.0;
        let (_, sh, _) = maps(&shape, &b);
        let w = geom(b.style, b.technique, 1.0, true, 9.0).width;
        let reach = tent::reach(f64::from(w)) as usize;
        let row = 39 + reach + 1;
        assert!(sh.v[row * 60 + 30] > 0.0, "{}", sh.v[row * 60 + 30]);
        assert_eq!(sh.v[(row + 1) * 60 + 30], 0.0);
    }

    #[test]
    fn chisel_hard_has_flat_facets() {
        let shape = square(48, 10, 38);
        let (hi, _, _) = maps(
            &shape,
            &bevel_of(BevelStyle::Inner, BevelTechnique::ChiselHard),
        );
        let at = |x: usize, y: usize| hi.v[y * 48 + x];
        // A constant slope: equal highlight along the top facet.
        assert!(at(24, 12) > 0.1 && (at(24, 12) - at(24, 13)).abs() < 1e-3);
    }

    /// The worst standard deviation of the chisel shading (highlight minus
    /// shadow) along lines parallel to an `aa_bar` 2..6 px in from its edges
    /// (PhotoCraft `bar_shade_ripple`, Issue #1926).
    fn bar_shade_ripple(deg: f32, angle: f32) -> f32 {
        let (w, h) = (220usize, 220usize);
        let bar = aa_bar(w, h, deg, 150.0, 16.0);
        let mut b = bevel_of(BevelStyle::Inner, BevelTechnique::ChiselHard);
        (b.size, b.depth, b.light) = (8.0, 2.2, light(angle, 32.0));
        let (hi, sh, _) = maps(&bar, &b);
        let (sn, cs) = deg.to_radians().sin_cos();
        let mut worst = 0.0f32;
        for o in [-6.0f32, -5.0, -4.0, -3.0, -2.0, 2.0, 3.0, 4.0, 5.0, 6.0] {
            let line: Vec<f32> = (-60..=60)
                .map(|k| {
                    let t = k as f32 * 0.5;
                    let (x, y) = (
                        w as f32 / 2.0 + t * cs - o * sn,
                        h as f32 / 2.0 + t * sn + o * cs,
                    );
                    let i = y.floor() as usize * w + x.floor() as usize;
                    hi.v[i] - sh.v[i]
                })
                .collect();
            let mean = line.iter().sum::<f32>() / line.len() as f32;
            worst = worst.max(
                (line.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / line.len() as f32)
                    .sqrt(),
            );
        }
        worst
    }

    #[test]
    fn chisel_facets_are_flat_along_oblique_edges() {
        for deg in [0.0f32, 30.0, 45.0, 60.0, 75.0, 120.0, 150.0] {
            for angle in [-90.0f32, 0.0, 45.0, 120.0] {
                let ripple = bar_shade_ripple(deg, angle);
                assert!(
                    ripple < 0.03,
                    "{deg} deg bar, light {angle}: ripple {ripple}"
                );
            }
        }
    }

    /// Review F28: a ticked Linear Contour is a table (PhotoCraft
    /// `bevel_contour_lut` bakes the identity), which leaves a height from 0
    /// to 1 alone, whatever its Range (carried, never applied), and clamps
    /// one past 1. Off, there is no table and nothing is clamped.
    #[test]
    fn a_ticked_linear_bevel_contour_clamps_the_height() {
        let linear = Table::charged_on(&Curve::Preset(0)).unwrap();
        for v in [0.0f32, 0.25, 0.5, 0.75, 1.0] {
            assert!((linear.at(v) - v).abs() < 1e-6, "{v}");
        }
        assert_eq!(linear.at(12.0 / 11.0), 1.0);
        assert!(Table::new(&Curve::Preset(0)).is_none());
        // Outer Hard, size 10: the chisel's height is 12/11 on the letters
        // and 1 at the first pixel out, so the slope there halves when it is
        // clamped. Light from the top at 30 degrees, depth 5 (100 % of
        // size / 2): at row 60, below the letters, slope 5 (h(61) - h(59)) /
        // 2.
        let shadow = |g: f32| {
            let (se, ce) = 30f32.to_radians().sin_cos();
            let shade = (-g * -ce + se) / (1.0 + g * g).sqrt();
            ((se - shade) / se).clamp(0.0, 1.0)
        };
        let n = 80;
        let shape = square(n, 20, 60);
        let mut b = bevel_of(BevelStyle::Outer, BevelTechnique::ChiselHard);
        b.size = 10.0;
        let (_, off, _) = maps(&shape, &b);
        let on = Shading {
            contour: Some(&linear),
            ..b
        };
        let (_, on, _) = maps(&shape, &on);
        let at = |m: &Map, y: usize| m.v[y * n + 40];
        let (h59, h61) = (12.0 / 11.0, 10.0 / 11.0);
        let unclamped = shadow(5.0 * (h61 - h59) / 2.0);
        let clamped = shadow(5.0 * (h61 - 1.0) / 2.0);
        assert!(
            (at(&off, 60) - unclamped).abs() < 0.01,
            "{} vs {unclamped}",
            at(&off, 60)
        );
        assert!(
            (at(&on, 60) - clamped).abs() < 0.01,
            "{} vs {clamped}",
            at(&on, 60)
        );
        // Further out the ramp is under 1: the same either way.
        assert!((at(&on, 64) - at(&off, 64)).abs() < 1e-6);
    }

    /// Review F8: an Outer Bevel or an Emboss with a contour that does not
    /// start at 0 lifts the flat ground to contour(0) = 1 (Cone - Inverted);
    /// the 0 read off the map once shaded its edge as a 1 px frame. Kept to
    /// the bevel's own extent, the map's edge rows are left alone.
    #[test]
    fn a_contour_that_lifts_the_ground_draws_no_frame_at_the_map_edge() {
        let n = 60;
        let shape = square(n, 20, 40);
        let cone_inverted = Table::new(&Curve::Preset(2)).unwrap();
        let cove_deep = Table::new(&Curve::Preset(3)).unwrap();
        for style in [BevelStyle::Outer, BevelStyle::Emboss, BevelStyle::Pillow] {
            for technique in [BevelTechnique::Smooth, BevelTechnique::ChiselHard] {
                for t in [&cone_inverted, &cove_deep] {
                    let b = Shading {
                        contour: Some(t),
                        ..bevel_of(style, technique)
                    };
                    let (hi, sh, _) = maps(&shape, &b);
                    let reach = outward(style, technique, 5.0, 0.0) as usize;
                    for y in 0..n {
                        for x in 0..n {
                            let far = x + reach < 20
                                || x >= 40 + reach
                                || y + reach < 20
                                || y >= 40 + reach;
                            if far {
                                let i = y * n + x;
                                assert_eq!(
                                    (hi.v[i], sh.v[i]),
                                    (0.0, 0.0),
                                    "{style:?} {technique:?} at ({x}, {y})"
                                );
                            }
                        }
                    }
                    // The bevel itself still shades.
                    assert!(hi.v.iter().chain(sh.v.iter()).any(|&v| v > 0.05));
                }
            }
        }
    }

    #[test]
    fn bevel_contour_and_texture_shape_the_height() {
        let shape = square(40, 6, 34);
        let plain = bevel_of(BevelStyle::Inner, BevelTechnique::Smooth);
        let (ahi, ash, _) = maps(&shape, &plain);
        // A contour reshapes the profile (here a ramp folded at its middle).
        let p = |x: f64, y: f64| Point {
            x,
            y,
            corner: false,
        };
        let fold = Table::new(&Curve::Points(vec![
            p(0.0, 0.0),
            p(127.5, 255.0),
            p(255.0, 0.0),
        ]))
        .unwrap();
        let c = Shading {
            contour: Some(&fold),
            ..bevel_of(BevelStyle::Inner, BevelTechnique::Smooth)
        };
        let (_, bsh, _) = maps(&shape, &c);
        let diff: f32 = ash.v.iter().zip(&bsh.v).map(|(x, y)| (x - y).abs()).sum();
        assert!(diff > 5.0, "{diff}");
        // A striped texture (rows of 2 black, 2 white) lights the flat
        // middle.
        let stripes = |_: usize, y: usize| if y % 4 < 2 { 0.0 } else { 1.0 };
        let t = Shading {
            texture: Some(Texture {
                depth: 1.0,
                invert: false,
                lum: &stripes,
            }),
            ..bevel_of(BevelStyle::Inner, BevelTechnique::Smooth)
        };
        let (thi, tsh, _) = maps(&shape, &t);
        let mid: f32 = (16..24)
            .map(|y| thi.v[y * 40 + 20] + tsh.v[y * 40 + 20])
            .sum();
        let flat: f32 = (16..24)
            .map(|y| ahi.v[y * 40 + 20] + ash.v[y * 40 + 20])
            .sum();
        assert!(mid > flat + 0.5, "{mid} vs {flat}");
    }

    #[test]
    fn an_outer_texture_stays_on_the_bevel() {
        // Texture raises the height everywhere, but an outer bevel still
        // shades only as far as its own ramp reaches.
        let shape = square(60, 20, 40);
        let ones = |_: usize, y: usize| if y % 4 < 2 { 0.0 } else { 1.0 };
        let t = Shading {
            texture: Some(Texture {
                depth: 1.0,
                invert: false,
                lum: &ones,
            }),
            ..bevel_of(BevelStyle::Outer, BevelTechnique::Smooth)
        };
        let (hi, sh, paint) = maps(&shape, &t);
        assert_eq!(paint, Reach::Outer);
        let reach = outward(BevelStyle::Outer, BevelTechnique::Smooth, 5.0, 0.0) as usize;
        for y in 0..60 {
            for x in 0..60 {
                let far = x + reach < 20 || x >= 40 + reach || y + reach < 20 || y >= 40 + reach;
                if far {
                    assert_eq!(hi.v[y * 60 + x] + sh.v[y * 60 + x], 0.0, "({x}, {y})");
                }
            }
        }
        // The texture shades the bevel's own pixels outside the square.
        assert!((0..60).any(|x| hi.v[18 * 60 + x] + sh.v[18 * 60 + x] > 0.0));
    }

    #[test]
    fn the_same_bevel_paints_the_same_twice() {
        let shape = super::super::edges::tests::aa_disc(64, 64, 20.0);
        for technique in [
            BevelTechnique::Smooth,
            BevelTechnique::ChiselHard,
            BevelTechnique::ChiselSoft,
        ] {
            for style in [
                BevelStyle::Inner,
                BevelStyle::Outer,
                BevelStyle::Emboss,
                BevelStyle::Pillow,
            ] {
                let b = bevel_of(style, technique);
                let (a, b2) = (maps(&shape, &b), maps(&shape, &b));
                assert_eq!(a.0.v, b2.0.v);
                assert_eq!(a.1.v, b2.1.v);
            }
        }
    }

    #[test]
    fn every_style_and_technique_paints_where_it_should() {
        let n = 80;
        let shape = square(n, 25, 55);
        for technique in [
            BevelTechnique::Smooth,
            BevelTechnique::ChiselHard,
            BevelTechnique::ChiselSoft,
        ] {
            for style in [
                BevelStyle::Inner,
                BevelStyle::Outer,
                BevelStyle::Emboss,
                BevelStyle::Pillow,
            ] {
                let mut b = bevel_of(style, technique);
                b.size = 8.0;
                let (hi, sh, _) = maps(&shape, &b);
                let (mut inside, mut outside) = (0.0f32, 0.0f32);
                for (i, a) in shape.v.iter().enumerate() {
                    let v = hi.v[i] + sh.v[i];
                    if *a > 0.0 {
                        inside += v;
                    } else {
                        outside += v;
                    }
                }
                let what = format!("{style:?} {technique:?}");
                match style {
                    BevelStyle::Inner => assert!(inside > 1.0 && outside == 0.0, "{what}"),
                    BevelStyle::Outer => assert!(inside == 0.0 && outside > 1.0, "{what}"),
                    _ => assert!(inside > 1.0 && outside > 1.0, "{what}"),
                }
                // Lit from the top: the highlight is above the shadow.
                let rows = |m: &Map| -> f32 {
                    let (mut s, mut w) = (0.0, 0.0);
                    for y in 0..n {
                        let r: f32 = (0..n).map(|x| m.v[y * n + x]).sum();
                        s += r * y as f32;
                        w += r;
                    }
                    s / w.max(1e-6)
                };
                let (hy, sy) = (rows(&hi), rows(&sh));
                if style == BevelStyle::Pillow {
                    // Inside the top lit and outside it dark, the bottom the
                    // other way round.
                    assert!(sh.v[23 * n + 40] > 0.1 && hi.v[56 * n + 40] > 0.1, "{what}");
                } else {
                    assert!(hy + 5.0 < sy, "{what}: {hy} {sy}");
                }
                // Nothing past the outward reach.
                let reach = outward(style, technique, 8.0, 0.0) as usize;
                for y in 0..n {
                    for x in 0..n {
                        if x + reach < 25 || x >= 55 + reach || y + reach < 25 || y >= 55 + reach {
                            assert_eq!(hi.v[y * n + x] + sh.v[y * n + x], 0.0, "{what} ({x}, {y})");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn down_swaps_the_highlight_and_the_shadow() {
        let shape = square(40, 10, 30);
        let up = maps(&shape, &bevel_of(BevelStyle::Inner, BevelTechnique::Smooth));
        let down = maps(
            &shape,
            &Shading {
                up: false,
                ..bevel_of(BevelStyle::Inner, BevelTechnique::Smooth)
            },
        );
        let at = |m: &Map, x: usize, y: usize| m.v[y * 40 + x];
        assert!(at(&up.0, 20, 10) > 0.5 && at(&down.1, 20, 10) > 0.5);
        assert!(at(&up.1, 20, 29) > 0.5 && at(&down.0, 20, 29) > 0.5);
        assert_eq!(at(&down.0, 20, 10), 0.0);
    }

    #[test]
    fn the_angle_and_altitude_move_the_highlight() {
        let shape = square(40, 10, 30);
        let lit = |angle: f32, altitude: f32| {
            let b = Shading {
                light: light(angle, altitude),
                ..bevel_of(BevelStyle::Inner, BevelTechnique::Smooth)
            };
            maps(&shape, &b)
        };
        let at = |m: &Map, x: usize, y: usize| m.v[y * 40 + x];
        // From the left (180 degrees): the left edge lit, the right dark.
        let (hi, sh, _) = lit(180.0, 30.0);
        assert!(at(&hi, 10, 20) > 0.5 && at(&sh, 29, 20) > 0.5);
        assert!(at(&hi, 20, 10) < 0.05);
        // From the right (0 degrees): the other way round.
        let (hi, sh, _) = lit(0.0, 30.0);
        assert!(at(&hi, 29, 20) > 0.5 && at(&sh, 10, 20) > 0.5);
        // A light from straight above lights no edge more than another and
        // leaves no highlight at all: every slope faces away from it.
        let (hi, sh, _) = lit(90.0, 90.0);
        assert!(hi.v.iter().all(|v| *v < 1e-4));
        assert!(at(&sh, 10, 20) > 0.05 && (at(&sh, 10, 20) - at(&sh, 29, 20)).abs() < 1e-3);
        // The altitude changes how a slope is lit.
        let (low, _, _) = lit(90.0, 10.0);
        let (high, _, _) = lit(90.0, 60.0);
        assert!((at(&low, 20, 11) - at(&high, 20, 11)).abs() > 0.05);
    }

    #[test]
    fn soften_blurs_the_height() {
        let shape = square(60, 15, 45);
        let b = bevel_of(BevelStyle::Inner, BevelTechnique::ChiselHard);
        let (hard, _, _) = maps(&shape, &b);
        let (soft, _, _) = maps(
            &shape,
            &Shading {
                soften: 6.0,
                ..bevel_of(BevelStyle::Inner, BevelTechnique::ChiselHard)
            },
        );
        // The chisel's facet ends sharply; softened, the end runs further in
        // and the facet's own top is lower.
        let at = |m: &Map, y: usize| m.v[y * 60 + 30];
        assert!(
            at(&hard, 22) < 0.02 && at(&soft, 22) > 0.02,
            "{} {}",
            at(&hard, 22),
            at(&soft, 22)
        );
        assert!(at(&soft, 17) < at(&hard, 17));
    }

    #[test]
    fn a_gloss_contour_reshapes_the_shading() {
        let shape = square(40, 10, 30);
        let plain = maps(&shape, &bevel_of(BevelStyle::Inner, BevelTechnique::Smooth));
        let ring = Table::new(&Curve::Preset(7)).unwrap();
        let g = maps(
            &shape,
            &Shading {
                gloss: Some(&ring),
                ..bevel_of(BevelStyle::Inner, BevelTechnique::Smooth)
            },
        );
        let diff: f32 = plain
            .0
            .v
            .iter()
            .zip(&g.0.v)
            .chain(plain.1.v.iter().zip(&g.1.v))
            .map(|(a, b)| (a - b).abs())
            .sum();
        assert!(diff > 5.0, "{diff}");
        // The flat face splits at what the contour maps it to: no light.
        assert!(g.0.v[20 * 40 + 20] < 1e-3 && g.1.v[20 * 40 + 20] < 1e-3);
    }
}
