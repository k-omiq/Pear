//! The SFX exports: the sound types (`mt_sfx_kinds`), auto pick
//! (`mt_sfx_pick`), the layout (`mt_sfx_place`, [`crate::sfx::place`]), the
//! numbers it will use (`mt_sfx_resolve`), one letter's outline
//! (`mt_sfx_outline`), and the handles' maths (`mt_sfx_hit`, `mt_sfx_turn`,
//! `mt_sfx_scale`, `mt_sfx_move`, `mt_sfx_bend_for`, `mt_sfx_curve`,
//! [`crate::sfx::gizmo`]).
//!
//! The caller writes the text into the text buffer (`mt_text_reserve`), the
//! params in their wire form (`sfx::params::decode`) into the buffer behind
//! `mt_sfx_params_reserve`, and calls `mt_sfx_place`. The answer is in the
//! shared out buffer, as `mt_line_carets` leaves its. `mt_sfx_hit` reads the
//! letters' quads from the params buffer instead: it is the one input buffer
//! these exports have.
//!
//! Kept apart from `abi.rs` for the reason `abi_paint.rs` is: the only thing
//! shared is the engine and its fonts. These exports are newer than the ABI
//! number, as `mt_line_carets` is: adding one changes no existing signature
//! or layout, and a loader that needs them tests for them.

use std::cell::RefCell;

use crate::abi::{face, with_engine_text, with_out, Status};
use crate::paint::budget;
use crate::sfx;
use crate::sfx::gizmo;
use crate::sfx::path::Path;
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
/// advance (the drawn text's, at the face's size), unit (pixels per em of
/// its hand edit), the ink quad's four corners (x, y each), the quad's
/// centre x, y, pen (how much wider its outlines are drawn).
pub const PLACE_F64S: usize = 26;
/// Numbers per path in it: ax, ay, bx, by, bend, control x, y, the curve's
/// middle x, y (ems).
pub const PATH_F64S: usize = 9;
/// Bytes per letter `mt_sfx_hit` reads: its quad, eight `f64`.
pub const QUAD_BYTES: usize = 64;

/// Writes `values` as the out buffer's little-endian `f64`, returns how many.
fn put_out(values: &[f64]) -> i32 {
    with_out(|out| {
        out.clear();
        for v in values {
            out.extend_from_slice(&v.to_le_bytes());
        }
    });
    values.len() as i32
}

fn params(len: usize) -> Result<sfx::place::Params, Error> {
    with(|s| sfx::params::decode(s.params.get(..len).ok_or(Error::BadSpec)?))
}

/// Lays out the text buffer's first `text_len` bytes as an SFX of the sound
/// types (`sfx::place`): its groups along their paths, in the face `font`,
/// `size`, `flags`, by the params in the params buffer's first `params_len`
/// bytes (`sfx::params::decode`).
///
/// Returns the letter count `n`. The out buffer then holds little-endian
/// `f64`: the group count `g`; the letters' bounds x0, y0, x1, y1 (pixels
/// from the box's centre); `g` paths of [`PATH_F64S`] (the box's own or the
/// made one, in ems); `n` letters of [`PLACE_F64S`]; the text's code point
/// count `c`, then `c` letter indices, -1 for a code point no letter draws
/// (`Layout::cp`). A negative [`Status`] otherwise, and the out buffer is
/// empty.
#[no_mangle]
pub extern "C" fn mt_sfx_place(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    params_len: usize,
) -> i32 {
    let params = params(params_len);
    let run = |engine: &mut crate::Engine, text: &str, out: &mut Vec<u8>| -> Result<i32, Error> {
        let _budget = budget::Scope::new();
        out.clear();
        let params = params?;
        let mut ink = sfx::EngineInk {
            engine,
            face: face(font, size, flags),
        };
        let layout = sfx::place::place(text, size, &params, &mut ink)?;
        let count = 5
            + layout.paths.len() * PATH_F64S
            + layout.letters.len() * PLACE_F64S
            + 1
            + layout.cp.len();
        budget::reserve_raw(out, count * 8)?;
        let mut put = |v: f64| out.extend_from_slice(&v.to_le_bytes());
        put(layout.paths.len() as f64);
        for v in layout.bounds {
            put(v);
        }
        for q in &layout.paths {
            let (ctrl, mid) = gizmo::curve(q);
            for v in [
                q.a[0], q.a[1], q.b[0], q.b[1], q.bend, ctrl[0], ctrl[1], mid[0], mid[1],
            ] {
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
                l.unit,
            ] {
                put(v);
            }
            for v in l.quad.iter().flatten().chain(&l.centre) {
                put(*v);
            }
            put(l.pen);
        }
        put(layout.cp.len() as f64);
        for &i in &layout.cp {
            put(f64::from(i));
        }
        Ok(layout.letters.len() as i32)
    };
    match with_engine_text(text_len, run) {
        Ok(n) => n,
        Err(e) => Status::from(e) as i32,
    }
}

