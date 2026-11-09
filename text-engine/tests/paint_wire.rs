//! The box wire, field by field (review F72). `encodeBox` (js/paint.mjs)
//! wrote `tests/data/box_wire_distinct.hex` from the request in
//! `tests/data/box_wire_distinct.request.mjs`, in which every field has a
//! value of its own; the other wire test builds its bytes by hand, with
//! values that repeat (a spread and a range of one half), so two fields
//! swapped between the writer and the reader read the same and pass. Here
//! each field of that request must come back from `decode_box` as itself.
//!
//! `src/lib/text-engine/box-wire-fixture.test.js` checks the fixture is
//! what `encodeBox` writes now, so a change on either side fails one of the
//! two. After a wire change: bump both versions, write the fixture again
//! (the request file says how), and state the new fields here.
#![cfg(feature = "paint")]

use mt_text::paint::fx::blend::Blend;
use mt_text::paint::fx::blending::Range;
use mt_text::paint::fx::contour::{Curve, Lut, Table};
use mt_text::paint::fx::effects::{
    Bevel, BevelStyle, BevelTechnique, BevelTexture, Effect, Glow, InnerShadow, Overlay, Paint,
    PaintOverlay, Position, Satin, Stroke, Technique,
};
use mt_text::paint::fx::gradient::{Gradient, Style};
use mt_text::paint::fx::gradient_bake::Method;
use mt_text::paint::fx::noise_gradient::{Model, Noise, Ramp};
use mt_text::paint::{
    decode_box, Align, Band, Clip, ClipMode, ClipShape, Fill, Pt, Rgba, Shadow, Tap,
    BOX_WIRE_VERSION,
};

const HEX: &str = include_str!("data/box_wire_distinct.hex");

