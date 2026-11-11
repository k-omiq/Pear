//! The fade (box wire v20): regional opacity laid after the mask. Properties
//! of the pixels: what a shape takes at its strength, that overlapping
//! shapes of one softness combine by the most and not by stacking, that a
//! soft edge grades, and that a box with no fade is painted as it always was.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, ClipShape, Effects, Fade, FadePart, Fill, Job, Pt,
    Raster, Request, Rgba, Run, Shadow,
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

/// A box of one line, "HHHH" at 60 in black: solid ink from about x 40 to
/// 200, y 56 to 100.
fn plain(font: FontId) -> BoxRequest {
    let request = Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(Rgba([0, 0, 0, 255]))),
            mesh: None,
            roughen: None,
            effects: Effects::default(),
            runs: vec![Run {
                text: "HHHH".to_owned(),
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
    };
    let mut b = BoxRequest::new(260, 160, request);
    b.blend = Blend::Normal;
    b
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> ClipShape {
    ClipShape::Polygon(vec![
        Pt::new(x0, y0),
        Pt::new(x1, y0),
        Pt::new(x1, y1),
        Pt::new(x0, y1),
    ])
}

fn faded(font: FontId, shapes: Vec<FadePart>) -> BoxRequest {
    let mut b = plain(font);
    b.fade = Some(Fade {
        origin: Pt::new(0.0, 0.0),
        shapes,
    });
    b
}

fn part(strength: f64, soft: f64, shape: ClipShape) -> FadePart {
    FadePart {
        strength,
        soft,
        shape,
    }
}

/// The alpha at a surface pixel, 0 where the raster has none.
fn alpha(r: &Option<Raster>, x: i32, y: i32) -> u8 {
    let Some(r) = r else { return 0 };
    if x < r.x || y < r.y || x >= r.x + r.width as i32 || y >= r.y + r.height as i32 {
        return 0;
    }
    r.data[((y - r.y) as usize * r.width as usize + (x - r.x) as usize) * 4 + 3]
}

/// A pixel inside the stem of an H: solid ink in the plain box.
fn solid(r: &Option<Raster>) -> (i32, i32) {
    for y in 60..96 {
        for x in 40..200 {
            if alpha(r, x, y) == 255 && alpha(r, x + 1, y) == 255 && alpha(r, x, y + 1) == 255 {
                return (x, y);
            }
        }
    }
    panic!("no solid ink");
}

#[test]
fn a_hard_fade_takes_its_strength_where_it_lies_and_nothing_elsewhere() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (x, y) = solid(&plain_r);
    // Half the opacity over the left of the box, all of it over nothing.
    let mut b = faded(
        font,
        vec![part(0.5, 0.0, rect(0.0, 0.0, f64::from(x) + 4.0, 160.0))],
    );
    let r = paint_box(&mut e, &mut b).unwrap();
    assert!((i32::from(alpha(&r, x, y)) - 128).abs() <= 1, "{}", alpha(&r, x, y));
    // Past the shape the letters are as they were, to the byte.
    for yy in 50..110 {
        for xx in (x + 6)..220 {
            assert_eq!(alpha(&r, xx, yy), alpha(&plain_r, xx, yy), "{xx} {yy}");
        }
    }
    // At full strength the letters under it are gone.
    let mut b = faded(font, vec![part(1.0, 0.0, rect(0.0, 0.0, 300.0, 160.0))]);
    assert_eq!(paint_box(&mut e, &mut b).unwrap(), None);
}

#[test]
fn shapes_that_overlap_take_the_most_of_them_and_do_not_stack() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (x, y) = solid(&plain_r);
    let one = vec![part(0.4, 0.0, rect(0.0, 0.0, 300.0, 160.0))];
    let two = vec![
        part(0.4, 0.0, rect(0.0, 0.0, 300.0, 160.0)),
        part(0.4, 0.0, rect(0.0, 0.0, 300.0, 160.0)),
        part(0.2, 0.0, rect(0.0, 0.0, 300.0, 160.0)),
    ];
    let a = paint_box(&mut e, &mut faded(font, one)).unwrap();
    let b = paint_box(&mut e, &mut faded(font, two)).unwrap();
    assert_eq!(a, b);
    // 40 %, not 64 %.
    assert!((i32::from(alpha(&a, x, y)) - 153).abs() <= 1, "{}", alpha(&a, x, y));
    // Shapes of different softness combine by the most too: a hard 40 % and a
    // soft 20 % over the same place leave the 40 %.
    let mixed = vec![
        part(0.4, 0.0, rect(0.0, 0.0, 300.0, 160.0)),
        part(0.2, 3.0, rect(0.0, 0.0, 300.0, 160.0)),
    ];
    let m = paint_box(&mut e, &mut faded(font, mixed)).unwrap();
    assert_eq!(alpha(&m, x, y), alpha(&a, x, y));
}

#[test]
fn a_soft_edge_grades_from_the_shape_into_the_letters() {
    let mut e = Engine::new();
    let font = load(&mut e);
    // The left half faded away whole, its edge at x 120, hard and soft.
    let edge = 120.0;
    let hard = paint_box(
        &mut e,
        &mut faded(font, vec![part(1.0, 0.0, rect(-200.0, -200.0, edge, 400.0))]),
    )
    .unwrap();
    let soft = paint_box(
        &mut e,
        &mut faded(font, vec![part(1.0, 8.0, rect(-200.0, -200.0, edge, 400.0))]),
    )
    .unwrap();
    // Hard: nothing left of the edge. Soft: some ink left of it, and less
    // right of it than with no fade.
    let left = |r: &Option<Raster>| (40..118).flat_map(|x| (56..100).map(move |y| (x, y))).map(|(x, y)| u32::from(alpha(r, x, y))).sum::<u32>();
    let right = |r: &Option<Raster>| (122..140).flat_map(|x| (56..100).map(move |y| (x, y))).map(|(x, y)| u32::from(alpha(r, x, y))).sum::<u32>();
    assert_eq!(left(&hard), 0);
    assert!(left(&soft) > 0);
    assert!(right(&soft) < right(&hard));
}

