//! Align with Layer off: a Gradient Overlay or a gradient Stroke laid over
//! the page the box sits on, not over its letters.
//!
//! Reference: PhotoCraft (Copyright (c) 2026 ArtCraft Team and the
//! PhotoCraft contributors, MIT licence, see `THIRD_PARTY.md`). PhotoCraft
//! renders `align: false` only for a fill layer, whose gradient it then lays
//! over the canvas (`fill_frame`, `crates/compose/src/content.rs`); its
//! effect gradients carry the flag but its effects never read it. Its effect
//! path on a layer that covers the whole canvas lays the overlay over the
//! canvas, which is that same rule. So the fixtures in
//! `tests/data/align_off/*.rgba` are PhotoCraft's Gradient Overlay on an
//! opaque raster layer filling a 64 x 48 document (128 x 96 for the zoom
//! case), rendered with `photocraft_compose::render` and rounded to RGBA8.
//! They were made by a throwaway crate (path dependencies on
//! `photocraft-compose`, `-doc`, `-color`, `-geom`, `-raster` at dada110):
//!
//! ```text
//! fn shot(name, w, h, g: Gradient) {
//!     let mut d = Document::with_background("t", Size::new(w, h), ColorMode::Rgb, SampleType::U8, Color::WHITE);
//!     let mut l = Layer::raster("sq", PixelFormat::RGBA8);
//!     l.surface_mut().unwrap().fill_rect(Rect::new(0, 0, w as i32, h as i32), &[1.0, 0.0, 0.0, 1.0]);
//!     l.effects.items = vec![Effect::GradientOverlay { common: FxCommon::new(BlendMode::Normal, 1.0),
//!         gradient: g, dither: false, interpolation: None }];
//!     d.layers.push(l);
//!     // (c.clamp(0, 1) * 255).round() per channel of render(&d, Rect::new(0, 0, w, h)).px
//! }
//! // stops (0 black, 0.5 rgb(1, 0.25, 0.5), 1 white), no opacity stops, align true:
//! shot("linear30", 64, 48, Linear 30 deg, scale 1, offset (0, 0))
//! shot("radial", 64, 48, Radial 90 deg, scale 0.7, offset (0.2, -0.1))
//! shot("angle120", 64, 48, Angle 120 deg, scale 1, offset (0, 0))
//! shot("reflected45", 64, 48, Reflected 45 deg, scale 1.3, offset (0, 0))
//! shot("diamond", 64, 48, Diamond 90 deg, scale 1, offset (-0.15, 0.1))
//! shot("linear0", 64, 48, Linear 0 deg, scale 1, offset (0, 0))
//! shot("linear30_zoom2", 128, 96, Linear 30 deg, scale 1, offset (0, 0))
//! ```
//!
//! The limit: our gradient is PhotoCraft's `gradient_t` without the
//! whole-pixel snap of `fill_layout::gradient_layout` (gradient.rs header),
//! so even with Align on, our gradient over the whole page differs from
//! PhotoCraft's by that snap. Each case measures that spread itself, with
//! Align ON over a box covering the whole page and the same settings, at the
//! same pixels; Align off on a small box must stay inside it, plus the one
//! level the exact check below allows. The exact check: our small box with
//! Align off paints what our whole-page box paints with Align on, pixel for
//! pixel, within 1 level (dither off).
//!
//! The strokes are a rule check, not PhotoCraft parity: PhotoCraft has no
//! stroke laid over the canvas (its stroke frame on a canvas-wide layer is
//! the canvas grown by the stroke, `stroke_frame` in
//! `crates/compose/src/effects/composite.rs`, and an outside stroke there
//! paints nothing). The rule (the page, not grown) is Krita's behaviour:
//! its stroke goes through the overlay's `fillOverlayDevice`
//! (`kis_ls_stroke_filter.cpp` L131), which with align off lays the
//! gradient over the image bounds (`kis_ls_utils.cpp` L430-431). Behaviour
//! only; Krita is GPL and none of its code is here.

use super::*;

const RED: Rgba = Rgba([255, 0, 0, 255]);

