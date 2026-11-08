//! `paint_box`, pass by pass. Properties of the pixels, as in `paint_job.rs`:
//! where a shadow lands, what a blur keeps, what a mask shows.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::contour::{Curve, Lut};
use mt_text::paint::fx::effects::{
    Effect, Glow, InnerShadow, Overlay, Paint, PaintOverlay, Position, Satin, Stroke, Technique,
};
use mt_text::paint::fx::gradient::{Gradient, Style};
use mt_text::paint::fx::noise_gradient::{Model, Noise, Ramp};

use mt_text::paint::{
    decode_box, paint_box, paint_job, Affine, Align, BoxRequest, Clip, ClipMode, ClipShape,
    Effects, Fill, Job, Mesh, Pt, Raster, Request, Rgba, Run, Shadow, Tap, BOX_MAGIC,
    BOX_WIRE_VERSION, MAGIC, WIRE_VERSION,
};
use mt_text::{Engine, Error, Face, FontId};

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
    }
}

fn plain(font: FontId) -> BoxRequest {
    BoxRequest {
        width: 200,
        height: 160,
        shadows: Vec::new(),
        blur: 0.0,
        taps: Vec::new(),
        clip: None,
        blend: Blend::Normal,
        fill_opacity: 1.0,
        effects: Vec::new(),
        backdrop: None,
        request: request(font),
    }
}

fn shadow(color: Rgba, x: f64, y: f64) -> Shadow {
    Shadow {
        color,
        opacity: 1.0,
        x,
        y,
        ..Shadow::default()
    }
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

/// Device box of the pixels `keep` says yes to: `(x0, y0, x1, y1)`.
fn boxed(r: &Raster, keep: impl Fn([u8; 4]) -> bool) -> (i32, i32, i32, i32) {
    let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for y in r.y..r.y + r.height as i32 {
        for x in r.x..r.x + r.width as i32 {
            if keep(px(r, x, y)) {
                b = (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1));
            }
        }
    }
    b
}

fn inked(r: &Raster) -> (i32, i32, i32, i32) {
    boxed(r, |p| p[3] != 0)
}

fn alpha_sum(r: &Raster) -> u64 {
    r.data.chunks_exact(4).map(|p| u64::from(p[3])).sum()
}

fn is_red(p: [u8; 4]) -> bool {
    p[3] > 200 && p[0] > 200 && p[1] < 40 && p[2] < 40
}

fn is_black(p: [u8; 4]) -> bool {
    p[3] > 200 && p[0] < 40 && p[1] < 40 && p[2] < 40
}

#[test]
fn a_box_with_nothing_laid_on_it_is_its_glyph_job() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = paint_job(&mut e, &b.request).unwrap().unwrap();
    assert_eq!(paint(&mut e, &mut b), glyphs);
    // A shadow with no opacity and a tap with no weight are nothing too.
    b.shadows = vec![Shadow {
        opacity: 0.0,
        ..shadow(RED, 5.0, 5.0)
    }];
    b.taps = vec![Tap {
        dx: 3.0,
        dy: 0.0,
        weight: 0.0,
    }];
    assert_eq!(paint(&mut e, &mut b), glyphs);
    // And the request comes back as it went in.
    assert_eq!(b.request.job.silhouette, None);
}

#[test]
fn the_raster_is_cut_to_the_surface() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let whole = inked(&paint(&mut e, &mut b));
    // A surface that ends through the letters.
    b.width = 70;
    b.height = 80;
    let r = paint(&mut e, &mut b);
    let got = inked(&r);
    assert_eq!((got.0, got.1), (whole.0, whole.1));
    assert_eq!((got.2, got.3), (70, 80));
    assert!(r.x >= 0 && r.y >= 0 && r.x + r.width as i32 <= 70 && r.y + r.height as i32 <= 80);
    // The same with a pass laid on, which takes the other road.
    b.shadows = vec![shadow(RED, 2.0, 2.0)];
    let r = paint(&mut e, &mut b);
    assert!(r.x + r.width as i32 <= 70 && r.y + r.height as i32 <= 80);
    // Nothing inside the surface is nothing.
    b.request.transform = Affine::translate(500.0, 0.0);
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
}

#[test]
fn a_shadow_is_thrown_under_the_letters_in_its_colour() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    b.shadows = vec![shadow(RED, 12.0, 7.0)];
    let r = paint(&mut e, &mut b);
    // The letters are where they were and are still black. (An edge pixel
    // is black over red now, so the box of black is within a pixel.)
    let (now, was) = (boxed(&r, is_black), glyphs);
    for (a, b) in [
        (now.0, was.0),
        (now.1, was.1),
        (now.2, was.2),
        (now.3, was.3),
    ] {
        assert!((a - b).abs() <= 1, "{now:?} against {was:?}");
    }
    // The red is the same shape, 12 right and 7 down.
    let red = boxed(&r, |p| p[3] != 0 && p[0] > 128);
    assert_eq!(red.2, glyphs.2 + 12);
    assert_eq!(red.3, glyphs.3 + 7);
    // Under: on the H's bar, where the stem's shadow falls too, the letter
    // shows.
    let (mx, my) = (glyphs.0 + 14, (glyphs.1 + glyphs.3) / 2);
    assert!(is_black(px(&r, mx, my)), "{:?}", px(&r, mx, my));
    // The same job twice is the same bytes.
    assert_eq!(paint(&mut e, &mut b), r);
}

#[test]
fn a_shadow_has_its_opacity_and_the_first_is_on_top() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    // Far enough that the shadow is clear of the letters.
    b.shadows = vec![Shadow {
        opacity: 0.5,
        ..shadow(RED, 0.0, 50.0)
    }];
    let r = paint(&mut e, &mut b);
    let p = px(&r, glyphs.0 + 4, glyphs.1 + 54);
    assert!((126..=129).contains(&p[3]) && p[0] == 255, "{p:?}");
    // Two shadows at one place: the first in the list is the one seen.
    b.shadows = vec![shadow(RED, 0.0, 50.0), shadow(BLUE, 0.0, 50.0)];
    let r = paint(&mut e, &mut b);
    assert!(is_red(px(&r, glyphs.0 + 4, glyphs.1 + 54)));
}

