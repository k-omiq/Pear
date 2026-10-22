//! The sound-type layout: items, auto pick, placement and shape kerning.
//!
//! Placement is tested with [`Boxes`], an ink whose letters are plain
//! rectangles, so every expected number can be worked out by hand.

use super::items::{groups, ItemKind, MAX_GROUPS};
use super::kinds::{index_of, kinds_json, KINDS};
use super::params::{decode, encode};
use super::path::{Path, Walker};
use super::pick::{pick, pick_json};
use super::place::{place, Edit, Ink, Lin, Params};
use crate::Error;

const EPS: f64 = 1e-9;

/// Letters are `adv` wide and drawn as one rectangle `0.8 adv` by `0.7 em`,
/// centred. `=` is two bars with a gap, for the inner-gap floor.
struct Boxes {
    size: f64,
    adv: f64,
}

impl Ink for Boxes {
    fn advance(&mut self, text: &str) -> Result<f64, Error> {
        Ok(self.adv * text.chars().count() as f64)
    }

    fn outline(&mut self, text: &str) -> Result<Vec<Vec<[f64; 2]>>, Error> {
        let w = self.advance(text)? * 0.8 / 2.0;
        let h = self.size * 0.35;
        let rect = |y0: f64, y1: f64| vec![[-w, y0], [w, y0], [w, y1], [-w, y1]];
        Ok(if text == "=" {
            vec![rect(-h, -h / 3.0), rect(h / 3.0, h)]
        } else {
            vec![rect(-h, h)]
        })
    }
}

fn boxes() -> Boxes {
    Boxes {
        size: 100.0,
        adv: 60.0,
    }
}

fn plain() -> Params {
    Params {
        kern: false,
        follow: 0.0,
        big_tighter: 0.0,
        ..Params::default()
    }
}

// ---- items ---------------------------------------------------------------

#[test]
fn a_slash_and_a_line_break_both_start_a_group_and_blanks_are_dropped() {
    let g = groups("ギ/ロッ", true).unwrap();
    assert_eq!(g.len(), 2);
    assert_eq!(g[0].len(), 1);
    assert_eq!(g[1].len(), 2);
    let g = groups("  A \n\n B//C  ", true).unwrap();
    assert_eq!(g.len(), 3, "{g:?}");
    assert!(g
        .iter()
        .all(|grp| grp.iter().all(|i| i.kind == ItemKind::Letter)));
}

#[test]
fn bars_join_into_one_stretched_bar_only_when_asked_and_only_from_two() {
    let text = "ドーーン";
    let g = groups(text, true).unwrap();
    let kinds: Vec<ItemKind> = g[0].iter().map(|i| i.kind).collect();
    assert_eq!(
        kinds,
        [ItemKind::Letter, ItemKind::Bar(2), ItemKind::Letter]
    );
    // The bar run draws one bar.
    assert_eq!(g[0][1].text(text), "ー");
    let g = groups("ドーン", true).unwrap();
    assert_eq!(g[0][1].kind, ItemKind::Letter);
    let g = groups(text, false).unwrap();
    assert_eq!(g[0].len(), 4);
}

#[test]
fn bangs_pack_three_to_a_cell_and_marks_stay_with_their_letter() {
    let g = groups("!!!!", true).unwrap();
    let kinds: Vec<ItemKind> = g[0].iter().map(|i| i.kind).collect();
    assert_eq!(kinds, [ItemKind::Punct(3), ItemKind::Punct(1)]);
    // か with a combining voiced mark is one item.
    let text = "か\u{3099}ン";
    let g = groups(text, true).unwrap();
    assert_eq!(g[0].len(), 2);
    assert_eq!(g[0][0].text(text), "か\u{3099}");
}

#[test]
fn utf16_ranges_count_surrogate_pairs_as_two() {
    let text = "😀A";
    let g = groups(text, true).unwrap();
    assert_eq!(g[0][0].utf16, 0..2);
    assert_eq!(g[0][1].utf16, 2..3);
}