fn fixture(name: &str) -> &'static [u8] {
    match name {
        "linear30" => include_bytes!("../../../tests/data/align_off/linear30.rgba"),
        "radial" => include_bytes!("../../../tests/data/align_off/radial.rgba"),
        "angle120" => include_bytes!("../../../tests/data/align_off/angle120.rgba"),
        "reflected45" => include_bytes!("../../../tests/data/align_off/reflected45.rgba"),
        "diamond" => include_bytes!("../../../tests/data/align_off/diamond.rgba"),
        "linear0" => include_bytes!("../../../tests/data/align_off/linear0.rgba"),
        "linear30_zoom2" => include_bytes!("../../../tests/data/align_off/linear30_zoom2.rgba"),
        _ => unreachable!(),
    }
}

/// The page, page px.
const PAGE: (f64, f64) = (64.0, 48.0);
/// The small box, page px.
const BOX: (f64, f64) = (20.0, 16.0);

#[derive(Clone, Copy)]
struct Case {
    name: &'static str,
    style: gradient::Style,
    angle: f32,
    scale: f32,
    offset: (f32, f32),
    /// Device px per page px.
    zoom: f64,
    /// The box's top-left on the page, page px, and its turn about its
    /// centre, degrees clockwise (as `boxToPage`).
    at: (f64, f64),
    turn: f64,
    /// The surface's corner on the page's device grid.
    corner: (i32, i32),
}

const fn case(
    name: &'static str,
    style: gradient::Style,
    angle: f32,
    scale: f32,
    offset: (f32, f32),
) -> Case {
    Case {
        name,
        style,
        angle,
        scale,
        offset,
        zoom: 1.0,
        at: (10.0, 8.0),
        turn: 0.0,
        corner: (0, 0),
    }
}

fn cases() -> Vec<Case> {
    use gradient::Style::*;
    vec![
        case("linear30", Linear, 30.0, 1.0, (0.0, 0.0)),
        // The same ramp under a box moved elsewhere on the page.
        Case {
            at: (31.0, 21.0),
            ..case("linear30", Linear, 30.0, 1.0, (0.0, 0.0))
        },
        case("radial", Radial, 90.0, 0.7, (0.2, -0.1)),
        case("angle120", Angle, 120.0, 1.0, (0.0, 0.0)),
        case("reflected45", Reflected, 45.0, 1.3, (0.0, 0.0)),
        case("diamond", Diamond, 90.0, 1.0, (-0.15, 0.1)),
        // A turned box: the ramp stays level on the page.
        Case {
            at: (20.0, 14.0),
            turn: 30.0,
            ..case("linear0", Linear, 0.0, 1.0, (0.0, 0.0))
        },
        // Zoom 2, on a surface whose corner is not the page's.
        Case {
            zoom: 2.0,
            corner: (5, 3),
            ..case("linear30_zoom2", Linear, 30.0, 1.0, (0.0, 0.0))
        },
    ]
}

fn grad(c: &Case, align: bool) -> Gradient {
    Gradient {
        stops: vec![(0.0, [0.0; 3]), (0.5, [1.0, 0.25, 0.5]), (1.0, [1.0; 3])],
        opacity: Vec::new(),
        style: c.style,
        angle: c.angle,
        scale: c.scale,
        reverse: false,
        offset: c.offset,
        mids: Vec::new(),
        opacity_mids: Vec::new(),
        dither: false,
        align,
        noise: None,
    }
}

/// The box's layout (its own page px from its corner) onto the page.
fn to_page(at: (f64, f64), size: (f64, f64), turn: f64) -> Affine {
    let (cx, cy) = (size.0 / 2.0, size.1 / 2.0);
    let r = turn.to_radians();
    Affine::translate(at.0 + cx, at.1 + cy)
        .after(&Affine::rotate(r.cos(), r.sin()))
        .after(&Affine::translate(-cx, -cy))
}

/// Job units onto the surface: onto the page, the zoom, the corner.
fn transform(c: &Case, to_page: &Affine) -> Affine {
    Affine::translate(-f64::from(c.corner.0), -f64::from(c.corner.1))
        .after(&Affine::scale(c.zoom, c.zoom))
        .after(to_page)
}