#[test]
fn a_shadow_turns_and_mirrors_with_the_box() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.shadows = vec![shadow(RED, 30.0, 0.0)];
    // A quarter turn about (100, 80): job right is device down.
    let turn = Affine::translate(100.0, 80.0)
        .after(&Affine::rotate(0.0, 1.0))
        .after(&Affine::translate(-100.0, -80.0));
    b.request.transform = turn;
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!(
        (red.0, red.2),
        (black.0, black.2),
        "thrown down, not across"
    );
    assert_eq!(red.3, black.3 + 30);
    // Mirrored left to right: job right is device left.
    b.request.transform = Affine([-1.0, 0.0, 0.0, 1.0, 200.0, 0.0]);
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!(red.0, black.0 - 30);
    // Twice the scale throws it twice as far.
    b.request.transform = Affine::scale(2.0, 2.0);
    b.width = 400;
    b.height = 320;
    let r = paint(&mut e, &mut b);
    let (black, red) = (boxed(&r, is_black), boxed(&r, is_red));
    assert_eq!(red.2, black.2 + 60);
}

#[test]
fn a_shadow_size_is_a_tent_that_reaches_the_size() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.request.job.fill = None;
    b.shadows = vec![Shadow {
        size: 12.0,
        ..shadow(BLACK, 0.0, 0.0)
    }];
    let soft = paint(&mut e, &mut b);
    b.shadows = vec![shadow(BLACK, 0.0, 0.0)];
    let hard = paint(&mut e, &mut b);
    // Photoshop's Size is how far the soft edge reaches: two boxes of 12,
    // whose last faint pixels can round away.
    let reach = inked(&hard).0 - inked(&soft).0;
    assert!((8..=12).contains(&reach), "reached {reach}");
    // Softer than the hard one at the letters' edge, and not a gaussian:
    // the whole-box blur at the sigma Photoshop's dialog would suggest is
    // another picture.
    assert_ne!(soft, hard);
}

#[test]
fn a_blur_keeps_the_ink_and_spreads_it() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let sharp = paint(&mut e, &mut b);
    b.blur = 3.0;
    let soft = paint(&mut e, &mut b);
    let (a, c) = (alpha_sum(&sharp) as f64, alpha_sum(&soft) as f64);
    assert!((a - c).abs() / a < 0.02, "{a} to {c}");
    let (s, t) = (inked(&sharp), inked(&soft));
    assert!(t.0 < s.0 - 4 && t.2 > s.2 + 4 && t.1 < s.1 - 4 && t.3 > s.3 + 4);
    // Nothing is fully inked at the old edge any more.
    assert!(px(&soft, s.0, (s.1 + s.3) / 2)[3] < 200);
}

#[test]
fn taps_add_moved_copies() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let sharp = paint(&mut e, &mut b);
    // One whole copy where it stands is the picture.
    b.taps = vec![Tap {
        dx: 0.0,
        dy: 0.0,
        weight: 1.0,
    }];
    assert_eq!(paint(&mut e, &mut b), sharp);
    // Two half copies, 40 apart: each letter twice, at half strength.
    b.taps = vec![
        Tap {
            dx: 0.0,
            dy: 0.0,
            weight: 0.5,
        },
        Tap {
            dx: 0.0,
            dy: 40.0,
            weight: 0.5,
        },
    ];
    let r = paint(&mut e, &mut b);
    let s = inked(&sharp);
    assert_eq!(inked(&r), (s.0, s.1, s.2, s.3 + 40));
    let total = alpha_sum(&r) as f64 / alpha_sum(&sharp) as f64;
    assert!((0.98..1.02).contains(&total), "{total}");
    let p = px(&r, s.0 + 4, s.1 + 4);
    assert!((126..=129).contains(&p[3]), "{p:?}");
}

fn clip(mode: ClipMode, shapes: Vec<ClipShape>) -> Option<Clip> {
    Some(Clip {
        mode,
        origin: Pt::new(0.0, 0.0),
        shapes,
    })
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> ClipShape {
    ClipShape::Polygon(vec![
        Pt::new(x0, y0),
        Pt::new(x1, y0),
        Pt::new(x1, y1),
        Pt::new(x0, y1),
    ])
}

#[test]
fn include_and_exclude_are_the_two_halves_of_the_picture() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let whole = paint(&mut e, &mut b);
    let s = inked(&whole);
    let mid = f64::from(s.0 + s.2) / 2.0 + 0.5;
    let shapes = || vec![rect(0.0, 0.0, mid, 200.0)];
    b.clip = clip(ClipMode::Include, shapes());
    let left = paint(&mut e, &mut b);
    b.clip = clip(ClipMode::Exclude, shapes());
    let right = paint(&mut e, &mut b);
    assert!(inked(&left).2 <= mid.ceil() as i32);
    assert!(inked(&right).0 >= mid.floor() as i32);
    for y in s.1..s.3 {
        for x in s.0..s.2 {
            let sum = i32::from(px(&left, x, y)[3]) + i32::from(px(&right, x, y)[3]);
            let want = i32::from(px(&whole, x, y)[3]);
            assert!((sum - want).abs() <= 1, "{x},{y}: {sum} against {want}");
        }
    }
    // Shapes that cover nothing: include shows nothing, exclude everything.
    b.clip = clip(ClipMode::Include, vec![rect(900.0, 900.0, 950.0, 950.0)]);
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
    b.clip = clip(ClipMode::Exclude, vec![rect(900.0, 900.0, 950.0, 950.0)]);
    assert_eq!(paint(&mut e, &mut b), whole);
    b.clip = clip(ClipMode::Include, Vec::new());
    assert_eq!(paint_box(&mut e, &mut b), Ok(None));
}

/// A box that is one flat sheet of ink, to see a mask's own shape in.
fn sheet(font: FontId) -> BoxRequest {
    let mut b = plain(font);
    // A block character with a band wide enough to fill the surface.
    b.request.job.runs[0].text = "H".to_owned();
    b.request.job.bands = vec![mt_text::paint::Band {
        color: BLACK,
        opacity: 1.0,
        line: 600.0,
    }];
    b
}

