//! The SFX exports: the sound types (`mt_sfx_kinds`), auto pick
//! (`mt_sfx_pick`) and the layout (`mt_sfx_place`, [`crate::sfx::place`]).
//!
//! The caller writes the text into the text buffer (`mt_text_reserve`), the
//! params in their wire form (`sfx::params::decode`) into the buffer behind
//! `mt_sfx_params_reserve`, and calls `mt_sfx_place`. The answer is in the
//! shared out buffer, as `mt_line_carets` leaves its.
//!
//! Kept apart from `abi.rs` for the reason `abi_paint.rs` is: the only thing
//! shared is the engine and its fonts. These exports are newer than the ABI
//! number, as `mt_line_carets` is: adding one changes no existing signature
//! or layout, and a loader that needs them tests for them.

use std::cell::RefCell;

use crate::abi::{face, with_engine_text, with_out, Status};
use crate::paint::budget;
use crate::sfx;
use crate::Error;

#[derive(Default)]
struct State {
    params: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// Largest params accepted, in bytes: four paths and every letter's edit,
/// with room; a guard like the paint job's.
pub const MAX_PARAMS_BYTES: usize = 1 << 16;

/// Returns the params buffer, grown to hold at least `capacity` bytes, or
/// null when `capacity` is more than [`MAX_PARAMS_BYTES`] or the memory is
/// not to be had. The pointer stays valid until the next call with a larger
/// capacity.
#[no_mangle]
pub extern "C" fn mt_sfx_params_reserve(capacity: usize) -> *mut u8 {
    with(|s| {
        if s.params.len() < capacity {
            let more = capacity - s.params.len();
            if capacity > MAX_PARAMS_BYTES || s.params.try_reserve_exact(more).is_err() {
                return core::ptr::null_mut();
            }
            s.params.resize(capacity, 0);
        }
        s.params.as_mut_ptr()
    })
}

/// Numbers per letter in `mt_sfx_place`'s answer: x, y, rot, sx, sy, skew,
/// UTF-16 start, UTF-16 end, group, index, direction x, direction y, em,
/// advance (the drawn text's, at the face's size).
pub const PLACE_F64S: usize = 14;
/// Numbers per path in it: ax, ay, bx, by, bend (ems).
pub const PATH_F64S: usize = 5;

/// Lays out the text buffer's first `text_len` bytes as an SFX of the sound
/// types (`sfx::place`): its groups along their paths, in the face `font`,
/// `size`, `flags`, by the params in the params buffer's first `params_len`
/// bytes (`sfx::params::decode`).
///
/// Returns the letter count `n`. The out buffer then holds little-endian
/// `f64`: the group count `g`; the letters' bounds x0, y0, x1, y1 (pixels
/// from the box's centre); `g` paths of [`PATH_F64S`] (the box's own or the
/// made one, in ems); `n` letters of [`PLACE_F64S`]. A negative [`Status`]
/// otherwise, and the out buffer is empty.
#[no_mangle]
pub extern "C" fn mt_sfx_place(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    params_len: usize,
) -> i32 {
    let params = with(|s| sfx::params::decode(s.params.get(..params_len).ok_or(Error::BadSpec)?));
    let run = |engine: &mut crate::Engine, text: &str, out: &mut Vec<u8>| -> Result<i32, Error> {
        let _budget = budget::Scope::new();
        out.clear();
        let params = params?;
        let mut ink = sfx::EngineInk {
            engine,
            face: face(font, size, flags),
        };
        let layout = sfx::place::place(text, size, &params, &mut ink)?;
        let count = 5 + layout.paths.len() * PATH_F64S + layout.letters.len() * PLACE_F64S;
        budget::reserve_raw(out, count * 8)?;
        let mut put = |v: f64| out.extend_from_slice(&v.to_le_bytes());
        put(layout.paths.len() as f64);
        for v in layout.bounds {
            put(v);
        }
        for q in &layout.paths {
            for v in [q.a[0], q.a[1], q.b[0], q.b[1], q.bend] {
                put(v);
            }
        }
        for l in &layout.letters {
            for v in [
                l.x,
                l.y,
                l.rot,
                l.sx,
                l.sy,
                l.skew,
                f64::from(l.utf16.start),
                f64::from(l.utf16.end),
                f64::from(l.group),
                f64::from(l.index),
                l.dir[0],
                l.dir[1],
                l.em,
                l.adv,
            ] {
                put(v);
            }
        }
        Ok(layout.letters.len() as i32)
    };
    match with_engine_text(text_len, run) {
        Ok(n) => n,
        Err(e) => Status::from(e) as i32,
    }
}

/// The twelve sound types as one ASCII JSON document (`sfx::kinds::kinds_json`)
/// in the out buffer. Returns its length.
#[no_mangle]
pub extern "C" fn mt_sfx_kinds() -> i32 {
    let json = sfx::kinds::kinds_json();
    with_out(|out| {
        out.clear();
        out.extend_from_slice(json.as_bytes());
    });
    json.len() as i32
}

/// Auto pick for the text buffer's first `text_len` bytes: the types ranked
/// best first, their scores and a strength, as one ASCII JSON document
/// (`sfx::pick::pick_json`) in the out buffer. Returns its length, or a
/// negative [`Status`] for text that is not UTF-8.
#[no_mangle]
pub extern "C" fn mt_sfx_pick(text_len: usize) -> i32 {
    let run = |_: &mut crate::Engine, text: &str, out: &mut Vec<u8>| -> Result<i32, Error> {
        out.clear();
        let json = sfx::pick::pick_json(&sfx::pick::pick(text));
        out.extend_from_slice(json.as_bytes());
        Ok(json.len() as i32)
    };
    match with_engine_text(text_len, run) {
        Ok(n) => n,
        Err(e) => Status::from(e) as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::{mt_alloc, mt_font_add, mt_out_len, mt_out_ptr, mt_text_reserve};

    fn load(name: &str) -> u32 {
        let path = format!("{}/../src/test/fonts/{name}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(path).unwrap();
        let ptr = mt_alloc(bytes.len());
        // SAFETY: `ptr` holds `bytes.len()` writable bytes from `mt_alloc`.
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
        // SAFETY: the allocation is initialised and handed over.
        unsafe { mt_font_add(ptr, bytes.len(), 0) }
    }

    fn set_text(s: &str) -> usize {
        let ptr = mt_text_reserve(s.len());
        // SAFETY: the text buffer holds at least `s.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(s.as_ptr(), ptr, s.len()) };
        s.len()
    }

    fn set_params(b: &[u8]) -> usize {
        let ptr = mt_sfx_params_reserve(b.len());
        assert!(!ptr.is_null());
        // SAFETY: the params buffer holds at least `b.len()` bytes.
        unsafe { core::ptr::copy_nonoverlapping(b.as_ptr(), ptr, b.len()) };
        b.len()
    }

    fn out() -> Vec<f64> {
        let (ptr, len) = (mt_out_ptr(), mt_out_len());
        // SAFETY: the out buffer holds `len` bytes at `ptr`.
        let bytes = unsafe { core::slice::from_raw_parts(ptr, len) };
        bytes
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect()
    }

    fn out_text() -> String {
        // SAFETY: the out buffer holds `mt_out_len()` bytes at `mt_out_ptr()`.
        let bytes = unsafe { core::slice::from_raw_parts(mt_out_ptr(), mt_out_len()) };
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn place_writes_paths_then_one_record_per_letter() {
        use crate::sfx::kinds::index_of;
        use crate::sfx::params::encode;
        let font = load("ComicNeue-Regular.ttf");
        let p = crate::sfx::place::Params {
            kind: index_of("impact"),
            ..Default::default()
        };
        let text = "BOOM!!";
        let n = mt_sfx_place(font, 40.0, 0, set_text(text), set_params(&encode(&p)));
        assert_eq!(n, 5, "the two bangs share a cell");
        let got = out();
        let g = got[0] as usize;
        assert_eq!(got.len(), 5 + g * PATH_F64S + 5 * PLACE_F64S);
        assert!(got.iter().all(|v| v.is_finite()));
        let [x0, y0, x1, y1] = [got[1], got[2], got[3], got[4]];
        let letters = &got[5 + g * PATH_F64S..];
        for (i, rec) in letters.chunks(PLACE_F64S).enumerate() {
            assert!(rec[0] > x0 && rec[0] < x1 && rec[1] > y0 && rec[1] < y1);
            assert_eq!(rec[8], 0.0, "one group");
            assert_eq!(rec[9], i as f64);
        }
        // The last cell is `!!`, UTF-16 4..6.
        assert_eq!(&letters[4 * PLACE_F64S + 6..4 * PLACE_F64S + 8], [4.0, 6.0]);
        // Bad params are refused, not placed.
        let bad = mt_sfx_place(font, 40.0, 0, set_text(text), set_params(&[1, 2, 3]));
        assert_eq!(bad, Status::BadSpec as i32);
    }

    #[test]
    fn kinds_and_pick_come_out_as_their_json() {
        let len = mt_sfx_kinds();
        assert_eq!(out_text(), sfx::kinds::kinds_json());
        assert_eq!(len as usize, mt_out_len());
        let len = mt_sfx_pick(set_text("ゴゴゴゴ"));
        let json = out_text();
        assert_eq!(len as usize, json.len());
        assert!(json.starts_with("{\"order\":[\"rumble\","), "{json}");
    }
}
