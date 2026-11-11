//! The special effects (glyph wire v15, plan 8.2): seeded patterns over the
//! whole box, made in the engine from their numbers.

#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::bevel::{BevelStyle, BevelTechnique};
use mt_text::paint::fx::effects::{Bevel, Effect, Overlay, Paint, Position, Stroke};
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

/// A crack at its largest under a black box stroke 12 wide, outside: 200 px
/// "KRAK" over a box 650 by 320 at `scale`.
fn largest_under_stroke(font: FontId, scale: f64, break_off: Option<BreakOff>) -> BoxRequest {
    let mut b = largest(font, scale, break_off);
    b.effects = vec![Effect::Stroke(Stroke {
        size: 12.0,
        position: Position::Outside,
        opacity: 1.0,
        blend: Blend::Normal,
        paint: Paint::Fill(Fill::Solid(BLACK)),
        seed: 0,
    })];
    b
}

/// A crack at its largest (amount 1, size 400 %, over every letter): 200 px
/// "KRAK" over a box 650 by 320 at `scale`.
fn largest(font: FontId, scale: f64, break_off: Option<BreakOff>) -> BoxRequest {
    let (w, h) = ((650.0 * scale) as u32, (320.0 * scale) as u32);
    let mut b = boxed(font, None);
    b.width = w;
    b.height = h;
    b.request.face = Face::new(font, 200.0);
    b.request.transform = Affine::scale(scale, scale);
    b.request.job.runs = vec![run("KRAK", 20.0, 250.0)];
    b.request.job.effects.special = Some(Special {
        rect: [0.0, 0.0, 650.0, 320.0],
        crack: Some(Crack { amount: 1.0, size: 4.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }),
        break_off,
        lightning: None,
        splash: None,
        scratches: None,
    });
    b
}

#[test]
fn the_largest_crack_broken_off_paints_close_up() {
    // Every piece broken off a crack at its largest, at scale 4, no
    // stroke: the pieces' outlines follow the crack's arms, some 31M device
    // pixels round the letters (once 84 MB of coverage, all kept). Only
    // what lies on the surface is rastered: everything the paint keeps fits
    // in a few surfaces' worth of bytes.
    use mt_text::paint::kept;
    let mut engine = Engine::new();
    let font = load(&mut engine);
    kept::set_ceiling(1 << 30);
    let surface = 2600 * 1280;
    for motion in [Motion::Fall, Motion::Apart] {
        kept::clear();
        let r = paint(&mut engine, largest(font, 4.0, Some(BreakOff { share: 1.0, motion })));
        assert!(ink(&r) > 0, "{motion:?}");
        assert!(r.x >= 0 && r.y >= 0 && r.x + r.width as i32 <= 2600 && r.y + r.height as i32 <= 1280, "{motion:?}");
        assert!(kept::bytes() < 8 * surface, "{motion:?}: kept {}", kept::bytes());
    }
    kept::clear();
    kept::set_ceiling(kept::KEPT_BYTES);
}

#[test]
fn the_largest_crack_under_a_box_stroke_paints_close_up() {
    // Crack at its largest (amount 1, size 400 %, over every letter) on
    // 200 px letters at scale 4 (a Retina screen at 200 % zoom) with the
    // box's own stroke on: its cuts reach some 68M device pixels round the
    // letters, past the painter's largest raster. The cuts-alone pass is cut
    // to the surface, so the box paints; it once failed whole.
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let r = paint(&mut engine, largest_under_stroke(font, 4.0, None));
    assert!(ink(&r) > 0);
    assert!(r.x >= 0 && r.y >= 0 && r.x + r.width as i32 <= 2600 && r.y + r.height as i32 <= 1280);
    // Broken off, at scale 2: each piece's cuts are cut to the surface too.
    let r = paint(&mut engine, largest_under_stroke(font, 2.0, Some(BreakOff { share: 1.0, motion: Motion::Fall })));
    assert!(ink(&r) > 0);
}