#[test]
fn each_shape_covers_what_it_should() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = sheet(font);
    // An ellipse.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Ellipse {
            centre: Pt::new(100.0, 80.0),
            rx: 40.0,
            ry: 20.0,
        }],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), (60, 60, 140, 100));
    assert_eq!(px(&r, 100, 80)[3], 255);
    assert_eq!(px(&r, 65, 65)[3], 0);
    // A stroke: two legs, round at the ends and at the corner.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Stroke {
            size: 20.0,
            pts: vec![
                Pt::new(40.0, 40.0),
                Pt::new(120.0, 40.0),
                Pt::new(120.0, 120.0),
            ],
        }],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), (30, 30, 130, 130));
    // Solid along both legs and across the joint: one line, not patches.
    for (x, y) in [
        (40, 40),
        (80, 40),
        (120, 40),
        (120, 80),
        (120, 120),
        (126, 34),
    ] {
        assert_eq!(px(&r, x, y)[3], 255, "{x},{y}");
    }
    // The outer corner is round: its very tip is clear.
    assert_eq!(px(&r, 129, 30)[3], 0);
    // One point is a dot.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Stroke {
            size: 30.0,
            pts: vec![Pt::new(100.0, 80.0)],
        }],
    );
    assert_eq!(inked(&paint(&mut e, &mut b)), (85, 65, 115, 95));
    // A figure of eight is filled in both loops.
    b.clip = clip(
        ClipMode::Include,
        vec![ClipShape::Polygon(vec![
            Pt::new(20.0, 20.0),
            Pt::new(100.0, 100.0),
            Pt::new(100.0, 20.0),
            Pt::new(20.0, 100.0),
        ])],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(px(&r, 30, 60)[3], 255);
    assert_eq!(px(&r, 90, 60)[3], 255);
    assert_eq!(px(&r, 60, 30)[3], 0);
    // Two shapes that overlap are one shape there.
    b.clip = clip(
        ClipMode::Include,
        vec![
            rect(20.0, 20.0, 100.0, 100.0),
            rect(60.0, 60.0, 140.0, 140.0),
        ],
    );
    let r = paint(&mut e, &mut b);
    assert_eq!(px(&r, 80, 80)[3], 255);
    assert_eq!(px(&r, 30, 130)[3], 0);
}

#[test]
fn a_mask_is_the_boxes_and_goes_where_the_box_goes() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = sheet(font);
    let shapes = vec![rect(10.0, 10.0, 50.0, 30.0)];
    // Stated from the box's corner.
    b.clip = Some(Clip {
        mode: ClipMode::Include,
        origin: Pt::new(30.0, 40.0),
        shapes: shapes.clone(),
    });
    assert_eq!(inked(&paint(&mut e, &mut b)), (40, 50, 80, 70));
    // Carried by the transform.
    b.request.transform = Affine::scale(2.0, 2.0);
    b.width = 400;
    b.height = 320;
    assert_eq!(inked(&paint(&mut e, &mut b)), (80, 100, 160, 140));
    // And bent by the box's mesh: one that moves the box whole moves it.
    b.request.transform = Affine::IDENTITY;
    let moved = |dx: f64, dy: f64| Mesh {
        cols: 1,
        rows: 1,
        pts: vec![
            Pt::new(dx, dy),
            Pt::new(200.0 + dx, dy),
            Pt::new(dx, 160.0 + dy),
            Pt::new(200.0 + dx, 160.0 + dy),
        ],
        x: 0.0,
        y: 0.0,
        w: 200.0,
        h: 160.0,
    };
    b.request.job.mesh = Some(moved(25.0, -15.0));
    assert_eq!(inked(&paint(&mut e, &mut b)), (65, 35, 105, 55));
}

#[test]
fn the_passes_come_in_their_order() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let s = inked(&paint(&mut e, &mut b));
    // The mask is last: it cuts the blur's spread clean.
    b.blur = 4.0;
    let mid = f64::from(s.0 + s.2) / 2.0;
    b.clip = clip(ClipMode::Include, vec![rect(0.0, 0.0, mid, 200.0)]);
    let r = paint(&mut e, &mut b);
    assert!(inked(&r).2 <= mid.ceil() as i32);
    assert!(
        inked(&r).0 < s.0 - 4,
        "the blur still spreads where it is shown"
    );
    // The blur is over the shadow too: a hard shadow comes out soft.
    b.clip = None;
    b.shadows = vec![shadow(RED, 0.0, 30.0)];
    let r = paint(&mut e, &mut b);
    assert!(inked(&r).3 > s.3 + 30 + 4);
}

// ---- the wire form ----

fn u(b: &mut Vec<u8>, v: u32) {
    b.extend_from_slice(&v.to_le_bytes());
}

fn f(b: &mut Vec<u8>, v: f64) {
    b.extend_from_slice(&v.to_le_bytes());
}

/// A glyph job on the wire: "HI", black, nothing else.
fn job_bytes(font: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, MAGIC);
    u(&mut b, WIRE_VERSION);
    u(&mut b, font);
    u(&mut b, 0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 60.0);
    for v in [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    f(&mut b, 0.0);
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // round join
    u(&mut b, 0); // no negative: its colour and grow
    f(&mut b, 0.0);
    f(&mut b, 0.0); // no extra weight
    f(&mut b, 0.0); // no extra lean
    u(&mut b, 0); // no bands
    u(&mut b, 1); // solid fill
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // no mesh
    u(&mut b, 0); // not roughened
    u(&mut b, 1);
    for v in [40.0, 100.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0] {
        f(&mut b, v);
    }
    u(&mut b, 0); // not an afterimage
    u(&mut b, 0);
    u(&mut b, 2);
    b.extend_from_slice(b"HI");
    u(&mut b, 0);
    b
}

/// A box job on the wire with one of everything, and where each part
/// starts: the shadow's opacity, the blur, the tap's weight, the clip mode.
/// A radial gradient at 45 degrees, 50 %, reversed, moved a tenth across:
/// red to blue, fading out.
fn gradient_record(b: &mut Vec<u8>) {
    u(b, 1);
    f(b, 45.0);
    f(b, 0.5);
    u(b, 1);
    f(b, 0.1);
    f(b, 0.0);
    u(b, 2);
    f(b, 0.0);
    b.extend_from_slice(&[255, 0, 0, 255]);
    f(b, 1.0);
    b.extend_from_slice(&[0, 0, 255, 255]);
    u(b, 2);
    f(b, 0.0);
    f(b, 1.0);
    f(b, 1.0);
    f(b, 0.0);
    u(b, 0); // solid
}

