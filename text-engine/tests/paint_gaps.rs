//! Test gaps from the Layer Styles review (F67 to F71): what the effect
//! wiring paints, which the unit tests of the maps do not reach. Properties
//! of the pixels, as in `paint_box.rs`.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::blending::{Blending, Range};
use mt_text::paint::fx::contour::{Curve, Lut};
use mt_text::paint::fx::effects::{
    Bevel, BevelStyle, BevelTechnique, Effect, Glow, InnerShadow, Overlay, Satin, Technique,
};
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, Effects, Fill, Job, Raster, Request, Rgba, Run, Shadow,
};
use mt_text::{Engine, Face, FontId};

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);
const WHITE: Rgba = Rgba([255, 255, 255, 255]);

/// A job of one line, "HI" at 60, its ink inside about (40..110, 56..100).
fn request(font: FontId) -> Request {
    Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(BLACK)),
            mesh: None,
            roughen: None,
            effects: Effects::default(),
            runs: vec![Run {
                text: "HI".to_owned(),
                x: 40.0,
                y: 100.0,
                rot: 0.0,
                sx: 1.0,
                sy: 1.0,
                skew: 0.0,
                drip: 0.0,
                pen: 1.0,
                ghost: false,
                fill: None,
            }],
        },
        face: Face::new(font, 60.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
        ink: None,
        faces: Default::default(),
    }
}

fn plain(font: FontId) -> BoxRequest {
    BoxRequest::new(200, 160, request(font))
}

fn paint(e: &mut Engine, r: &mut BoxRequest) -> Raster {
    paint_box(e, r).unwrap().expect("something was drawn")
}

/// The pixel at device `(x, y)`, transparent outside the raster.
fn px(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (lx, ly) = (x - r.x, y - r.y);
    if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
        return [0; 4];
    }
    let i = (ly as usize * r.width as usize + lx as usize) * 4;
    [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
}

fn inked(r: &Raster) -> (i32, i32, i32, i32) {
    let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in r.y..r.y + r.height as i32 {
        for x in r.x..r.x + r.width as i32 {
            if px(r, x, y)[3] != 0 {
                b = (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1));
            }
        }
    }
    b
}

fn stem(glyphs: (i32, i32, i32, i32)) -> (i32, i32) {
    (glyphs.0 + 3, (glyphs.1 + glyphs.3) / 2)
}

fn grey_page(v: u8) -> Vec<u8> {
    [v, v, v, 255].repeat(200 * 160)
}

/// What a box raster shows laid source-over on a page of one grey.
fn shown(r: &Raster, x: i32, y: i32, page: u8) -> [f32; 3] {
    let p = px(r, x, y);
    let a = f32::from(p[3]) / 255.0;
    [0, 1, 2].map(|c| f32::from(p[c]) * a + f32::from(page) * (1.0 - a))
}

/// Red letters, and where they lie.
fn red_box(e: &mut Engine) -> (BoxRequest, (i32, i32, i32, i32)) {
    let font = load(e);
    let mut b = plain(font);
    b.request.job.fill = Some(Fill::Solid(RED));
    let g = inked(&paint(e, &mut b));
    (b, g)
}

fn bevel(style: BevelStyle, technique: BevelTechnique) -> Bevel {
    Bevel {
        style,
        technique,
        depth: 1.0,
        up: true,
        size: 5.0,
        soften: 0.0,
        angle: 90.0,
        altitude: 30.0,
        highlight: Overlay {
            color: WHITE,
            opacity: 1.0,
            blend: Blend::Normal,
        },
        shadow: Overlay {
            color: BLUE,
            opacity: 1.0,
            blend: Blend::Normal,
        },
        gloss: None,
        gloss_aa: false,
        contour: None,
        range: 0.5,
        contour_aa: false,
        texture: None,
    }
}

fn glow(color: Rgba, size: f64, noise: f64, blend: Blend) -> Glow {
    Glow {
        color,
        gradient: None,
        opacity: 1.0,
        blend,
        technique: Technique::Softer,
        size,
        spread: 0.0,
        range: 0.5,
        noise,
        contour: None,
        center: false,
        jitter: 0.0,
        seed: 3,
    }
}

// ---- F67: Satin through a contour ----