/// The layout numbers the params in the params buffer's first `params_len`
/// bytes lay out with, every unset one filled from the type and moved by the
/// macros (`sfx::params::resolved`): twelve `f64` in the out buffer. Returns
/// 12, or a negative [`Status`] for params that do not decode.
#[no_mangle]
pub extern "C" fn mt_sfx_resolve(params_len: usize) -> i32 {
    match params(params_len) {
        Ok(p) => put_out(&sfx::params::resolved(&p)),
        Err(e) => {
            with_out(Vec::clear);
            Status::from(e) as i32
        }
    }
}

/// The outline of letter `index` of the layout `mt_sfx_place` makes from the
/// same arguments, as an SVG path's `d` in the out buffer (ASCII): one
/// `M .. L .. Z` per contour, holes included, pixels from the box's centre
/// to two decimals. Returns its length, or a negative [`Status`] (a letter
/// past the layout is `BadSpec`).
#[no_mangle]
pub extern "C" fn mt_sfx_outline(
    font: u32,
    size: f64,
    flags: u32,
    text_len: usize,
    params_len: usize,
    index: u32,
) -> i32 {
    let params = params(params_len);
    let run = |engine: &mut crate::Engine, text: &str, out: &mut Vec<u8>| -> Result<i32, Error> {
        let _budget = budget::Scope::new();
        out.clear();
        let params = params?;
        let mut ink = sfx::EngineInk {
            engine,
            face: face(font, size, flags),
        };
        let contours = sfx::place::letter_outline(text, size, &params, &mut ink, index as usize)?;
        let d = svg_d(&contours);
        budget::reserve_raw(out, d.len())?;
        out.extend_from_slice(d.as_bytes());
        Ok(d.len() as i32)
    };
    match with_engine_text(text_len, run) {
        Ok(n) => n,
        Err(e) => Status::from(e) as i32,
    }
}

/// Closed contours as an SVG path's `d`, two decimals.
fn svg_d(contours: &[Vec<[f64; 2]>]) -> String {
    use std::fmt::Write;
    let mut d = String::new();
    let n = |v: f64| (v * 100.0).round() / 100.0 + 0.0;
    for c in contours.iter().filter(|c| c.len() > 1) {
        for (i, p) in c.iter().enumerate() {
            let _ = write!(
                d,
                "{}{} {}",
                if i == 0 { 'M' } else { 'L' },
                n(p[0]),
                n(p[1])
            );
        }
        d.push('Z');
    }
    d
}

/// The topmost of the first `n` letters whose quad holds `x, y`
/// (`gizmo::hit`), or within `slop` pixels the nearest. The quads are in the
/// params buffer, [`QUAD_BYTES`] a letter: the corners' x, y as `sfxPlace`
/// gave them. Returns the letter's index, -1 for none, or `BadSpec` for
/// more quads than the buffer holds.
#[no_mangle]
pub extern "C" fn mt_sfx_hit(n: usize, x: f64, y: f64, slop: f64) -> i32 {
    let quads = with(|s| {
        let bytes = s.params.get(..n.checked_mul(QUAD_BYTES)?)?;
        Some(
            bytes
                .as_chunks::<QUAD_BYTES>()
                .0
                .iter()
                .map(|q| {
                    let v = |i: usize| {
                        let b = &q[i * 8..i * 8 + 8];
                        f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
                    };
                    [[v(0), v(1)], [v(2), v(3)], [v(4), v(5)], [v(6), v(7)]]
                })
                .collect::<Vec<_>>(),
        )
    });
    match quads {
        Some(q) => gizmo::hit(&q, [x, y], slop.max(0.0)).map_or(-1, |i| i as i32),
        None => Status::BadSpec as i32,
    }
}

