//! A line set in several faces (`Engine::advance_spans`): cut at every span,
//! then at every change of coverage inside one, each piece shaped alone. So it
//! measures exactly what its spans measure each alone, summed - the number the
//! layout breaks lines by and the painter will draw.

use mt_text::{BoldAdvance, Engine, Error, Face, FontId, Synth};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const SIZE: f64 = 40.0;

fn setup() -> (Engine, Face, Face) {
    let mut e = Engine::new();
    e.rules.bold_advance = BoldAdvance::WebKit;
    let bangers = load(&mut e, "Bangers-Regular.ttf");
    let regular = Face::new(bangers, SIZE);
    let bold = Face {
        synth: Synth::from_bits(1),
        ..regular
    };
    (e, regular, bold)
}

#[test]
fn one_span_is_the_face_alone() {
    let (mut e, regular, _) = setup();
    let text = "HELLO, WORLD";
    let alone = e.advance(regular, text).unwrap();
    let spans = e.advance_spans(&[(regular, 0..12)], text).unwrap();
    assert_eq!(spans.to_bits(), alone.to_bits());
}

#[test]
fn spans_measure_what_each_measures_alone() {
    let (mut e, regular, bold) = setup();
    let text = "HELLO WORLD";
    let got = e
        .advance_spans(&[(bold, 0..5), (regular, 5..11)], text)
        .unwrap();
    let parts = e.advance(bold, "HELLO").unwrap() + e.advance(regular, " WORLD").unwrap();
    assert_eq!(got.to_bits(), parts.to_bits());
    // The bold span is wider by what a synthesised bold adds to each of its
    // five glyphs, and the rest is untouched.
    let plain = e.advance(regular, text).unwrap();
    assert!((got - plain - 5.0 * SIZE / 36.0).abs() < 0.5, "{got} vs {plain}");
}

#[test]
fn no_kerning_across_a_span_edge() {
    let (mut e, regular, _) = setup();
    // Cut between two letters, the same face on both sides measures each side
    // alone: whatever the pair kerns by inside one run is not applied.
    let cut = e
        .advance_spans(&[(regular, 0..1), (regular, 1..2)], "AV")
        .unwrap();
    let apart = e.advance(regular, "A").unwrap() + e.advance(regular, "V").unwrap();
    assert_eq!(cut.to_bits(), apart.to_bits());
}

#[test]
fn a_span_is_still_cut_where_coverage_changes() {
    let (mut e, _, _) = setup();
    let comic = load(&mut e, "ComicNeue-Regular.ttf");
    let dejavu = load(&mut e, "DejaVuSans.ttf");
    let chain = e.chain_new();
    e.chain_push(chain, dejavu, Synth::NONE).unwrap();
    let face = Face {
        chain,
        ..Face::new(comic, SIZE)
    };
    let bold = Face {
        synth: Synth::from_bits(1),
        ..face
    };
    // Comic Neue has no Greek: the Ω in the bold span is DejaVu's.
    let text = "AΩB C";
    let got = e
        .advance_spans(&[(bold, 0..3), (face, 3..5)], text)
        .unwrap();
    // The chain's DejaVu lends the Ω with the chain's own synthesis (none
    // here); the app builds a chain per face for that reason.
    let fonts: Vec<_> = e.parts().iter().map(|p| (p.font, p.synth.bits(), p.text.clone())).collect();
    assert_eq!(
        fonts,
        [(comic, 1, 0..1), (dejavu, 0, 1..2), (comic, 1, 2..3), (comic, 0, 3..5)]
    );
    let parts = e.advance(bold, "AΩB").unwrap() + e.advance(face, " C").unwrap();
    assert_eq!(got.to_bits(), parts.to_bits());
}

#[test]
fn spans_must_cover_the_text_in_order() {
    let (mut e, regular, bold) = setup();
    let text = "AB\u{1d538}";
    assert_eq!(e.advance_spans(&[(regular, 0..1)], text), Err(Error::BadSpec));
    assert_eq!(e.advance_spans(&[(regular, 1..4)], text), Err(Error::BadSpec));
    assert_eq!(
        e.advance_spans(&[(regular, 0..2), (bold, 1..4)], text),
        Err(Error::BadSpec)
    );
    // Through the middle of the surrogate pair.
    assert_eq!(
        e.advance_spans(&[(regular, 0..3), (bold, 3..4)], text),
        Err(Error::BadSpec)
    );
    assert!(e
        .advance_spans(&[(regular, 0..2), (bold, 2..4)], text)
        .is_ok());
    assert_eq!(e.advance_spans(&[], ""), Ok(0.0));
}