fn satin(contour: Option<Lut>) -> Effect {
    Effect::Satin(Satin {
        color: BLUE,
        opacity: 1.0,
        blend: Blend::Normal,
        angle: 0.0,
        distance: 5.0,
        size: 6.0,
        invert: false,
        contour,
    })
}

/// F67: a Satin through a contour reads it from its far end (`Lut::satin`):
/// each pixel's strength is the Linear one's through that table. Cone's
/// Satin table is nearly Cone itself (PhotoCraft measured them alike), so
/// Gaussian, whose Satin table runs under its plain curve, tells the Satin
/// table from the plain contour.
#[test]
fn a_satin_through_a_contour_is_the_linear_one_through_the_satin_table() {
    let mut e = Engine::new();
    let (mut b, glyphs) = red_box(&mut e);
    b.effects = vec![satin(None)];
    let linear = paint(&mut e, &mut b);
    assert_eq!(inked(&linear), glyphs);
    for (preset, name) in [(1, "Cone"), (5, "Gaussian")] {
        let curve = Lut::new(&Curve::Preset(preset));
        b.effects = vec![satin(Some(curve))];
        let curved = paint(&mut e, &mut b);
        assert_eq!(inked(&curved), glyphs, "{name}");
        let table = curve.satin();
        // The blue the satin lays over red letters is its strength, in levels.
        let (mut mid, mut moved, mut not_plain) = (0, 0, 0);
        for y in glyphs.1..glyphs.3 {
            for x in glyphs.0..glyphs.2 {
                let (l, c) = (px(&linear, x, y), px(&curved, x, y));
                if l[3] != 255 {
                    continue;
                }
                let s = l[2];
                // Through the Satin table, within the rounding of two bytes.
                assert!(
                    c[2].abs_diff(table.apply(s)) <= 6,
                    "{name} ({x}, {y}): linear {s}, got {}, want {}",
                    c[2],
                    table.apply(s)
                );
                if (40..=215).contains(&s) {
                    mid += 1;
                    moved += usize::from(c[2].abs_diff(s) >= 15);
                    not_plain += usize::from(c[2].abs_diff(curve.apply(s)) >= 15);
                }
            }
        }
        // The comparison had pixels to compare, and the curve moved them.
        assert!(mid >= 20, "{name}: {mid} mid-strength pixels");
        assert!(moved * 4 >= mid, "{name}: {moved} of {mid} moved");
        if preset == 5 {
            assert!(not_plain * 4 >= mid, "{name}: {not_plain} of {mid} not the plain curve");
        }
    }
}

// ---- F68: Bevel Soften through the effect ----

/// The highlight down the stem's first rows from the letters' top: on red
/// letters under a white highlight, the green channel is its strength.
fn top_profile(r: &Raster, glyphs: (i32, i32, i32, i32), rows: i32) -> Vec<u8> {
    let (sx, _) = stem(glyphs);
    (glyphs.1..glyphs.1 + rows).map(|y| px(r, sx, y)[1]).collect()
}

/// F68: Soften blurs a bevel's height, so the same Inner Smooth bevel lit
/// from the top has a lower, wider highlight at Soften 4 than at 0.
#[test]
fn a_bevels_soften_lowers_and_widens_its_highlight() {
    let mut e = Engine::new();
    let (mut b, glyphs) = red_box(&mut e);
    let mut at = |soften: f64| {
        let mut bv = bevel(BevelStyle::Inner, BevelTechnique::Smooth);
        bv.soften = soften;
        b.effects = vec![Effect::Bevel(bv)];
        top_profile(&paint(&mut e, &mut b), glyphs, 16)
    };
    let (hard, soft) = (at(0.0), at(4.0));
    let peak = |p: &[u8]| p.iter().copied().max().unwrap();
    // The rows the highlight reaches at least a fifth of its own peak.
    let width = |p: &[u8]| p.iter().filter(|&&v| v >= peak(p) / 5).count();
    let (hp, sp) = (peak(&hard), peak(&soft));
    let (hw, sw) = (width(&hard), width(&soft));
    assert!(hp > 100, "the unsoftened highlight is strong: {hp}");
    assert!(sp + 10 < hp, "softened peak {sp} vs {hp}");
    assert!(sw > hw, "softened width {sw} vs {hw}");
    // It still lights the edge (it softens, it does not remove).
    assert!(sp > 30, "{sp}");
    assert_ne!(hard, soft);
}

