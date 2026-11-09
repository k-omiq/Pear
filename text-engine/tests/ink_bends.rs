//! Brush ink bent by the box's mesh and roughened by its field (phase 8c),
//! and the letters' bends kept as they were.
//!
//! The reference for the ink's pixels is the canvas path in `src/lib`
//! (`src/lib/ink-bend.engine.test.js`). What is held here is the engine's
//! own arithmetic: the letters' bytes did not move when the map they are
//! bent by became one shared with the ink (hashes taken at a858107, before
//! the change), the ink goes through that map, and a stamp under a mesh
//! that is one affine map is the same stamp with that map folded into the
//! transform.
#![cfg(feature = "paint")]

use mt_text::paint::ink::tips::with_cache;
use mt_text::paint::ink::{Ink, Stroke};
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, Effects, Fill, Job, Mesh, Pt, Raster, Request, Rgba,
    Roughen, Run,
};
use mt_text::{Engine, Face, FontId};

const BLUE: Rgba = Rgba([0, 0, 255, 255]);

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// 64-bit FNV-1a over a raster's origin, size and bytes (paint_hashes.rs).
fn hash(r: &Option<Raster>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: &[u8]| {
        for &x in b {
            h ^= u64::from(x);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    match r {
        None => eat(b"none"),
        Some(r) => {
            eat(&r.x.to_le_bytes());
            eat(&r.y.to_le_bytes());
            eat(&r.width.to_le_bytes());
            eat(&r.height.to_le_bytes());
            eat(&r.data);
        }
    }
    h
}

/// A 3 x 3 mesh over (20, 30, 200, 120), its inner nodes moved.
fn bumpy() -> Mesh {
    let (cols, rows, w, h) = (3u32, 3u32, 200.0, 120.0);
    let mut pts = Vec::new();
    for j in 0..=rows {
        for i in 0..=cols {
            pts.push(Pt::new(
                w * f64::from(i) / f64::from(cols),
                h * f64::from(j) / f64::from(rows),
            ));
        }
    }
    let mut mv = |i: usize, j: usize, dx: f64, dy: f64| {
        let k = j * 4 + i;
        pts[k] = Pt::new(pts[k].x + dx, pts[k].y + dy);
    };
    mv(1, 1, -12.0, -18.0);
    mv(2, 1, 15.0, 10.0);
    mv(1, 2, 10.0, 14.0);
    mv(2, 2, -20.0, -12.0);
    Mesh {
        cols,
        rows,
        pts,
        x: 20.0,
        y: 30.0,
        w,
        h,
    }
}

fn rough() -> Roughen {
    Roughen {
        amount: 6.0,
        detail: 0.07,
        seed: 7.0,
        origin: Pt::new(20.0, 30.0),
        grit: 0.0,
    }
}

/// "HIWAVE" at 40, blue, curved or straight, with a drip.
fn letters(font: FontId, mesh: Option<Mesh>, roughen: Option<Roughen>, curved: bool) -> BoxRequest {
    BoxRequest::new(
        260,
        200,
        Request {
            job: Job {
                curved,
                align: Align::Left,
                letter_spacing: 0.0,
                bands: Vec::new(),
                silhouette: None,
                no_fill: false,
                fill: Some(Fill::Solid(BLUE)),
                mesh,
                roughen,
                effects: Effects::default(),
                runs: vec![Run {
                    text: "HIWAVE".to_owned(),
                    x: 30.0,
                    y: 110.0,
                    rot: 0.0,
                    sx: 1.0,
                    sy: 1.0,
                    skew: 0.0,
                    drip: if curved { 9.0 } else { 0.0 },
                    pen: 1.0,
                    ghost: false,
                    fill: None,
                }],
            },
            face: Face::new(font, 40.0),
            bold_draw: None,
            weight: 0.0,
            transform: Affine([1.5, 0.0, 0.0, 1.5, 3.25, 1.5]),
            tiles: Vec::new(),
            ink: None,
        },
    )
}

/// The letters' hashes at a858107, before the ink shared their map.
const BEFORE: [(&str, u64); 6] = [
    ("mesh", 0x8fe38285671b3cd9),
    ("roughen", 0x1f081b220bfe192e),
    ("mesh and roughen", 0x3564405bbd5c279f),
    ("drip", 0x4d5a1916a5385d61),
    ("drip, mesh and roughen", 0x7532172a7a668ce8),
    ("plain", 0xedf3e082b930185a),
];

#[test]
fn the_letters_bend_as_they_did_before_the_ink_shared_their_map() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let cases = [
        ("mesh", Some(bumpy()), None, false),
        ("roughen", None, Some(rough()), false),
        ("mesh and roughen", Some(bumpy()), Some(rough()), false),
        ("drip", None, None, true),
        ("drip, mesh and roughen", Some(bumpy()), Some(rough()), true),
        ("plain", None, None, false),
    ];
    let mut wrong = Vec::new();
    for ((name, mesh, roughen, curved), (want_name, want)) in cases.into_iter().zip(BEFORE) {
        assert_eq!(name, want_name);
        let got = hash(&paint_box(&mut e, &mut letters(font, mesh, roughen, curved)).unwrap());
        if std::env::var_os("PRINT_HASHES").is_some() {
            println!("(\"{name}\", 0x{got:016x}),");
        }
        if got != want {
            wrong.push(name);
        }
    }
    let exact = cfg!(all(target_arch = "aarch64", target_os = "macos"))
        || std::env::var_os("STRICT_HASHES").is_some();
    if exact {
        assert!(wrong.is_empty(), "letters moved: {wrong:?}");
    }
}

// ---------------------------------------------------------------------------
// The ink, bent.

fn put(key: &str, w: usize, h: usize, data: &[u8]) {
    with_cache(|c| c.put(key, w, h, (w as u32, h as u32), data)).unwrap();
}

/// A soft disc, `side` square.
fn disc(side: usize) -> Vec<u8> {
    let c = side as f64 / 2.0;
    (0..side * side)
        .map(|i| {
            let (x, y) = ((i % side) as f64 + 0.5 - c, (i / side) as f64 + 0.5 - c);
            ((1.0 - (x.hypot(y) / c)).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

/// A wavy stroke across the box, `size` wide.
fn wave(size: f64) -> Stroke {
    Stroke {
        size,
        color: Rgba([20, 20, 20, 255]),
        pts: (0..24)
            .map(|i| {
                let t = f64::from(i) / 23.0;
                [
                    10.0 + t * 170.0,
                    50.0 + (t * std::f64::consts::TAU).sin() * 30.0,
                    1.0,
                    1.0,
                    1.0,
                ]
            })
            .collect(),
        ..Stroke::default()
    }
}

/// A box of ink alone, corner (20, 30), one stroke, the tips `keys`, under
/// `transform`, bent by `mesh` and `roughen`.
fn inked(
    font: FontId,
    k: Stroke,
    keys: &[&str],
    transform: Affine,
    mesh: Option<Mesh>,
    roughen: Option<Roughen>,
) -> BoxRequest {
    let mut ink = Ink::new(Pt::new(20.0, 30.0), vec![k]);
    ink.name_tips(keys.iter().map(|k| (*k).to_owned()).collect());
    BoxRequest::new(
        600,
        500,
        Request {
            job: Job {
                curved: false,
                align: Align::Left,
                letter_spacing: 0.0,
                bands: Vec::new(),
                silhouette: None,
                no_fill: false,
                fill: None,
                mesh,
                roughen,
                effects: Effects::default(),
                runs: Vec::new(),
            },
            face: Face::new(font, 40.0),
            bold_draw: None,
            weight: 0.0,
            transform,
            tiles: Vec::new(),
            ink: Some(ink),
        },
    )
}

/// One cell over the box (20, 30, 200, 120) whose corners are `q` (tl,
/// tr, bl, br, relative to the corner): a parallelogram is one affine map.
fn cell(q: [(f64, f64); 4]) -> Mesh {
    Mesh {
        cols: 1,
        rows: 1,
        pts: q.iter().map(|&(x, y)| Pt::new(x, y)).collect(),
        x: 20.0,
        y: 30.0,
        w: 200.0,
        h: 120.0,
    }
}

/// The job-space affine map a parallelogram `cell` is: the unit square's
/// corners (0, 0), (w, 0), (0, h) go to tl, tr, bl.
fn cell_map(q: [(f64, f64); 4]) -> Affine {
    let (w, h) = (200.0, 120.0);
    let (tl, tr, bl) = (q[0], q[1], q[2]);
    let (a, b) = ((tr.0 - tl.0) / w, (tr.1 - tl.1) / w);
    let (c, d) = ((bl.0 - tl.0) / h, (bl.1 - tl.1) / h);
    // Job space: off the mesh's corner (20, 30), mapped, back on.
    let m = Affine([a, b, c, d, tl.0, tl.1]);
    Affine::translate(20.0, 30.0)
        .after(&m)
        .after(&Affine::translate(-20.0, -30.0))
}

/// The most two rasters differ by in any channel, and over how many pixels
/// either has ink.
fn worst(a: &Raster, b: &Raster) -> (u8, usize) {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = (a.x + a.width as i32).max(b.x + b.width as i32);
    let y1 = (a.y + a.height as i32).max(b.y + b.height as i32);
    let at = |r: &Raster, x: i32, y: i32| -> [u8; 4] {
        let (lx, ly) = (x - r.x, y - r.y);
        if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
            return [0; 4];
        }
        let i = (ly as usize * r.width as usize + lx as usize) * 4;
        r.data[i..i + 4].try_into().unwrap()
    };
    let (mut most, mut n) = (0u8, 0usize);
    for y in y0..y1 {
        for x in x0..x1 {
            let (p, q) = (at(a, x, y), at(b, x, y));
            if p[3] == 0 && q[3] == 0 {
                continue;
            }
            n += 1;
            for c in 0..4 {
                most = most.max(p[c].abs_diff(q[c]));
            }
        }
    }
    (most, n)
}

const SHEAR: [(f64, f64); 4] = [(0.0, 0.0), (210.0, 25.0), (-30.0, 110.0), (180.0, 135.0)];
/// The box mirrored left for right, and squeezed: a turned-over cell.
const MIRROR: [(f64, f64); 4] = [(200.0, 0.0), (20.0, 10.0), (190.0, 120.0), (10.0, 130.0)];

#[test]
fn under_a_mesh_that_is_one_affine_map_the_ink_is_that_map_folded_into_the_transform() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("disc|64x64", 64, 64, &disc(64));
    let base = Affine([2.0, 0.0, 0.0, 2.0, 1.25, 0.5]);
    let strokes = [
        ("hard round", wave(14.0), Vec::new()),
        (
            "soft round",
            Stroke {
                hardness: 30.0,
                ..wave(20.0)
            },
            Vec::new(),
        ),
        (
            "flat and turned",
            Stroke {
                flatness: 0.4,
                angle: 35.0,
                ..wave(18.0)
            },
            Vec::new(),
        ),
        (
            "a tip",
            Stroke {
                tip: Some(0),
                ..wave(26.0)
            },
            vec!["disc|64x64"],
        ),
        (
            "a tip, flipped",
            Stroke {
                tip: Some(0),
                flatness: 0.5,
                flip_x: mt_text::paint::ink::Flip::On,
                ..wave(26.0)
            },
            vec!["disc|64x64"],
        ),
    ];
    for q in [SHEAR, MIRROR] {
        for (name, k, keys) in &strokes {
            let bent = paint_box(
                &mut e,
                &mut inked(font, k.clone(), keys, base, Some(cell(q)), None),
            )
            .unwrap()
            .expect("bent ink");
            let folded = base.after(&cell_map(q));
            let flat = paint_box(
                &mut e,
                &mut inked(font, k.clone(), keys, folded, None, None),
            )
            .unwrap()
            .expect("folded ink");
            let (most, n) = worst(&bent, &flat);
            assert!(n > 2000, "{name}: {n}");
            // The same polygon and the same read, by another order of the
            // same products: within a level.
            assert!(most <= 1, "{name} under {q:?}: {most}");
        }
    }
}

#[test]
fn a_mesh_that_moves_nothing_and_a_roughening_of_nothing_are_the_ink_unbent_to_the_byte() {
    let mut e = Engine::new();
    let font = load(&mut e);
    let base = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    let same = cell([(0.0, 0.0), (200.0, 0.0), (0.0, 120.0), (200.0, 120.0)]);
    let none = Roughen {
        amount: 0.0,
        ..rough()
    };
    let plain = paint_box(&mut e, &mut inked(font, wave(14.0), &[], base, None, None)).unwrap();
    let b = paint_box(
        &mut e,
        &mut inked(font, wave(14.0), &[], base, Some(same), Some(none)),
    )
    .unwrap();
    assert_eq!(plain, b);
}

#[test]
fn a_mesh_that_crushes_a_stamp_to_nothing_draws_no_stamp_there() {
    let mut e = Engine::new();
    let font = load(&mut e);
    // Every point onto one line: no slope to read anywhere.
    let flat = cell([(0.0, 60.0), (200.0, 60.0), (0.0, 60.0), (200.0, 60.0)]);
    put("disc|64x64", 64, 64, &disc(64));
    let k = Stroke {
        tip: Some(0),
        ..wave(26.0)
    };
    let r = paint_box(
        &mut e,
        &mut inked(font, k, &["disc|64x64"], Affine::IDENTITY, Some(flat), None),
    )
    .unwrap();
    // Not a full-size tip drawn at each crushed place.
    let inked_px = r.map_or(0, |r| {
        r.data
            .as_chunks::<4>()
            .0
            .iter()
            .filter(|p| p[3] > 128)
            .count()
    });
    assert!(inked_px < 200, "{inked_px}");
}

#[test]
fn a_roughened_stroke_is_moved_and_paints_the_same_twice() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("disc|64x64", 64, 64, &disc(64));
    let base = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    for (k, keys) in [
        (wave(14.0), vec![]),
        (
            Stroke {
                hardness: 30.0,
                ..wave(20.0)
            },
            vec![],
        ),
        (
            Stroke {
                tip: Some(0),
                ..wave(26.0)
            },
            vec!["disc|64x64"],
        ),
    ] {
        let flat = paint_box(&mut e, &mut inked(font, k.clone(), &keys, base, None, None))
            .unwrap()
            .unwrap();
        let a = paint_box(
            &mut e,
            &mut inked(font, k.clone(), &keys, base, None, Some(rough())),
        )
        .unwrap()
        .unwrap();
        let b = paint_box(
            &mut e,
            &mut inked(font, k.clone(), &keys, base, None, Some(rough())),
        )
        .unwrap()
        .unwrap();
        assert_eq!(a, b);
        // Moved by up to half the amount (3 page px, 6 device) everywhere.
        let (most, _) = worst(&a, &flat);
        assert!(most > 120, "the crumple moved the edge: {most}");
        let total = |r: &Raster| {
            r.data
                .as_chunks::<4>()
                .0
                .iter()
                .map(|p| u64::from(p[3]))
                .sum::<u64>()
        };
        let ratio = total(&a) as f64 / total(&flat) as f64;
        assert!((0.9..1.1).contains(&ratio), "{ratio}");
    }
}

/// A solid tip, 16 by 64.
const SOLID: [u8; 16 * 64] = [255; 16 * 64];

/// Pixels inside a band that are not inked through: under 230, with ink at
/// or over 250 within two pixels on both sides, across or along.
fn holes(r: &Raster) -> usize {
    let (w, h) = (r.width as i32, r.height as i32);
    let a = |x: i32, y: i32| -> u8 {
        if x < 0 || y < 0 || x >= w || y >= h {
            return 0;
        }
        r.data[(y as usize * w as usize + x as usize) * 4 + 3]
    };
    let mut n = 0;
    for y in 0..h {
        for x in 0..w {
            if a(x, y) >= 230 {
                continue;
            }
            let both = |dx: i32, dy: i32| {
                (1..=2).any(|k| a(x - k * dx, y - k * dy) >= 250)
                    && (1..=2).any(|k| a(x + k * dx, y + k * dy) >= 250)
            };
            if both(1, 0) && both(0, 1) {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn a_ribbon_bent_by_a_mesh_has_no_seam_between_its_slices() {
    let mut e = Engine::new();
    let font = load(&mut e);
    put("solid|16x64", 16, 64, &SOLID);
    for scale in [2.0, 2.74] {
        let base = Affine::scale(scale, scale);
        let k = Stroke {
            tip: Some(0),
            ribbon: true,
            ..wave(22.0)
        };
        let flat = paint_box(
            &mut e,
            &mut inked(font, k.clone(), &["solid|16x64"], base, None, None),
        )
        .unwrap()
        .unwrap();
        let bent = paint_box(
            &mut e,
            &mut inked(font, k.clone(), &["solid|16x64"], base, Some(bumpy()), None),
        )
        .unwrap()
        .unwrap();
        let both = paint_box(
            &mut e,
            &mut inked(
                font,
                k,
                &["solid|16x64"],
                base,
                Some(bumpy()),
                Some(rough()),
            ),
        )
        .unwrap()
        .unwrap();
        let (hf, hb, hr) = (holes(&flat), holes(&bent), holes(&both));
        if std::env::var_os("PRINT_SEAMS").is_some() {
            println!("seams at {scale}: flat {hf}, bent {hb}, bent and roughened {hr}");
        }
        assert!(hb <= hf + 2, "bent: {hb} against flat {hf} at {scale}");
        assert!(
            hr <= hf + 2,
            "bent and roughened: {hr} against flat {hf} at {scale}"
        );
    }
}