#[test]
fn a_fade_that_is_empty_paints_the_box_as_it_was() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let r = paint_box(&mut e, &mut faded(font, Vec::new())).unwrap();
    assert_eq!(r, plain_r);
    // A shape off the surface takes nothing either.
    let r = paint_box(
        &mut e,
        &mut faded(font, vec![part(1.0, 2.0, rect(-90.0, -90.0, -50.0, -50.0))]),
    )
    .unwrap();
    assert_eq!(r, plain_r);
}

/// Each pixel's alpha as a share of the plain box's, over the letters' rows,
/// read at the box's own coordinates (`dx`, `dy` is where the box lies on the
/// surface).
fn shares(r: &Option<Raster>, plain_r: &Option<Raster>, dx: i32, dy: i32) -> Vec<(i32, i32, u8, u8)> {
    let mut out = Vec::new();
    for y in 50..106 {
        for x in 30..220 {
            let p = alpha(plain_r, x + dx, y + dy);
            if p > 0 {
                out.push((x, y, p, alpha(r, x + dx, y + dy)));
            }
        }
    }
    out
}

#[test]
fn a_shape_far_larger_than_the_box_fades_every_letter_evenly() {
    // The soft blur once read past the picture's edge as nothing, so letters
    // near the edge kept up to half their opacity under a fade that covers
    // the whole page.
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let huge = rect(-100_000.0, -100_000.0, 100_000.0, 100_000.0);
    let hard = paint_box(&mut e, &mut faded(font, vec![part(0.5, 0.0, huge.clone())])).unwrap();
    for soft in [3.0, 40.0, 400.0] {
        let r = paint_box(&mut e, &mut faded(font, vec![part(0.5, soft, huge.clone())])).unwrap();
        assert_eq!(r, hard, "soft {soft}");
    }
    // Every letter pixel at half its plain opacity.
    for (x, y, p, a) in shares(&hard, &plain_r, 0, 0) {
        let want = (u32::from(p) * 127 + 127) / 255;
        assert_eq!(u32::from(a), want, "{x} {y}");
    }
}

#[test]
fn the_fade_on_a_letter_does_not_change_with_the_room_round_the_box() {
    // A shadow makes the picture bigger: the box sits further in, and the
    // surface's page corner moves out by as much. What the fade takes from a
    // letter must not change with it.
    let mut e = Engine::new();
    let font = load(&mut e);
    let shapes = || {
        vec![
            part(0.7, 40.0, rect(-50.0, -50.0, 110.0, 300.0)),
            part(0.4, 6.0, rect(150.0, 20.0, 260.0, 90.0)),
            part(1.0, 0.0, rect(185.0, 0.0, 190.0, 160.0)),
        ]
    };
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let r = paint_box(&mut e, &mut faded(font, shapes())).unwrap();
    let base = shares(&r, &plain_r, 0, 0);
    for (dx, dy) in [(37, 0), (0, 53), (91, 64)] {
        let room = |mut b: BoxRequest| {
            b.width += 2 * dx as u32;
            b.height += 2 * dy as u32;
            b.grain = (-dx, -dy);
            b.request.transform = Affine::translate(f64::from(dx), f64::from(dy));
            b
        };
        let pr = paint_box(&mut e, &mut room(plain(font))).unwrap();
        let fr = paint_box(&mut e, &mut room(faded(font, shapes()))).unwrap();
        assert_eq!(shares(&fr, &pr, dx, dy), base, "room {dx} {dy}");
        // And with a real shadow thrown below the letters, clear of them.
        let shadow = Shadow { y: 70.0, ..Shadow::default() };
        let mut sp = room(plain(font));
        sp.shadows.push(shadow);
        let mut sf = room(faded(font, shapes()));
        sf.shadows.push(shadow);
        let pr = paint_box(&mut e, &mut sp).unwrap();
        let fr = paint_box(&mut e, &mut sf).unwrap();
        assert_eq!(shares(&fr, &pr, dx, dy), base, "shadow {dx} {dy}");
    }
}

#[test]
fn soft_shapes_far_apart_fade_as_each_would_alone() {
    // Shapes of one softness whose blurs cannot meet are blurred apart, each
    // on its own small piece; what they take is what each takes alone.
    let mut e = Engine::new();
    let font = load(&mut e);
    let a = || part(0.8, 4.0, rect(44.0, 50.0, 70.0, 110.0));
    let b = || part(0.6, 4.0, rect(170.0, 50.0, 196.0, 110.0));
    let both = paint_box(&mut e, &mut faded(font, vec![a(), b()])).unwrap().unwrap();
    let ra = paint_box(&mut e, &mut faded(font, vec![a()])).unwrap().unwrap();
    let rb = paint_box(&mut e, &mut faded(font, vec![b()])).unwrap().unwrap();
    assert_eq!((both.x, both.y, both.width, both.height), (ra.x, ra.y, ra.width, ra.height));
    let min: Vec<u8> = ra.data.iter().zip(&rb.data).map(|(x, y)| *x.min(y)).collect();
    assert_eq!(both.data, min);
    assert_ne!(both.data, ra.data);
    assert_ne!(both.data, rb.data);
}
