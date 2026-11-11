//! Paint over the letters (box wire v21): marks of colour laid on the fill,
//! inside the letters only, in the order drawn, an eraser taking paint away;
//! the mask still cuts after it.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::effects::{Effect, Marks, PaintMark};
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, Clip, ClipMode, ClipShape, Effects, Fill, Job, Pt,
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

fn mark(color: [u8; 3], opacity: f64, soft: f64, erase: bool, shape: ClipShape) -> PaintMark {
    PaintMark {
        shape,
        color: Rgba([color[0], color[1], color[2], 255]),
        opacity,
        soft,
        erase,
    }
}

fn painted(font: FontId, marks: Vec<PaintMark>) -> BoxRequest {
    let mut b = plain(font);
    b.effects.push(Effect::Paint(Marks {
        origin: Pt::new(0.0, 0.0),
        marks,
    }));
    b
}

fn px(r: &Option<Raster>, x: i32, y: i32) -> [u8; 4] {
    let Some(r) = r else { return [0; 4] };
    if x < r.x || y < r.y || x >= r.x + r.width as i32 || y >= r.y + r.height as i32 {
        return [0; 4];
    }
    let i = ((y - r.y) as usize * r.width as usize + (x - r.x) as usize) * 4;
    [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
}

/// Solid ink pixels of the plain box, left of `split` and right of it.
fn solid_sides(r: &Option<Raster>, split: i32) -> ((i32, i32), (i32, i32)) {
    let find = |lo: i32, hi: i32| {
        for y in 60..96 {
            for x in lo..hi {
                if [(0, 0), (1, 0), (0, 1), (-1, 0), (0, -1)].iter().all(|(dx, dy)| px(r, x + dx, y + dy)[3] == 255) {
                    return (x, y);
                }
            }
        }
        panic!("no solid ink in {lo}..{hi}");
    };
    (find(40, split - 4), find(split + 4, 220))
}

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

#[test]
fn a_mark_colours_the_letters_where_it_lies_and_nothing_outside_them() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (l, r) = solid_sides(&plain_r, 120);
    let out = paint_box(
        &mut e,
        &mut painted(font, vec![mark(RED, 1.0, 0.0, false, rect(-50.0, -50.0, 120.0, 300.0))]),
    )
    .unwrap();
    assert_eq!(px(&out, l.0, l.1), [255, 0, 0, 255]);
    assert_eq!(px(&out, r.0, r.1), [0, 0, 0, 255]);
    // No pixel gains or loses opacity: the paint is inside the letters only.
    let (o, p) = (out.as_ref().unwrap(), plain_r.as_ref().unwrap());
    assert_eq!((o.x, o.y, o.width, o.height), (p.x, p.y, p.width, p.height));
    for (a, b) in o.data.chunks_exact(4).zip(p.data.chunks_exact(4)) {
        assert_eq!(a[3], b[3]);
    }
    // At half opacity, half of the colour over the fill.
    let half = paint_box(
        &mut e,
        &mut painted(font, vec![mark(RED, 0.5, 0.0, false, rect(-50.0, -50.0, 120.0, 300.0))]),
    )
    .unwrap();
    let c = px(&half, l.0, l.1);
    assert!((i32::from(c[0]) - 128).abs() <= 1 && c[1] == 0 && c[3] == 255, "{c:?}");
}

#[test]
fn marks_lie_in_the_order_drawn_and_an_eraser_takes_paint_away() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (l, r) = solid_sides(&plain_r, 120);
    let all = || rect(-50.0, -50.0, 400.0, 300.0);
    let out = paint_box(
        &mut e,
        &mut painted(
            font,
            vec![
                mark(RED, 1.0, 0.0, false, all()),
                mark(BLUE, 1.0, 0.0, false, rect(120.0, -50.0, 400.0, 300.0)),
            ],
        ),
    )
    .unwrap();
    assert_eq!(px(&out, l.0, l.1), [255, 0, 0, 255]);
    assert_eq!(px(&out, r.0, r.1), [0, 0, 255, 255]);
    // An eraser over the right takes both away there: the fill shows again.
    let out = paint_box(
        &mut e,
        &mut painted(
            font,
            vec![
                mark(RED, 1.0, 0.0, false, all()),
                mark(BLUE, 1.0, 0.0, false, rect(120.0, -50.0, 400.0, 300.0)),
                mark(RED, 1.0, 0.0, true, rect(120.0, -50.0, 400.0, 300.0)),
            ],
        ),
    )
    .unwrap();
    assert_eq!(px(&out, l.0, l.1), [255, 0, 0, 255]);
    assert_eq!(px(&out, r.0, r.1), [0, 0, 0, 255]);
    // Paint that is all erased, or an eraser alone, is the plain box.
    for marks in [
        vec![mark(RED, 1.0, 0.0, false, all()), mark(RED, 1.0, 0.0, true, all())],
        vec![mark(RED, 1.0, 0.0, true, all())],
        Vec::new(),
    ] {
        assert_eq!(paint_box(&mut e, &mut painted(font, marks)).unwrap(), plain_r);
    }
}

#[test]
fn a_soft_mark_grades_and_a_brush_paints_its_line() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (l, r) = solid_sides(&plain_r, 120);
    let soft = paint_box(
        &mut e,
        &mut painted(font, vec![mark(RED, 1.0, 12.0, false, rect(-200.0, -200.0, 120.0, 400.0))]),
    )
    .unwrap();
    // Deep inside: all red. Past the edge, some red, less the further out.
    assert_eq!(px(&soft, l.0, l.1)[0], 255);
    let reds: Vec<u8> = (122..200).filter(|&x| px(&plain_r, x, r.1)[3] == 255).map(|x| px(&soft, x, r.1)[0]).collect();
    assert!(reds.first().copied().unwrap_or(0) > 0, "{reds:?}");
    assert!(reds.windows(2).all(|w| w[0] >= w[1]), "{reds:?}");
    // A brush stroke across the letters at mid height.
    let line = paint_box(
        &mut e,
        &mut painted(
            font,
            vec![mark(BLUE, 1.0, 0.0, false, ClipShape::Stroke { size: 6.0, pts: vec![Pt::new(0.0, 78.0), Pt::new(260.0, 78.0)] })],
        ),
    )
    .unwrap();
    let blue_rows: Vec<i32> = (50..110).filter(|&y| (40..200).any(|x| px(&line, x, y)[2] == 255 && px(&line, x, y)[0] == 0 && px(&line, x, y)[3] == 255)).collect();
    assert!(!blue_rows.is_empty() && blue_rows.iter().all(|&y| (74..=82).contains(&y)), "{blue_rows:?}");
}

#[test]
fn the_mask_cuts_after_the_paint() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let plain_r = paint_box(&mut e, &mut plain(font)).unwrap();
    let (l, _) = solid_sides(&plain_r, 120);
    let mut b = painted(font, vec![mark(RED, 1.0, 0.0, false, rect(-50.0, -50.0, 400.0, 300.0))]);
    b.clip = Some(Clip::all(ClipMode::Exclude, Pt::new(0.0, 0.0), vec![rect(-50.0, -50.0, 120.0, 300.0)]));
    let out = paint_box(&mut e, &mut b).unwrap();
    assert_eq!(px(&out, l.0, l.1)[3], 0);
}
