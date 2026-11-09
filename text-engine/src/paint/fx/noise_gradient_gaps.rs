//! Test gaps from the Layer Styles review (F59): the full-hue wrap, and the
//! mid-ramp samples the native pins did not cover.

use super::*;

fn noise(seed: u32, roughness: f32) -> Noise {
    Noise {
        seed,
        roughness,
        model: Model::Rgb,
        min: [0.0; 3],
        max: [1.0; 3],
        restrict: false,
        transparency: false,
    }
}

/// F59: a full hue range wraps (the walk is not folded, so it runs past the
/// ends and `hsb_rgb` takes the turn), and a part range folds.
#[test]
fn a_full_hue_walk_runs_past_its_ends_and_a_part_one_stays_inside() {
    let mut ran_past = false;
    for seed in 0..16u32 {
        for r in [0.5f32, 1.0] {
            let wrapped = walk(&mut Rng::new(seed, 1), 0.0, 1.0, r, true, SAMPLES);
            ran_past |= wrapped.iter().any(|v| !(0.0..=1.0).contains(v));
            let folded = walk(&mut Rng::new(seed, 1), 0.0, 1.0, r, false, SAMPLES);
            assert!(
                folded.iter().all(|v| (0.0..=1.0).contains(v)),
                "seed {seed} r {r}: a folded walk left its limits"
            );
        }
    }
    assert!(ran_past, "no wrapped hue walk ever left 0..1 in 32 tries");
}

/// F59: the wrap is real in the colour: a hue past 1 is the hue past 0, and
/// the ends of the circle are the same red.
#[test]
fn hue_wraps_round_the_circle_in_the_colour() {
    for h in [0.2f32, 0.5, 0.83] {
        let want = hsb_rgb(h, 1.0, 1.0);
        for turn in [-2.0f32, -1.0, 1.0, 3.0] {
            let got = hsb_rgb(h + turn, 1.0, 1.0);
            for c in 0..3 {
                assert!(
                    (got[c] - want[c]).abs() < 1e-4,
                    "hue {h} + {turn}: {got:?} vs {want:?}"
                );
            }
        }
    }
    assert_eq!(hsb_rgb(0.0, 1.0, 1.0), [1.0, 0.0, 0.0]);
    assert_eq!(hsb_rgb(1.0, 1.0, 1.0), [1.0, 0.0, 0.0]);
    // A quarter, a third and two thirds round: yellow-green, green, blue.
    let g = hsb_rgb(1.0 / 3.0, 1.0, 1.0);
    assert!(g[0] < 1e-3 && (g[1] - 1.0).abs() < 1e-3 && g[2] < 1e-3, "{g:?}");
    let b = hsb_rgb(2.0 / 3.0, 1.0, 1.0);
    assert!(b[0] < 1e-3 && b[1] < 1e-3 && (b[2] - 1.0).abs() < 1e-3, "{b:?}");
}

/// F59: a baked HSB ramp with a full hue range is the unfolded walk through
/// `hsb_rgb`, sample by sample; one whose hue range stops a hair short is
/// folded, and is not.
#[test]
fn a_full_hue_range_bakes_the_wrapped_walk() {
    let hsb = |hi: f32| Noise {
        model: Model::Hsb,
        min: [0.0, 1.0, 1.0],
        max: [hi, 1.0, 1.0],
        ..noise(5, 1.0)
    };
    let table = Ramp::new(hsb(1.0)).table().to_vec();
    let hue = walk(&mut Rng::new(5, 1), 0.0, 1.0, 1.0, true, SAMPLES);
    for (i, c) in table.iter().enumerate() {
        let want = hsb_rgb(hue[i], 1.0, 1.0);
        for k in 0..3 {
            assert!((c[k] - want[k]).abs() < 1e-5, "sample {i}: {c:?} vs {want:?}");
        }
    }
    assert_ne!(table, Ramp::new(hsb(0.999)).table());
}

/// F59: mid-ramp samples, natively pinned. The two ends are pinned by
/// `the_ends_match_what_the_wasm_engine_paints`; the walk's easing and the
/// HSB conversion show only between the ends. 0 to 255 per channel.
/// src/lib/text-engine/rust-painter.engine.test.js paints the same samples
/// through the wasm build (an Angle gradient's centre moved off one letter
/// pixel) and expects these colours, so the two builds agree mid-ramp.
#[test]
fn mid_ramp_samples_are_pinned() {
    let lab = Noise {
        model: Model::Lab,
        restrict: true,
        ..noise(7, 0.5)
    };
    let hsb = Noise {
        model: Model::Hsb,
        ..noise(7, 0.5)
    };
    let hsb_full_hue = Noise {
        model: Model::Hsb,
        min: [0.0, 0.5, 0.5],
        max: [1.0, 1.0, 1.0],
        ..noise(7, 0.5)
    };
    let at = |n: Noise, ts: [f32; 3]| {
        let r = Ramp::new(n);
        ts.map(|t| r.sample(t).map(|v| (v * 255.0).round() as u8))
    };
    let ts = [0.25, 0.5, 0.75];
    assert_eq!(at(noise(7, 0.5), ts), PINNED_RGB);
    assert_eq!(at(lab, ts), PINNED_LAB);
    assert_eq!(at(hsb, ts), PINNED_HSB);
    assert_eq!(at(hsb_full_hue, ts), PINNED_HSB_FULL);
}

const PINNED_RGB: [[u8; 4]; 3] = [[60, 47, 188, 255], [68, 167, 169, 255], [75, 198, 208, 255]];
const PINNED_LAB: [[u8; 4]; 3] = [[0, 75, 0, 255], [119, 29, 0, 255], [163, 0, 0, 255]];
const PINNED_HSB: [[u8; 4]; 3] = [[173, 188, 153, 255], [169, 120, 59, 255], [47, 83, 208, 255]];
const PINNED_HSB_FULL: [[u8; 4]; 3] = [[166, 222, 90, 255], [212, 134, 37, 255], [26, 72, 232, 255]];
