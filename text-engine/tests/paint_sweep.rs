//! An extrude's steps laid in one pass (`paint/sweep.rs`) against the same
//! shadows laid a copy at a time, the way the box job laid them before.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::{
    paint_box_copy_by_copy, paint_box_with, Affine, Align, BoxRequest, Effects, Exact, Fill, Job,
    Raster, Request, Rgba, Run, Shadow,
};
use mt_text::{Engine, Face, FontId};
use std::time::Instant;

fn load(engine: &mut Engine, file: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{file}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const INK: Rgba = Rgba([17, 17, 17, 255]);
const EDGE: Rgba = Rgba([255, 255, 255, 255]);
const RED: Rgba = Rgba([230, 30, 40, 255]);

/// `text` at `size` from `(x, y)` in a box `width` by `height` job units,
/// painted through `transform`.
fn sheet(
    font: FontId,
    text: &str,
    size: f64,
    (x, y): (f64, f64),
    transform: Affine,
    (width, height): (u32, u32),
) -> BoxRequest {
    BoxRequest {
        width,
        height,
        shadows: Vec::new(),
        blur: 0.0,
        taps: Vec::new(),
        clip: None,
        blend: Blend::Normal,
        fill_opacity: 1.0,
        effects: Vec::new(),
        backdrop: None,
        request: Request {
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
                }],
            },
            face: Face::new(font, size),
            bold_draw: None,
            weight: 0.0,
            transform,
            tiles: Vec::new(),
        },
    }
}

/// An extrude as `effectShadows` (`src/lib/text-paint.js`) writes it: `n`
/// steps `len` long at `angle` degrees, and as many again in `edge` grown by
/// `grow` under them when there is one. First on top.
fn extrude(angle: f64, len: f64, n: usize, color: Rgba, edge: Option<(Rgba, f64)>) -> Vec<Shadow> {
    let (uy, ux) = angle.to_radians().sin_cos();
    let step = |k: usize, color: Rgba, grow: f64| Shadow {
        color,
        opacity: 1.0,
        x: ux * len * k as f64 / n as f64,
        y: uy * len * k as f64 / n as f64,
        grow,
        ..Shadow::default()
    };
    let mut out: Vec<Shadow> = (1..=n).map(|k| step(k, color, 0.0)).collect();
    if let Some((edge, grow)) = edge {
        out.extend((1..=n).map(|k| step(k, edge, grow)));
    }
    out
}

/// A shake as `effectShadows` writes it: `count` copies each way.
fn shake(angle: f64, amp: f64, count: usize, color: Rgba) -> Vec<Shadow> {
    let (uy, ux) = angle.to_radians().sin_cos();
    let mut out = Vec::new();
    for k in 1..=count {
        let d = amp * k as f64 / count as f64;
        let opacity = 0.45 * (1.0 - (k - 1) as f64 / (count + 1) as f64);
        for s in [1.0, -1.0] {
            out.push(Shadow {
                color,
                opacity,
                x: s * ux * d,
                y: s * uy * d,
                grow: 0.0,
                ..Shadow::default()
            });
        }
    }
    out
}

/// The worst difference per channel between two rasters, and how many
/// pixels differ at all, over the box both cover.
fn compare(a: &Raster, b: &Raster) -> ([u8; 4], usize) {
    let at = |r: &Raster, x: i32, y: i32| -> [u8; 4] {
        let (lx, ly) = (x - r.x, y - r.y);
        if lx < 0 || ly < 0 || lx >= r.width as i32 || ly >= r.height as i32 {
            return [0; 4];
        }
        let i = (ly as usize * r.width as usize + lx as usize) * 4;
        [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]]
    };
    let (x0, y0) = (a.x.min(b.x), a.y.min(b.y));
    let x1 = (a.x + a.width as i32).max(b.x + b.width as i32);
    let y1 = (a.y + a.height as i32).max(b.y + b.height as i32);
    let mut worst = [0u8; 4];
    let mut differ = 0;
    for y in y0..y1 {
        for x in x0..x1 {
            let (p, q) = (at(a, x, y), at(b, x, y));
            if p != q {
                differ += 1;
            }
            for c in 0..4 {
                worst[c] = worst[c].max(p[c].abs_diff(q[c]));
            }
        }
    }
    (worst, differ)
}

fn both(e: &mut Engine, b: &mut BoxRequest) -> (Raster, Raster) {
    let swept = paint_box_with(e, b, &Exact)
        .unwrap()
        .expect("something was drawn");
    let copies = paint_box_copy_by_copy(e, b, &Exact)
        .unwrap()
        .expect("something was drawn");
    (swept, copies)
}

