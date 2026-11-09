//! Bevel & Emboss against PhotoCraft on the same input: Chisel Soft's
//! emboss blur, the Texture's height unit and pattern Scale, and the
//! shading of a Stroke Emboss band.
//!
//! Reference: PhotoCraft dada110, `crates/compose/src/effects/bevel.rs`
//! `bevel_maps`, run on these cases by a throwaway harness that called the
//! crate (a scratch copy with one wrapper around the private `bevel_maps`).
//! `tests/data/bevel_photocraft.txt` keeps what it gave: per case and map
//! (highlight, shadow) a row, a column and both diagonals through the disc,
//! and the whole-map sums. Copyright (c) 2026 ArtCraft Team and the
//! PhotoCraft contributors, MIT licence (see `THIRD_PARTY.md`).
//!
//! This checks the port, not Photoshop. PhotoCraft has no Photoshop
//! measurement for any of the three: no test, comment or result in its
//! tree. Its pinned Photoshop corpus (`xtask/photoshop-corpus.sha256`:137,
//! 155 and 157-161: emboss and pillow Chisel Soft, five Stroke Emboss files;
//! nothing for the Texture) is not fetched here. To measure them later,
//! fetch `storytold/photocraft-corpus` at f5b1178 (PhotoCraft's
//! `PHOTOCRAFT_CORPUS_COMMIT`) and compare those files' merged composites.
//!
//! Limits: see `MAX_WORST` and `MAX_MEAN`.

use super::*;

const W: usize = 88;
const H: usize = 72;

/// The letters: a disc and a slanted bar, 4 x 4 supersampled coverage (the
/// harness ran the same code).
fn letters() -> Map {
    let (cx, cy, r) = (30.3f64, 36.7f64, 12.4f64);
    let (ax, ay) = (50.0f64, 18.0f64);
    let l = (10.0f64 * 10.0 + 34.0 * 34.0).sqrt();
    let (tx, ty) = (10.0 / l, 34.0 / l);
    let mut v = vec![0.0f32; W * H];
    for y in 0..H {
        for x in 0..W {
            let mut n = 0u32;
            for j in 0..4 {
                for i in 0..4 {
                    let px = x as f64 + (f64::from(i) + 0.5) / 4.0;
                    let py = y as f64 + (f64::from(j) + 0.5) / 4.0;
                    let disc = (px - cx).powi(2) + (py - cy).powi(2) <= r * r;
                    let (dx, dy) = (px - ax, py - ay);
                    let along = dx * tx + dy * ty;
                    let across = -dx * ty + dy * tx;
                    let bar = across.abs() <= 3.6 && (0.0..=36.0).contains(&along);
                    if disc || bar {
                        n += 1;
                    }
                }
            }
            v[y * W + x] = n as f32 / 16.0;
        }
    }
    Map::collect(W, H, v).unwrap()
}

/// The texture tile, 6 x 6 straight RGBA8 (the harness's bytes).
fn tile() -> Tile {
    let mut t = Vec::new();
    for y in 0..6u32 {
        for x in 0..6u32 {
            let a = [255u32, 255, 192, 255, 128, 0][((x + 2 * y) % 6) as usize];
            t.extend([
                ((x * 41 + y * 13) % 256) as u8,
                ((x * 7 + y * 53) % 256) as u8,
                ((x * 97 + y * 29 + 11) % 256) as u8,
                a as u8,
            ]);
        }
    }
    Tile::from_rgba(6, 6, &t).unwrap()
}

/// The Stroke Emboss band: an outside stroke of 3 px and an inside one of 2.
fn band(letters: &Map) -> Map {
    let st = |size, position| Stroke {
        size,
        position,
        opacity: 1.0,
        blend: Blend::Normal,
        paint: Paint::Fill(Fill::Solid(Rgba([0, 0, 0, 255]))),
        seed: 0,
    };
    let (out, inn) = (st(3.0, Position::Outside), st(2.0, Position::Inside));
    let din = map::chamfer_inside(letters).unwrap();
    stroke_band(letters, &[(0, &out), (1, &inn)], 1.0, Some(&din))
        .unwrap()
        .unwrap()
}

/// One case of `tests/data/bevel_photocraft.txt`.
struct Case {
    key: String,
    /// 1: every pixel; 2: only where we shade or the letters are (an outer
    /// or emboss texture is kept to the bevel's own extent here, while
    /// PhotoCraft's textured height shades the whole pad).
    check: u32,
    bevel: Bevel,
    band: bool,
}

