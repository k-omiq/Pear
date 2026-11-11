//! Imported brush tips in the box job (layer styles phase 8b): a tip the
//! engine holds stamps as the canvas's `stampTip` does, a ribbon unrolls it,
//! a cycle turns through its tips, Darken keeps the denser of two dabs, and
//! a tip the engine was not given paints round.
#![cfg(feature = "paint")]

use mt_text::paint::ink::tips::{tip_bytes, with_cache, CACHE_BYTES};
use mt_text::paint::ink::{Ink, Stroke, TipOrder};
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, Effects, Job, Pt, Raster, Request, Rgba,
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

/// A soft disc, `side` square: full in the middle, clear at the rim.
fn disc(side: usize) -> Vec<u8> {
    let c = side as f64 / 2.0;
    (0..side * side)
        .map(|i| {
            let (x, y) = ((i % side) as f64 + 0.5 - c, (i / side) as f64 + 0.5 - c);
            ((1.0 - (x.hypot(y) / c)).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

/// Bars across, `side` wide and `tall` tall, ink every other `bar` rows.
fn bars(side: usize, tall: usize, bar: usize) -> Vec<u8> {
    (0..side * tall)
        .map(|i| {
            if (i / side / bar).is_multiple_of(2) {
                255
            } else {
                0
            }
        })
        .collect()
}

fn put(key: &str, w: usize, h: usize, data: &[u8]) {
    with_cache(|c| c.put(key, w, h, (w as u32, h as u32), data)).unwrap();
}

/// A box with no letters and one stroke `k`, the tips `keys` named, in a
/// 240 x 160 surface at `scale`.
fn tipped(font: FontId, k: Stroke, keys: &[&str], scale: f64) -> BoxRequest {
    let mut ink = Ink::new(Pt::new(20.0, 40.0), vec![k]);
    ink.name_tips(keys.iter().map(|k| (*k).to_owned()).collect());
    let request = Request {
        job: Job {
            curved: false,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: None,
            mesh: None,
            roughen: None,
            effects: Effects::default(),
            runs: Vec::new(),
        },
        face: Face::new(font, 40.0),
        bold_draw: None,
        weight: 0.0,
        transform: Affine::scale(scale, scale),
        tiles: Vec::new(),
        ink: Some(ink),
        faces: Default::default(),
    };
    BoxRequest::new((240.0 * scale) as u32, (160.0 * scale) as u32, request)
}

fn line(size: f64) -> Stroke {
    Stroke {
        size,
        color: Rgba([200, 30, 30, 255]),
        pts: vec![[10.0, 30.0, 1.0, 1.0, 1.0], [150.0, 30.0, 1.0, 1.0, 1.0]],
        ..Stroke::default()
    }
}

fn paint(e: &mut Engine, r: &mut BoxRequest) -> Option<Raster> {
    paint_box(e, r).unwrap()
}

fn px(r: &Raster, x: i32, y: i32) -> [u8; 4] {
    let (lx, ly) = (x - r.x, y - r.y);
    if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
        return [0; 4];
    }
    let i = (ly as usize * r.width as usize + lx as usize) * 4;
    r.data[i..i + 4].try_into().unwrap()
}

#[test]
fn a_tip_stamps_as_a_soft_disc_and_paints_the_same_twice() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("disc|64x64", 64, 64, &disc(64));
    // One dab: spacing past the line's length, so one stamp at its start.
    let one = Stroke {
        spacing: 200.0,
        pts: vec![[60.0, 40.0, 1.0, 1.0, 1.0]],
        ..line(40.0)
    };
    let r = paint(
        &mut e,
        &mut tipped(
            font,
            Stroke {
                tip: Some(0),
                ..one.clone()
            },
            &["disc|64x64"],
            1.0,
        ),
    )
    .unwrap();
    // At the dab's centre (80, 80) all of it, the stroke's colour; half way
    // out (10 of 20) about half; at the rim nothing.
    let mid = px(&r, 80, 80);
    assert_eq!(&mid[..3], &[200, 30, 30]);
    assert!(mid[3] >= 240, "{mid:?}");
    let half = px(&r, 90, 80)[3];
    assert!((110..=145).contains(&half), "{half}");
    assert_eq!(px(&r, 101, 80)[3], 0);
    // The round dab of that size is solid to its rim.
    let round = paint(&mut e, &mut tipped(font, one, &[], 1.0)).unwrap();
    assert_eq!(px(&round, 90, 80)[3], 255);
    // The same twice, byte for byte.
    let k = Stroke {
        tip: Some(0),
        ..line(30.0)
    };
    let a = paint(&mut e, &mut tipped(font, k.clone(), &["disc|64x64"], 2.74));
    let b = paint(&mut e, &mut tipped(font, k, &["disc|64x64"], 2.74));
    assert_eq!(a, b);
}

#[test]
fn a_tip_the_engine_was_not_given_paints_round() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let k = line(20.0);
    let round = paint(&mut e, &mut tipped(font, k.clone(), &[], 1.0));
    let missing = paint(
        &mut e,
        &mut tipped(font, Stroke { tip: Some(0), ..k }, &["gone|64x64"], 1.0),
    );
    assert!(round.is_some());
    assert_eq!(round, missing);
}

#[test]
fn a_cycle_entry_not_in_hand_is_the_strokes_own_tip() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("disc|64x64", 64, 64, &disc(64));
    put("bars|64x64", 64, 64, &bars(64, 64, 8));
    let own = Stroke {
        tip: Some(0),
        spacing: 60.0,
        ..line(30.0)
    };
    let alone = paint(
        &mut e,
        &mut tipped(font, own.clone(), &["disc|64x64", "gone|1x1"], 1.0),
    );
    // Both the cycle's entries the stroke's own, or not in hand: as alone.
    for cycle in [
        vec![Some(0), Some(1)],
        vec![Some(0), None],
        vec![Some(1), Some(1)],
    ] {
        let k = Stroke {
            cycle,
            ..own.clone()
        };
        assert_eq!(
            paint(
                &mut e,
                &mut tipped(font, k, &["disc|64x64", "gone|1x1"], 1.0)
            ),
            alone
        );
    }
    // A second tip in hand changes every other stamp, in each order.
    let keys = ["disc|64x64", "bars|64x64"];
    let mut seen = Vec::new();
    for order in [
        TipOrder::Repeat,
        TipOrder::Reverse,
        TipOrder::Once,
        TipOrder::Random,
    ] {
        let k = Stroke {
            cycle: vec![Some(0), Some(1), Some(0)],
            tip_order: order,
            ..own.clone()
        };
        let r = paint(&mut e, &mut tipped(font, k, &keys, 1.0));
        assert_ne!(r, alone, "{order:?}");
        seen.push(r);
    }
    // Repeat and Reverse agree on three tips only as far as the third
    // stamp; Once stays on the last.
    assert_ne!(seen[0], seen[2]);
}

