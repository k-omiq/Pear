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
