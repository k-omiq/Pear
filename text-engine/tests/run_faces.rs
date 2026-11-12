//! A straight job's lines set in several faces (glyph wire v13): the face
//! table and the stretches at the end of the job, how the painter shapes a
//! line by them, and that a job without them is the job it was.
#![cfg(feature = "paint")]

use mt_text::paint::{
    decode, paint_job, shape_run, shape_spans, Affine, Align, Effects, Fill, Job, Raster, Request,
    Rgba, Run, RunFaces, MAGIC, WIRE_VERSION,
};
use mt_text::{BoldAdvance, Engine, Error, Face, FontId, Synth};

fn load(engine: &mut Engine, name: &str) -> FontId {
    let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
    engine
        .add_font_bytes(std::fs::read(path).unwrap(), 0)
        .unwrap()
}

const BLACK: Rgba = Rgba([0, 0, 0, 255]);

fn setup() -> (Engine, Face, Face) {
    let mut e = Engine::new();
    e.rules.bold_advance = BoldAdvance::WebKit;
    let font = load(&mut e, "DejaVuSans.ttf");
    let regular = Face::new(font, 40.0);
    let bold = Face {
        synth: Synth::from_bits(1),
        ..regular
    };
    (e, regular, bold)
}

fn request(text: &str, face: Face, faces: RunFaces) -> Request {
    Request {
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
                x: 10.0,
                y: 60.0,
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
        face,
        bold_draw: None,
        weight: 0.0,
        transform: Affine::IDENTITY,
        tiles: Vec::new(),
        ink: None,
        faces,
    }
}

fn paint(e: &mut Engine, r: &Request) -> Raster {
    paint_job(e, r).unwrap().expect("something was drawn")
}

/// The wire form of a one-run straight job, as paint.mjs writes it, and the
/// v13 block after it when `block` is given, flagged (128) as it says.
fn wire(font: u32, text: &str, curved: bool, block: Option<&[u32]>) -> Vec<u8> {
    wire_flagged(font, text, curved, block, block.is_some())
}

fn wire_flagged(font: u32, text: &str, curved: bool, block: Option<&[u32]>, flagged: bool) -> Vec<u8> {
    let mut b = Vec::new();
    let u = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
    let f = |b: &mut Vec<u8>, v: f64| b.extend_from_slice(&v.to_le_bytes());
    u(&mut b, MAGIC);
    u(&mut b, WIRE_VERSION);
    u(&mut b, font);
    u(&mut b, 0); // no synthesis
    u(&mut b, 0); // no chain
    u(&mut b, 0); // bold as the rule has it
    f(&mut b, 40.0);
    for v in [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] {
        f(&mut b, v);
    }
    f(&mut b, 0.0); // weight
    u(&mut b, u32::from(curved) | if flagged { 128 } else { 0 });
    u(&mut b, 0); // left
    f(&mut b, 0.0);
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // round join
    b.extend_from_slice(&[0, 0, 0, 0]);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    f(&mut b, 0.0);
    u(&mut b, 0); // no band
    u(&mut b, 1); // solid fill
    b.extend_from_slice(&[0, 0, 0, 255]);
    u(&mut b, 0); // no mesh
    u(&mut b, 0); // not roughened
    u(&mut b, 1); // one run
    for v in [10.0, 60.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0] {
        f(&mut b, v);
    }
    u(&mut b, 0);
    u(&mut b, 0); // the job's fill
    u(&mut b, text.len() as u32);
    b.extend_from_slice(text.as_bytes());
    u(&mut b, 0); // no tiles
    for v in block.unwrap_or(&[]) {
        u(&mut b, *v);
    }
    b
}

#[test]
fn a_job_without_the_block_has_no_faces() {
    let r = decode(&wire(3, "HI", false, None)).unwrap();
    assert_eq!(r.faces, RunFaces::default());
    assert!(r.faces.of(0).is_none());
}

#[test]
fn the_block_decodes_to_the_faces_and_stretches_it_states() {
    // Two faces (font 3 regular, font 3 bold on chain 2); the run's H bold.
    let block = [2, 3, 0, 0, 3, 1, 2, 1, 2, 1, 0, 1, 0, 1, 2];
    let r = decode(&wire(3, "HI", false, Some(&block))).unwrap();
    assert_eq!(r.faces.faces.len(), 2);
    assert_eq!(r.faces.faces[1].font, 3);
    assert!(r.faces.faces[1].synth.bold);
    assert_eq!(r.faces.faces[1].chain, 2);
    // Every face is at the job's size.
    assert_eq!(r.faces.faces[1].size, 40.0);
    assert_eq!(r.faces.spans, vec![vec![(1, 0..1), (0, 1..2)]]);
    let of = r.faces.of(0).unwrap();
    assert_eq!(of[0].0, r.faces.faces[1]);
    assert_eq!(of[1].1, 1..2);
}