/// A crack or scratches under a box's own stroke through the kept path
/// (commit 26f8e7f): the letters whole, the cuts alone and the strokes'
/// distances over the letters whole ("chamfer out, whole", "depth in,
/// whole") are kept under keys of their own, and a paint that keeps them is
/// the fresh paint to the byte, cold, warm, and with a store too small to
/// hold them.
#[test]
fn a_cut_box_stroke_kept_is_the_fresh_one_to_the_byte() {
    use mt_text::paint::{paint_box_kept, BoxKeys};
    let mut engine = Engine::new();
    let font = load(&mut engine);
    let crack = || only(|s| s.crack = Some(Crack { amount: 0.5, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }));
    let scratched = || only(|s| s.scratches = Some(Scratches { amount: 0.7, angle: -0.3, seed: 9 }));
    let stroked = |sp: Option<Special>, position: Position, size: f64, color: Rgba| {
        let mut b = boxed(font, sp);
        b.lay_special_paint().unwrap();
        b.effects = vec![
            Effect::Stroke(Stroke {
                size,
                position,
                opacity: 1.0,
                blend: Blend::Normal,
                paint: Paint::Fill(Fill::Solid(color)),
                seed: 0,
            }),
            // A Stroke Emboss reads the cut letters' own distance out
            // ("chamfer out") beside the stroke's of the letters whole.
            Effect::Bevel(Bevel {
                style: BevelStyle::StrokeEmboss,
                technique: BevelTechnique::Smooth,
                depth: 1.2,
                up: true,
                size: 5.0,
                soften: 1.0,
                angle: 120.0,
                altitude: 30.0,
                highlight: Overlay { color: Rgba([255, 255, 255, 255]), opacity: 0.75, blend: Blend::Screen },
                shadow: Overlay { color: BLACK, opacity: 0.75, blend: Blend::Multiply },
                gloss: None,
                gloss_aa: false,
                contour: None,
                range: 0.5,
                contour_aa: false,
                texture: None,
            }),
        ];
        b
    };
    let cases = [
        ("crack, outside", false, Position::Outside, 4.0),
        ("crack, centre", false, Position::Center, 4.0),
        ("crack, inside", false, Position::Inside, 3.0),
        ("crack, wide outside", false, Position::Outside, 40.0),
        ("scratches, centre", true, Position::Center, 4.0),
    ];
    for (i, (what, scratches, position, size)) in cases.into_iter().enumerate() {
        let b = |color| stroked(if scratches { scratched() } else { crack() }, position, size, color);
        let keys = BoxKeys {
            job: kept::Hasher::new("t job").u64(i as u64).finish().unwrap(),
            premask: None,
            cover: None,
        };
        for ceiling in [kept::KEPT_BYTES, 150_000, 0] {
            kept::set_ceiling(ceiling);
            kept::clear();
            let mut hits = Vec::new();
            // Cold, the same again, then the stroke recoloured: the box's
            // picture is not the last one, and its pieces are read back.
            for (pass, color) in [("cold", BLACK), ("warm", BLACK), ("recoloured", RED)] {
                let fresh = paint_box(&mut engine, &mut b(color)).unwrap().expect("something painted");
                let mut k = b(color);
                let before = kept::hits();
                let r = paint_box_kept(&mut engine, &mut k, keys).unwrap().expect("something painted");
                hits.push(kept::hits() - before);
                assert_eq!((r.x, r.y, r.width, r.height), (fresh.x, fresh.y, fresh.width, fresh.height), "{what}, {pass}, {ceiling}");
                assert!(r.data == fresh.data, "{what}, {pass}, a store of {ceiling}");
            }
            if ceiling == kept::KEPT_BYTES {
                // Warm, the box's picture is read back; recoloured, its
                // pieces are.
                assert!(hits[1] > hits[0] && hits[2] > hits[0], "{what}: {hits:?}");
            }
        }
    }
    kept::set_ceiling(kept::KEPT_BYTES);
}

/// The holes and the pieces' outlines are rastered once a paint and shared
/// by every pass of the box (fill, bands, a box stroke's whole letters and
/// cuts alone): kept or made again for each pass, the picture is the same
/// to the byte, both motions, with a band, a box stroke and a shadow.
#[test]
fn broken_pieces_shared_by_the_passes_paint_the_same_bytes() {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    for motion in [Motion::Apart, Motion::Fall] {
        let make = || {
            let mut b = boxed(font, breaking(0.75, motion, (0.5, 0.5), 1.0));
            b.request.job.bands = vec![Band { color: BLACK, opacity: 1.0, line: 6.0 }];
            b.shadows = vec![mt_text::paint::Shadow { color: BLACK, opacity: 0.5, x: 4.0, y: 5.0, ..Default::default() }];
            b.effects = vec![Effect::Stroke(Stroke {
                size: 3.0,
                position: Position::Outside,
                opacity: 1.0,
                blend: Blend::Multiply,
                paint: Paint::Fill(Fill::Solid(BLUE)),
                seed: 0,
            })];
            b
        };
        kept::set_ceiling(0);
        let alone = paint(&mut engine, make());
        kept::set_ceiling(kept::KEPT_BYTES);
        kept::clear();
        let shared = paint(&mut engine, make());
        assert!(alone == shared, "{motion:?}");
    }
}