/// A Shape Burst noise gradient: the stops of [`gradient_record`], then
/// type noise, seed 21, Roughness 0.4, HSB, the limits, Add Transparency.
/// Hands back where the noise record starts.
fn noise_gradient_record(b: &mut Vec<u8>) -> usize {
    gradient_record(b);
    b.truncate(b.len() - 4);
    // style, angle, scale, reverse, offset, two colour stops, two opacity.
    let style_at = b.len() - (4 + 8 + 8 + 4 + 16 + 4 + 2 * 12 + 4 + 2 * 16);
    b[style_at..style_at + 4].copy_from_slice(&5u32.to_le_bytes());
    u(b, 1);
    let at = b.len();
    u(b, 21);
    f(b, 0.4);
    u(b, 1);
    for v in [0.0, 1.0, 0.25, 0.75, 0.5, 1.0] {
        f(b, v);
    }
    u(b, 2);
    at
}

fn noise_gradient() -> Gradient {
    Gradient {
        style: Style::ShapeBurst,
        noise: Some(Ramp::new(Noise {
            seed: 21,
            roughness: 0.4,
            model: Model::Hsb,
            min: [0.0, 0.25, 0.5],
            max: [1.0, 0.75, 1.0],
            restrict: false,
            transparency: true,
        })),
        ..gradient()
    }
}

fn gradient() -> Gradient {
    Gradient {
        stops: vec![(0.0, [1.0, 0.0, 0.0]), (1.0, [0.0, 0.0, 1.0])],
        opacity: vec![(0.0, 1.0), (1.0, 0.0)],
        style: Style::Radial,
        angle: 45.0,
        scale: 0.5,
        reverse: true,
        offset: (0.1, 0.0),
        noise: None,
    }
}

fn wire(font: u32) -> (Vec<u8>, [usize; 7]) {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, 1);
    b.extend_from_slice(&[255, 0, 0, 255]);
    let opacity_at = b.len();
    for v in [0.5, 6.0, -4.0, 3.0, 0.0, 0.25, 0.5] {
        f(&mut b, v);
    }
    u(&mut b, 3); // multiply
    u(&mut b, 1); // knocks out
    u(&mut b, 7); // seed
    u(&mut b, 1); // the Cone
    let blur_at = b.len();
    f(&mut b, 1.5);
    u(&mut b, 1);
    f(&mut b, 2.0);
    f(&mut b, 0.0);
    let weight_at = b.len();
    f(&mut b, 0.25);
    let mode_at = b.len();
    u(&mut b, 2);
    f(&mut b, 10.0);
    f(&mut b, 20.0);
    u(&mut b, 3);
    u(&mut b, 1);
    for v in [1.0, 2.0, 3.0, 4.0] {
        f(&mut b, v);
    }
    u(&mut b, 2);
    u(&mut b, 3);
    for v in [0.0, 0.0, 9.0, 0.0, 0.0, 9.0] {
        f(&mut b, v);
    }
    u(&mut b, 3);
    f(&mut b, 5.0);
    u(&mut b, 1);
    f(&mut b, 7.0);
    f(&mut b, 8.0);
    u(&mut b, 12); // the letters in Overlay
    f(&mut b, 0.5); // half their fill
    let effects_at = b.len();
    u(&mut b, 8);
    // An outer glow: yellow, Screen, Precise, size 5, spread 0.1, range 0.5.
    u(&mut b, 1);
    b.extend_from_slice(&[255, 255, 0, 255]);
    f(&mut b, 0.75);
    u(&mut b, 8); // screen
    u(&mut b, 1); // precise
    for v in [5.0, 0.1, 0.5, 0.0] {
        f(&mut b, v);
    }
    u(&mut b, 11); // seed
    u(&mut b, 0); // linear
    u(&mut b, 0); // its colour, not a gradient
                  // An inner glow from the centre, the Cone.
    u(&mut b, 2);
    b.extend_from_slice(&[255, 255, 255, 255]);
    f(&mut b, 1.0);
    u(&mut b, 0);
    u(&mut b, 0); // softer
    for v in [3.0, 0.0, 1.0, 0.25] {
        f(&mut b, v);
    }
    u(&mut b, 12);
    u(&mut b, 1); // the Cone
    u(&mut b, 1); // centre
    u(&mut b, 1); // a gradient
    gradient_record(&mut b);
    // An inner shadow.
    u(&mut b, 3);
    b.extend_from_slice(&[0, 0, 0, 255]);
    f(&mut b, 0.5);
    u(&mut b, 3); // multiply
    for v in [2.0, 3.0, 4.0, 0.2, 0.0] {
        f(&mut b, v);
    }
    u(&mut b, 13);
    u(&mut b, 0);
    // A colour overlay.
    u(&mut b, 4);
    b.extend_from_slice(&[0, 0, 255, 255]);
    f(&mut b, 0.5);
    u(&mut b, 0);
    // A centred stroke of 2 painted with the gradient.
    u(&mut b, 5);
    f(&mut b, 2.0);
    u(&mut b, 2);
    f(&mut b, 1.0);
    u(&mut b, 3);
    u(&mut b, 14);
    u(&mut b, 1);
    gradient_record(&mut b);
    // A gradient overlay (a Shape Burst noise gradient) and a pattern
    // overlay (a solid fill record).
    u(&mut b, 6);
    f(&mut b, 0.5);
    u(&mut b, 0);
    u(&mut b, 1);
    let noise_at = noise_gradient_record(&mut b);
    u(&mut b, 7);
    f(&mut b, 1.0);
    u(&mut b, 0);
    u(&mut b, 2);
    u(&mut b, 1);
    b.extend_from_slice(&[0, 0, 255, 255]);
    // A satin: Photoshop's own, black, Multiply, 50 %, 19 degrees, 11 away,
    // size 14, inverted and anti-aliased, the Gaussian.
    let satin_at = b.len();
    u(&mut b, 8);
    b.extend_from_slice(&[0, 0, 0, 255]);
    f(&mut b, 0.5);
    u(&mut b, 3);
    for v in [19.0, 11.0, 14.0] {
        f(&mut b, v);
    }
    u(&mut b, 3);
    u(&mut b, 5);
    u(&mut b, 0); // no page under them
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    (
        b,
        [
            opacity_at, blur_at, weight_at, mode_at, effects_at, noise_at, satin_at,
        ],
    )
}

