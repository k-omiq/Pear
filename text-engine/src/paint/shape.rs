//! The shaping step: a run of text in, positioned glyphs out.
//!
//! The painter draws positioned glyphs and nothing else, so everything it
//! knows about text is in this file: [`shape_run`] turns a run into glyphs,
//! and the two anchor rules ([`align_offset`] and [`curved_origin`]) say
//! where a run's start lies relative to the point a job gives.
//!
//! The glyphs are the engine's measured line (`Engine::measure_line`), the
//! one `advance`, `lineInk` and the breaker read: the same whitespace rule,
//! the same features, the same fallback parts, the same advances under the
//! `boldAdvance` rule. So the ink lands where the measurement says, and a
//! letter the face lacks is drawn from the font its part names.

use super::budget;
use super::job::Align;
use crate::engine::{Engine, Face, FontId, ShapeMode, Synth};
use crate::Error;
use core::ops::Range;

/// One glyph, placed relative to the start of its run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placed {
    pub font: FontId,
    pub glyph: u32,
    /// The glyph's origin in pixels: x from the run's start, y **down** from
    /// the alphabetic baseline.
    pub x: f64,
    pub y: f64,
    /// Font size in pixels.
    pub size: f64,
    pub synth: Synth,
    /// The cluster the glyph belongs to: its first UTF-16 offset in the
    /// run's text. Glyphs of one letter (a base and its marks) share it.
    pub cluster: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShapedRun {
    pub glyphs: budget::Buffer<Placed>,
    /// Where the pen ends: the sum of the advances, plus the letter spacing
    /// once per cluster. This is the width alignment uses.
    pub advance: f64,
}

/// Shapes `text` as a line of `face` and places its glyphs.
///
/// The line is one part, or one per font when `face.chain` supplies a letter
/// the face lacks (RULES.md rule 10). Positions are computed as
/// `Engine::line_ink` computes them: each part's pen in integer font units,
/// scaled once, after the widths of the parts before it; a synthesised bold
/// under `boldAdvance = webkit` moves every later glyph of its part on.
///
/// `letter_spacing` is canvas `letterSpacing` in pixels:
///
/// - it is added after every cluster, **the last one included**. A centred
///   line is centred on the advance with that trailing gap in it, so its ink
///   sits half a gap left of centre. Chromium, WebKit and Skia all do this
///   (measured on the reference pictures of the `spacing` cases, P5A-REPORT.md);
/// - when it is not zero the optional ligatures (`liga`, `clig`) are turned
///   off, as the breaker does for the same line, so "fi" is spaced as two
///   letters. Kerning stays on.
pub fn shape_run(
    engine: &mut Engine,
    face: Face,
    text: &str,
    letter_spacing: f64,
) -> Result<ShapedRun, Error> {
    shape_with(engine, face, text, letter_spacing, letter_spacing != 0.0)
}

/// [`shape_run`], with the ligatures on or off by the caller's word rather
/// than by the spacing: a curved line is shaped with none of its own (the
/// gaps are in its letters' places) and its ligatures as its spacing says.
fn shape_with(
    engine: &mut Engine,
    face: Face,
    text: &str,
    letter_spacing: f64,
    no_ligatures: bool,
) -> Result<ShapedRun, Error> {
    if text.len() > budget::MAX_RUN_BYTES {
        return Err(Error::BadSpec);
    }
    let mode = ShapeMode {
        no_ligatures,
        ..ShapeMode::MEASURE
    };
    engine.measure_line(face, text, mode)?;
    place(engine, face.size, letter_spacing)
}

/// [`shape_run`] for a line set in several faces: `spans` are `(face,
/// start..end)`, UTF-16 units of `text`, in order and end to end, all at one
/// size. The line is cut at every span and then where coverage changes, as
/// `Engine::measure_spans` measures it for the layout, and each piece is
/// placed after the ones before it. So nothing kerns across a change of
/// face, the letter spacing still follows every cluster of the line, and the
/// glyphs land where the measured widths say. `BadSpec` for spans that do
/// not cover the text.
pub fn shape_spans(
    engine: &mut Engine,
    spans: &[(Face, Range<u32>)],
    text: &str,
    letter_spacing: f64,
) -> Result<ShapedRun, Error> {
    if text.len() > budget::MAX_RUN_BYTES {
        return Err(Error::BadSpec);
    }
    let Some((first, _)) = spans.first() else {
        return Err(Error::BadSpec);
    };
    let size = first.size;
    engine.measure_spans(spans, text, mode_for(letter_spacing))?;
    place(engine, size, letter_spacing)
}

// Spaced text has its optional ligatures off, as the breaker measures it.
fn mode_for(letter_spacing: f64) -> ShapeMode {
    ShapeMode {
        no_ligatures: letter_spacing != 0.0,
        ..ShapeMode::MEASURE
    }
}