// ---- F69: Noise on a glow and an inner shadow, a Colour Overlay's mode ----

/// The grain multiplies each covered pixel by `1 + (n - 0.5) * 2 * amount`,
/// n in 0..1 (`map::speckle`): within `1 +- amount`. `grained` and `clean`
/// are one effect painted with and without it; `strength` reads each
/// pixel's strength, 0 to 255, where the effect shows. Returns how many
/// pixels the grain lowered and raised by more than 5 %.
fn grain_bounds(
    clean: &Raster,
    grained: &Raster,
    amount: f64,
    strength: impl Fn([u8; 4]) -> Option<u8>,
) -> (usize, usize) {
    let (mut lower, mut higher, mut seen) = (0, 0, 0);
    for y in clean.y.min(grained.y)..(clean.y + clean.height as i32).max(grained.y + grained.height as i32) {
        for x in clean.x.min(grained.x)..(clean.x + clean.width as i32).max(grained.x + grained.width as i32) {
            let (Some(c), Some(g)) = (strength(px(clean, x, y)), strength(px(grained, x, y))) else {
                continue;
            };
            // Mid strengths only: a whole one is clamped, a faint one is
            // lost in the byte.
            if !(60..=200).contains(&c) {
                continue;
            }
            seen += 1;
            let ratio = f64::from(g) / f64::from(c);
            assert!(
                ratio >= 1.0 - amount - 0.04 && ratio <= 1.0 + amount + 0.04,
                "({x}, {y}): {c} became {g}, past 1 +- {amount}"
            );
            lower += usize::from(ratio < 0.95);
            higher += usize::from(ratio > 1.05);
        }
    }
    assert!(seen >= 100, "only {seen} pixels to compare");
    (lower, higher)
}

/// F69: an Outer Glow's Noise grains its strength by a bounded share, the
/// same every time, another every seed.
#[test]
fn an_outer_glows_noise_grains_it_by_a_bounded_share() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let mut with = |noise: f64, seed: u32| {
        let mut g = glow(RED, 8.0, noise, Blend::Normal);
        g.seed = seed;
        b.effects = vec![Effect::OuterGlow(g)];
        paint(&mut e, &mut b)
    };
    let clean = with(0.0, 3);
    let grained = with(0.4, 3);
    // A red glow behind black letters: its alpha is its strength.
    let (lower, higher) = grain_bounds(&clean, &grained, 0.4, |p| (p[0] == 255).then_some(p[3]));
    assert!(lower >= 50 && higher >= 50, "lowered {lower}, raised {higher}");
    assert_eq!(with(0.4, 3), grained);
    assert_ne!(with(0.4, 4), grained);
    // More noise, more spread: at 100 % it reaches the whole span.
    let wild = with(1.0, 3);
    let (lower, higher) = grain_bounds(&clean, &wild, 1.0, |p| (p[0] == 255).then_some(p[3]));
    assert!(lower >= 100 && higher >= 100, "lowered {lower}, raised {higher}");
}

/// F69: an Inner Shadow's Noise, on red letters under a black shadow: the
/// letters' red is `255 * (1 - strength)`.
#[test]
fn an_inner_shadows_noise_grains_it_by_a_bounded_share() {
    let mut e = Engine::new();
    let (mut b, _) = red_box(&mut e);
    let mut with = |noise: f64, seed: u32| {
        b.effects = vec![Effect::InnerShadow(InnerShadow {
            color: BLACK,
            opacity: 1.0,
            blend: Blend::Normal,
            x: 0.0,
            y: 4.0,
            size: 8.0,
            choke: 0.0,
            noise,
            contour: None,
            seed,
        })];
        paint(&mut e, &mut b)
    };
    let clean = with(0.0, 5);
    let grained = with(0.5, 5);
    let shade = |p: [u8; 4]| (p[3] == 255).then(|| 255 - p[0]);
    let (lower, higher) = grain_bounds(&clean, &grained, 0.5, shade);
    assert!(lower >= 50 && higher >= 50, "lowered {lower}, raised {higher}");
    assert_eq!(with(0.5, 5), grained);
    assert_ne!(with(0.5, 6), grained);
}

