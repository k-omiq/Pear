//! The SFX effects a glyph job and a box job carry: letter-by-letter bands,
//! a mitred join, a negative, afterimages, a run's pen, and a shadow's grow.
//! Properties of the pixels, as in `paint_job.rs`.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::{
    paint_box, paint_job, Affine, Align, Band, BoxRequest, Effects, Fill, Job, Join, Negative,
    Raster, Request, Rgba, Run, Shadow, MITER_LIMIT,
};
use mt_text::{Engine, Face, FontId};

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const WHITE: Rgba = Rgba([255, 255, 255, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);
const GRAY: Rgba = Rgba([128, 128, 128, 255]);

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// An upright `I` centred on `(x, 100)`.
fn letter(x: f64) -> Run {
    Run {
        text: "I".to_owned(),
        x,
        y: 100.0,
        rot: 0.0,
        sx: 1.0,
        sy: 1.0,
        skew: 0.0,
        drip: 0.0,
        fill: None,
        pen: 1.0,
        ghost: false,
    }
}

fn job(runs: Vec<Run>, band: f64) -> Job {
    Job {
        curved: true,
        align: Align::Left,
        letter_spacing: 0.0,
        bands: if band > 0.0 {
            vec![Band {
                color: RED,
                opacity: 1.0,
                line: band,
            }]
        } else {
            Vec::new()
        },
        silhouette: None,
        no_fill: false,
        fill: Some(Fill::Solid(BLACK)),
        mesh: None,
        roughen: None,
        effects: Effects::default(),
        runs,
    }
}

fn request(job: Job, font: FontId) -> Request {
    Request {
        job,
        face: Face::new(font, 100.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
    }
}

fn paint(e: &mut Engine, r: &Request) -> Raster {
    paint_job(e, r).unwrap().expect("something was drawn")
}

/// The pixel at device `(x, y)`, clear outside the raster.
fn px(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (cx, cy) = (x - r.x, y - r.y);
    if cx < 0 || cy < 0 || cx >= r.width as i32 || cy >= r.height as i32 {
        return [0; 4];
    }
    let i = (cy as usize * r.width as usize + cx as usize) * 4;
    r.data[i..i + 4].try_into().unwrap()
}

fn is(p: [u8; 4], c: Rgba) -> bool {
    p[3] > 240
        && p[..3]
            .iter()
            .zip(&c.0[..3])
            .all(|(a, b)| a.abs_diff(*b) < 16)
}

/// The box of pixels at least half covered: `(x0, y0, x1, y1)`, ends in.
fn ink(r: &Raster) -> (i32, i32, i32, i32) {
    let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in 0..r.height as i32 {
        for x in 0..r.width as i32 {
            if px(r, r.x + x, r.y + y)[3] >= 128 {
                x0 = x0.min(r.x + x);
                y0 = y0.min(r.y + y);
                x1 = x1.max(r.x + x);
                y1 = y1.max(r.y + y);
            }
        }
    }
    (x0, y0, x1, y1)
}

/// The stem of a plain `I` at `x`: its ink box.
fn stem(e: &mut Engine, font: FontId, x: f64) -> (i32, i32, i32, i32) {
    ink(&paint(e, &request(job(vec![letter(x)], 0.0), font)))
}

#[test]
fn letter_by_letter_lays_a_later_rim_over_an_earlier_fill() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (x0, y0, x1, y1) = stem(&mut e, font, 100.0);
    let w = f64::from(x1 - x0 + 1);
    // The next stem 4 px on, its rim 8 px wide: 4 px into this stem.
    let runs = vec![letter(100.0), letter(100.0 + w + 4.0)];
    let mut j = job(runs, 16.0);
    let probe = (x1 - 1, (y0 + y1) / 2);
    let merged = paint(&mut e, &request(j.clone(), font));
    assert!(
        is(px(&merged, probe.0, probe.1), BLACK),
        "one fill over every rim"
    );
    j.effects.each = true;
    let each = paint(&mut e, &request(j, font));
    assert!(
        is(px(&each, probe.0, probe.1), RED),
        "the next letter's rim on top"
    );
    // Away from the overlap the two agree.
    let far = (x0 + 1, probe.1);
    assert_eq!(px(&merged, far.0, far.1), px(&each, far.0, far.1));
}

#[test]
fn a_mitred_rim_keeps_its_corners_square() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (_, y0, x1, _) = stem(&mut e, font, 100.0);
    // A 20 px rim: 17, 17 out from the corner is 24 px from it, past a
    // round rim and within a mitred one.
    let mut j = job(vec![letter(100.0)], 40.0);
    let corner = (x1 + 17, y0 - 17);
    let round = paint(&mut e, &request(j.clone(), font));
    assert_eq!(px(&round, corner.0, corner.1)[3], 0);
    j.effects.join = Join::Miter { limit: MITER_LIMIT };
    let miter = paint(&mut e, &request(j, font));
    assert!(is(px(&miter, corner.0, corner.1), RED));
    // Along a side the two are the same rim.
    let side = (x1 + 15, (y0 + 40));
    assert!(is(px(&round, side.0, side.1), RED));
    assert!(is(px(&miter, side.0, side.1), RED));
}

