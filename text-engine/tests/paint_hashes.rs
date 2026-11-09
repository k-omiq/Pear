//! A pixel hash sheet (review F74): one small paint for each kind of layer
//! effect, and a hash of its raster, kept in `tests/data/paint_hashes.txt`.
//! The suites above this check properties of the pixels; this is the net
//! under them, for a change that moves pixels none of those properties
//! mention (a mutation that kept every one of 18 of them green).
//!
//! A failure lists the names whose pixels changed. If the change is meant,
//! re-bless the sheet on purpose and look at the diff of the file:
//!
//!   BLESS=1 cargo test --release --test paint_hashes
//!
//! The hash is exact (64-bit FNV-1a over the raster's origin, size and
//! bytes), so it also reads the platform's float maths: the sheet is
//! written on aarch64 macOS. A hash that differs on another target with no
//! change to the engine is that, not a bug; bless on the target that
//! matters, or look at the two rasters before trusting either.
//!
//! So the exact check fails only where the sheet was blessed (aarch64
//! macOS, [`BLESSED_HERE`]) or when `STRICT_HASHES` is set:
//!
//!   STRICT_HASHES=1 cargo test --release --test paint_hashes
//!
//! On any other target a changed hash is printed as a warning (run with
//! `--nocapture` to see it) and the test falls back to a coarser check that
//! holds on every target: every row paints something, and no two rows paint
//! the same pixels. A row added to or missing from the sheet fails
//! everywhere: that is not the platform's maths.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::blending::{Blending, Range};
use mt_text::paint::fx::contour::{Curve, Lut, Table};
use mt_text::paint::fx::effects::{
    Bevel, BevelStyle, BevelTechnique, BevelTexture, Effect, Glow, InnerShadow, Overlay, Paint,
    PaintOverlay, Position, Satin, Stroke, Technique,
};
use mt_text::paint::fx::gradient::{Gradient, Style};
use mt_text::paint::fx::noise_gradient::{Model, Noise, Ramp};
use mt_text::paint::{
    paint_box, Affine, Align, BoxRequest, Clip, ClipMode, ClipShape, Effects, Fill, Job, Pt,
    Raster, Request, Rgba, Run, Shadow, Tap,
};
use mt_text::{Engine, Face, FontId};

const SHEET: &str = include_str!("data/paint_hashes.txt");

/// The target the sheet was blessed on, where its hashes are exact.
const BLESSED_HERE: bool = cfg!(all(target_arch = "aarch64", target_os = "macos"));

/// Whether a changed hash fails the test (see the header).
fn strict() -> bool {
    BLESSED_HERE || std::env::var_os("STRICT_HASHES").is_some()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);
const RED: Rgba = Rgba([255, 0, 0, 255]);
const BLUE: Rgba = Rgba([0, 0, 255, 255]);
const WHITE: Rgba = Rgba([255, 255, 255, 255]);