#[test]
fn groups_past_the_limit_fold_into_the_last() {
    let g = groups("a\nb\nc\nd\ne\nf", true).unwrap();
    assert_eq!(g.len(), MAX_GROUPS);
    assert_eq!(g[MAX_GROUPS - 1].len(), 3);
}

// ---- kinds and pick ------------------------------------------------------

#[test]
fn the_table_has_the_twelve_types_with_unique_ids_and_ascii_json() {
    assert_eq!(KINDS.len(), 12);
    for (i, k) in KINDS.iter().enumerate() {
        assert_eq!(index_of(k.id), Some(i));
        assert!(!k.paths.is_empty());
        assert!(!k.look.outlines.is_empty());
    }
    let json = kinds_json();
    assert!(json.is_ascii());
    assert!(json.starts_with("{\"kinds\":[{\"id\":\"impact\""));
    assert_eq!(json.matches("\"id\":").count(), 12);
    // ドン!! as escapes.
    assert!(json.contains("\\u30c9\\u30f3!!"));
}

fn top(text: &str, n: usize) -> Vec<&'static str> {
    pick(text).order[..n].iter().map(|&i| KINDS[i].id).collect()
}

#[test]
fn auto_pick_puts_each_types_own_sound_first() {
    for (sound, want) in [
        ("ドン!!", "impact"),
        ("ゴゴゴゴ", "rumble"),
        ("ザシュッ", "slash"),
        ("バキッ", "explosion"),
        ("ドボーン", "splash"),
        ("きらっ", "soft"),
        ("ぽちゃん", "drip"),
        ("ストン", "small"),
        ("ギロッ", "glare"),
        ("シーン", "silence"),
        ("ズーン", "shock"),
        ("BOOM!", "impact"),
        ("CRAAASH", "explosion"),
        ("whoosh", "slash"),
    ] {
        assert_eq!(top(sound, 1), [want], "{sound}: {:?}", pick(sound).scores);
    }
}

#[test]
fn auto_pick_ranks_near_sounds_in_its_top_three() {
    for (sound, want) in [
        ("ドーン!!", "pop"),
        ("ドドドド", "rumble"),
        ("ガーン", "shock"),
        ("ぷにっ", "soft"),
        ("ポタッ", "drip"),
        ("カチッ", "small"),
        ("ジロッ", "glare"),
        ("ズバッ", "slash"),
    ] {
        assert!(
            top(sound, 3).contains(&want),
            "{sound}: {:?}",
            top(sound, 3)
        );
    }
}

#[test]
fn heavy_sounds_get_more_strength_than_light_ones() {
    assert!(pick("ドゴォン!!").strength > pick("ぽちゃん").strength);
    let p = pick("");
    assert_eq!(p.order.len(), 12);
    let json = pick_json(&pick("ドン"));
    assert!(json.starts_with("{\"order\":[\"impact\","), "{json}");
}

// ---- params --------------------------------------------------------------

#[test]
fn params_go_round_the_wire_and_bad_bytes_are_refused() {
    let p = Params {
        vertical: true,
        kind: Some(3),
        seed: 42,
        paths: vec![Path {
            a: [-1.0, 2.0],
            b: [3.0, -4.0],
            bend: 0.25,
        }],
        edits: vec![Edit {
            group: 0,
            index: 2,
            dx: 0.1,
            dy: -0.2,
            rot: 15.0,
            scale: 1.5,
        }],
        ..Params::default()
    };
    let bytes = encode(&p);
    assert_eq!(decode(&bytes).unwrap(), p);
    let mut long = bytes.clone();
    long.push(0);
    assert_eq!(decode(&long), Err(Error::BadSpec));
    assert_eq!(decode(&bytes[..bytes.len() - 1]), Err(Error::BadSpec));
    let mut bad_kind = bytes.clone();
    bad_kind[8..12].copy_from_slice(&99u32.to_le_bytes());
    assert_eq!(decode(&bad_kind), Err(Error::BadSpec));
    let mut nan = bytes;
    nan[12..20].copy_from_slice(&f64::NAN.to_le_bytes());
    assert_eq!(decode(&nan), Err(Error::BadSpec));
}