/// The surface: the page's device grid less the corner.
fn surface(c: &Case) -> (u32, u32) {
    ((PAGE.0 * c.zoom) as u32, (PAGE.1 * c.zoom) as u32)
}

/// Red letters filling a `size` box laid by `t`: every surface pixel whose
/// centre falls inside it, whole.
fn letters(c: &Case, t: &Affine, size: (f64, f64)) -> Raster {
    let (w, h) = surface(c);
    let back = t.invert().unwrap();
    let mut data = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = back.apply(Pt::new(f64::from(x) + 0.5, f64::from(y) + 0.5));
            if (0.0..size.0).contains(&p.x) && (0.0..size.1).contains(&p.y) {
                let i = ((y * w + x) * 4) as usize;
                data[i..i + 4].copy_from_slice(&RED.0);
            }
        }
    }
    Raster {
        x: 0,
        y: 0,
        width: w,
        height: h,
        data,
    }
}

fn place(t: Affine, page: Option<Page>) -> Place<'static> {
    Place {
        transform: t,
        tiles: &[],
        grain: (0, 0),
        page,
    }
}

fn overlay(g: Gradient) -> Effect {
    Effect::GradientOverlay(PaintOverlay {
        opacity: 1.0,
        blend: Blend::Normal,
        paint: Paint::Gradient(g),
    })
}

fn stroke(g: Gradient, size: f64, position: Position) -> Effect {
    Effect::Stroke(Stroke {
        size,
        position,
        opacity: 1.0,
        blend: Blend::Normal,
        paint: Paint::Gradient(g),
        seed: 0,
    })
}

/// A surface pixel of `r`, or clear outside it.
fn at(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (ix, iy) = (x - r.x, y - r.y);
    if ix < 0 || iy < 0 || ix >= r.width as i32 || iy >= r.height as i32 {
        return [0; 4];
    }
    let i = (iy as usize * r.width as usize + ix as usize) * 4;
    [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
}

/// Our paint with the case's settings: the small box with Align `align`,
/// the page known, and the whole-page box with Align on.
struct Paints {
    small: Raster,
    whole: Raster,
    letters: Raster,
}

fn paint(c: &Case, align: bool, fx: impl Fn(Gradient) -> Effect) -> Paints {
    let tp = to_page(c.at, BOX, c.turn);
    let t = transform(c, &tp);
    let page = Page {
        to_page: tp,
        w: PAGE.0,
        h: PAGE.1,
    };
    let lt = letters(c, &t, BOX);
    let (small, _, _) = interior(
        &lt,
        &[fx(grad(c, align))],
        1.0,
        false,
        c.zoom,
        |x, y| (x, y),
        &place(t, Some(page)),
    )
    .unwrap();
    let whole = whole_page(c);
    Paints {
        small,
        whole,
        letters: lt,
    }
}

/// Our Align on overlay of `c`'s gradient over a box covering the whole
/// page, on a surface whose corner is the page's: read at a surface pixel
/// of `c` plus `c.corner`.
fn whole_page(c: &Case) -> Raster {
    let c0 = Case {
        corner: (0, 0),
        ..*c
    };
    let tw = transform(&c0, &Affine::IDENTITY);
    let lw = letters(&c0, &tw, PAGE);
    interior(
        &lw,
        &[overlay(grad(c, true))],
        1.0,
        false,
        c.zoom,
        |x, y| (x, y),
        &place(tw, None),
    )
    .unwrap()
    .0
}

/// Worst channel difference and mean (levels) of `a` against `b` over `px`.
fn spread(
    px: &[(i32, i32)],
    a: impl Fn(i32, i32) -> [u8; 4],
    b: impl Fn(i32, i32) -> [u8; 4],
) -> (u8, f64) {
    let (mut worst, mut sum, mut n) = (0u8, 0f64, 0f64);
    for &(x, y) in px {
        let (p, q) = (a(x, y), b(x, y));
        for k in 0..3 {
            let d = p[k].abs_diff(q[k]);
            worst = worst.max(d);
            sum += f64::from(d);
            n += 1.0;
        }
    }
    (worst, if n > 0.0 { sum / n } else { 0.0 })
}

/// PhotoCraft's pixel at surface pixel (x, y) of `c`.
fn reference(c: &Case) -> impl Fn(i32, i32) -> [u8; 4] {
    let f = fixture(c.name);
    let w = (PAGE.0 * c.zoom) as i32;
    let corner = c.corner;
    move |x, y| {
        let (px, py) = (x + corner.0, y + corner.1);
        let i = (py * w + px) as usize * 4;
        [f[i], f[i + 1], f[i + 2], f[i + 3]]
    }
}

/// The surface pixels on the page where `r` is opaque and the letters are
/// whole (or, `outside`, not there at all).
fn pixels(c: &Case, r: &Raster, letters: &Raster, outside: bool) -> Vec<(i32, i32)> {
    let (w, h) = surface(c);
    let mut out = Vec::new();
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let (px, py) = (x + c.corner.0, y + c.corner.1);
            if px >= (PAGE.0 * c.zoom) as i32 || py >= (PAGE.1 * c.zoom) as i32 {
                continue;
            }
            let l = at(letters, x, y)[3];
            let want = if outside { l == 0 } else { l == 255 };
            if want && at(r, x, y)[3] == 255 {
                out.push((x, y));
            }
        }
    }
    out
}