/// One move of a turn about `cx, cy` from `fx, fy` to `tx, ty`, added to the
/// running `total` (`gizmo::turn`). Returns 2: the out buffer holds the new
/// running total and the turn to store (whole degrees, -180..180, snapped
/// to `snap` degrees when it is above 0).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mt_sfx_turn(
    cx: f64,
    cy: f64,
    fx: f64,
    fy: f64,
    tx: f64,
    ty: f64,
    total: f64,
    snap: f64,
) -> i32 {
    let (total, shown) = gizmo::turn([cx, cy], [fx, fy], [tx, ty], total, snap);
    put_out(&[total, shown])
}

/// The scale for a drag on the scale handle (`gizmo::scale`): `from` times
/// the pointer's distance from `cx, cy` now (`nx, ny`) over at grab
/// (`sx, sy`), snapped to 0.05 when `snap` is not 0.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mt_sfx_scale(
    cx: f64,
    cy: f64,
    sx: f64,
    sy: f64,
    nx: f64,
    ny: f64,
    from: f64,
    snap: u32,
) -> f64 {
    gizmo::scale([cx, cy], [sx, sy], [nx, ny], from, snap != 0)
}

/// A letter's hand-edit offset for a drag from `sx, sy` to `nx, ny`
/// (`gizmo::moved`), `unit` pixels to its em, from `dx, dy` at grab.
/// Returns 2: the out buffer holds the new dx, dy.
#[no_mangle]
pub extern "C" fn mt_sfx_move(
    unit: f64,
    sx: f64,
    sy: f64,
    nx: f64,
    ny: f64,
    dx: f64,
    dy: f64,
) -> i32 {
    put_out(&gizmo::moved(unit, [sx, sy], [nx, ny], [dx, dy]))
}

/// The bend that puts the middle of the path `a`..`b` (bent `bend` now) at
/// `px, py` (`gizmo::bend_for`).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn mt_sfx_bend_for(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    bend: f64,
    px: f64,
    py: f64,
) -> f64 {
    let path = Path {
        a: [ax, ay],
        b: [bx, by],
        bend,
    };
    gizmo::bend_for(&path, [px, py])
}