#[test]
fn a_damaged_block_is_refused() {
    let bad: [&[u32]; 6] = [
        // No faces.
        &[0, 1, 0],
        // A face index past the table.
        &[1, 3, 0, 0, 1, 1, 1, 0, 2],
        // A run count that is not the job's.
        &[1, 3, 0, 0, 2, 0, 0],
        // A stretch that ends before it starts.
        &[1, 3, 0, 0, 1, 1, 0, 2, 1],
        // Cut short.
        &[1, 3, 0],
        // More faces than a job may have.
        &[17],
    ];
    for block in bad {
        assert_eq!(decode(&wire(3, "HI", false, Some(block))).err(), Some(Error::BadSpec), "{block:?}");
    }
    // A block with no flag saying so is bytes past the job's end, and a flag
    // with no block is a job cut short.
    assert_eq!(decode(&wire_flagged(3, "HI", false, Some(&[1, 3, 0, 0, 1, 0]), false)).err(), Some(Error::BadSpec));
    assert_eq!(decode(&wire_flagged(3, "HI", false, None, true)).err(), Some(Error::BadSpec));
    // A curve is laid out in one face.
    assert_eq!(
        decode(&wire(3, "HI", true, Some(&[1, 3, 0, 0, 1, 0]))).err(),
        Some(Error::BadSpec)
    );
}

#[test]
fn one_stretch_in_a_face_paints_what_the_face_alone_paints() {
    let (mut e, regular, bold) = setup();
    let spans = RunFaces {
        faces: vec![bold],
        spans: vec![vec![(0, 0..5)]],
    };
    let cut = paint(&mut e, &request("HELLO", regular, spans));
    let whole = paint(&mut e, &request("HELLO", bold, RunFaces::default()));
    assert_eq!((cut.x, cut.y, cut.width, cut.height), (whole.x, whole.y, whole.width, whole.height));
    assert!(cut.data == whole.data);
}

#[test]
fn a_line_in_two_faces_is_placed_by_each_faces_own_widths() {
    let (mut e, regular, bold) = setup();
    let shaped = shape_spans(&mut e, &[(bold, 0..1), (regular, 1..2)], "HI", 0.0).unwrap();
    let h = e.advance(bold, "H").unwrap();
    let i = e.advance(regular, "I").unwrap();
    // The I starts where the bold H ends, and the line is as wide as the
    // layout measures it (`advance_spans`).
    assert_eq!(shaped.glyphs[1].x.to_bits(), h.to_bits());
    assert!(shaped.glyphs[0].synth.bold && !shaped.glyphs[1].synth.bold);
    assert_eq!(shaped.advance.to_bits(), (h + i).to_bits());
    let measured = e.advance_spans(&[(bold, 0..1), (regular, 1..2)], "HI").unwrap();
    assert_eq!(shaped.advance.to_bits(), measured.to_bits());
    // Letter spacing still follows every cluster of the line.
    let spaced = shape_spans(&mut e, &[(bold, 0..1), (regular, 1..2)], "HI", 3.0).unwrap();
    assert!((spaced.advance - (h + i + 6.0)).abs() < 1e-9);
    assert!((spaced.glyphs[1].x - (h + 3.0)).abs() < 1e-9);
    // And the painted line differs from the line in one face.
    let two = paint(
        &mut e,
        &request(
            "HI",
            regular,
            RunFaces {
                faces: vec![regular, bold],
                spans: vec![vec![(1, 0..1), (0, 1..2)]],
            },
        ),
    );
    let one = paint(&mut e, &request("HI", regular, RunFaces::default()));
    assert!(two.width > one.width || two.data != one.data);
    let plain = shape_run(&mut e, regular, "HI", 0.0).unwrap();
    assert!(shaped.advance > plain.advance);
}

#[test]
fn a_face_the_engine_does_not_hold_is_refused() {
    let (mut e, regular, _) = setup();
    let ghost = Face {
        font: 999,
        ..regular
    };
    let r = request(
        "HI",
        regular,
        RunFaces {
            faces: vec![ghost],
            spans: vec![vec![(0, 0..2)]],
        },
    );
    assert!(paint_job(&mut e, &r).is_err());
}