// The glyphs of the line the engine last measured, placed part after part.
fn place(engine: &Engine, size: f64, letter_spacing: f64) -> Result<ShapedRun, Error> {
    let mut glyphs = budget::Buffer::new();
    super::budget::reserve(&mut glyphs, engine.line.len())?;
    let mut origin = 0.0f64;
    let mut gaps = 0u32;
    let mut at = 0usize;
    for part in engine.parts() {
        let upem = f64::from(engine.font(part.font)?.info.units_per_em);
        let scale = size / upem;
        let extra = engine.bold_extra(part.synth, size);
        let mut pen = 0i64;
        for (n, g) in engine.line[part.glyphs.clone()].iter().enumerate() {
            budget::push(
                &mut glyphs,
                Placed {
                    font: part.font,
                    glyph: g.id,
                    x: origin
                        + n as f64 * extra
                        + (pen + i64::from(g.x_offset)) as f64 * scale
                        + f64::from(gaps) * letter_spacing,
                    y: -f64::from(g.y_offset) * scale,
                    size,
                    synth: part.synth,
                    cluster: g.cluster,
                },
            )?;
            pen += i64::from(g.x_advance);
            at += 1;
            // The gap follows the last glyph of a cluster. Clusters are
            // counted along the whole line, so this holds across parts.
            if engine
                .line
                .get(at)
                .is_none_or(|next| next.cluster != g.cluster)
            {
                gaps += 1;
            }
        }
        origin += pen as f64 * scale + part.glyphs.len() as f64 * extra;
    }
    Ok(ShapedRun {
        glyphs,
        advance: engine.line_advance(size)? + f64::from(gaps) * letter_spacing,
    })
}

/// The runs of a curved line (`Effects::line`) shaped as the one line they
/// are, so kerning between letters, ligatures and contextual alternates (a
/// bouncy font's `calt`) hold on a curve as on a straight line. Each run is
/// one cluster of the line, in order, as the app lays them out
/// (`lineClusters` in measure.js, which reads the same shaping through
/// `mt_line_carets`); each comes back as its own run: the line's glyphs of
/// that cluster, placed from the cluster's pen, and as its advance the
/// distance to the next cluster's pen, kerning included, which is what the
/// letter is centred by.
///
/// `no_ligatures` is the line's letter spacing being set: a spaced line has
/// none, as a straight one has none.
///
/// `None` when the runs are not the line's clusters one for one (a run that
/// starts inside a cluster, or one with no glyph, or a line whose clusters
/// do not run forwards), or the line is longer than a run may be: the
/// caller then shapes each run on its own, as every curved run was before.
pub fn shape_line_runs<'t>(
    engine: &mut Engine,
    face: Face,
    texts: impl Iterator<Item = &'t str> + Clone,
    no_ligatures: bool,
) -> Result<Option<budget::Buffer<ShapedRun>>, Error> {
    let len: usize = texts.clone().map(str::len).sum();
    if len > budget::MAX_RUN_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    budget::reserve_raw(&mut bytes, len)?;
    // Where each run starts in the line, in UTF-16 units (a cluster's unit).
    let mut starts: budget::Buffer<u32> = budget::Buffer::new();
    let mut at16 = 0u32;
    for text in texts {
        if text.is_empty() {
            return Ok(None);
        }
        budget::push(&mut starts, at16)?;
        at16 += text.encode_utf16().count() as u32;
        bytes.extend_from_slice(text.as_bytes());
    }
    // Whole runs of `str` end to end are a `str`.
    let line = core::str::from_utf8(&bytes).map_err(|_| Error::BadSpec)?;
    let shaped = shape_with(engine, face, line, 0.0, no_ligatures)?;
    // Each glyph's pen: its origin less its own x offset, as
    // `mt_line_carets` reads it.
    let mut pens: budget::Buffer<f64> = budget::Buffer::new();
    budget::reserve(&mut pens, shaped.glyphs.len())?;
    for (placed, glyph) in shaped.glyphs.iter().zip(engine.line.iter()) {
        let upem = f64::from(engine.font(placed.font)?.info.units_per_em);
        budget::push(&mut pens, placed.x - f64::from(glyph.x_offset) * (face.size / upem))?;
    }
    let glyphs = &shaped.glyphs;
    if glyphs.windows(2).any(|w| w[1].cluster < w[0].cluster) {
        return Ok(None);
    }
    let mut out = budget::Buffer::new();
    budget::reserve(&mut out, starts.len())?;
    let mut g = 0usize;
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(at16);
        let from = g;
        while g < glyphs.len() && glyphs[g].cluster < end {
            g += 1;
        }
        if from == g || glyphs[from].cluster != start {
            return Ok(None);
        }
        let pen = pens[from];
        let next = pens.get(g).copied().unwrap_or(shaped.advance);
        let mut run = ShapedRun {
            glyphs: budget::Buffer::new(),
            advance: next - pen,
        };
        budget::reserve(&mut run.glyphs, g - from)?;
        for placed in &glyphs[from..g] {
            budget::push(
                &mut run.glyphs,
                Placed {
                    x: placed.x - pen,
                    cluster: placed.cluster - start,
                    ..*placed
                },
            )?;
        }
        budget::push(&mut out, run)?;
    }
    Ok(Some(out))
}

