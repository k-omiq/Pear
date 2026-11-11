//! The special effects (glyph wire v15, plan 8.2): seeded patterns over the
//! whole box, made in the engine from their numbers.

#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::effects::{Effect, Paint, Position, Stroke};
use mt_text::paint::kept;
use mt_text::paint::special::{letter_shapes, lightning_marks, BreakOff, Motion, BREAK_DROP, BREAK_SIDE};
use mt_text::paint::{
    paint_box, Affine, Align, Band, BoxRequest, Crack, Effects, Fill, Job, Lightning, Raster, Request, Rgba, Run, Scratches,
    Special, Splash,
};
use mt_text::{Engine, Face, FontId};
use std::rc::Rc;

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);
const SIZE: f64 = 60.0;

fn load(engine: &mut Engine) -> FontId {
    let path = format!("{}/../src/test/fonts/DejaVuSans.ttf", env!("CARGO_MANIFEST_DIR"));
    engine.add_font_bytes(std::fs::read(path).unwrap(), 0).unwrap()
}

fn run(text: &str, x: f64, y: f64) -> Run {
    Run {
        text: text.to_owned(),
        x,
        y,
        rot: 0.0,
        sx: 1.0,
        sy: 1.0,
        skew: 0.0,
        drip: 0.0,
        pen: 1.0,
        ghost: false,
        fill: None,
    }
}

/// Red "HELLO" at 60 on a 360 by 160 box, with `special` over it.
fn boxed(font: FontId, special: Option<Special>) -> BoxRequest {
    BoxRequest::new(
        360,
        160,
        Request {
            job: Job {
                curved: false,
                align: Align::Left,
                letter_spacing: 0.0,
                bands: Vec::new(),
                silhouette: None,
                no_fill: false,
                fill: Some(Fill::Solid(RED)),
                mesh: None,
                roughen: None,
                effects: Effects { special, ..Effects::default() },
                runs: vec![run("HELLO", 40.0, 100.0)],
            },
            face: Face::new(font, SIZE),
            bold_draw: None,
            weight: 0.0,
            transform: Affine::IDENTITY,
            tiles: Vec::new(),
            ink: None,
            faces: Default::default(),
        },
    )
}

/// A lightning with a white core in a blue glow.
fn bolt(amount: f64, seed: u32) -> Lightning {
    Lightning { amount, core: Rgba([255, 255, 255, 255]), glow: BLUE, glow_size: 1.0, seed }
}

/// `only`, over a box drawn tight round the letters, as the app's is.
fn tight(f: impl FnOnce(&mut Special)) -> Option<Special> {
    only(|s| {
        s.rect = [40.0, 45.0, 190.0, 60.0];
        f(s)
    })
}

fn only(f: impl FnOnce(&mut Special)) -> Option<Special> {
    let mut sp = Special { rect: [0.0, 0.0, 360.0, 160.0], crack: None, break_off: None, lightning: None, splash: None, scratches: None };
    f(&mut sp);
    Some(sp)
}

fn paint(engine: &mut Engine, mut b: BoxRequest) -> Raster {
    b.lay_special_paint().unwrap();
    paint_box(engine, &mut b).unwrap().expect("something painted")
}

fn ink(r: &Raster) -> u64 {
    r.data.chunks_exact(4).map(|p| u64::from(p[3])).sum()
}

fn at(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (i, j) = (x - r.x, y - r.y);
    if i < 0 || j < 0 || i >= r.width as i32 || j >= r.height as i32 {
        return [0; 4];
    }
    let k = (j as usize * r.width as usize + i as usize) * 4;
    [r.data[k], r.data[k + 1], r.data[k + 2], r.data[k + 3]]
}

#[test]
fn a_crack_cuts_and_past_sixty_percent_pieces_fall_out() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let plain = ink(&paint(&mut engine, boxed(font, None)));
    let crack = |a| only(|s| s.crack = Some(Crack { amount: a, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }));
    let light = ink(&paint(&mut engine, boxed(font, crack(0.3))));
    let heavy = ink(&paint(&mut engine, boxed(font, crack(0.59))));
    let falls = ink(&paint(&mut engine, boxed(font, crack(1.0))));
    assert!(light < plain, "a crack takes ink away");
    assert!(heavy < light);
    // Pieces fall: far more is gone past 60 % than the lines alone take.
    assert!((plain - falls) as f64 > 1.5 * (plain - heavy) as f64, "{plain} {heavy} {falls}");
    // Never all of it.
    assert!(falls > plain / 3);
}