fn parse(f: &[&str]) -> Case {
    let num = |i: usize| f[i].parse::<f64>().unwrap();
    let style = match f[1] {
        "inner" => BevelStyle::Inner,
        "outer" => BevelStyle::Outer,
        "emboss" => BevelStyle::Emboss,
        "pillow" => BevelStyle::Pillow,
        "stroke" => BevelStyle::StrokeEmboss,
        s => panic!("{s}"),
    };
    let technique = match f[2] {
        "smooth" => BevelTechnique::Smooth,
        "hard" => BevelTechnique::ChiselHard,
        "soft" => BevelTechnique::ChiselSoft,
        s => panic!("{s}"),
    };
    let tdepth = num(9);
    let bevel = Bevel {
        style,
        technique,
        depth: num(3),
        up: f[4] == "1",
        size: num(5),
        soften: num(6),
        angle: num(7),
        altitude: num(8),
        highlight: Overlay {
            color: Rgba([255; 4]),
            opacity: 0.75,
            blend: Blend::Screen,
        },
        shadow: Overlay {
            color: Rgba([0, 0, 0, 255]),
            opacity: 0.75,
            blend: Blend::Multiply,
        },
        gloss: None,
        gloss_aa: false,
        contour: None,
        range: 0.5,
        contour_aa: false,
        texture: (tdepth != 0.0).then(|| BevelTexture {
            depth: tdepth,
            invert: f[10] == "1",
            fill: Fill::Pattern {
                tile: 0,
                pitch: 6.0 * num(11),
                origin: Pt::new(num(12), num(13)),
                fallback: Rgba([0; 4]),
            },
        }),
    };
    Case {
        key: f[0].to_string(),
        check: f[15].parse().unwrap(),
        bevel,
        band: f[14] == "band",
    }
}

/// Our highlight and shadow maps for a case, one device pixel a job unit.
fn ours(c: &Case, letters: &Map) -> (Map, Map) {
    let tiles = [tile()];
    let place = Place {
        transform: Affine::IDENTITY,
        tiles: &tiles,
        grain: (0, 0),
        page: None,
    };
    let shape = if c.band {
        band(letters)
    } else {
        letters.try_clone().unwrap()
    };
    let (hi, sh, _) = bevel_maps(&shape, &c.bevel, 1.0, |x, y| (x, y), &place, (0, 0)).unwrap();
    (hi, sh)
}