// ---- maps and paths ------------------------------------------------------

#[test]
fn a_letters_map_comes_back_from_the_painters_turn_lean_and_scale() {
    for (m, ok) in [
        (Lin::rot(0.7).after(&Lin::scale(2.0, 0.5)), true),
        (Lin([1.0, -0.3, -0.2, 1.0]), true),
        (
            Lin::rot(core::f64::consts::FRAC_PI_2).after(&Lin::scale(1.0, 3.0)),
            true,
        ),
        (Lin::scale(-1.0, 1.0), false),
    ] {
        match m.decompose() {
            Some((rot, sx, sy, skew)) => {
                assert!(ok);
                // rotate(rot) * skewX(skew) * scale(sx, sy), as the painter.
                let lean = Lin([1.0, 0.0, -skew.tan(), 1.0]);
                let back = Lin::rot(rot).after(&lean).after(&Lin::scale(sx, sy));
                for (a, b) in back.0.iter().zip(m.0) {
                    assert!((a - b).abs() < 1e-9, "{m:?} -> {back:?}");
                }
            }
            None => assert!(!ok),
        }
    }
}

#[test]
fn a_straight_path_is_walked_evenly_and_a_bent_one_is_longer() {
    let w = Walker::new(Path {
        a: [0.0, 0.0],
        b: [100.0, 0.0],
        bend: 0.0,
    });
    assert!((w.len() - 100.0).abs() < 1e-6);
    let (p, d) = w.at(25.0);
    assert!((p[0] - 25.0).abs() < 1e-6 && p[1].abs() < 1e-9);
    assert_eq!(d, [1.0, 0.0]);
    let bent = Walker::new(Path {
        a: [0.0, 0.0],
        b: [100.0, 0.0],
        bend: 0.3,
    });
    assert!(bent.len() > 105.0);
    // Bent to the right of travel: down, on a y-down screen. A quadratic's
    // middle is half way to its control point (30 px out).
    assert!((bent.at(bent.len() / 2.0).0[1] - 15.0).abs() < 0.5);
}

// ---- placement -----------------------------------------------------------

#[test]
fn letters_fill_their_path_in_order_and_upright_without_follow() {
    let p = Params {
        paths: vec![Path {
            a: [-3.0, 0.0],
            b: [3.0, 0.0],
            bend: 0.0,
        }],
        ..plain()
    };
    let l = place("ABC", 100.0, &p, &mut boxes()).unwrap();
    assert_eq!(l.letters.len(), 3);
    // 600 px of path for three 0.6 em letters: each grows to 600 / 1.8 px.
    let em = 600.0 / 1.8;
    for (i, x) in [-200.0, 0.0, 200.0].iter().enumerate() {
        let t = &l.letters[i];
        assert!((t.x - x).abs() < 1e-6, "{i}: {}", t.x);
        assert!(t.y.abs() < EPS && t.rot.abs() < EPS && t.skew.abs() < EPS);
        assert!((t.em - em).abs() < 1e-6);
        assert!((t.sx - em / 100.0).abs() < 1e-9);
        assert_eq!(t.utf16, i as u32..i as u32 + 1);
    }
    assert_eq!(l.paths, p.paths);
}