fn bytes() -> Vec<u8> {
    let hex: String = HEX.split_whitespace().collect();
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn rgb(c: u32) -> Rgba {
    Rgba([(c >> 16) as u8, (c >> 8) as u8, c as u8, 255])
}

/// The straight colour of a stop, as the decoder reads a byte.
fn stop(pos: f32, c: u32) -> (f32, [f32; 3]) {
    let b = |v: u32| (v & 255) as f32 / 255.0;
    (pos, [b(c >> 16), b(c >> 8), b(c)])
}

fn stops_gradient(style: Style, angle: f32, scale: f32, offset: (f32, f32)) -> Gradient {
    Gradient {
        stops: vec![stop(0.0625, 0xaa0011), stop(0.5, 0x22bb33), stop(0.9375, 0x4455cc)],
        opacity: vec![(0.125, 1.0), (0.4375, 0.625), (0.75, 0.375), (0.875, 0.1875)],
        style,
        angle,
        scale,
        reverse: false,
        offset,
        // v14: each midpoint is sent for the segment the stop ends.
        mids: vec![0.3125, 0.8125],
        opacity_mids: vec![0.6875, 0.5, 0.1875],
        dither: false,
        noise: None,
    }
}

/// [`stops_gradient`] as the overlay sends it (v14): Dither on, Classic at
/// 0 %, so the stops and midpoints come back as they are.
fn overlay_gradient() -> Gradient {
    Gradient {
        dither: true,
        ..stops_gradient(Style::Radial, 71.5, 1.375, (0.3125, -0.4375))
    }
}

/// [`stops_gradient`] as the stroke sends it (v14): Perceptual at 43.75 %,
/// which the reader bakes into the stops.
fn stroke_gradient() -> Gradient {
    let mut g = stops_gradient(Style::Angle, 12.5, 0.625, (-0.0625, 0.125));
    g.interpolate(Method::Perceptual, 0.4375).unwrap();
    g
}

fn noise_gradient() -> Gradient {
    Gradient {
        stops: vec![stop(0.125, 0x102030), stop(0.875, 0x405060)],
        opacity: vec![(0.125, 0.5), (0.875, 0.25)],
        style: Style::Diamond,
        angle: 33.5,
        scale: 0.875,
        reverse: true,
        offset: (0.0625, -0.1875),
        mids: Vec::new(),
        opacity_mids: Vec::new(),
        dither: false,
        noise: Some(Ramp::new(Noise {
            seed: 31415,
            roughness: 0.3125,
            model: Model::Lab,
            min: [0.0625, 0.125, 0.1875],
            max: [0.6875, 0.8125, 0.9375],
            restrict: true,
            transparency: true,
        })),
    }
}

fn preset(n: u32) -> Option<Lut> {
    Some(Lut::new(&Curve::Preset(n)))
}

#[test]
fn every_field_of_the_box_comes_back_as_itself() {
    let r = decode_box(&bytes()).expect("the fixture decodes (a wire change needs a new one)");
    assert_eq!(BOX_WIRE_VERSION, 16, "the fixture is of another wire version");
    assert_eq!((r.width, r.height), (211, 137));
    assert_eq!(r.grain, (-1_234_567, 89_012));
    assert_eq!(
        r.shadows,
        vec![
            Shadow {
                color: rgb(0x102030),
                opacity: 0.3125,
                x: 1.5,
                y: -2.5,
                size: 3.25,
                grow: 0.75,
                spread: 0.125,
                noise: 0.4375,
                blend: Blend::Multiply,
                knockout: true,
                exact: true,
                contour: preset(7),
                seed: 90210,
            },
            Shadow {
                color: rgb(0xa0b0c0),
                opacity: 0.8125,
                x: -3.75,
                y: 4.25,
                size: 5.5,
                grow: 1.25,
                spread: 0.375,
                noise: 0.0625,
                blend: Blend::Screen,
                knockout: false,
                exact: false,
                contour: preset(11),
                seed: 1357,
            },
        ]
    );
    assert_eq!(r.blur, 0.8125);
    assert_eq!(
        r.taps,
        vec![
            Tap { dx: 1.5, dy: -0.5, weight: 0.3125 },
            Tap { dx: -2.5, dy: 3.5, weight: 0.625 },
        ]
    );
    assert_eq!(
        r.clip,
        Some(Clip {
            mode: ClipMode::Exclude,
            origin: Pt::new(13.5, 17.25),
            shapes: vec![
                ClipShape::Ellipse { centre: Pt::new(21.5, 22.5), rx: 5.5, ry: 6.5 },
                ClipShape::Polygon(vec![Pt::new(1.5, 2.5), Pt::new(30.5, 3.5), Pt::new(4.5, 29.5)]),
                ClipShape::Stroke { size: 3.5, pts: vec![Pt::new(7.5, 8.5), Pt::new(9.5, 12.5)] },
            ],
        })
    );
    assert_eq!((r.blend, r.fill_opacity), (Blend::ColorBurn, 0.6875));
    assert!(r.blending.interior);
    // Transparency Shapes Layer off (v13): flag 2.
    assert!(r.blending.shapeless);
    // R and B kept, G left out: bit 1.
    assert_eq!(r.blending.channels_out, 2);
    // Gray, R, G, B, each This Layer then Underlying: eight sliders, each of
    // four levels of its own.
    let range = |n: u8| Range { black: [n, n + 10], white: [200 + n, 220 + n] };
    let want = [[range(1), range(2)], [range(3), range(4)], [range(5), range(6)], [range(7), range(8)]];
    assert_eq!(r.blending.blend_if.ranges, want);
    assert!(r.backdrop.is_none());
    // The glyph job under it.
    let q = &r.request;
    assert_eq!((q.face.font, q.face.size, q.weight), (7, 53.5, 1.5));
    assert_eq!(q.transform.0, [1.25, 0.5, -0.25, 1.5, 11.0, 13.0]);
    assert!(q.job.curved);
    assert_eq!((q.job.align, q.job.letter_spacing), (Align::Center, 1.75));
    assert_eq!(q.job.silhouette, None);
    assert!(!q.job.no_fill);
    assert_eq!(q.job.bands, vec![Band { color: rgb(0x112233), opacity: 0.6875, line: 3.5 }]);
    assert_eq!(q.job.fill, Some(Fill::Solid(rgb(0x778899))));
    assert_eq!(q.job.runs.len(), 2);
    let (a, b) = (&q.job.runs[0], &q.job.runs[1]);
    assert_eq!((a.text.as_str(), a.x, a.y, a.rot), ("AB", 14.5, 21.5, 0.375));
    assert_eq!((a.sx, a.sy, a.skew, a.drip, a.pen, a.ghost), (1.125, 0.875, 0.0625, 0.5, 1.25, true));
    assert_eq!(a.fill, Some(Fill::Solid(rgb(0x334455))));
    assert_eq!((b.text.as_str(), b.x, b.y, b.rot), ("C", 33.5, 41.25, -0.1875));
    assert_eq!((b.sx, b.sy, b.skew, b.drip, b.pen, b.ghost), (0.9375, 1.0625, -0.03125, 0.25, 1.5, false));
    assert_eq!(b.fill, None);
}

#[test]
fn every_field_of_every_effect_comes_back_as_itself() {
    let r = decode_box(&bytes()).unwrap();
    let want = vec![
        Effect::OuterGlow(Glow {
            color: rgb(0xaabbcc),
            gradient: Some(noise_gradient()),
            opacity: 0.71875,
            blend: Blend::Screen,
            technique: Technique::Precise,
            size: 6.5,
            spread: 0.1875,
            range: 0.8125,
            noise: 0.34375,
            contour: preset(3),
            center: false,
            jitter: 0.40625,
            seed: 12345,
        }),
        Effect::InnerGlow(Glow {
            color: rgb(0xddeeff),
            gradient: None,
            opacity: 0.59375,
            blend: Blend::LinearDodge,
            technique: Technique::Softer,
            size: 4.75,
            // An inner glow's Choke rides the same slot as an outer one's Spread.
            spread: 0.21875,
            range: 0.65625,
            noise: 0.15625,
            contour: preset(6),
            center: true,
            jitter: 0.53125,
            seed: 23456,
        }),
        Effect::InnerShadow(InnerShadow {
            color: rgb(0x010203),
            opacity: 0.84375,
            blend: Blend::LinearBurn,
            x: 2.25,
            y: -3.75,
            size: 4.5,
            choke: 0.28125,
            noise: 0.46875,
            contour: preset(10),
            seed: 777,
        }),
        Effect::ColorOverlay(Overlay {
            color: rgb(0x0f1e2d),
            opacity: 0.90625,
            blend: Blend::HardLight,
        }),
        Effect::GradientOverlay(PaintOverlay {
            opacity: 0.78125,
            blend: Blend::SoftLight,
            paint: Paint::Gradient(overlay_gradient()),
        }),
        Effect::PatternOverlay(PaintOverlay {
            opacity: 0.53125,
            blend: Blend::Lighten,
            paint: Paint::Fill(Fill::Solid(rgb(0x456789))),
        }),
        Effect::Stroke(Stroke {
            size: 5.5,
            position: Position::Center,
            opacity: 0.4375,
            blend: Blend::Difference,
            paint: Paint::Gradient(stroke_gradient()),
            seed: 4242,
        }),
        Effect::Satin(Satin {
            color: rgb(0xf0e0d0),
            opacity: 0.46875,
            blend: Blend::Darken,
            angle: 47.5,
            distance: 9.5,
            size: 12.25,
            invert: true,
            contour: preset(9),
        }),
        Effect::Bevel(Bevel {
            style: BevelStyle::Pillow,
            technique: BevelTechnique::ChiselHard,
            depth: 2.5,
            up: false,
            size: 7.5,
            soften: 1.75,
            angle: 133.5,
            altitude: 41.5,
            highlight: Overlay { color: rgb(0xfafbfc), opacity: 0.6875, blend: Blend::Overlay },
            shadow: Overlay { color: rgb(0x050607), opacity: 0.3125, blend: Blend::Exclusion },
            gloss: Table::new(&Curve::Preset(8)),
            // The Gloss Contour's Anti-aliased flag, which painting does not
            // read, is carried.
            gloss_aa: true,
            contour: Table::new(&Curve::Preset(2)),
            range: 0.5625,
            contour_aa: true,
            texture: Some(BevelTexture {
                depth: 3.5,
                invert: true,
                fill: Fill::Solid(rgb(0x13579b)),
            }),
        }),
    ];
    assert_eq!(r.effects.len(), want.len());
    // One at a time, so a failure names the effect.
    for (i, (got, want)) in r.effects.iter().zip(&want).enumerate() {
        assert_eq!(got, want, "effect {i}");
    }
}