#[test]
fn an_extrude_in_one_pass_is_its_steps_laid_one_by_one() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let turned = {
        let (s, c) = 0.3f64.sin_cos();
        Affine([2.0 * c, 2.0 * s, -2.0 * s, 2.0 * c, 60.0, 10.0])
    };
    let transforms = [
        Affine::IDENTITY,
        Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]),
        Affine([1.5, 0.0, 0.0, 1.5, 0.3, 0.7]),
        turned,
        // Mirrored.
        Affine([-2.0, 0.0, 0.0, 2.0, 480.0, 0.0]),
    ];
    let looks = [
        (135.0, 24.0, 16, None),
        (45.0, 30.0, 20, Some((EDGE, 2.0))),
        (90.0, 18.0, 12, None),
        (0.0, 20.0, 13, Some((RED, 1.0))),
        (200.0, 33.0, 22, None),
        (300.0, 7.0, 5, None),
    ];
    for (t, transform) in transforms.iter().enumerate() {
        for &(angle, len, n, edge) in &looks {
            let mut b = sheet(font, "BOOM!", 60.0, (40.0, 110.0), *transform, (480, 340));
            b.shadows = extrude(angle, len, n, INK, edge);
            let (swept, copies) = both(&mut e, &mut b);
            let (worst, differ) = compare(&swept, &copies);
            let what = format!("transform {t}, extrude {angle} deg x {n}, edge {edge:?}");
            // Alpha is the same everywhere; a colour is within a level where
            // a copy's edge falls over the extrude's own colour.
            assert_eq!(worst[3], 0, "{what}: alpha {worst:?}");
            assert!(worst.iter().all(|&d| d <= 1), "{what}: {worst:?}");
            let area = swept.width as usize * swept.height as usize;
            assert!(
                differ * 100 < area,
                "{what}: {differ} of {area} pixels differ"
            );
        }
    }
}

#[test]
fn shadows_that_are_not_an_extrude_are_laid_as_before() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let transform = Affine([2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
    let mut lists = vec![
        // A shake: faded copies, one at a time as they always were.
        shake(0.0, 7.0, 2, INK),
        shake(30.0, 12.0, 4, RED),
        // One opaque shadow alone, and steps broken up by a faded one.
        vec![Shadow {
            color: RED,
            opacity: 1.0,
            x: 5.0,
            y: 5.0,
            grow: 0.0,
            ..Shadow::default()
        }],
    ];
    let mut broken = extrude(135.0, 20.0, 8, INK, None);
    broken[3].opacity = 0.5;
    lists.push(broken);
    // A blurred shadow among them.
    let mut blurred = extrude(60.0, 12.0, 6, INK, None);
    blurred.push(Shadow {
        color: RED,
        opacity: 0.8,
        x: 4.0,
        y: 4.0,
        size: 9.0,
        ..Shadow::default()
    });
    lists.push(blurred);
    for (i, shadows) in lists.into_iter().enumerate() {
        let mut b = sheet(font, "HI!", 60.0, (40.0, 110.0), transform, (400, 300));
        let faded_only = shadows.iter().all(|s| s.opacity < 1.0);
        b.shadows = shadows;
        let (swept, copies) = both(&mut e, &mut b);
        if faded_only {
            assert_eq!(swept, copies, "list {i}");
        } else {
            let (worst, _) = compare(&swept, &copies);
            assert!(
                worst[3] == 0 && worst.iter().all(|&d| d <= 1),
                "list {i}: {worst:?}"
            );
        }
    }
}

/// Milliseconds for the box job, the median of a few. Run with
/// `cargo test --release --features paint --test paint_sweep -- --ignored --nocapture`.
#[test]
#[ignore = "a benchmark: prints times"]
fn bench_extrude_steps() {
    let mut e = Engine::new();
    let font = load(&mut e, "Bangers-Regular.ttf");
    // The app's case: "BOOM!!" at 120 in a 520 by 240 box, at scale 2.
    let transform = Affine([2.0, 0.0, 0.0, 2.0, 120.0, 120.0]);
    let time = |e: &mut Engine, b: &mut BoxRequest, copies: bool| {
        let mut t = Vec::new();
        for _ in 0..9 {
            let at = Instant::now();
            let r = if copies {
                paint_box_copy_by_copy(e, b, &Exact)
            } else {
                paint_box_with(e, b, &Exact)
            };
            assert!(r.unwrap().is_some());
            t.push(at.elapsed().as_secs_f64() * 1000.0);
        }
        t.sort_by(f64::total_cmp);
        t[t.len() / 2]
    };
    let cases: Vec<(&str, Vec<Shadow>)> = vec![
        ("none", Vec::new()),
        ("extrude 24", extrude(135.0, 36.0, 24, INK, None)),
        ("extrude 48", extrude(135.0, 72.0, 48, INK, None)),
        (
            "extrude + edge 48",
            extrude(135.0, 36.0, 24, INK, Some((EDGE, 3.6))),
        ),
        ("shake 4", shake(0.0, 7.2, 2, INK)),
    ];
    for (name, shadows) in cases {
        let mut b = sheet(font, "BOOM!!", 120.0, (20.0, 170.0), transform, (1280, 760));
        b.shadows = shadows;
        let swept = time(&mut e, &mut b, false);
        let copies = time(&mut e, &mut b, true);
        println!("{name:>20}: one pass {swept:7.2} ms, copy by copy {copies:7.2} ms");
    }
}