/// The control point and the middle of the path `a`..`b` bent `bend`
/// (`gizmo::curve`). Returns 4: the out buffer holds control x, y, middle
/// x, y.
#[no_mangle]
pub extern "C" fn mt_sfx_curve(ax: f64, ay: f64, bx: f64, by: f64, bend: f64) -> i32 {
    let (c, m) = gizmo::curve(&Path {
        a: [ax, ay],
        b: [bx, by],
        bend,
    });
    put_out(&[c[0], c[1], m[0], m[1]])
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
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| f64::from_le_bytes(*c))
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
        let tail = 5 + g * PATH_F64S + 5 * PLACE_F64S;
        assert_eq!(got.len(), tail + 1 + 6, "six code points");
        assert!(got.iter().all(|v| v.is_finite()));
        let [x0, y0, x1, y1] = [got[1], got[2], got[3], got[4]];
        // The path's control point and middle follow its ends and bend.
        let q = &got[5..5 + PATH_F64S];
        let (ctrl, mid) = gizmo::curve(&Path {
            a: [q[0], q[1]],
            b: [q[2], q[3]],
            bend: q[4],
        });
        assert_eq!(&q[5..], [ctrl[0], ctrl[1], mid[0], mid[1]]);
        let letters = &got[5 + g * PATH_F64S..tail];
        for (i, rec) in letters.chunks(PLACE_F64S).enumerate() {
            assert!(rec[0] > x0 && rec[0] < x1 && rec[1] > y0 && rec[1] < y1);
            assert_eq!(rec[8], 0.0, "one group");
            assert_eq!(rec[9], i as f64);
            assert_eq!(
                rec[14], rec[12],
                "no hand edit: the edit's em is the letter's"
            );
            // The quad's centre is its corners' middle, near the letter.
            let quad = &rec[15..23];
            assert!((rec[23] - (quad[0] + quad[4]) / 2.0).abs() < 1e-9);
            assert!((rec[23] - rec[0]).hypot(rec[24] - rec[1]) < rec[12]);
        }
        // The last cell is `!!`, UTF-16 4..6.
        assert_eq!(&letters[4 * PLACE_F64S + 6..4 * PLACE_F64S + 8], [4.0, 6.0]);
        // B O O M ! !: the second bang is drawn by the first's letter.
        assert_eq!(&got[tail..], [6.0, 0.0, 1.0, 2.0, 3.0, 4.0, -1.0]);
        // Bad params are refused, not placed.
        let bad = mt_sfx_place(font, 40.0, 0, set_text(text), set_params(&[1, 2, 3]));
        assert_eq!(bad, Status::BadSpec as i32);
    }

    #[test]
    fn resolve_fills_the_unset_numbers_from_the_type() {
        use crate::sfx::kinds::{index_of, KINDS};
        use crate::sfx::params::{encode, number_at};
        let k = index_of("rumble").unwrap();
        let mut b = encode(&crate::sfx::place::Params {
            kind: Some(k),
            gap: 0.3,
            ..Default::default()
        });
        // Flow from and follow unset: the type's. The gap stays the box's.
        for i in [3, 6] {
            b[number_at(i)..number_at(i) + 8].copy_from_slice(&f64::NAN.to_le_bytes());
        }
        assert_eq!(mt_sfx_resolve(set_params(&b)), 12);
        let r = out();
        assert_eq!(r[1], KINDS[k].flow.0);
        assert_eq!(r[4], KINDS[k].follow);
        assert_eq!(r[5], 0.3);
        assert_eq!(mt_sfx_resolve(set_params(&[0; 3])), Status::BadSpec as i32);
    }

    #[test]
    fn a_letters_outline_is_a_path_inside_its_quad() {
        use crate::sfx::params::encode;
        let font = load("ComicNeue-Regular.ttf");
        let p = encode(&crate::sfx::place::Params::default());
        let text = "BO";
        assert_eq!(
            mt_sfx_place(font, 40.0, 0, set_text(text), set_params(&p)),
            2
        );
        let got = out();
        let g = got[0] as usize;
        let o = &got[5 + g * PATH_F64S + PLACE_F64S..];
        let quad = &o[15..23];
        let len = mt_sfx_outline(font, 40.0, 0, set_text(text), set_params(&p), 1);
        let d = out_text();
        assert_eq!(len as usize, d.len());
        // An O is two contours, both closed.
        assert_eq!(d.matches('M').count(), 2, "{d}");
        assert_eq!(d.matches('Z').count(), 2);
        let nums: Vec<f64> = d
            .split(|c: char| c.is_ascii_alphabetic() || c == ' ')
            .filter(|s| !s.is_empty())
            .map(|s| s.parse().unwrap())
            .collect();
        let (xs, ys) = (
            [quad[0], quad[2], quad[4], quad[6]],
            [quad[1], quad[3], quad[5], quad[7]],
        );
        let lo = |v: [f64; 4]| v.iter().copied().fold(f64::MAX, f64::min) - 0.01;
        let hi = |v: [f64; 4]| v.iter().copied().fold(f64::MIN, f64::max) + 0.01;
        for xy in nums.chunks(2) {
            assert!(xy[0] >= lo(xs) && xy[0] <= hi(xs) && xy[1] >= lo(ys) && xy[1] <= hi(ys));
        }
        // The hit test finds the O by its quad, read from the params buffer.
        let mut qb = Vec::new();
        for v in quad {
            qb.extend_from_slice(&v.to_le_bytes());
        }
        set_params(&qb);
        let c = [(quad[0] + quad[4]) / 2.0, (quad[1] + quad[5]) / 2.0];
        assert_eq!(mt_sfx_hit(1, c[0], c[1], 0.0), 0);
        assert_eq!(mt_sfx_hit(1, c[0] + 1000.0, c[1], 0.0), -1);
        assert_eq!(mt_sfx_hit(1 << 20, c[0], c[1], 0.0), Status::BadSpec as i32);
        // A letter past the layout is refused.
        let bad = mt_sfx_outline(font, 40.0, 0, set_text(text), set_params(&p), 2);
        assert_eq!(bad, Status::BadSpec as i32);
    }

    #[test]
    fn the_handle_exports_answer_through_the_out_buffer() {
        assert_eq!(mt_sfx_turn(0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 100.0, 0.0), 2);
        let t = out();
        assert!((t[0] - 190.0).abs() < 1e-9 && t[1] == -170.0, "{t:?}");
        assert_eq!(mt_sfx_move(100.0, 0.0, 0.0, 25.0, -50.0, 0.0, 0.0), 2);
        assert_eq!(out(), [0.25, -0.5]);
        assert_eq!(mt_sfx_scale(0.0, 0.0, 10.0, 0.0, 30.0, 0.0, 1.0, 0), 3.0);
        assert_eq!(mt_sfx_curve(0.0, 0.0, 2.0, 0.0, 0.5), 4);
        assert_eq!(out(), [1.0, 1.0, 1.0, 0.5]);
        assert_eq!(mt_sfx_bend_for(0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.5), 0.5);
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
