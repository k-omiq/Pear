//! The fade (box wire v20): regional opacity laid after the mask. Properties
//! of the pixels: what a shape takes at its strength, that overlapping
//! shapes of one softness combine by the most and not by stacking, that a
//! soft edge grades, and that a box with no fade is painted as it always was.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, ClipShape, Effects, Fade, FadePart, Fill, Job, Pt,
    Raster, Request, Rgba, Run,
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