#[test]
fn a_negative_fills_the_gap_between_letters_and_its_rim_goes_round_the_blob() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (x0, y0, x1, y1) = stem(&mut e, font, 100.0);
    let w = f64::from(x1 - x0 + 1);
    let gap = 20.0;
    let mut j = job(vec![letter(100.0), letter(100.0 + w + gap)], 10.0);
    j.fill = Some(Fill::Solid(WHITE));
    j.effects.negative = Some(Negative {
        color: BLUE,
        grow: 15.0,
    });
    let r = paint(&mut e, &request(j, font));
    let mid = (y0 + y1) / 2;
    // The letters are white on the blob, and the blob closes the gap.
    assert!(is(px(&r, x0 + (x1 - x0) / 2, mid), WHITE));
    assert!(is(px(&r, x1 + (gap / 2.0) as i32, mid), BLUE));
    // The rim is round the blob: 15 px out is blue, 18 red, 23 clear.
    assert!(is(px(&r, x0 - 12, mid), BLUE));
    assert!(is(px(&r, x0 - 18, mid), RED));
    assert_eq!(px(&r, x0 - 23, mid)[3], 0);
}

#[test]
fn an_afterimage_is_painted_first_with_its_fill_alone() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (x0, y0, x1, y1) = stem(&mut e, font, 100.0);
    let mid = (y0 + y1) / 2;
    let ghost = Run {
        fill: Some(Fill::Solid(GRAY)),
        ghost: true,
        ..letter(40.0)
    };
    // The afterimage is listed after the letter and still lies under its rim.
    let near = Run {
        fill: Some(Fill::Solid(GRAY)),
        ghost: true,
        ..letter(90.0)
    };
    let mut j = job(vec![letter(100.0), ghost, near], 10.0);
    let r = paint(&mut e, &request(j.clone(), font));
    let gx = x0 - 60 + (x1 - x0) / 2;
    assert!(is(px(&r, gx, mid), GRAY), "the afterimage is filled");
    assert_eq!(px(&r, x0 - 60 - 3, mid)[3], 0, "with no rim of its own");
    assert!(is(px(&r, x0 - 3, mid), RED), "the letter's rim is over it");
    // A hollow job keeps its afterimages.
    j.no_fill = true;
    let r = paint(&mut e, &request(j, font));
    assert!(is(px(&r, gx, mid), GRAY));
}

#[test]
fn a_runs_pen_scales_its_rim() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (_, y0, x1, y1) = stem(&mut e, font, 100.0);
    let mid = (y0 + y1) / 2;
    // A 20 px pen reaches 10 px; at half it reaches 5.
    let full = paint(&mut e, &request(job(vec![letter(100.0)], 20.0), font));
    let half = Run {
        pen: 0.5,
        ..letter(100.0)
    };
    let half = paint(&mut e, &request(job(vec![half], 20.0), font));
    assert!(is(px(&full, x1 + 7, mid), RED));
    assert_eq!(px(&half, x1 + 7, mid)[3], 0);
    assert!(is(px(&half, x1 + 3, mid), RED));
}

fn boxed(font: FontId, shadows: Vec<Shadow>) -> BoxRequest {
    BoxRequest {
        width: 300,
        height: 200,
        shadows,
        blur: 0.0,
        taps: Vec::new(),
        clip: None,
        blend: Blend::Normal,
        fill_opacity: 1.0,
        backdrop: None,
        request: request(job(vec![letter(100.0)], 0.0), font),
    }
}

fn shadow(x: f64, grow: f64) -> Shadow {
    Shadow {
        color: BLUE,
        opacity: 1.0,
        x,
        y: 0.0,
        grow,
        ..Shadow::default()
    }
}

#[test]
fn shadows_alike_are_one_silhouette_moved_and_a_grow_widens_it() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (x0, y0, x1, y1) = stem(&mut e, font, 100.0);
    let (cx, mid) = ((x0 + x1) / 2, (y0 + y1) / 2);
    // Three steps of an extrude: every copy lands.
    let mut b = boxed(
        font,
        vec![shadow(30.0, 0.0), shadow(60.0, 0.0), shadow(90.0, 0.0)],
    );
    let r = paint_box(&mut e, &mut b).unwrap().unwrap();
    for dx in [30, 60, 90] {
        assert!(is(px(&r, cx + dx, mid), BLUE), "{dx}");
    }
    assert!(is(px(&r, cx, mid), BLACK));
    // Grown by 8, the copy at 60 reaches 6 px past its stem's edge.
    let edge = x1 + 60 + 6;
    assert_eq!(px(&r, edge, mid)[3], 0);
    let mut b = boxed(font, vec![shadow(60.0, 8.0), shadow(60.0, 0.0)]);
    let r = paint_box(&mut e, &mut b).unwrap().unwrap();
    assert!(is(px(&r, edge, mid), BLUE));
    // The request is handed back as it came.
    assert_eq!(b.request.job.effects.grow, 0.0);
    assert_eq!(b.request.job.silhouette, None);
}