#[test]
fn a_missing_path_is_made_at_the_natural_length_so_letters_keep_the_face_size() {
    let l = place("AB", 100.0, &plain(), &mut boxes()).unwrap();
    assert!(l.letters.iter().all(|t| (t.em - 100.0).abs() < 1e-6));
    assert!((l.letters[1].x - l.letters[0].x - 60.0).abs() < 1e-6);
    assert!((l.paths[0].b[0] - l.paths[0].a[0] - 1.2).abs() < 1e-9);
    // Two groups stack, the first above.
    let l = place("A\nB", 100.0, &plain(), &mut boxes()).unwrap();
    assert!(l.letters[0].y < l.letters[1].y);
    // Vertical: down the page, and the next group to the left.
    let v = Params {
        vertical: true,
        ..plain()
    };
    let l = place("AB\nC", 100.0, &v, &mut boxes()).unwrap();
    assert!((l.letters[1].y - l.letters[0].y - 100.0).abs() < 1e-6);
    assert!(l.letters[2].x < l.letters[0].x);
    assert!(l.letters.iter().all(|t| t.rot.abs() < EPS));
}

#[test]
fn the_size_flows_from_start_to_end_and_strength_scales_it() {
    let p = Params {
        flow: (0.5, 1.5, 1.0),
        ..plain()
    };
    let l = place("ABC", 100.0, &p, &mut boxes()).unwrap();
    let r = l.letters[2].em / l.letters[0].em;
    assert!((r - 3.0).abs() < 1e-9, "{r}");
    let flat = Params {
        strength: 0.0,
        ..p.clone()
    };
    let l = place("ABC", 100.0, &flat, &mut boxes()).unwrap();
    assert!((l.letters[2].em - l.letters[0].em).abs() < 1e-9);
}

#[test]
fn follow_turns_letters_with_the_path_by_its_share() {
    let p = |follow| Params {
        follow,
        paths: vec![Path {
            a: [0.0, 0.0],
            b: [3.0, 3.0],
            bend: 0.0,
        }],
        ..plain()
    };
    let quarter = core::f64::consts::FRAC_PI_4;
    let full = place("AB", 100.0, &p(1.0), &mut boxes()).unwrap();
    assert!(full.letters.iter().all(|t| (t.rot - quarter).abs() < 1e-9));
    let half = place("AB", 100.0, &p(0.5), &mut boxes()).unwrap();
    assert!(half
        .letters
        .iter()
        .all(|t| (t.rot - quarter / 2.0).abs() < 1e-9));
    assert!(half
        .letters
        .iter()
        .all(|t| (t.dir[0] - quarter.cos()).abs() < 1e-9));
}

#[test]
fn slant_leans_and_rise_lifts_the_horizontals() {
    let p = Params {
        slant: 20.0,
        ..plain()
    };
    let t = &place("A", 100.0, &p, &mut boxes()).unwrap().letters[0];
    assert!((t.skew - 20f64.to_radians()).abs() < 1e-9);
    assert!(t.rot.abs() < EPS);
    let p = Params {
        rise: 10.0,
        ..plain()
    };
    let t = &place("A", 100.0, &p, &mut boxes()).unwrap().letters[0];
    // The x axis turns up (negative), the y axis stays vertical.
    let m = Lin::rot(t.rot)
        .after(&Lin([1.0, 0.0, -t.skew.tan(), 1.0]))
        .after(&Lin::scale(t.sx, t.sy));
    assert!(m.0[1] < 0.0, "{m:?}");
    assert!(m.0[2].abs() < 1e-9, "{m:?}");
}

#[test]
fn the_same_seed_places_the_same_and_another_seed_does_not() {
    let p = Params {
        jitter: (10.0, 0.3, 0.5),
        seed: 7,
        ..plain()
    };
    let a = place("ABCD", 100.0, &p, &mut boxes()).unwrap();
    let b = place("ABCD", 100.0, &p, &mut boxes()).unwrap();
    assert_eq!(a, b);
    let c = place(
        "ABCD",
        100.0,
        &Params {
            seed: 8,
            ..p.clone()
        },
        &mut boxes(),
    )
    .unwrap();
    assert_ne!(a.letters, c.letters);
    assert!(a.letters.iter().any(|t| t.rot.abs() > 1e-3));
}

