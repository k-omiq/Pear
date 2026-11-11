//! A curved line shaped whole (`Effects::line`, box wire v22): its runs are
//! the clusters of one line, so a curve keeps the line's kerning, ligatures
//! and contextual forms, and a curve bent to nothing paints the straight
//! line.
#![cfg(feature = "paint")]

use mt_text::paint::{
    curved_origin, paint_job, shape_line_runs, shape_run, Affine, Align, Effects, Fill, Job,
    Raster, Request, Rgba, Run,
};
use mt_text::{Engine, Face, FontId};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
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

fn request(face: Face, curved: bool, line: bool, runs: Vec<Run>) -> Request {
    Request {
        job: Job {
            curved,
            align: Align::Left,
            letter_spacing: 0.0,
            bands: Vec::new(),
            silhouette: None,
            no_fill: false,
            fill: Some(Fill::Solid(Rgba([0, 0, 0, 255]))),
            mesh: None,
            roughen: None,
            effects: Effects {
                line,
                ..Effects::default()
            },
            runs,
        },
        face,
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
        ink: None,
    }
}

fn letters(text: &str) -> Vec<String> {
    text.chars().map(String::from).collect()
}

#[test]
fn the_clusters_of_a_line_add_up_to_the_line_kerning_and_all() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 48.0);
    let text = "AVATAR WAVE";
    let parts = letters(text);
    let runs = shape_line_runs(&mut e, face, parts.iter().map(String::as_str), false)
        .unwrap()
        .expect("one run per letter");
    assert_eq!(runs.len(), parts.len());
    let line = shape_run(&mut e, face, text, 0.0).unwrap();
    let sum: f64 = runs.iter().map(|r| r.advance).sum();
    assert!((sum - line.advance).abs() < 1e-9, "{sum} vs {}", line.advance);
    // Each glyph, put back at its cluster's pen, is where the line has it.
    let mut pen = 0.0;
    let mut k = 0;
    for r in runs.iter() {
        for g in r.glyphs.iter() {
            assert!((pen + g.x - line.glyphs[k].x).abs() < 1e-9);
            assert_eq!(g.glyph, line.glyphs[k].glyph);
            k += 1;
        }
        pen += r.advance;
    }
    // The A before the V is kerned: it takes less room in the line than on
    // its own, which is what a letter shaped alone on a curve lost.
    let alone = shape_run(&mut e, face, "A", 0.0).unwrap().advance;
    assert!(runs[0].advance < alone - 0.5, "{} vs {alone}", runs[0].advance);
}

#[test]
fn a_ligature_is_one_cluster_and_spacing_parts_it() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // "fi" is one glyph in DejaVu Sans: two runs cannot be its clusters.
    assert!(shape_line_runs(&mut e, face, ["f", "i"].into_iter(), false)
        .unwrap()
        .is_none());
    let one = shape_line_runs(&mut e, face, ["fi"].into_iter(), false)
        .unwrap()
        .unwrap();
    assert_eq!((one.len(), one[0].glyphs.len()), (1, 1));
    // Spaced, the line has no ligatures, as a straight one has none.
    let two = shape_line_runs(&mut e, face, ["f", "i"].into_iter(), true)
        .unwrap()
        .unwrap();
    assert_eq!(two.len(), 2);
    assert!(two.iter().all(|r| r.glyphs.len() == 1));
}

fn same(a: &Raster, b: &Raster) -> bool {
    (a.x, a.y, a.width, a.height) == (b.x, b.y, b.width, b.height)
        && a.data.iter().zip(&b.data).all(|(p, q)| p.abs_diff(*q) <= 2)
}

#[test]
fn a_line_on_a_curve_bent_to_nothing_paints_the_straight_line() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 48.0);
    let text = "AVATAR WAVE";
    let (x0, base) = (20.0, 80.0);
    let straight = paint_job(&mut e, &request(face, false, false, vec![run(text, x0, base)]))
        .unwrap()
        .unwrap();
    // Each letter centred on its cluster's middle, as the layouts place it.
    let parts = letters(text);
    let shaped = shape_line_runs(&mut e, face, parts.iter().map(String::as_str), false)
        .unwrap()
        .unwrap();
    let mut pen = x0;
    let mut runs = Vec::new();
    for (p, r) in parts.iter().zip(shaped.iter()) {
        let (_, dy) = curved_origin(&e, face, r.advance).unwrap();
        runs.push(run(p, pen + r.advance / 2.0, base - dy));
        pen += r.advance;
    }
    let line = paint_job(&mut e, &request(face, true, true, runs.clone()))
        .unwrap()
        .unwrap();
    assert!(same(&line, &straight), "the line drawn letter by letter moved");
    // Each letter shaped alone is centred by its own width, not the room
    // the line gives it: the kerned letters slide.
    let apart = paint_job(&mut e, &request(face, true, false, runs))
        .unwrap()
        .unwrap();
    assert!(!same(&apart, &straight));
}

#[test]
fn runs_that_are_not_the_lines_clusters_are_shaped_one_by_one() {
    let mut e = Engine::new();
    let font = load(&mut e, "DejaVuSans.ttf");
    let face = Face::new(font, 40.0);
    // "f" and "i" are one cluster of the line: the job falls back and paints
    // each run alone, the picture it painted before lines.
    let runs = vec![run("f", 30.0, 50.0), run("i", 50.0, 50.0)];
    let line = paint_job(&mut e, &request(face, true, true, runs.clone()))
        .unwrap()
        .unwrap();
    let apart = paint_job(&mut e, &request(face, true, false, runs))
        .unwrap()
        .unwrap();
    assert_eq!(line, apart);
}