#[test]
fn the_same_seed_is_the_same_picture_and_another_is_another() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let sc = |seed| only(|s| s.scratches = Some(Scratches { amount: 0.6, angle: 0.2, seed }));
    let a = paint(&mut engine, boxed(font, sc(1)));
    kept::clear();
    let b = paint(&mut engine, boxed(font, sc(1)));
    let c = paint(&mut engine, boxed(font, sc(2)));
    assert_eq!(a.data, b.data);
    assert_ne!(a.data, c.data);
}

#[test]
fn a_moved_box_paints_the_same_pattern_where_it_went() {
    // The box job's coordinates are the box's own: a move is a whole-pixel
    // shift of the transform, and the picture shifts with it to the byte.
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let all = only(|s| {
        s.crack = Some(Crack { amount: 0.8, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 7 });
        s.splash = Some(Splash { amount: 0.5, size: 0.6, color: BLUE, seed: 7 });
        s.scratches = Some(Scratches { amount: 0.5, angle: 0.4, seed: 7 });
    });
    let here = paint(&mut engine, boxed(font, all));
    let mut moved = boxed(font, all);
    moved.request.transform = Affine::translate(17.0, 9.0);
    moved.width += 17;
    moved.height += 9;
    let there = paint(&mut engine, moved);
    assert_eq!((there.x - here.x, there.y - here.y), (17, 9));
    assert_eq!((there.width, there.height), (here.width, here.height));
    assert_eq!(there.data, here.data);
}

#[test]
fn the_shapes_are_kept_under_their_numbers() {
    let sp = only(|s| s.crack = Some(Crack { amount: 0.5, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 })).unwrap();
    let a = letter_shapes(&sp, SIZE, (10.0, 20.0, 200.0, 90.0)).unwrap();
    let b = letter_shapes(&sp, SIZE, (10.0, 20.0, 200.0, 90.0)).unwrap();
    assert!(Rc::ptr_eq(&a, &b), "read back, not made again");
    let l = bolt(0.5, 1);
    let m = lightning_marks(&l, [0.0, 0.0, 360.0, 160.0], SIZE);
    // A move of the box (its corner) keeps the same bolts.
    let n = lightning_marks(&l, [50.0, 30.0, 360.0, 160.0], SIZE);
    assert!(Rc::ptr_eq(&m, &n));
}

#[test]
fn lightning_and_splash_paint_on_the_fill_and_nowhere_else() {
    // Both are paint on the letters' fill: the picture is as big as the
    // plain one, nothing lands outside the letters, and their colours show.
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let plain = paint(&mut engine, boxed(font, None));
    let lit = paint(&mut engine, boxed(font, only(|s| s.lightning = Some(bolt(1.0, 4)))));
    let green = Rgba([0, 200, 0, 255]);
    let splashed = paint(&mut engine, boxed(font, tight(|s| s.splash = Some(Splash { amount: 0.6, size: 1.0, color: green, seed: 5 }))));
    for (name, r) in [("lightning", &lit), ("splash", &splashed)] {
        assert_eq!((r.x, r.y, r.width, r.height), (plain.x, plain.y, plain.width, plain.height), "{name}");
        let outside = plain.data.chunks_exact(4).zip(r.data.chunks_exact(4)).filter(|(p, q)| p[3] == 0 && q[3] != 0).count();
        assert_eq!(outside, 0, "{name}");
    }
    let count = |r: &Raster, f: &dyn Fn(&[u8]) -> bool| r.data.chunks_exact(4).filter(|q| q[3] == 255 && f(q)).count();
    let blue = count(&lit, &|q| q[2] > 200 && q[0] < 80);
    let white = count(&lit, &|q| q[0] > 240 && q[1] > 240 && q[2] > 240);
    assert!(blue > 100, "{blue}");
    // The bright core.
    assert!(white > 30, "{white}");
    let painted = count(&splashed, &|q| q[1] > 150 && q[0] < 60 && q[2] < 60);
    assert!(painted > 300, "{painted}");
}

#[test]
fn every_effect_reads_at_a_fifth() {
    // At 20 % on a 60 px letter each effect changes a clear share of the
    // letters.
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let plain = paint(&mut engine, boxed(font, None));
    let lit = paint(&mut engine, boxed(font, tight(|s| s.lightning = Some(bolt(0.2, 4)))));
    let splashed = paint(&mut engine, boxed(font, tight(|s| s.splash = Some(Splash { amount: 0.2, size: 1.0, color: BLUE, seed: 5 }))));
    let solid = plain.data.chunks_exact(4).filter(|p| p[3] == 255).count();
    for (name, r) in [("lightning", &lit), ("splash", &splashed)] {
        let changed = plain.data.chunks_exact(4).zip(r.data.chunks_exact(4)).filter(|(p, q)| p[3] == 255 && p[..3] != q[..3]).count();
        assert!(changed * 50 > solid, "{name} changes {changed} of {solid}");
    }
}