#[test]
fn the_wire_form_decodes_to_the_box_it_states() {
    let (bytes, _) = wire(3);
    let r = decode_box(&bytes).unwrap();
    assert_eq!((r.width, r.height), (200, 160));
    assert_eq!(
        r.shadows,
        vec![Shadow {
            color: RED,
            opacity: 0.5,
            x: 6.0,
            y: -4.0,
            size: 3.0,
            grow: 0.0,
            spread: 0.25,
            noise: 0.5,
            blend: Blend::Multiply,
            knockout: true,
            contour: Some(Lut::new(&Curve::Preset(1))),
            seed: 7,
        }]
    );
    assert_eq!(r.blur, 1.5);
    assert_eq!(
        (r.blend, r.fill_opacity, r.backdrop.is_none()),
        (Blend::Overlay, 0.5, true)
    );
    assert_eq!(
        r.taps,
        vec![Tap {
            dx: 2.0,
            dy: 0.0,
            weight: 0.25
        }]
    );
    assert_eq!(
        r.clip,
        Some(Clip {
            mode: ClipMode::Exclude,
            origin: Pt::new(10.0, 20.0),
            shapes: vec![
                ClipShape::Ellipse {
                    centre: Pt::new(1.0, 2.0),
                    rx: 3.0,
                    ry: 4.0
                },
                ClipShape::Polygon(vec![
                    Pt::new(0.0, 0.0),
                    Pt::new(9.0, 0.0),
                    Pt::new(0.0, 9.0)
                ]),
                ClipShape::Stroke {
                    size: 5.0,
                    pts: vec![Pt::new(7.0, 8.0)]
                },
            ],
        })
    );
    assert_eq!(
        r.effects,
        vec![
            Effect::OuterGlow(Glow {
                color: Rgba([255, 255, 0, 255]),
                gradient: None,
                opacity: 0.75,
                blend: Blend::Screen,
                technique: Technique::Precise,
                size: 5.0,
                spread: 0.1,
                range: 0.5,
                noise: 0.0,
                contour: None,
                center: false,
                seed: 11,
            }),
            Effect::InnerGlow(Glow {
                color: Rgba([255, 255, 255, 255]),
                gradient: Some(gradient()),
                opacity: 1.0,
                blend: Blend::Normal,
                technique: Technique::Softer,
                size: 3.0,
                spread: 0.0,
                range: 1.0,
                noise: 0.25,
                contour: Some(Lut::new(&Curve::Preset(1))),
                center: true,
                seed: 12,
            }),
            Effect::InnerShadow(InnerShadow {
                color: BLACK,
                opacity: 0.5,
                blend: Blend::Multiply,
                x: 2.0,
                y: 3.0,
                size: 4.0,
                choke: 0.2,
                noise: 0.0,
                contour: None,
                seed: 13,
            }),
            Effect::ColorOverlay(Overlay {
                color: BLUE,
                opacity: 0.5,
                blend: Blend::Normal,
            }),
            Effect::Stroke(Stroke {
                size: 2.0,
                position: Position::Center,
                opacity: 1.0,
                blend: Blend::Multiply,
                paint: Paint::Gradient(gradient()),
                seed: 14,
            }),
            Effect::GradientOverlay(PaintOverlay {
                opacity: 0.5,
                blend: Blend::Normal,
                paint: Paint::Gradient(noise_gradient()),
            }),
            Effect::PatternOverlay(PaintOverlay {
                opacity: 1.0,
                blend: Blend::Normal,
                paint: Paint::Fill(Fill::Solid(BLUE)),
            }),
            Effect::Satin(Satin {
                color: BLACK,
                opacity: 0.5,
                blend: Blend::Multiply,
                angle: 19.0,
                distance: 11.0,
                size: 14.0,
                invert: true,
                contour: Some(Lut::new(&Curve::Preset(5))),
            }),
        ]
    );
    assert_eq!(r.request.face.font, 3);
    assert_eq!(r.request.job.runs[0].text, "HI");
    assert_eq!((BOX_MAGIC, BOX_WIRE_VERSION), (0x4250_544d, 7));
}