#[test]
fn darken_keeps_the_denser_of_two_dabs() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("disc|64x64", 64, 64, &disc(64));
    // Dabs 4 apart, each 40 across: a dozen over every pixel of the line.
    let k = Stroke {
        tip: Some(0),
        spacing: 10.0,
        ..line(40.0)
    };
    let over = paint(&mut e, &mut tipped(font, k.clone(), &["disc|64x64"], 1.0)).unwrap();
    let dark = paint(
        &mut e,
        &mut tipped(
            font,
            Stroke {
                darken_tips: true,
                ..k
            },
            &["disc|64x64"],
            1.0,
        ),
    )
    .unwrap();
    // Ten up from the middle of the line: one dab gives about half there,
    // a dozen over each other give nearly all of it; darkened, the densest
    // of them, the one under it, about half.
    let (a, d) = (px(&over, 100, 60)[3], px(&dark, 100, 60)[3]);
    assert!(a > 230, "{a}");
    assert!((110..=150).contains(&d), "{d}");
    // And the colour is the stroke's.
    assert_eq!(&px(&dark, 100, 70)[..3], &[200, 30, 30]);
}

#[test]
fn a_ribbon_unrolls_the_tip_and_wraps_it() {
    let mut e = Engine::new();
    let font = load(&mut e);
    // 32 wide, 64 tall: bars 16 rows deep, so along a ribbon 20 wide the
    // bars are 10 long and the tip comes round every 40.
    put("bars|32x64", 32, 64, &bars(32, 64, 16));
    let k = Stroke {
        tip: Some(0),
        ribbon: true,
        ..line(20.0)
    };
    let r = paint(&mut e, &mut tipped(font, k, &["bars|32x64"], 1.0)).unwrap();
    // Along the middle of the band (y 70), from its start at x 30: ink for
    // 10, a gap of 10, again; and again past the wrap at 40. The slices
    // meet with no seam between them: all of the ink across a bar.
    let along: Vec<u8> = (0..120).map(|i| px(&r, 30 + i, 70)[3]).collect();
    for (i, &a) in along.iter().enumerate() {
        let phase = i % 20;
        if (2..8).contains(&phase) {
            assert_eq!(a, 255, "ink at {i}");
        } else if (12..18).contains(&phase) {
            assert!(a < 40, "a gap at {i}: {a}");
        }
    }
}