/// F69: a Colour Overlay painted in Multiply is the product of the fill and
/// its colour, at full opacity and half of the way there at 50 %.
#[test]
fn a_colour_overlay_paints_in_its_blend_mode() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.request.job.fill = Some(Fill::Solid(Rgba([200, 100, 50, 255])));
    let glyphs = inked(&paint(&mut e, &mut b));
    let (sx, sy) = stem(glyphs);
    let mut overlay = |blend: Blend, opacity: f64| {
        b.effects = vec![Effect::ColorOverlay(Overlay {
            color: Rgba([128, 128, 128, 255]),
            opacity,
            blend,
        })];
        px(&paint(&mut e, &mut b), sx, sy)
    };
    let near = |p: [u8; 4], want: [u8; 3]| {
        p[3] == 255 && (0..3).all(|c| p[c].abs_diff(want[c]) <= 1)
    };
    // Normal: the colour. Multiply: the product, 128 / 255 of each channel.
    let normal = overlay(Blend::Normal, 1.0);
    assert!(near(normal, [128, 128, 128]), "{normal:?}");
    let product = overlay(Blend::Multiply, 1.0);
    assert!(near(product, [100, 50, 25]), "{product:?}");
    // Half opacity: half way from the fill to the product.
    let half = overlay(Blend::Multiply, 0.5);
    assert!(near(half, [150, 75, 38]), "{half:?}");
    // Screen is the other way: lighter than the fill.
    let screen = overlay(Blend::Screen, 1.0);
    assert!(near(screen, [228, 178, 153]), "{screen:?}");
}

// ---- F70: effects round the letters read the page ----

/// What a mode lays over one page grey: the W3C result of `colour` over
/// `page` in `mode`, at `strength`.
fn lay(mode: Blend, colour: [u8; 3], strength: f32, page: u8) -> [f32; 3] {
    let (c, p) = (|v: u8| f32::from(v) / 255.0, f32::from(page) / 255.0);
    [0, 1, 2].map(|k| {
        let s = c(colour[k]);
        let m = match mode {
            Blend::Multiply => s * p,
            Blend::Screen => 1.0 - (1.0 - s) * (1.0 - p),
            _ => s,
        };
        255.0 * (p * (1.0 - strength) + m * strength)
    })
}

/// Every pixel off the letters where `normal` (the effect in Normal, no
/// page) shows `colour` at a strength of at least 100: `(x, y, strength)`.
fn clear_of_letters(
    normal: &Raster,
    letters: &Raster,
    colour: [u8; 3],
) -> Vec<(i32, i32, f32)> {
    let mut out = Vec::new();
    for y in normal.y..normal.y + normal.height as i32 {
        for x in normal.x..normal.x + normal.width as i32 {
            let p = px(normal, x, y);
            if p[3] >= 100
                && px(letters, x, y)[3] == 0
                && (0..3).all(|c| p[c].abs_diff(colour[c]) <= 2)
            {
                out.push((x, y, f32::from(p[3]) / 255.0));
            }
        }
    }
    out
}

/// The effect `fx(mode)` over a page of grey 128 and of 64, in `mode`: each
/// pixel round the letters shows the mode's result on that page at the
/// strength the effect has in Normal over nothing. A box that passed the
/// effect no page (or took Normal) would show the colour as it is.
fn reads_the_page(
    fx: impl Fn(Blend) -> Effect,
    colour: [u8; 3],
    mode: Blend,
    needs: usize,
    alone_is_normal: bool,
) {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let letters = paint(&mut e, &mut b);
    b.effects = vec![fx(Blend::Normal)];
    let normal = paint(&mut e, &mut b);
    let spots = clear_of_letters(&normal, &letters, colour);
    assert!(spots.len() >= needs, "{} pixels of the effect clear of the letters", spots.len());
    b.effects = vec![fx(mode)];
    for page in [128u8, 64] {
        b.backdrop = Some(grey_page(page));
        let r = paint(&mut e, &mut b);
        let mut differs = 0;
        for &(x, y, strength) in &spots {
            let got = shown(&r, x, y, page);
            let want = lay(mode, colour, strength, page);
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() <= 3.0,
                    "{mode:?} over grey {page} at ({x}, {y}) channel {c}: {got:?} vs {want:?}"
                );
            }
            let plain_colour = lay(Blend::Normal, colour, strength, page);
            differs += usize::from((0..3).any(|c| (got[c] - plain_colour[c]).abs() > 20.0));
        }
        assert!(differs * 2 >= spots.len(), "{differs} of {} pixels read the page", spots.len());
    }
    // Behind the letters, no page is Normal: the colour as it is. (An
    // Emboss lies over the letters, and blends with them whatever the page.)
    if alone_is_normal {
        b.backdrop = None;
        let alone = paint(&mut e, &mut b);
        assert_eq!(alone, normal, "{mode:?} over no page is Normal");
    }
}