#[test]
fn an_edit_moves_turns_and_scales_its_letter_only() {
    let base = place("ABC", 100.0, &plain(), &mut boxes()).unwrap();
    let p = Params {
        edits: vec![Edit {
            group: 0,
            index: 1,
            dx: 0.5,
            dy: -1.0,
            rot: 90.0,
            scale: 2.0,
        }],
        ..plain()
    };
    let l = place("ABC", 100.0, &p, &mut boxes()).unwrap();
    let (a, b) = (&base.letters[1], &l.letters[1]);
    assert!((b.x - a.x - 50.0).abs() < 1e-6 && (b.y - a.y + 100.0).abs() < 1e-6);
    assert!((b.rot - core::f64::consts::FRAC_PI_2).abs() < 1e-9);
    assert!((b.em - 2.0 * a.em).abs() < 1e-9);
    assert_eq!(base.letters[0], l.letters[0]);
    assert_eq!(base.letters[2], l.letters[2]);
}

#[test]
fn a_long_bar_is_one_letter_stretched_and_vertical_turns_it_upright() {
    let l = place("AーーーB", 100.0, &plain(), &mut boxes()).unwrap();
    assert_eq!(l.letters.len(), 3);
    let bar = &l.letters[1];
    assert!((bar.sx / bar.sy - 3.0).abs() < 1e-9);
    let v = Params {
        vertical: true,
        ..plain()
    };
    let l = place("AーーーB", 100.0, &v, &mut boxes()).unwrap();
    let bar = &l.letters[1];
    assert!((bar.rot - core::f64::consts::FRAC_PI_2).abs() < 1e-9);
    // Three cells down from A's.
    assert!((l.letters[2].y - l.letters[0].y - 400.0).abs() < 1e-6);
}

#[test]
fn a_type_makes_its_own_paths_glare_two_apart() {
    let p = Params {
        kind: index_of("glare"),
        vertical: true,
        ..plain()
    };
    let l = place("ギ/ロッ", 100.0, &p, &mut boxes()).unwrap();
    assert_eq!(l.paths.len(), 2);
    let (g0, g1) = (&l.letters[0], &l.letters[1]);
    assert!(g0.x > g1.x && g0.y < g1.y, "{g0:?} {g1:?}");
}

#[test]
fn bounds_hold_every_letters_box() {
    let p = Params {
        jitter: (20.0, 0.2, 0.5),
        follow: 1.0,
        paths: vec![Path {
            a: [-2.0, 1.0],
            b: [2.0, -1.0],
            bend: 0.2,
        }],
        ..plain()
    };
    let l = place("ABCDE", 100.0, &p, &mut boxes()).unwrap();
    let [x0, y0, x1, y1] = l.bounds;
    for t in &l.letters {
        assert!(t.x > x0 && t.x < x1 && t.y > y0 && t.y < y1);
    }
}

#[test]
fn nothing_to_place_is_an_empty_layout_and_bad_numbers_are_refused() {
    let l = place(" \n/ ", 100.0, &plain(), &mut boxes()).unwrap();
    assert!(l.letters.is_empty() && l.paths.is_empty());
    let bad = Params {
        gap: f64::NAN,
        ..plain()
    };
    assert_eq!(place("A", 100.0, &bad, &mut boxes()), Err(Error::BadSpec));
    assert_eq!(place("A", 0.0, &plain(), &mut boxes()), Err(Error::BadSpec));
    assert_eq!(
        place(&"A".repeat(401), 100.0, &plain(), &mut boxes()),
        Err(Error::BadSpec)
    );
}

// ---- kerning -------------------------------------------------------------