/// Checks a paint `r` (Align off) of case `c` over `px` against PhotoCraft,
/// within the case's own Align-on spread, and against our whole-page box.
fn check(c: &Case, what: &str, r: &Raster, whole: &Raster, px: &[(i32, i32)]) -> (u8, f64) {
    assert!(
        px.len() > 20,
        "{} {what}: only {} pixels to compare",
        c.name,
        px.len()
    );
    let pc = reference(c);
    let (cx, cy) = c.corner;
    let on = |x: i32, y: i32| at(whole, x + cx, y + cy);
    let (exact, _) = spread(px, |x, y| at(r, x, y), on);
    assert!(
        exact <= 1,
        "{} {what}: off box vs on whole page, worst {exact}",
        c.name
    );
    let (on_worst, on_mean) = spread(px, on, &pc);
    let (worst, mean) = spread(px, |x, y| at(r, x, y), &pc);
    eprintln!(
        "{} at {:?} turn {} {what}: vs PhotoCraft worst {worst} mean {mean:.3}; Align on spread worst {on_worst} mean {on_mean:.3}; {} px",
        c.name,
        c.at,
        c.turn,
        px.len()
    );
    // The exact check bounds every pixel to the Align on one within a
    // level, so no more than a level past its spread.
    assert!(
        worst <= on_worst + 1 && mean <= on_mean + 1.0,
        "{} {what}: worst {worst} mean {mean:.3} past the Align on spread {on_worst} / {on_mean:.3}",
        c.name
    );
    (worst, mean)
}

#[test]
fn an_overlay_with_align_off_paints_photocrafts_page_wide_gradient() {
    let _scope = budget::Scope::new();
    // Worst and mean (levels) measured 2026-11-09, case by case, which are
    // each case's Align on spread to the level (the snap): Radial, Angle,
    // Diamond and the level turned ramp land exactly; the 30 degree Linear
    // ramps lose up to 2 levels and Reflected at 45 degrees and 130 %, which
    // tilts on the snapped grid, 6.
    let measured = [
        (2, 0.931),
        (2, 0.796),
        (0, 0.0),
        (0, 0.0),
        (6, 1.771),
        (0, 0.0),
        (0, 0.0),
        (2, 0.834),
    ];
    for (c, (w, m)) in cases().iter().zip(measured) {
        let p = paint(c, false, overlay);
        let px = pixels(c, &p.small, &p.letters, false);
        let (worst, mean) = check(c, "overlay", &p.small, &p.whole, &px);
        assert!(
            worst <= w && mean <= m + 0.001,
            "{}: {worst} {mean:.3} past {w} {m}",
            c.name
        );
    }
}

#[test]
fn align_on_still_spans_the_letters() {
    let _scope = budget::Scope::new();
    let c = cases()[0];
    let p = paint(&c, true, overlay);
    let px = pixels(&c, &p.small, &p.letters, false);
    // The small box's own ramp is not the page's.
    let (worst, _) = spread(&px, |x, y| at(&p.small, x, y), reference(&c));
    assert!(worst > 60, "Align on painted the page's ramp: {worst}");
}