/// Canvas `textAlign`: how far the run's start lies from the anchor.
pub fn align_offset(align: Align, advance: f64) -> f64 {
    match align {
        Align::Left => 0.0,
        Align::Center => -advance / 2.0,
        Align::Right => -advance,
    }
}

/// Where a curved glyph's run starts relative to the point it is centred
/// on: canvas `textAlign = "center"` with `textBaseline = "middle"`.
///
/// The vertical part is the engine's `middle` rule and this is the only
/// place the painter asks for it, so when that rule is settled (SPIKE.md
/// rule 4) the painter follows without a change.
pub fn curved_origin(engine: &Engine, face: Face, advance: f64) -> Result<(f64, f64), Error> {
    Ok((-advance / 2.0, engine.middle_shift(face)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_with(name: &str) -> (Engine, FontId) {
        let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        let mut e = Engine::new();
        let id = e.add_font_bytes(std::fs::read(path).unwrap(), 0).unwrap();
        (e, id)
    }

    #[test]
    fn the_run_limit_precedes_shaping_allocations() {
        let (mut e, font) = engine_with("DejaVuSans.ttf");
        let before = e.line.capacity();
        assert!(shape_run(
            &mut e,
            Face::new(font, 40.),
            &"I".repeat(budget::MAX_RUN_BYTES + 1),
            0.
        )
        .is_err());
        assert_eq!(e.line.capacity(), before);
    }

    #[test]
    fn an_unspaced_run_ends_at_the_engines_advance() {
        let (mut e, font) = engine_with("ComicNeue-Regular.ttf");
        let face = Face::new(font, 22.5);
        let run = shape_run(&mut e, face, "AVATAR WAVE!", 0.0).unwrap();
        assert_eq!(run.advance, e.advance(face, "AVATAR WAVE!").unwrap());
        assert_eq!(run.glyphs.len(), 12);
        assert_eq!(run.glyphs[0].x, 0.0);
        assert!(run.glyphs.windows(2).all(|w| w[0].x < w[1].x));
    }

    #[test]
    fn spacing_follows_every_cluster_including_the_last() {
        let (mut e, font) = engine_with("ComicNeue-Regular.ttf");
        let face = Face::new(font, 40.0);
        let plain = shape_run(&mut e, face, "WAVE!", 0.0).unwrap();
        let spaced = shape_run(&mut e, face, "WAVE!", 3.0).unwrap();
        assert!((spaced.advance - (plain.advance + 5.0 * 3.0)).abs() < 1e-9);
        for (i, (a, b)) in plain.glyphs.iter().zip(&spaced.glyphs).enumerate() {
            assert!((b.x - a.x - 3.0 * i as f64).abs() < 1e-9);
        }
        // Centred: the start moves left by half the advance, trailing gap
        // and all, which puts the ink 1.5 px left of where it would be if
        // the last gap did not count.
        assert_eq!(
            align_offset(Align::Center, spaced.advance),
            -spaced.advance / 2.0
        );
        assert_eq!(align_offset(Align::Right, 10.0), -10.0);
        assert_eq!(align_offset(Align::Left, 10.0), 0.0);
    }

    #[test]
    fn spacing_breaks_a_ligature_into_its_letters() {
        let (mut e, font) = engine_with("DejaVuSans.ttf");
        let face = Face::new(font, 40.0);
        let joined = shape_run(&mut e, face, "fi", 0.0).unwrap();
        let spaced = shape_run(&mut e, face, "fi", 2.0).unwrap();
        // DejaVu Sans has an "fi" ligature: one glyph unspaced, two spaced.
        assert_eq!(joined.glyphs.len(), 1);
        assert_eq!(spaced.glyphs.len(), 2);
        let f = e.advance(face, "f").unwrap();
        let i = e.advance(face, "i").unwrap();
        assert!((spaced.advance - (f + i + 4.0)).abs() < 1e-9);
    }

    #[test]
    fn a_curved_glyph_is_centred_on_its_advance_and_the_middle_line() {
        let (mut e, font) = engine_with("Bangers-Regular.ttf");
        let face = Face::new(font, 30.0);
        let run = shape_run(&mut e, face, "W", 0.0).unwrap();
        let (dx, dy) = curved_origin(&e, face, run.advance).unwrap();
        assert_eq!(dx, -run.advance / 2.0);
        assert_eq!(dy, e.middle_shift(face).unwrap());
        // The middle of the line box before it is rounded to whole pixels
        // (RULES.md rule 5), so a glyph on a curve does not jump with the size.
        let b = e.font_box_unrounded(face).unwrap();
        assert!((dy - (b.ascent - b.descent) / 2.0).abs() < 1e-12);
    }
}