/// F70: an Outer Glow in Multiply and in Screen blends with the page it is
/// given, laid behind the letters.
#[test]
fn an_outer_glow_blends_with_the_page() {
    for (mode, colour) in [(Blend::Multiply, RED), (Blend::Screen, Rgba([40, 90, 200, 255]))] {
        reads_the_page(
            |blend| Effect::OuterGlow(glow(colour, 8.0, 0.0, blend)),
            [colour.0[0], colour.0[1], colour.0[2]],
            mode,
            200,
            true,
        );
    }
}

/// F70: an Outer Bevel's highlight, laid in Screen or Multiply, and an
/// Emboss's, laid over the finished letters, blend with the page round them.
#[test]
fn an_outer_bevel_and_an_emboss_blend_with_the_page() {
    for style in [BevelStyle::Outer, BevelStyle::Emboss] {
        for (mode, colour) in [(Blend::Screen, [100u8, 50, 200]), (Blend::Multiply, [220u8, 180, 90])] {
            reads_the_page(
                |blend| {
                    let mut bv = bevel(style, BevelTechnique::Smooth);
                    bv.highlight = Overlay {
                        color: Rgba([colour[0], colour[1], colour[2], 255]),
                        opacity: 1.0,
                        blend,
                    };
                    // The shadow side stays clear of the highlight's pixels.
                    bv.shadow.opacity = 0.0;
                    Effect::Bevel(bv)
                },
                colour,
                mode,
                10,
                style == BevelStyle::Outer,
            );
        }
    }
}

// ---- F71: the default Advanced Blending against another path ----

/// F71: a box with Advanced Blending at its defaults paints what one does
/// whose Blend If goes through the blending pass (`Blending::restricts`)
/// and hides nothing: Underlying Layer's black point at 1 on a page whose
/// every level is 90. The two are different code, and agree to the level.
#[test]
fn the_default_blending_is_what_a_blending_pass_that_hides_nothing_paints() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.blend = Blend::Multiply;
    b.shadows = vec![Shadow {
        color: RED,
        opacity: 1.0,
        x: 3.0,
        y: 4.0,
        ..Shadow::default()
    }];
    b.effects = vec![Effect::Bevel(bevel(BevelStyle::Outer, BevelTechnique::Smooth))];
    b.backdrop = Some(grey_page(90));
    assert!(!b.blending.restricts());
    let default = paint(&mut e, &mut b);
    let mut through = Blending::default();
    for ranges in through.blend_if.ranges.iter_mut() {
        ranges[1] = Range {
            black: [1, 1],
            white: [255, 255],
        };
    }
    b.blending = through;
    assert!(b.blending.restricts(), "the other path is not the other path");
    let restricted = paint(&mut e, &mut b);
    assert_eq!(default.x, restricted.x);
    assert_eq!((default.width, default.height), (restricted.width, restricted.height));
    let worst = default
        .data
        .iter()
        .zip(&restricted.data)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(worst <= 1, "the two paths differ by {worst} levels");
    // The path does what it says: the same Blend If with the page at 0
    // hides the box.
    b.backdrop = Some(grey_page(0));
    let hidden = paint_box(&mut e, &mut b).unwrap();
    assert!(hidden.is_none_or(|r| r.data.as_chunks::<4>().0.iter().all(|p| p[3] == 0)));
    // And the quick path (letters alone over a page) agrees with it too.
    let mut q = plain(font);
    let glyph_only = paint(&mut e, &mut q);
    q.backdrop = Some(grey_page(90));
    q.blending = Blending::default();
    for ranges in q.blending.blend_if.ranges.iter_mut() {
        ranges[1] = Range {
            black: [1, 1],
            white: [255, 255],
        };
    }
    let slow = paint(&mut e, &mut q);
    assert_eq!(inked(&slow), inked(&glyph_only));
    let worst = glyph_only
        .data
        .iter()
        .zip(&slow.data)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(worst <= 1, "the quick and the blending path differ by {worst}");
}