#[test]
fn a_tall_tip_is_as_tall_as_the_stamp_and_flatness_squashes_it() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("strip|16x64", 16, 64, &[255; 16 * 64]);
    let one = Stroke {
        tip: Some(0),
        spacing: 200.0,
        pts: vec![[60.0, 40.0, 1.0, 1.0, 1.0]],
        ..line(40.0)
    };
    let r = paint(
        &mut e,
        &mut tipped(font, one.clone(), &["strip|16x64"], 1.0),
    )
    .unwrap();
    // 40 tall and 10 wide round (80, 80).
    assert_eq!((r.width, r.height), (10, 40));
    let flat = paint(
        &mut e,
        &mut tipped(
            font,
            Stroke {
                flatness: 0.5,
                ..one.clone()
            },
            &["strip|16x64"],
            1.0,
        ),
    )
    .unwrap();
    assert_eq!((flat.width, flat.height), (10, 20));
    // Turned a quarter: 40 wide, 10 tall.
    let turned = paint(
        &mut e,
        &mut tipped(font, Stroke { angle: 90.0, ..one }, &["strip|16x64"], 2.0),
    )
    .unwrap();
    assert_eq!((turned.width, turned.height), (80, 20));
}

#[test]
fn the_cache_holds_no_more_than_its_ceiling_and_keeps_a_jobs_tips() {
    let side = 2048;
    let px = vec![128u8; side * side];
    let one = tip_bytes(side, side);
    for i in 0..20 {
        with_cache(|c| {
            c.put(
                &format!("t{i}"),
                side,
                side,
                (side as u32, side as u32),
                &px,
            )
            .unwrap();
            c.end_job();
        });
        assert!(with_cache(|c| c.bytes()) <= CACHE_BYTES);
    }
    let held = with_cache(|c| c.len());
    assert_eq!(held, CACHE_BYTES / one);
    // The newest are the ones held.
    assert!(with_cache(|c| c.has("t19") && !c.has("t0")));
    // A job naming every tip held: the next has no room, and nothing named
    // is let go for it.
    with_cache(|c| c.end_job());
    let names: Vec<String> = (20 - held..20).map(|i| format!("t{i}")).collect();
    for n in &names {
        assert!(with_cache(|c| c.has(n)));
    }
    assert!(with_cache(|c| c.put("late", side, side, (1, 1), &px)).is_err());
    for n in &names {
        assert!(with_cache(|c| c.has(n)), "{n}");
    }
    with_cache(|c| c.forget());
    assert_eq!(with_cache(|c| c.bytes()), 0);
}