/// The pixels each fixture line runs through: row 36, column 30, and the
/// two diagonals through the disc's centre (oblique edges, where the edge
/// placement and the chisel ramps are hardest).
fn lines() -> [(&'static str, Vec<usize>); 4] {
    let row = (0..W).map(|x| 36 * W + x).collect();
    let col = (0..H).map(|y| y * W + 30).collect();
    let down = (0..W)
        .filter(|&x| x + 6 < H)
        .map(|x| (x + 6) * W + x)
        .collect();
    let up = (0..W)
        .filter(|&x| x <= 67 && 67 - x < H)
        .map(|x| (67 - x) * W + x)
        .collect();
    [("row", row), ("col", col), ("down", down), ("up", up)]
}

/// Sum, sum of squares, and position-weighted sum of a map.
fn sums(v: &[f32]) -> [f64; 3] {
    let mut s = [0.0f64; 3];
    for (i, &x) in v.iter().enumerate() {
        let x = f64::from(x);
        s[0] += x;
        s[1] += x * x;
        s[2] += x * i as f64 / (W * H) as f64;
    }
    s
}

/// The worst difference from PhotoCraft along the fixture's lines, and the
/// mean over the line pixels either side shades. Measured over every pixel
/// of every case with the harness: worst 8.9e-7 (Emboss Chisel Soft at
/// depth 250 %, angle 45, altitude 60), case means at most 2.1e-7. The
/// spread is f32 noise: the light vector is f64 trigonometry here and f32
/// in PhotoCraft, and the two running-sum blurs add in their own order. The
/// limits are about twice that, plus the fixture's 5e-8 rounding.
const MAX_WORST: f32 = 2e-6;
const MAX_MEAN: f64 = 4e-7;
/// The whole-map sums (plain, squared, position-weighted) over 6336
/// pixels, each pixel off by the noise above: measured at most 3.7e-5 (a
/// relative 1.5e-7), so 1e-4.
const MAX_SUM: f64 = 1e-4;

const FIXTURE: &str = include_str!("../../../tests/data/bevel_photocraft.txt");

/// The fixture's cases whose key starts with `group`: the case and
/// PhotoCraft's lines and sums for the highlight and the shadow.
#[allow(clippy::type_complexity)]
fn fixture(
    group: &str,
) -> Vec<(
    Case,
    Vec<(String, String, Vec<f32>)>,
    Vec<(String, [f64; 3])>,
)> {
    let mut out = Vec::new();
    for block in FIXTURE.split("case ").skip(1) {
        let mut rows = block.lines();
        let head: Vec<&str> = rows.next().unwrap().split_whitespace().collect();
        if !head[0].starts_with(group) {
            continue;
        }
        let (mut lines, mut sums) = (Vec::new(), Vec::new());
        for r in rows.filter(|r| !r.starts_with('#') && !r.is_empty()) {
            let f: Vec<&str> = r.split_whitespace().collect();
            if f[1] == "sums" {
                let n = |i: usize| f[i].parse::<f64>().unwrap();
                sums.push((f[0].to_string(), [n(2), n(3), n(4)]));
            } else {
                let v = f[2..].iter().map(|x| x.parse::<f32>().unwrap()).collect();
                lines.push((f[0].to_string(), f[1].to_string(), v));
            }
        }
        out.push((parse(&head), lines, sums));
    }
    out
}

/// Every case of `group` against PhotoCraft's lines and sums, within the
/// limits; the number of cases checked.
fn check(group: &str) -> usize {
    let letters = letters();
    let paths = lines();
    let cases = fixture(group);
    for (c, want, sums_want) in &cases {
        let (hi, sh) = ours(c, &letters);
        let map = |name: &str| if name == "hi" { &hi } else { &sh };
        let (mut sum, mut n) = (0.0f64, 0usize);
        for (name, line, v) in want {
            let m = map(name);
            let idx = &paths.iter().find(|(l, _)| l == line).unwrap().1;
            assert_eq!(idx.len(), v.len(), "{} {name} {line}", c.key);
            for (&i, &p) in idx.iter().zip(v) {
                // Outer and Emboss textures: only where we shade or the
                // letters are (see `Case::check`).
                if c.check == 2 && !(m.v[i] > 0.0 || letters.v[i] > map::INSIDE_EPS) {
                    continue;
                }
                let d = (m.v[i] - p).abs();
                assert!(
                    d <= MAX_WORST,
                    "{} {name} {line} at ({}, {}): ours {} PhotoCraft {p}",
                    c.key,
                    i % W,
                    i / W,
                    m.v[i]
                );
                if m.v[i] > 0.0 || p > 0.0 {
                    sum += f64::from(d);
                    n += 1;
                }
            }
        }
        assert!(
            n > 0 && sum / n as f64 <= MAX_MEAN,
            "{} mean {}",
            c.key,
            sum / n.max(1) as f64
        );
        assert_eq!(
            sums_want.len(),
            if c.check == 1 { 2 } else { 0 },
            "{}",
            c.key
        );
        for (name, s) in sums_want {
            let got = sums(&map(name).v);
            for k in 0..3 {
                assert!(
                    (got[k] - s[k]).abs() <= MAX_SUM,
                    "{} {name} sum {k}: ours {} PhotoCraft {}",
                    c.key,
                    got[k],
                    s[k]
                );
            }
        }
    }
    cases.len()
}

/// (a) Chisel Soft's emboss blur. PhotoCraft's `max(1, size / 4)` tent over
/// an Emboss or Pillow chisel ramp (`bevel.rs:55, 81-85`), unmeasured there
/// ("emboss styles keep the blur until measured"); and none on Inner or
/// Outer, which PhotoCraft measured (`tests.rs:207-228`). Sizes 1, 3, 8, 21,
/// Soften 0 and 2, Up and Down, another light, Chisel Hard beside it, and
/// the Inner and Outer controls.
#[test]
fn chisel_soft_matches_photocraft() {
    assert_eq!(check("a_"), 22);
}

/// (b) The Texture: PhotoCraft's height unit `depth / unit`
/// (`bevel.rs:93-99`, unmeasured there) and the pattern's Scale and Phase
/// through our pattern shader, one factor at a time from Inner Smooth size
/// 8 (Texture Depth -1.5 and 3, Invert, Depth 250 %, Down, Scale 2, 0.5 and
/// 0.25, Phase (2, 1), Chisel Hard), one case with all of them changed, and
/// Outer Smooth and Emboss Chisel Soft where we shade. Scale 0.8 is left
/// out: there our shader takes one sample a pixel and PhotoCraft's two
/// (`shade.rs` `taps` against PhotoCraft `pattern.rs` `pixel_taps`), a
/// difference of the shared pattern sampler, not of the bevel. Measured at
/// 0.8: the base case differs by up to 0.151 (mean 0.027), the crossed one
/// (Chisel Hard, Depth 250 %, Texture Depth -1.5, Invert, Phase (2, 1)) by
/// up to 0.52 (mean 0.058).
#[test]
fn texture_matches_photocraft() {
    assert_eq!(check("b_"), 14);
}

/// (c) Stroke Emboss: PhotoCraft's Inner Bevel shading over our stroke band
/// (an outside stroke of 3 and an inside one of 2), Smooth, Chisel Hard and
/// Chisel Soft. The band itself and where it is laid are ours: PhotoCraft
/// maps Stroke Emboss to its Inner Bevel of the letters (`bevel.rs:40`) with
/// no comment or measurement. Measured on these letters, PhotoCraft's own
/// Stroke Emboss against ours differs by up to 0.89 (highlight) and 1.0
/// (shadow); the means over the pixels either shades, highlight / shadow,
/// are Smooth 0.23 / 0.34, Chisel Hard 0.22 / 0.30, Chisel Soft 0.25 / 0.35.
#[test]
fn stroke_emboss_band_shades_as_photocraft() {
    assert_eq!(check("c_"), 3);
}