#[test]
fn a_damaged_box_is_refused_not_guessed_at() {
    let (good, [opacity_at, blur_at, weight_at, mode_at, effects_at, noise_at, satin_at]) = wire(1);
    assert!(decode_box(&good).is_ok());
    for len in 0..good.len() {
        assert!(decode_box(&good[..len]).is_err(), "accepted {len} bytes");
    }
    let mut long = good.clone();
    long.push(0);
    assert!(decode_box(&long).is_err());
    let with_f = |at: usize, v: f64| {
        let mut b = good.clone();
        b[at..at + 8].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    let with_u = |at: usize, v: u32| {
        let mut b = good.clone();
        b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        decode_box(&b).map(|_| ()).err()
    };
    for bad in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
        assert_eq!(
            with_f(opacity_at, bad),
            Some(Error::BadSpec),
            "opacity {bad}"
        );
        assert_eq!(with_f(weight_at, bad), Some(Error::BadSpec), "weight {bad}");
    }
    for bad in [-1.0, 4097.0, f64::NAN] {
        assert_eq!(with_f(blur_at, bad), Some(Error::BadSpec), "blur {bad}");
        // The shadow's own blur is three numbers past its opacity.
        assert_eq!(
            with_f(opacity_at + 24, bad),
            Some(Error::BadSpec),
            "shadow blur {bad}"
        );
        // And its grow, one past that.
        assert_eq!(
            with_f(opacity_at + 32, bad),
            Some(Error::BadSpec),
            "shadow grow {bad}"
        );
    }
    // A throw past the guard.
    assert_eq!(with_f(opacity_at + 8, 1e9), Some(Error::BadSpec));
    // A mode, a magic, a version and a surface that are not ones.
    assert_eq!(with_u(mode_at, 3), Some(Error::BadSpec));
    assert_eq!(with_u(0, MAGIC), Some(Error::BadSpec));
    assert_eq!(with_u(4, 1), Some(Error::BadSpec));
    assert_eq!(with_u(8, 0), Some(Error::BadSpec));
    assert_eq!(with_u(8, 1 << 20), Some(Error::BadSpec));
    // Counts past their guards, and counts the bytes cannot hold.
    assert_eq!(with_u(16, 17), Some(Error::BadSpec));
    assert_eq!(with_u(16, 2), Some(Error::BadSpec));
    assert_eq!(with_u(blur_at + 8, 513), Some(Error::BadSpec));
    assert_eq!(with_u(mode_at + 20, 4097), Some(Error::BadSpec));
    // A shape of no known kind.
    assert_eq!(with_u(mode_at + 24, 9), Some(Error::BadSpec));
    // An effect of no known kind, a technique and a glow source that are
    // not ones, and a range past 1.
    assert_eq!(with_u(effects_at + 4, 5), Some(Error::BadSpec));
    assert_eq!(with_u(effects_at + 24, 2), Some(Error::BadSpec));
    assert_eq!(with_f(effects_at + 44, 1.5), Some(Error::BadSpec));
    // The inner glow's source: past the outer glow's 68 bytes and its own 64,
    // and its gradient flag after it.
    assert_eq!(with_u(effects_at + 136, 2), Some(Error::BadSpec));
    assert_eq!(with_u(effects_at + 140, 2), Some(Error::BadSpec));
    // A gradient style that is not one, and a stop past the end.
    assert_eq!(with_u(effects_at + 144, 6), Some(Error::BadSpec));
    assert_eq!(with_f(effects_at + 188, 1.5), Some(Error::BadSpec));
    // A gradient type that is not one: the inner glow's, after its two
    // colour stops and two opacity stops.
    assert_eq!(with_u(effects_at + 144 + 104, 2), Some(Error::BadSpec));
    // A noise record's Roughness past 1, a model that is not one, a limit
    // whose min is past its max, and flags that are not ones.
    assert_eq!(with_f(noise_at + 4, 1.5), Some(Error::BadSpec));
    assert_eq!(with_u(noise_at + 12, 3), Some(Error::BadSpec));
    assert_eq!(with_f(noise_at + 16 + 16, 0.9), Some(Error::BadSpec));
    assert_eq!(with_u(noise_at + 16 + 48, 4), Some(Error::BadSpec));
    // A satin's distance below 0, its size past the guard, flags that are not
    // ones and a contour that does not exist.
    assert_eq!(with_f(satin_at + 28, -1.0), Some(Error::BadSpec));
    assert_eq!(with_f(satin_at + 36, 4097.0), Some(Error::BadSpec));
    assert_eq!(with_u(satin_at + 44, 4), Some(Error::BadSpec));
    assert_eq!(with_u(satin_at + 48, 12), Some(Error::BadSpec));
}

#[test]
fn a_box_read_from_the_wire_paints() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let (bytes, _) = wire(font);
    let mut b = decode_box(&bytes).unwrap();
    let r = paint(&mut e, &mut b);
    assert!(r.width > 0 && r.x >= 0 && r.y >= 0);
    // A font the engine does not hold is its own error.
    let (bytes, _) = wire(999);
    let mut b = decode_box(&bytes).unwrap();
    assert_eq!(paint_box(&mut e, &mut b).err(), Some(Error::UnknownFont));
}

/// The Blending Options at their defaults: Normal, the whole fill, no
/// effects, no page.
fn no_blending(b: &mut Vec<u8>) {
    u(b, 0);
    f(b, 1.0);
    u(b, 0);
    u(b, 0);
}

/// A box job on the wire with `n` shadows, each thrown a little further, and
/// nothing else laid on it.
fn shadowed(font: u32, n: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, n);
    for i in 0..n {
        b.extend_from_slice(&[255, 0, 0, 255]);
        for v in [0.5, 2.0 + f64::from(i % 4), 2.0, 1.0, 0.0, 0.0, 0.0] {
            f(&mut b, v);
        }
        // Normal, no flags, seed 0, Linear.
        for v in [0, 0, 0, 0] {
            u(&mut b, v);
        }
    }
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 0);
    no_blending(&mut b);
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    b
}

