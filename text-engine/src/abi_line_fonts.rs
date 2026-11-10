//! Which font each stretch of a line is drawn in, over the C ABI.
//!
//! `mt_missing` says which letters nothing has. It does not say which font
//! drew the ones something has, and that cannot be worked out from it: a
//! letter is drawn from the font the part before it uses when that font has
//! it, whatever comes first in the chain (RULES.md rule 10). Whoever has to
//! NAME the font of a stretch afterwards - a PSD type layer - asks here.
//!
//! The answer is `Engine::line_fonts`: the parts of the same `measure_line`
//! the measuring exports and the painter go through.
//!
//! A file of its own, behind `paint`, with its own way of passing text, for
//! the reason `abi_instance.rs` gives: `abi.rs` and its text buffer were
//! another worker's when this was written.

use crate::abi::with_engine;
use crate::engine::{Face, Synth};

/// `u32`s written per part: font id, synth bits (1 bold, 2 oblique), and the
/// first and one-past-last UTF-16 unit of the text it covers.
pub const LINE_FONT_FIELDS: usize = 4;

/// Writes the parts of `text` as a line of `font` with `flags` (as every
/// measuring export takes them) to `out`, and returns how many there are.
///
/// `text` is `text_len` bytes of UTF-8 and `out` room for `out_cap` `u32`s,
/// both in memory the caller got from `mt_alloc`. Returns -1 for an unknown
/// font, for a chain handle the engine does not hold (`Engine::line_fonts`;
/// zero is "no chain" and is not one of those), or for text that is not
/// UTF-8, and -2 when the parts do not fit in `out` - a line of `n` UTF-16
/// units has at most `n` parts, so `4 * n` always fits. On -1 and on -2
/// nothing is written to `out`.
///
/// # Safety
///
/// `text` must be valid for reads of `text_len` bytes and `out` for writes
/// of `out_cap` `u32`s (it need not be aligned), or either may be null with a zero
/// length.
#[no_mangle]
pub unsafe extern "C" fn mt_line_fonts(
    font: u32,
    flags: u32,
    text: *const u8,
    text_len: usize,
    out: *mut u32,
    out_cap: usize,
) -> i32 {
    let bytes: &[u8] = if text.is_null() || text_len == 0 {
        &[]
    } else {
        // SAFETY: the caller's promise above.
        unsafe { core::slice::from_raw_parts(text, text_len) }
    };
    let Ok(text) = core::str::from_utf8(bytes) else {
        return -1;
    };
    let face = Face {
        font,
        size: 1.0,
        synth: Synth::from_bits(flags),
        chain: flags >> 8,
    };
    with_engine(|engine| {
        let Ok(parts) = engine.line_fonts(face, text) else {
            return -1;
        };
        if out.is_null() || parts.len() * LINE_FONT_FIELDS > out_cap {
            return if parts.is_empty() { 0 } else { -2 };
        }
        for (i, part) in parts.iter().enumerate() {
            let fields = [part.font, part.synth.bits(), part.text.start, part.text.end];
            for (k, value) in fields.into_iter().enumerate() {
                // SAFETY: `i * 4 + k` is below `out_cap`, checked above.
                unsafe { out.add(i * LINE_FONT_FIELDS + k).write_unaligned(value) };
            }
        }
        parts.len() as i32
    })
}

/// `u32`s read per span by [`mt_advance_spans`]: font id, flags (as every
/// measuring export takes them: synth bits, chain above bit 8), and the first
/// and one-past-last UTF-16 unit of the text it covers.
pub const SPAN_FIELDS: usize = 4;

/// The advance in pixels of `text` set as one line in several faces, without
/// letter spacing: `Engine::advance_spans`, the measure the painter's cut of
/// a line into faces agrees with. `spans` holds `count` spans of
/// [`SPAN_FIELDS`] `u32`s, in order and covering the text end to end, all at
/// `size`. NaN for an unknown font or chain, text that is not UTF-8, or spans
/// that do not cover the text.
///
/// # Safety
///
/// `text` must be valid for reads of `text_len` bytes and `spans` for reads of
/// `count * SPAN_FIELDS` `u32`s (neither need be aligned), or either may be
/// null with a zero length.
#[no_mangle]
pub unsafe extern "C" fn mt_advance_spans(
    size: f64,
    text: *const u8,
    text_len: usize,
    spans: *const u32,
    count: usize,
) -> f64 {
    let bytes: &[u8] = if text.is_null() || text_len == 0 {
        &[]
    } else {
        // SAFETY: the caller's promise above.
        unsafe { core::slice::from_raw_parts(text, text_len) }
    };
    let Ok(text) = core::str::from_utf8(bytes) else {
        return f64::NAN;
    };
    if spans.is_null() && count > 0 {
        return f64::NAN;
    }
    let list: Vec<(Face, core::ops::Range<u32>)> = (0..count)
        .map(|i| {
            // SAFETY: `i * SPAN_FIELDS + k` is below `count * SPAN_FIELDS`.
            let at = |k: usize| unsafe { spans.add(i * SPAN_FIELDS + k).read_unaligned() };
            let flags = at(1);
            let face = Face {
                font: at(0),
                size,
                synth: Synth::from_bits(flags),
                chain: flags >> 8,
            };
            (face, at(2)..at(3))
        })
        .collect();
    with_engine(|engine| engine.advance_spans(&list, text).unwrap_or(f64::NAN))
}