fn load(engine: &mut Engine) -> FontId {
    let path = format!(
        "{}/../src/test/fonts/DejaVuSans.ttf",
        env!("CARGO_MANIFEST_DIR")
    );
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

/// Red "HI" at 60, a 200 by 160 surface.
fn base(font: FontId) -> BoxRequest {
    BoxRequest::new(
        200,
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
                effects: Effects::default(),
                runs: vec![Run {
                    text: "HI".to_owned(),
                    x: 40.0,
                    y: 100.0,
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
            face: Face::new(font, 60.0),
            bold_draw: None,
            weight: 0.0,
            transform: Affine::IDENTITY,
            tiles: Vec::new(),
            ink: None,
        },
    )
}

/// A page of a grey with a lighter band down it, so a mode has something
/// to read that is not one level.
fn page() -> Vec<u8> {
    let mut v = Vec::with_capacity(200 * 160 * 4);
    for _y in 0..160 {
        for x in 0..200 {
            let g = (60 + x * 3 / 4) as u8;
            v.extend_from_slice(&[g, g / 2 + 40, 255 - g, 255]);
        }
    }
    v
}

fn glow(color: Rgba, technique: Technique, size: f64) -> Glow {
    Glow {
        color,
        gradient: None,
        opacity: 0.9,
        blend: Blend::Normal,
        technique,
        size,
        spread: 0.1,
        range: 0.5,
        noise: 0.0,
        contour: None,
        center: false,
        jitter: 0.0,
        seed: 3,
    }
}

fn grad(style: Style) -> Gradient {
    Gradient {
        stops: vec![(0.0, [1.0, 0.9, 0.0]), (0.5, [0.0, 0.6, 0.2]), (1.0, [0.1, 0.0, 0.8])],
        opacity: vec![(0.0, 1.0), (1.0, 0.8)],
        style,
        angle: 35.0,
        scale: 0.9,
        reverse: false,
        offset: (0.05, -0.05),
        mids: Vec::new(),
        opacity_mids: Vec::new(),
        align: true,
        dither: false,
        noise: None,
    }
}

fn noise_grad() -> Gradient {
    Gradient {
        mids: Vec::new(),
        opacity_mids: Vec::new(),
        align: true,
        dither: false,
        noise: Some(Ramp::new(Noise {
            seed: 9,
            roughness: 0.6,
            model: Model::Hsb,
            min: [0.0, 0.3, 0.5],
            max: [1.0, 1.0, 1.0],
            restrict: false,
            transparency: false,
        })),
        ..grad(Style::Linear)
    }
}

fn overlay(color: Rgba, blend: Blend, opacity: f64) -> Overlay {
    Overlay {
        color,
        opacity,
        blend,
    }
}

fn stroke(size: f64, position: Position, paint: Paint) -> Effect {
    Effect::Stroke(Stroke {
        size,
        position,
        opacity: 1.0,
        blend: Blend::Normal,
        paint,
        seed: 2,
    })
}

fn bevel(style: BevelStyle, technique: BevelTechnique) -> Bevel {
    Bevel {
        style,
        technique,
        depth: 1.2,
        up: true,
        size: 5.0,
        soften: 1.0,
        angle: 120.0,
        altitude: 30.0,
        highlight: overlay(WHITE, Blend::Screen, 0.75),
        shadow: overlay(BLACK, Blend::Multiply, 0.75),
        gloss: None,
        gloss_aa: false,
        contour: None,
        range: 0.5,
        contour_aa: false,
        texture: None,
    }
}

fn shadow(x: f64, y: f64) -> Shadow {
    Shadow {
        color: BLACK,
        opacity: 0.8,
        x,
        y,
        ..Shadow::default()
    }
}

fn turn(deg: f64) -> Affine {
    let (s, c) = deg.to_radians().sin_cos();
    Affine::translate(100.0, 80.0)
        .after(&Affine::rotate(c, s))
        .after(&Affine::translate(-100.0, -80.0))
}

type Mutate = Box<dyn Fn(&mut BoxRequest)>;

fn effect(fx: Effect) -> Mutate {
    Box::new(move |b| b.effects = vec![fx.clone()])
}

fn effects(fx: Vec<Effect>) -> Mutate {
    Box::new(move |b| b.effects = fx.clone())
}

/// The sheet: a name and what to change on the base box.
fn sheet() -> Vec<(&'static str, Mutate)> {
    let cone = Lut::new(&Curve::Preset(1));
    let mut rows: Vec<(&'static str, Mutate)> = vec![
        ("letters", Box::new(|_| {})),
        // The box's own passes.
        ("shadow", Box::new(|b| b.shadows = vec![shadow(5.0, 6.0)])),
        (
            "shadow_size_spread_noise_contour",
            Box::new(|b| {
                b.shadows = vec![Shadow {
                    size: 6.0,
                    spread: 0.3,
                    noise: 0.4,
                    seed: 4,
                    contour: Some(Lut::new(&Curve::Preset(1))),
                    ..shadow(4.0, 5.0)
                }]
            }),
        ),
        (
            "shadow_multiply_over_page",
            Box::new(|b| {
                b.shadows = vec![Shadow {
                    blend: Blend::Multiply,
                    knockout: true,
                    ..shadow(4.0, 5.0)
                }];
                b.backdrop = Some(page());
            }),
        ),
        ("blur", Box::new(|b| b.blur = 2.5)),
        (
            "taps",
            Box::new(|b| {
                b.taps = vec![
                    Tap { dx: 3.0, dy: 0.0, weight: 0.5 },
                    Tap { dx: 6.0, dy: 1.0, weight: 0.25 },
                ]
            }),
        ),
        (
            "clip_include_ellipse",
            Box::new(|b| {
                b.clip = Some(Clip {
                    mode: ClipMode::Include,
                    origin: Pt::new(0.0, 0.0),
                    shapes: vec![ClipShape::Ellipse {
                        centre: Pt::new(75.0, 78.0),
                        rx: 30.0,
                        ry: 18.0,
                    }],
                })
            }),
        ),
        (
            "blend_overlay_fill_half_over_page",
            Box::new(|b| {
                b.blend = Blend::Overlay;
                b.fill_opacity = 0.5;
                b.backdrop = Some(page());
            }),
        ),
        (
            "blend_if_underlying",
            Box::new(|b| {
                b.backdrop = Some(page());
                b.blending = Blending::default();
                b.blending.blend_if.ranges[0][1] = Range {
                    black: [80, 120],
                    white: [255, 255],
                };
            }),
        ),
        // Outer Glow.
        ("outer_glow_softer", effect(Effect::OuterGlow(glow(Rgba([255, 200, 0, 255]), Technique::Softer, 8.0)))),
        ("outer_glow_precise", effect(Effect::OuterGlow(glow(Rgba([0, 200, 255, 255]), Technique::Precise, 10.0)))),
        (
            "outer_glow_gradient_jitter",
            effect(Effect::OuterGlow(Glow {
                gradient: Some(grad(Style::Linear)),
                jitter: 0.5,
                ..glow(WHITE, Technique::Softer, 9.0)
            })),
        ),
        (
            "outer_glow_noise_contour",
            effect(Effect::OuterGlow(Glow {
                noise: 0.5,
                contour: Some(cone),
                ..glow(BLUE, Technique::Softer, 8.0)
            })),
        ),
        (
            "outer_glow_screen_over_page",
            Box::new(|b| {
                b.effects = vec![Effect::OuterGlow(Glow {
                    blend: Blend::Screen,
                    ..glow(Rgba([60, 90, 200, 255]), Technique::Softer, 8.0)
                })];
                b.backdrop = Some(page());
            }),
        ),
        // Inner Glow and Inner Shadow.
        ("inner_glow_edge", effect(Effect::InnerGlow(glow(Rgba([255, 255, 150, 255]), Technique::Softer, 5.0)))),
        (
            "inner_glow_center_precise",
            effect(Effect::InnerGlow(Glow {
                center: true,
                ..glow(Rgba([255, 255, 150, 255]), Technique::Precise, 6.0)
            })),
        ),
        (
            "inner_shadow",
            effect(Effect::InnerShadow(InnerShadow {
                color: BLACK,
                opacity: 0.75,
                blend: Blend::Multiply,
                x: 2.0,
                y: 3.0,
                size: 5.0,
                choke: 0.2,
                noise: 0.0,
                contour: None,
                seed: 1,
            })),
        ),
        (
            "inner_shadow_noise_contour",
            effect(Effect::InnerShadow(InnerShadow {
                color: BLACK,
                opacity: 1.0,
                blend: Blend::Normal,
                x: 0.0,
                y: 4.0,
                size: 8.0,
                choke: 0.0,
                noise: 0.5,
                contour: Some(Lut::new(&Curve::Preset(5))),
                seed: 6,
            })),
        ),
        // Overlays.
        ("color_overlay_multiply", effect(Effect::ColorOverlay(overlay(Rgba([128, 200, 255, 255]), Blend::Multiply, 0.8)))),
        ("pattern_overlay_solid", effect(Effect::PatternOverlay(PaintOverlay {
            opacity: 0.6,
            blend: Blend::Normal,
            paint: Paint::Fill(Fill::Solid(BLUE)),
        }))),
        ("noise_gradient_overlay", effect(Effect::GradientOverlay(PaintOverlay {
            opacity: 1.0,
            blend: Blend::Normal,
            paint: Paint::Gradient(noise_grad()),
        }))),
        // Satin.
        (
            "satin",
            effect(Effect::Satin(Satin {
                color: BLACK,
                opacity: 0.5,
                blend: Blend::Multiply,
                angle: 19.0,
                distance: 11.0,
                size: 14.0,
                invert: false,
                contour: None,
            })),
        ),
        (
            "satin_gaussian_inverted",
            effect(Effect::Satin(Satin {
                color: BLUE,
                opacity: 1.0,
                blend: Blend::Normal,
                angle: 60.0,
                distance: 6.0,
                size: 6.0,
                invert: true,
                contour: Some(Lut::new(&Curve::Preset(5))),
            })),
        ),
        // Strokes.
        ("stroke_outside", effect(stroke(4.0, Position::Outside, Paint::Color(BLACK)))),
        ("stroke_inside", effect(stroke(3.0, Position::Inside, Paint::Color(BLUE)))),
        ("stroke_center", effect(stroke(4.0, Position::Center, Paint::Color(WHITE)))),
        ("stroke_outside_gradient", effect(stroke(5.0, Position::Outside, Paint::Gradient(grad(Style::Linear))))),
        ("stroke_inside_shape_burst", effect(stroke(5.0, Position::Inside, Paint::Gradient(grad(Style::ShapeBurst))))),
        (
            "stroke_multiply_over_page",
            Box::new(|b| {
                b.effects = vec![Effect::Stroke(Stroke {
                    size: 4.0,
                    position: Position::Outside,
                    opacity: 1.0,
                    blend: Blend::Multiply,
                    paint: Paint::Color(Rgba([255, 150, 60, 255])),
                    seed: 2,
                })];
                b.backdrop = Some(page());
            }),
        ),
        // Bevel & Emboss.
        ("bevel_inner_smooth", effect(Effect::Bevel(bevel(BevelStyle::Inner, BevelTechnique::Smooth)))),
        ("bevel_inner_chisel_hard", effect(Effect::Bevel(bevel(BevelStyle::Inner, BevelTechnique::ChiselHard)))),
        ("bevel_inner_chisel_soft", effect(Effect::Bevel(bevel(BevelStyle::Inner, BevelTechnique::ChiselSoft)))),
        ("bevel_outer_smooth", effect(Effect::Bevel(bevel(BevelStyle::Outer, BevelTechnique::Smooth)))),
        ("bevel_emboss_smooth", effect(Effect::Bevel(bevel(BevelStyle::Emboss, BevelTechnique::Smooth)))),
        ("bevel_pillow_chisel_soft", effect(Effect::Bevel(bevel(BevelStyle::Pillow, BevelTechnique::ChiselSoft)))),
        (
            "bevel_stroke_emboss",
            effects(vec![
                stroke(5.0, Position::Outside, Paint::Color(BLUE)),
                Effect::Bevel(bevel(BevelStyle::StrokeEmboss, BevelTechnique::Smooth)),
            ]),
        ),
        (
            "bevel_down_gloss_contour_texture",
            effect(Effect::Bevel(Bevel {
                up: false,
                soften: 3.0,
                gloss: Table::new(&Curve::Preset(5)),
                contour: Table::new(&Curve::Preset(1)),
                texture: Some(BevelTexture {
                    depth: 2.0,
                    invert: false,
                    fill: Fill::Solid(Rgba([90, 90, 90, 255])),
                }),
                ..bevel(BevelStyle::Inner, BevelTechnique::Smooth)
            })),
        ),
        (
            "bevel_outer_screen_over_page",
            Box::new(|b| {
                b.effects = vec![Effect::Bevel(bevel(BevelStyle::Outer, BevelTechnique::Smooth))];
                b.backdrop = Some(page());
            }),
        ),
    ];
    // The five gradient styles, as an overlay.
    for (name, style) in [
        ("gradient_overlay_linear", Style::Linear),
        ("gradient_overlay_radial", Style::Radial),
        ("gradient_overlay_angle", Style::Angle),
        ("gradient_overlay_reflected", Style::Reflected),
        ("gradient_overlay_diamond", Style::Diamond),
        ("gradient_overlay_shape_burst", Style::ShapeBurst),
    ] {
        rows.push((
            name,
            effect(Effect::GradientOverlay(PaintOverlay {
                opacity: 0.9,
                blend: Blend::Normal,
                paint: Paint::Gradient(grad(style)),
            })),
        ));
    }
    // A zoom and a turn: effects are carried by the transform.
    rows.push((
        "everything_at_zoom_2",
        Box::new(|b| {
            b.width = 400;
            b.height = 320;
            b.request.transform = Affine::scale(2.0, 2.0);
            b.shadows = vec![shadow(3.0, 4.0)];
            b.effects = vec![
                Effect::OuterGlow(glow(Rgba([255, 200, 0, 255]), Technique::Softer, 5.0)),
                Effect::GradientOverlay(PaintOverlay {
                    opacity: 1.0,
                    blend: Blend::Normal,
                    paint: Paint::Gradient(grad(Style::Linear)),
                }),
                stroke(3.0, Position::Outside, Paint::Color(BLACK)),
                Effect::Bevel(bevel(BevelStyle::Inner, BevelTechnique::Smooth)),
            ];
        }),
    ));
    rows.push((
        "everything_turned_30",
        Box::new(|b| {
            b.request.transform = turn(30.0);
            b.shadows = vec![shadow(3.0, 4.0)];
            b.effects = vec![
                Effect::OuterGlow(glow(Rgba([255, 200, 0, 255]), Technique::Softer, 5.0)),
                Effect::GradientOverlay(PaintOverlay {
                    opacity: 1.0,
                    blend: Blend::Normal,
                    paint: Paint::Gradient(grad(Style::Linear)),
                }),
                stroke(3.0, Position::Outside, Paint::Color(BLACK)),
                Effect::Bevel(bevel(BevelStyle::Inner, BevelTechnique::Smooth)),
            ];
        }),
    ));
    rows
}

/// 64-bit FNV-1a over the raster's origin, size and bytes (little endian);
/// the empty paint hashes as nothing.
fn hash(r: Option<&Raster>) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &v in bytes {
            h = (h ^ u64::from(v)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    if let Some(r) = r {
        for v in [r.x, r.y, r.width as i32, r.height as i32] {
            eat(&v.to_le_bytes());
        }
        eat(&r.data);
    }
    format!("{h:016x}")
}

fn painted() -> Vec<(String, String)> {
    let mut engine = Engine::new();
    let font = load(&mut engine);
    sheet()
        .into_iter()
        .map(|(name, change)| {
            let mut b = base(font);
            change(&mut b);
            let r = paint_box(&mut engine, &mut b).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            (name.to_owned(), hash(r.as_ref()))
        })
        .collect()
}

#[test]
fn every_effect_paints_the_pixels_the_sheet_pins() {
    let now = painted();
    if std::env::var_os("BLESS").is_some() {
        let text: String = now.iter().map(|(n, h)| format!("{n} {h}\n")).collect();
        let path = format!("{}/tests/data/paint_hashes.txt", env!("CARGO_MANIFEST_DIR"));
        std::fs::write(path, text).unwrap();
        return;
    }
    let pinned: Vec<(&str, &str)> = SHEET
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.split_once(' ').expect("`name hash` lines"))
        .collect();
    // `wrong`: what fails on every target; `changed`: hashes, which fail
    // only where they are exact (`strict`).
    let mut wrong = Vec::new();
    let mut changed = Vec::new();
    for (name, h) in &now {
        match pinned.iter().find(|(n, _)| n == name) {
            Some((_, want)) if want == h => {}
            Some((_, want)) => changed.push(format!("{name}: pixels changed ({want} -> {h})")),
            None => wrong.push(format!("{name}: not in the sheet ({h})")),
        }
    }
    for (name, _) in &pinned {
        if !now.iter().any(|(n, _)| n == name) {
            wrong.push(format!("{name}: in the sheet and no longer painted"));
        }
    }
    if strict() {
        wrong.append(&mut changed);
    } else if !changed.is_empty() {
        eprintln!(
            "warning: paint_hashes: {} of {} hashes differ from the sheet blessed on aarch64 macOS; \
             this target's float maths may differ (STRICT_HASHES=1 makes this fail):\n{}",
            changed.len(),
            now.len(),
            changed.join("\n")
        );
        coarse_check(&now);
    }
    assert!(
        wrong.is_empty(),
        "the sheet and the engine disagree (BLESS=1 to re-bless, on purpose):\n{}",
        wrong.join("\n")
    );
}

/// What holds on every target, exact hashes or not: every row paints
/// something, and no two rows paint the same pixels.
fn coarse_check(now: &[(String, String)]) {
    let nothing = hash(None);
    for (name, h) in now {
        assert_ne!(*h, nothing, "{name} painted nothing");
    }
    for (i, (a, ha)) in now.iter().enumerate() {
        for (b, hb) in &now[i + 1..] {
            assert_ne!(ha, hb, "{a} and {b} paint the same pixels");
        }
    }
}

/// Every hash is of something drawn, and no two entries are alike: a sheet
/// whose rows all paint the same would pin nothing.
#[test]
fn the_sheet_has_a_distinct_picture_in_every_row() {
    coarse_check(&painted());
}