#[test]
fn a_box_has_every_shadow_its_style_has() {
    // The app counts no shadows: a style may hold as many as a person adds,
    // and the canvas paints each. The decoder once stopped at 16, and the
    // 17th made the box one the engine would not paint at all.
    let mut e = Engine::new();
    let font = load(&mut e);
    for n in [16, 17, 64] {
        let mut b = decode_box(&shadowed(font, n)).unwrap();
        assert_eq!(b.shadows.len(), n as usize);
        let r = paint(&mut e, &mut b);
        assert!(
            r.data
                .chunks_exact(4)
                .any(|p| is_red(p.try_into().unwrap())),
            "{n}"
        );
    }
    // A count the bytes cannot hold is still refused before anything is
    // allocated.
    let mut b = shadowed(font, 17);
    b[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(decode_box(&b).map(|_| ()).err(), Some(Error::BadSpec));
}

/// A box job on the wire masked by `shapes` dots far off the lettering, the
/// last of them a stroke of `points` points, so what is cut is nothing.
fn masked(font: u32, shapes: u32, points: u32) -> Vec<u8> {
    let mut b = Vec::new();
    u(&mut b, BOX_MAGIC);
    u(&mut b, BOX_WIRE_VERSION);
    u(&mut b, 200);
    u(&mut b, 160);
    u(&mut b, 0);
    f(&mut b, 0.0);
    u(&mut b, 0);
    u(&mut b, 2);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    u(&mut b, shapes + 1);
    for i in 0..shapes {
        u(&mut b, 1);
        for v in [-500.0 - f64::from(i % 50), -500.0, 1.0, 1.0] {
            f(&mut b, v);
        }
    }
    u(&mut b, 3);
    f(&mut b, 1.0);
    u(&mut b, points);
    for i in 0..points {
        f(&mut b, -900.0 - f64::from(i % 7));
        f(&mut b, -900.0);
    }
    no_blending(&mut b);
    let job = job_bytes(font);
    u(&mut b, job.len() as u32);
    b.extend_from_slice(&job);
    b
}

#[test]
fn a_box_has_every_mask_shape_its_style_has() {
    // The app counts no mask strokes, nor the points in one: the canvas
    // paints a mask of any size. The decoder once stopped at 4096 shapes and
    // 65536 points, and one more made the box one the engine would not paint.
    let mut e = Engine::new();
    let font = load(&mut e);
    for (shapes, points) in [(4096, 8), (5000, 8), (8, 70_000)] {
        let mut b = decode_box(&masked(font, shapes, points)).unwrap();
        assert_eq!(b.clip.as_ref().unwrap().shapes.len(), shapes as usize + 1);
        let r = paint(&mut e, &mut b);
        assert!(
            r.data.chunks_exact(4).any(|p| p[3] > 0),
            "{shapes} shapes, {points} points"
        );
    }
}

// ---- Photoshop's Drop Shadow options and Blending Options ----

/// The H's left stem, a pixel in from its left edge, half way down: inside
/// the letter wherever the job is painted.
fn stem(glyphs: (i32, i32, i32, i32)) -> (i32, i32) {
    (glyphs.0 + 3, (glyphs.1 + glyphs.3) / 2)
}

#[test]
fn spread_hardens_the_edge_the_size_softens() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    let soft = |spread: f64, e: &mut Engine, b: &mut BoxRequest| {
        b.shadows = vec![Shadow {
            size: 10.0,
            spread,
            ..shadow(RED, 0.0, 60.0)
        }];
        paint(e, b)
    };
    let none = soft(0.0, &mut e, &mut b);
    let full = soft(1.0, &mut e, &mut b);
    // At full spread the matte is grown by the whole size and not blurred:
    // a shadow pixel 5 past the stem's edge is solid, where the blurred one
    // is faint.
    let (x, y) = (glyphs.0 - 5, (glyphs.1 + glyphs.3) / 2 + 60);
    assert_eq!(px(&full, x, y)[3], 255, "{:?}", px(&full, x, y));
    assert!(px(&none, x, y)[3] < 128, "{:?}", px(&none, x, y));
    // Both reach about as far: the size is the reach either way.
    let reach = |r: &Raster| glyphs.0 - boxed(r, |p| p[3] > 0 && p[0] > 128).0;
    assert!(
        (reach(&none) - reach(&full)).abs() <= 2,
        "{} {}",
        reach(&none),
        reach(&full)
    );
}

#[test]
fn a_contour_reshapes_the_falloff_and_noise_grains_it_the_same_every_time() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.shadows = vec![Shadow {
        size: 16.0,
        ..shadow(RED, 0.0, 60.0)
    }];
    let linear = paint(&mut e, &mut b);
    b.shadows[0].contour = Some(Lut::new(&Curve::Preset(2)));
    let cone = paint(&mut e, &mut b);
    assert_ne!(linear, cone);
    b.shadows[0].contour = None;
    b.shadows[0].noise = 0.8;
    b.shadows[0].seed = 5;
    let grain = paint(&mut e, &mut b);
    assert_ne!(grain, linear);
    assert_eq!(paint(&mut e, &mut b), grain);
    b.shadows[0].seed = 6;
    assert_ne!(paint(&mut e, &mut b), grain);
}

#[test]
fn fill_opacity_fades_the_fill_and_not_its_outline_or_shadow() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.request.job.bands = vec![mt_text::paint::Band {
        color: BLUE,
        opacity: 1.0,
        line: 6.0,
    }];
    let full = paint(&mut e, &mut b);
    let glyphs = inked(&full);
    b.fill_opacity = 0.25;
    let faded = paint(&mut e, &mut b);
    let (x, y) = stem(glyphs);
    let p = px(&faded, x + 3, y);
    assert!((60..=68).contains(&p[3]) && p[0] < 20, "the fill: {p:?}");
    // The outline is whole outside the letter, and none of its inner half
    // shows through the faded fill.
    assert_eq!(px(&faded, glyphs.0 + 1, y), px(&full, glyphs.0 + 1, y));
    assert!(px(&faded, x + 3, y)[2] < 20);
    // A shadow under it is cut out where the letters knock it out.
    b.shadows = vec![Shadow {
        knockout: true,
        ..shadow(RED, 2.0, 0.0)
    }];
    let knocked = paint(&mut e, &mut b);
    assert!(
        px(&knocked, x + 3, y)[0] < 20,
        "{:?}",
        px(&knocked, x + 3, y)
    );
    b.shadows[0].knockout = false;
    let through = paint(&mut e, &mut b);
    assert!(
        px(&through, x + 3, y)[0] > 128,
        "{:?}",
        px(&through, x + 3, y)
    );
}

#[test]
fn a_mode_blends_with_the_page_it_is_given() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let plain_r = paint(&mut e, &mut b);
    let (x, y) = stem(inked(&plain_r));
    b.request.job.fill = Some(Fill::Solid(Rgba([128, 128, 128, 255])));
    b.blend = Blend::Multiply;
    // With no page, a mode has nothing to blend with: Normal.
    let alone = paint(&mut e, &mut b);
    assert_eq!(px(&alone, x, y), [128, 128, 128, 255]);
    // Over a page of mid red the grey multiplies it.
    let mut page = vec![0u8; 200 * 160 * 4];
    for p in page.chunks_exact_mut(4) {
        p.copy_from_slice(&[200, 100, 50, 255]);
    }
    b.backdrop = Some(page);
    let mixed = paint(&mut e, &mut b);
    let p = px(&mixed, x, y);
    for (k, want) in [100u8, 50, 25].into_iter().enumerate() {
        assert!(p[k].abs_diff(want) <= 1, "{p:?}");
    }
    // A shadow in Screen lightens the page where it falls.
    b.blend = Blend::Normal;
    b.shadows = vec![Shadow {
        blend: Blend::Screen,
        color: Rgba([0, 0, 255, 255]),
        ..shadow(BLUE, 0.0, 50.0)
    }];
    let lit = paint(&mut e, &mut b);
    let p = px(&lit, x, y + 50);
    assert_eq!(&p[..], &[200, 100, 255, 255]);
}

#[test]
fn black_multiply_and_an_unseen_knockout_take_the_quick_path() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    b.shadows = vec![shadow(BLACK, 4.0, 4.0)];
    let quick = paint(&mut e, &mut b);
    b.shadows[0].blend = Blend::Multiply;
    b.shadows[0].knockout = true;
    assert_eq!(paint(&mut e, &mut b), quick);
}