/// Ink gap between letter `i` and `i + 1` of a horizontal, unturned layout.
fn ink_gap(l: &super::place::Layout, i: usize, adv_em: f64) -> f64 {
    let (a, b) = (&l.letters[i], &l.letters[i + 1]);
    let half = |t: &super::place::Letter| adv_em * 0.8 / 2.0 * t.em;
    (b.x - half(b)) - (a.x + half(a))
}

#[test]
fn kerning_sets_the_ink_gap_to_the_letter_gap_and_keeps_the_ends() {
    for gap in [-0.1, 0.0, 0.15] {
        let p = Params {
            kern: true,
            gap,
            ..plain()
        };
        let plain_l = place(
            "ABCD",
            100.0,
            &Params {
                kern: false,
                ..p.clone()
            },
            &mut boxes(),
        )
        .unwrap();
        let l = place("ABCD", 100.0, &p, &mut boxes()).unwrap();
        for i in 0..3 {
            let g = ink_gap(&l, i, 0.6) / l.letters[i].em;
            assert!((g - gap).abs() < 0.02, "gap {gap}: pair {i} is {g}");
        }
        let span = |l: &super::place::Layout| l.letters[3].x - l.letters[0].x;
        assert!((span(&l) - span(&plain_l)).abs() < 1e-6);
    }
}

#[test]
fn kerning_never_brings_a_letter_closer_than_half_its_own_inner_gap() {
    // `=` has two bars 0.233 em apart: the floor is half that.
    let p = Params {
        kern: true,
        gap: -0.3,
        ..plain()
    };
    let l = place("==", 100.0, &p, &mut boxes()).unwrap();
    let g = ink_gap(&l, 0, 0.6) / l.letters[0].em;
    assert!((g - 0.7 / 3.0 / 2.0).abs() < 0.02, "{g}");
}

#[test]
fn kerning_leaves_hand_moved_letters_and_spaces_alone() {
    let p = Params {
        kern: true,
        gap: -0.2,
        ..plain()
    };
    let l = place("A B", 100.0, &p, &mut boxes()).unwrap();
    let n = place(
        "A B",
        100.0,
        &Params {
            kern: false,
            ..p.clone()
        },
        &mut boxes(),
    )
    .unwrap();
    for (a, b) in l.letters.iter().zip(&n.letters) {
        assert!((a.x - b.x).abs() < 1e-9 && (a.em - b.em).abs() < 1e-9);
    }
}

// ---- the export, on a real font ------------------------------------------

#[test]
fn the_engine_ink_measures_and_outlines_a_real_font() {
    use crate::engine::{Engine, Face};
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut e = Engine::new();
    let font = e.add_font_bytes(std::fs::read(path).unwrap(), 0).unwrap();
    let face = Face::new(font, 100.0);
    let want = e.advance(face, "V").unwrap();
    let mut ink = super::EngineInk {
        engine: &mut e,
        face,
    };
    assert_eq!(ink.advance("V").unwrap(), want);
    let c = ink.outline("O").unwrap();
    assert_eq!(c.len(), 2, "an O is two contours");
    // Centred on the origin.
    let xs: Vec<f64> = c.iter().flatten().map(|p| p[0]).collect();
    let (lo, hi) = (
        xs.iter().copied().fold(f64::MAX, f64::min),
        xs.iter().copied().fold(f64::MIN, f64::max),
    );
    assert!((lo + hi).abs() < 2.0, "{lo} {hi}");
    // AV kerned to no gap ends closer than AV set by advance.
    let p = Params {
        kern: true,
        gap: 0.0,
        ..plain()
    };
    let k = place("AV", 100.0, &p, &mut ink).unwrap();
    let n = place(
        "AV",
        100.0,
        &Params {
            kern: false,
            ..p.clone()
        },
        &mut ink,
    )
    .unwrap();
    let d = |l: &super::place::Layout| (l.letters[1].x - l.letters[0].x) / l.letters[0].em;
    assert!(d(&k) < d(&n) - 0.05, "{} vs {}", d(&k), d(&n));
}