#[test]
fn a_box_with_none_is_the_box_it_was() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let plain = paint(&mut engine, boxed(font, None));
    // Amount 0 draws nothing.
    let zero = paint(&mut engine, boxed(font, only(|s| s.crack = Some(Crack { amount: 0.0, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }))));
    assert_eq!(plain.data, zero.data);
}

#[test]
fn a_crack_gathers_at_its_focus_or_spreads_over_the_word() {
    // Focused on the first letter with a small spread, every cut is near
    // it; spread over all, cuts reach the far end of the word.
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let plain = paint(&mut engine, boxed(font, None));
    let of = |at, spread| only(|s| s.crack = Some(Crack { amount: 0.5, size: 1.0, at, spread, seed: 3 }));
    let cut_cols = |r: &Raster| -> Vec<i32> {
        (plain.x..plain.x + plain.width as i32)
            .filter(|&x| (plain.y..plain.y + plain.height as i32).any(|y| at(&plain, x, y)[3] == 255 && at(r, x, y)[3] < 128))
            .collect()
    };
    let near = paint(&mut engine, boxed(font, of((0.05, 0.5), 0.1)));
    let wide = paint(&mut engine, boxed(font, of((0.05, 0.5), 1.0)));
    let (n, w) = (cut_cols(&near), cut_cols(&wide));
    let third = plain.x + plain.width as i32 / 3;
    assert!(!n.is_empty() && n.iter().all(|&x| x < third), "focused cuts reach {:?}", n.last());
    assert!(w.iter().any(|&x| x > plain.x + 2 * plain.width as i32 / 3), "spread cuts stop at {:?}", w.last());
}

#[test]
fn a_crack_cuts_a_box_stroke_through_as_it_cuts_a_band() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let crack = only(|s| s.crack = Some(Crack { amount: 0.7, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }));
    // A black outline 4 wide outside the letters: a glyph band, whose pen
    // is centred on the outline, or the box's own stroke.
    let banded = |sp: Option<Special>| {
        let mut b = boxed(font, sp);
        b.request.job.bands = vec![Band { color: BLACK, opacity: 1.0, line: 8.0 }];
        b
    };
    let stroked = |sp: Option<Special>| {
        let mut b = boxed(font, sp);
        b.effects = vec![Effect::Stroke(Stroke {
            size: 4.0,
            position: Position::Outside,
            opacity: 1.0,
            blend: Blend::Normal,
            paint: Paint::Fill(Fill::Solid(BLACK)),
            seed: 0,
        })];
        b
    };
    // What the crack clears: whole before, near nothing after.
    let cleared = |whole: &Raster, cut: &Raster| -> Vec<(i32, i32)> {
        let mut out = Vec::new();
        for y in 0..160 {
            for x in 0..360 {
                if at(whole, x, y)[3] > 200 && at(cut, x, y)[3] < 55 {
                    out.push((x, y));
                }
            }
        }
        out
    };
    let band = cleared(&paint(&mut engine, banded(None)), &paint(&mut engine, banded(crack)));
    let stroke = cleared(&paint(&mut engine, stroked(None)), &paint(&mut engine, stroked(crack)));
    let both = band.iter().filter(|p| stroke.contains(p)).count();
    let either = band.len() + stroke.len() - both;
    assert!(band.len() > 200, "the crack cuts the band: {}", band.len());
    assert!(both as f64 > 0.9 * either as f64, "band {} stroke {} both {both}", band.len(), stroke.len());
}

fn breaking(share: f64, motion: Motion, at: (f64, f64), spread: f64) -> Option<Special> {
    tight(|s| {
        s.crack = Some(Crack { amount: 0.8, size: 1.0, at, spread, seed: 3 });
        s.break_off = Some(BreakOff { share, motion });
    })
}