fn glow(color: Rgba, size: f64) -> Glow {
    Glow {
        color,
        gradient: None,
        opacity: 1.0,
        blend: Blend::Normal,
        technique: Technique::Softer,
        size,
        spread: 0.0,
        range: 0.5,
        noise: 0.0,
        contour: None,
        center: false,
        seed: 1,
    }
}

#[test]
fn an_outer_glow_lies_round_the_letters_and_not_on_them() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let glyphs = inked(&paint(&mut e, &mut b));
    b.effects = vec![Effect::OuterGlow(glow(RED, 8.0))];
    let r = paint(&mut e, &mut b);
    let lit = inked(&r);
    // It reaches about its size past the letters, and no further.
    let reach = glyphs.0 - lit.0;
    assert!((6..=10).contains(&reach), "{reach}");
    // Strong red against the stem (a tent of 8 keeps a third of the edge a
    // pixel and a half out, which the Range of 50 % doubles); the letters
    // stay black over it.
    let (sx, sy) = stem(glyphs);
    let red = |p: [u8; 4]| p[3] > 150 && p[0] == 255 && p[1] == 0;
    assert!(
        red(px(&r, glyphs.0 - 1, sy)),
        "{:?}",
        px(&r, glyphs.0 - 1, sy)
    );
    assert!(is_black(px(&r, sx, sy)));
    // At Fill Opacity 0 the glow is kept from behind the letters.
    b.fill_opacity = 0.0;
    let r = paint(&mut e, &mut b);
    assert!(px(&r, sx, sy)[3] < 40, "{:?}", px(&r, sx, sy));
    assert!(red(px(&r, glyphs.0 - 1, sy)));
}

#[test]
fn a_colour_overlay_recolours_the_letters_and_nothing_else() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let plain_r = paint(&mut e, &mut b);
    b.effects = vec![Effect::ColorOverlay(Overlay {
        color: BLUE,
        opacity: 1.0,
        blend: Blend::Normal,
    })];
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), inked(&plain_r));
    let (sx, sy) = stem(inked(&plain_r));
    assert_eq!(px(&r, sx, sy), [0, 0, 255, 255]);
    // The edge keeps its coverage.
    let diff = alpha_sum(&r).abs_diff(alpha_sum(&plain_r));
    assert!(diff * 200 < alpha_sum(&plain_r), "{diff}");
    // Still there at Fill Opacity 0, as Photoshop's are.
    b.fill_opacity = 0.0;
    let r = paint(&mut e, &mut b);
    assert_eq!(px(&r, sx, sy), [0, 0, 255, 255]);
}

#[test]
fn an_inner_glow_and_an_inner_shadow_stay_inside_the_letters() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let plain_r = paint(&mut e, &mut b);
    let glyphs = inked(&plain_r);
    b.effects = vec![Effect::InnerGlow(Glow {
        size: 2.0,
        ..glow(Rgba([255, 255, 255, 255]), 2.0)
    })];
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), glyphs);
    let (_, sy) = stem(glyphs);
    // White at the stem's inside edge.
    let edge = px(&r, glyphs.0, sy);
    assert!(edge[0] > 150 && edge[0] == edge[2], "{edge:?}");
    b.effects = vec![Effect::InnerShadow(InnerShadow {
        color: RED,
        opacity: 1.0,
        blend: Blend::Normal,
        x: 3.0,
        y: 0.0,
        size: 0.0,
        choke: 0.0,
        noise: 0.0,
        contour: None,
        seed: 1,
    })];
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), glyphs);
    // Thrown right: red along the stem's left inside edge, black past it.
    assert!(
        is_red(px(&r, glyphs.0 + 1, sy)),
        "{:?}",
        px(&r, glyphs.0 + 1, sy)
    );
    assert!(
        is_black(px(&r, glyphs.0 + 5, sy)),
        "{:?}",
        px(&r, glyphs.0 + 5, sy)
    );
}

#[test]
fn a_satin_stays_inside_the_letters_and_turns_with_the_box() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let mut b = plain(font);
    let plain_r = paint(&mut e, &mut b);
    let glyphs = inked(&plain_r);
    let satin = |angle: f64| Satin {
        color: RED,
        opacity: 1.0,
        blend: Blend::Normal,
        angle,
        distance: 2.0,
        size: 0.0,
        invert: false,
        contour: None,
    };
    // Thrown across: red down the stem's left inside edge, black past it.
    b.effects = vec![Effect::Satin(satin(0.0))];
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), glyphs);
    let (_, sy) = stem(glyphs);
    assert!(
        is_red(px(&r, glyphs.0 + 1, sy)),
        "{:?}",
        px(&r, glyphs.0 + 1, sy)
    );
    assert!(is_black(px(&r, glyphs.0 + 4, sy)));
    // Thrown up and down instead, the stem's side is left black.
    b.effects = vec![Effect::Satin(satin(90.0))];
    let r = paint(&mut e, &mut b);
    assert!(
        is_black(px(&r, glyphs.0 + 1, sy)),
        "{:?}",
        px(&r, glyphs.0 + 1, sy)
    );
    // A quarter turn carries the across throw to up and down on the page:
    // the turned stems' long sides run across, and are lit.
    let turn = Affine::translate(100.0, 80.0)
        .after(&Affine::rotate(0.0, 1.0))
        .after(&Affine::translate(-100.0, -80.0));
    b.request.transform = turn;
    b.effects = Vec::new();
    let turned = paint(&mut e, &mut b);
    let tg = inked(&turned);
    b.effects = vec![Effect::Satin(satin(0.0))];
    let r = paint(&mut e, &mut b);
    assert_eq!(inked(&r), tg);
    // Its second row (the first is the stem's soft edge), where the
    // first stem lies across, is red.
    let row: Vec<[u8; 4]> = (tg.0..tg.2).map(|x| px(&r, x, tg.1 + 1)).collect();
    let lit = row.iter().filter(|p| is_red(**p)).count();
    let solid = row.iter().filter(|p| p[3] > 200).count();
    assert!(solid > 10 && lit * 10 > solid * 8, "{row:?}");
}