#[test]
fn without_the_page_align_off_paints_as_align_on() {
    let _scope = budget::Scope::new();
    let c = cases()[0];
    let tp = to_page(c.at, BOX, c.turn);
    let t = transform(&c, &tp);
    let lt = letters(&c, &t, BOX);
    let run = |align: bool| {
        interior(
            &lt,
            &[overlay(grad(&c, align))],
            1.0,
            false,
            1.0,
            |x, y| (x, y),
            &place(t, None),
        )
        .unwrap()
        .0
        .data
    };
    assert_eq!(run(false), run(true));
}

#[test]
fn an_inside_gradient_stroke_with_align_off_lays_the_page_wide_gradient() {
    let _scope = budget::Scope::new();
    for c in [cases()[0], cases()[6]] {
        let p = paint(&c, false, |g| stroke(g, 3.0, Position::Inside));
        // The ring the stroke covers whole: letters whole and the stroke's
        // colour, not red, on top.
        let px: Vec<_> = pixels(&c, &p.small, &p.letters, false)
            .into_iter()
            .filter(|&(x, y)| {
                let q = at(&p.small, x, y);
                let (sx, sy) = (x, y);
                // Three pixels in from every side of an upright box, or the
                // letters' own edge for a turned one: only the ring is
                // painted; keep pixels whose four neighbours at 1 px are
                // letters too and that are not plain red.
                let inner = [(1, 0), (-1, 0), (0, 1), (0, -1)]
                    .iter()
                    .all(|(dx, dy)| at(&p.letters, sx + dx, sy + dy)[3] == 255);
                inner && q != RED.0
            })
            .filter(|&(x, y)| {
                // Covered whole by the stroke: at least a pixel in from the
                // ring's inner edge.
                [(2, 0), (-2, 0), (0, 2), (0, -2)]
                    .iter()
                    .any(|(dx, dy)| at(&p.letters, x + dx, y + dy)[3] == 0)
            })
            .collect();
        check(&c, "inside stroke", &p.small, &p.whole, &px);
    }
}

#[test]
fn an_outside_gradient_stroke_with_align_off_lays_the_page_wide_gradient() {
    let _scope = budget::Scope::new();
    let c = cases()[0];
    let tp = to_page(c.at, BOX, c.turn);
    let t = transform(&c, &tp);
    let page = Page {
        to_page: tp,
        w: PAGE.0,
        h: PAGE.1,
    };
    let lt = letters(&c, &t, BOX);
    let fx = [stroke(grad(&c, false), 3.0, Position::Outside)];
    let pl = place(t, Some(page));
    let (_, o, _) = interior(&lt, &fx, 1.0, false, 1.0, |x, y| (x, y), &pl).unwrap();
    let (w, h) = surface(&c);
    let mut s = Surface::new(w as usize, h as usize).unwrap();
    lay_outside(&mut s, &o.unwrap(), &fx, &pl, None).unwrap();
    let ring = Raster {
        x: 0,
        y: 0,
        width: w,
        height: h,
        data: s.data.to_vec(),
    };
    let whole = whole_page(&c);
    let px = pixels(&c, &ring, &lt, true);
    check(&c, "outside stroke", &ring, &whole, &px);
}

#[test]
fn a_page_record_with_a_shape_burst_paints_by_depth_as_before() {
    let _scope = budget::Scope::new();
    let c = Case {
        style: gradient::Style::ShapeBurst,
        ..cases()[0]
    };
    let tp = to_page(c.at, BOX, c.turn);
    let t = transform(&c, &tp);
    let page = Page {
        to_page: tp,
        w: PAGE.0,
        h: PAGE.1,
    };
    let lt = letters(&c, &t, BOX);
    let run = |align: bool| {
        interior(
            &lt,
            &[overlay(grad(&c, align))],
            1.0,
            false,
            1.0,
            |x, y| (x, y),
            &place(t, Some(page)),
        )
        .unwrap()
        .0
        .data
    };
    assert_eq!(run(false), run(true));
}