#[test]
fn pieces_break_off_the_same_cracks_and_never_past_the_padding() {
    const INK: (f64, f64, f64, f64) = (40.0, 55.0, 230.0, 100.0);
    let crack_only = tight(|s| s.crack = Some(Crack { amount: 0.8, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 })).unwrap();
    let cuts = letter_shapes(&crack_only, SIZE, INK).unwrap();
    assert!(cuts.pieces.is_empty());
    for motion in [Motion::Apart, Motion::Fall] {
        let mut last = 0;
        for share in [0.25, 0.5, 0.75, 1.0] {
            let sp = breaking(share, motion, (0.5, 0.5), 1.0).unwrap();
            let sh = letter_shapes(&sp, SIZE, INK).unwrap();
            // The crack lines are the same whatever breaks off.
            assert_eq!(sh.cuts.pts, cuts.cuts.pts);
            assert!(sh.pieces.len() > last, "{motion:?} {share}: more pieces as it goes up");
            last = sh.pieces.len();
            let down = sp.rect[3] + BREAK_DROP * SIZE;
            let side = BREAK_SIDE * SIZE;
            for p in &sh.pieces {
                let Some(m) = p.moved else {
                    assert_eq!(motion, Motion::Fall, "only a fall loses pieces");
                    continue;
                };
                for &v in &p.outline {
                    let d = m.apply(v).minus(v);
                    assert!(d.x.abs() <= side + 1e-9 && d.y >= -side - 1e-9 && d.y <= down + 1e-9, "{motion:?}: {d:?}");
                }
            }
        }
    }
}

#[test]
fn the_densest_cracks_break_first() {
    // A long line of letters, the cracks over all of it and gathered at the
    // left: the first pieces to break lie at the left.
    const INK: (f64, f64, f64, f64) = (0.0, 0.0, 1200.0, 300.0);
    let sp = Special {
        rect: [0.0, 0.0, 1200.0, 300.0],
        crack: Some(Crack { amount: 0.8, size: 1.0, at: (0.05, 0.5), spread: 1.0, seed: 3 }),
        break_off: Some(BreakOff { share: 0.1, motion: Motion::Apart }),
        lightning: None,
        splash: None,
        scratches: None,
    };
    let sh = letter_shapes(&sp, SIZE, INK).unwrap();
    assert!(sh.pieces.len() >= 3);
    let mean = sh.pieces.iter().map(|p| p.outline.iter().map(|v| v.x).sum::<f64>() / p.outline.len() as f64).sum::<f64>()
        / sh.pieces.len() as f64;
    assert!(mean < 400.0, "the first pieces are not at the focus: {mean}");
}

#[test]
fn a_piece_moves_with_its_fill_and_bands_and_the_hole_is_clean() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let banded = |sp: Option<Special>| {
        let mut b = boxed(font, sp);
        b.request.job.bands = vec![Band { color: BLACK, opacity: 1.0, line: 6.0 }];
        b
    };
    let crack = paint(&mut engine, banded(tight(|s| s.crack = Some(Crack { amount: 0.8, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }))));
    for motion in [Motion::Apart, Motion::Fall] {
        let a = paint(&mut engine, banded(breaking(0.75, motion, (0.5, 0.5), 1.0)));
        let b = paint(&mut engine, banded(breaking(0.75, motion, (0.5, 0.5), 1.0)));
        assert_eq!((a.x, a.y, a.width, a.height, &a.data), (b.x, b.y, b.width, b.height, &b.data), "the same numbers, the same picture");
        // Ink where the crack alone has none, red and black both: a piece
        // moved there with its fill and its band.
        let (mut red, mut black, mut holes) = (0, 0, 0);
        for y in 0..160 {
            for x in 0..360 {
                let (p, q) = (at(&a, x, y), at(&crack, x, y));
                if p[3] > 200 && q[3] == 0 {
                    if p[0] > 200 && p[1] < 60 {
                        red += 1;
                    } else if p[0] < 60 && p[1] < 60 && p[2] < 60 {
                        black += 1;
                    }
                }
                if q[3] > 200 && p[3] == 0 {
                    holes += 1;
                }
            }
        }
        assert!(red > 40 && black > 20 && holes > 40, "{motion:?}: red {red} black {black} holes {holes}");
    }
    // Falling, pieces lie below the letters' ink.
    let fall = paint(&mut engine, banded(breaking(1.0, Motion::Fall, (0.5, 0.5), 1.0)));
    let low = (0..160).rev().find(|&y| (0..360).any(|x| at(&crack, x, y)[3] > 0)).unwrap();
    let below: usize = (low + 3..160).map(|y| (0..360).filter(|&x| at(&fall, x, y)[3] > 128).count()).sum();
    assert!(below > 40, "below {below}");
}