/// A piece's middle (the mean of its outline) and its box, where `m` takes
/// it.
fn placed(outline: &[mt_text::paint::Pt], m: &Affine) -> (f64, f64, (f64, f64, f64, f64)) {
    let pts: Vec<_> = outline.iter().map(|&v| m.apply(v)).collect();
    let n = pts.len() as f64;
    let b = pts.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, v| (b.0.min(v.x), b.1.min(v.y), b.2.max(v.x), b.3.max(v.y)));
    (pts.iter().map(|v| v.x).sum::<f64>() / n, pts.iter().map(|v| v.y).sum::<f64>() / n, b)
}

/// How the pieces of a crack at 80 over a line of letters move at
/// `share`: the mean of how much farther from the focus each lands, how
/// far down, the most any drifts sideways, how much the boxes of the pieces
/// where they lie overlap (pairwise, a share of their area) and how many
/// moved and how many are gone.
fn motion_numbers(motion: Motion, share: f64) -> (f64, f64, f64, f64, usize, usize) {
    const INK: (f64, f64, f64, f64) = (40.0, 55.0, 330.0, 100.0);
    let sp = Special { rect: [0.0, 0.0, 360.0, 160.0], crack: Some(Crack { amount: 0.8, size: 1.0, at: (0.5, 0.5), spread: 1.0, seed: 3 }), break_off: Some(BreakOff { share, motion }), lightning: None, splash: None, scratches: None };
    let sh = letter_shapes(&sp, SIZE, INK).unwrap();
    let focus = (185.0, 77.5);
    let (mut out, mut down, mut side, mut gone, mut over, mut area) = (0.0, 0.0, 0.0f64, 0, 0.0, 0.0);
    let mut boxes = Vec::new();
    for p in &sh.pieces {
        let Some(m) = p.moved else {
            gone += 1;
            continue;
        };
        let (x0, y0, _) = placed(&p.outline, &Affine::IDENTITY);
        let (x1, y1, b) = placed(&p.outline, &m);
        out += (x1 - focus.0).hypot(y1 - focus.1) - (x0 - focus.0).hypot(y0 - focus.1);
        down += y1 - y0;
        side = side.max((x1 - x0).abs());
        boxes.push(b);
    }
    for (i, a) in boxes.iter().enumerate() {
        area += (a.2 - a.0) * (a.3 - a.1);
        for b in &boxes[i + 1..] {
            over += (a.2.min(b.2) - a.0.max(b.0)).max(0.0) * (a.3.min(b.3) - a.1.max(b.1)).max(0.0);
        }
    }
    let n = boxes.len();
    (out / n as f64, down / n as f64, side, over / area, n, gone)
}

#[test]
fn apart_pieces_move_clearly_out_from_the_focus_farther_as_break_off_grows() {
    // Measured (font size 60): out 8.5, 12.9, 18.1, 19.1 at 25 to 100 %,
    // against 2.6 to 6.2 for the first Apart, which read as wider cracks.
    let mut last = 0.0;
    for share in [0.25, 0.5, 0.75, 1.0] {
        let (out, down, _, _, n, gone) = motion_numbers(Motion::Apart, share);
        assert!(out > 0.12 * SIZE && out > last, "{share}: out {out}");
        assert!(down.abs() < 0.1 * SIZE, "{share}: they stay by the letters, {down}");
        assert!(n > 0 && gone == 0, "{share}: none is lost");
        last = out;
    }
}

#[test]
fn falling_pieces_drop_below_where_they_were_and_keep_apart() {
    // Measured (font size 60): down 20.6 to 51.8 from 25 to 100 %, drift at
    // most 11.3, overlap 0.24 to 0.46, against 0.44 to 0.65 for the first
    // Fall, which dropped every piece to the letters' foot in one heap.
    let mut last = 0.0;
    for share in [0.25, 0.5, 0.75, 1.0] {
        let (_, down, side, overlap, n, _) = motion_numbers(Motion::Fall, share);
        assert!(down > last + 5.0, "{share}: down {down}");
        assert!(side < 0.25 * SIZE, "{share}: below where it was, drift {side}");
        assert!(overlap < 0.5 && (share > 0.9 || overlap < 0.4), "{share}: overlap {overlap}");
        assert!(n > 0);
        last = down;
    }
    // Some small ones are gone at the most.
    assert!(motion_numbers(Motion::Fall, 1.0).5 > 0);
}
